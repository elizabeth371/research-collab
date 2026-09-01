"""
水印基准测试脚本 (论文实验数据生产)
====================================
对批量真实 DeepSeek 生成样本运行「模式 x 攻击矩阵」对照实验, 产出论文
核心表格所需数据:

- 模式: char_bigram (Kirchenbauer 基线) / word_bigram / unigram_anchor /
  dual_anchor (本工作改进), 全部在同一份 logprobs 候选上本地重采样,
  一次 API 调用复用多模式, 成本与样本数成正比而非 模式数 x 样本数;
- 攻击: 删除 10/20/30/40% / 截断 20% / 同义替换 / 噪声插入 /
  局部乱序 (窗口 2/3/4) / 机器翻译回译 (--translate, 真实 DeepSeek);
- 人类基线: 内置 + 外部目录的真人中文文本, 统计各模式在 z=4 阈值下的
  误报率 (论文必须有的 False Positive 数据);
- 断点续跑: 候选与逐样本结果落盘 JSON, 重跑只补缺失项, 不重复烧 API 费。

用法 (在 backend/ 目录下执行):
  python ../scripts/run_watermark_benchmark.py --samples 6 --modes char_bigram,dual_anchor
  python ../scripts/run_watermark_benchmark.py --samples 10 --translate --human-dir ../docs/human_corpus
  python ../scripts/run_watermark_benchmark.py --synthetic  # 离线冒烟测试

输出 (--out 目录):
  candidates/     每样本的 LLM logprobs 候选 (JSON, 重跑复用)
  texts/          每模式注入后的水印文本
  rows/           逐 (样本, 模式, 攻击) 的检测结果
  summary.csv / summary.md   均值±标准差汇总表
  human_baseline.csv/md     人类文本 z 分布与误报率
"""

import argparse
import asyncio
import json
import statistics
import sys
from pathlib import Path

import numpy as np

# 脚本位于 scripts/, 后端包在 ../backend: 注入 sys.path 以便 import services.*
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from services.llm_client import llm_client
from services.watermark_attack import WatermarkAttackSuite
from services.watermark_engine import WatermarkEngine

# 主题池 (每次运行取前 N 个, seed 固定保证可复现)
DEFAULT_TOPICS = [
    "科研论文的版权溯源与 AIGC 检测",
    "大语言模型生成内容的可验证来源",
    "多智能体协同编辑中的作者归属",
    "文本水印在内容平台的应用",
    "人工智能生成内容的安全治理",
    "学术写作中的引用规范与溯源",
    "协同文档系统的权限与审计",
    "生成式 AI 的可信度评估",
    "知识产权的数字化保护技术",
    "科研数据管理与版本追溯",
]

# 内置人类中文文本 (真人书写, 无任何水印; 用于误报率基线)
HUMAN_SAMPLES = [
    "今天下午的组会上, 我们一起讨论了开题报告的修改意见, 我负责整理会议记录。"
    "会后去图书馆借了几本关于数据安全的书, 晚上把参考文献的格式统一了一遍,"
    "顺便把下周的实验计划列成了清单。",
    "这个学期的课程任务比较重, 每周都有两三次实验要写报告。好在实验室的师兄"
    "愿意分享他整理的模板, 让我少走了不少弯路。我想等结题之后把整个项目的"
    "文档重新梳理一遍, 方便下一届的学弟学妹接手。",
    "写论文的时候最头疼的是引言部分, 既要把研究背景讲清楚, 又不能写得太长。"
    "指导老师建议我先列提纲, 再逐段填充内容, 最后统一润色措辞。这个方法"
    "确实有效, 比直接从头写到尾快多了。",
    "周末去参加了学校组织的创新创业训练营, 听了两场关于成果转化的讲座。"
    "印象最深的是老师讲知识产权布局, 说技术成果要尽早申请保护, 免得"
    "公开之后失去新颖性。回来之后我把这些内容记进了项目的笔记里。",
    "下午把实验数据重新跑了一遍, 发现上次的结果是因为参数设置出了问题。"
    "修正之后曲线基本符合预期, 误差也在可接受范围内。明天准备把图表整理好,"
    "发给导师看一下, 再决定要不要补一组对照实验。",
    "图书馆的自习室晚上人不多, 适合集中精力写代码。我把协同编辑模块的接口"
    "文档补完了, 又把水印检测的测试用例过了一遍, 总共花了两三个小时, 进度"
    "比预想的顺利一些。",
]


def _attack_variants(text: str) -> list[dict]:
    """确定性攻击矩阵 (含强度梯度), 返回 [{name, label, text}]。"""
    suite = WatermarkAttackSuite
    return [
        {"name": "no_attack", "label": "无攻击（基线）", "text": text},
        {"name": "delete_10", "label": "随机删除 10% 字符", "text": suite.delete_random(text, 0.10, seed=1)},
        {"name": "delete_20", "label": "随机删除 20% 字符", "text": suite.delete_random(text, 0.20, seed=2)},
        {"name": "delete_30", "label": "随机删除 30% 字符", "text": suite.delete_random(text, 0.30, seed=3)},
        {"name": "delete_40", "label": "随机删除 40% 字符", "text": suite.delete_random(text, 0.40, seed=4)},
        {"name": "truncate_20", "label": "截断末尾 20%", "text": suite.truncate_tail(text, 0.20)},
        {"name": "synonym_replace", "label": "中文同义替换", "text": suite.synonym_replace(text)},
        {"name": "noise_insert", "label": "插入噪声字符", "text": suite.insert_noise(text, per_100=2, seed=1)},
        {"name": "reorder_w2", "label": "局部乱序 窗口2", "text": suite.reorder_local(text, window=2, seed=1)},
        {"name": "reorder_w4", "label": "局部乱序 窗口4", "text": suite.reorder_local(text, window=4, seed=1)},
        {"name": "reorder_w6", "label": "局部乱序 窗口6", "text": suite.reorder_local(text, window=6, seed=1)},
    ]


async def _fetch_candidates(sample_id: str, topic: str) -> list | None:
    """请求一次 logprobs 候选 (多模式复用)。"""
    prompt = (
        f"围绕以下主题撰写一段规范的中文学术短文 (300-500 字), 直接输出正文:\n{topic}"
    )
    return await llm_client.generate_with_logprobs(
        [{"role": "system", "content": "你是一位严谨的中文学术写作者。"},
         {"role": "user", "content": prompt}],
        temperature=1.5,
        max_tokens=600,
        top_logprobs=20,
    )


def _synthetic_candidates(n_positions: int = 400, seed: int = 42) -> list:
    """离线冒烟用合成候选 (结构与真实 logprobs 同构)。"""
    vocab = list("的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体")
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_positions):
        idx = rng.choice(len(vocab), size=20, replace=False)
        lps = np.concatenate([rng.uniform(-1.5, 0.0, size=1), rng.uniform(-12.0, -3.0, size=19)])
        rng.shuffle(lps)
        out.append([(vocab[int(i)], float(lp)) for i, lp in zip(idx, lps)])
    return out


async def _translate(text: str) -> str | None:
    """机器翻译回译 (zh->en->zh), 失败返回 None。"""
    return await WatermarkAttackSuite.translate_roundtrip(
        WatermarkAttackSuite(), llm_client, text
    )


def _row(engine: WatermarkEngine, text: str, attack_name: str, label: str) -> dict:
    d = engine.detect_watermark(text)
    row = {
        "attack": attack_name,
        "label": label,
        "z_score": d["z_score"],
        "is_ai_generated": d["is_ai_generated"],
        "num_tokens_scored": d["num_tokens_scored"],
        "green_fraction": d["green_fraction"],
        "model": d["model_name"],
    }
    if engine.hash_mode == "dual_anchor":
        row["z_char"] = d.get("z_char")
        row["z_anchor"] = d.get("z_anchor")
    return row


def _load_human_texts(human_dir: Path | None) -> list[str]:
    texts = list(HUMAN_SAMPLES)
    if human_dir and human_dir.is_dir():
        for fp in sorted(human_dir.glob("*.txt")):
            content = fp.read_text(encoding="utf-8").strip()
            if len(content) >= 100:
                texts.append(content)
    return texts


def _agg(rows: list[dict], attack: str) -> dict:
    zs = [r["z_score"] for r in rows]
    detected = sum(1 for r in rows if r["is_ai_generated"])
    return {
        "attack": attack,
        "n": len(rows),
        "z_mean": round(statistics.mean(zs), 3) if zs else None,
        "z_std": round(statistics.pstdev(zs), 3) if len(zs) > 1 else None,
        "detect_rate": round(detected / len(rows), 3) if rows else None,
    }


async def run(out_dir: Path, modes: list[str], n_samples: int, delta: float,
              do_translate: bool, synthetic: bool, human_dir: Path | None) -> None:
    (out_dir / "candidates").mkdir(parents=True, exist_ok=True)
    (out_dir / "texts").mkdir(parents=True, exist_ok=True)
    (out_dir / "rows").mkdir(parents=True, exist_ok=True)
    topics = DEFAULT_TOPICS[: max(1, n_samples)]

    engines = {m: WatermarkEngine(hash_mode=m, delta=delta) for m in modes}

    # ---------- 1. 采样: 候选一次性请求, 各模式本地重采样 ----------
    for i, topic in enumerate(topics):
        sample_id = f"sample_{i:02d}"
        cand_path = out_dir / "candidates" / f"{sample_id}.json"
        if cand_path.exists():
            candidates = json.loads(cand_path.read_text(encoding="utf-8"))
        else:
            candidates = (
                await _fetch_candidates(sample_id, topic)
                if not synthetic else _synthetic_candidates(seed=100 + i)
            )
            if not candidates:
                print(f"[warn] {sample_id} 候选获取失败, 跳过")
                continue
            cand_path.write_text(
                json.dumps(candidates, ensure_ascii=False), encoding="utf-8"
            )

        for mode in modes:
            text_path = out_dir / "texts" / f"{sample_id}.{mode}.txt"
            if text_path.exists():
                continue
            text = engines[mode].resample_with_watermark(
                candidates, rng=np.random.default_rng(7 + i), delta=delta
            )
            text_path.write_text(text, encoding="utf-8")
            print(f"[inject] {sample_id}.{mode} len={len(text)}")

    # ---------- 2. 攻击矩阵 (逐样本逐模式) ----------
    translation_cache: dict[str, str | None] = {}
    for i in range(len(topics)):
        sample_id = f"sample_{i:02d}"
        for mode in modes:
            text_path = out_dir / "texts" / f"{sample_id}.{mode}.txt"
            if not text_path.exists():
                continue
            row_path = out_dir / "rows" / f"{sample_id}.{mode}.json"
            if row_path.exists():
                continue
            text = text_path.read_text(encoding="utf-8")
            rows = []
            for atk in _attack_variants(text):
                rows.append(_row(engines[mode], atk["text"], atk["name"], atk["label"]))
            if do_translate:
                if sample_id not in translation_cache:
                    translation_cache[sample_id] = await _translate(text)
                tr = translation_cache[sample_id]
                if tr:
                    rows.append(_row(engines[mode], tr, "translate_roundtrip",
                                     "机器翻译回译 zh→en→zh"))
            row_path.write_text(
                json.dumps({"sample": sample_id, "mode": mode, "rows": rows},
                           ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            print(f"[attack] {sample_id}.{mode} rows={len(rows)}")

    # ---------- 3. 汇总 ----------
    per_mode: dict[str, dict[str, list]] = {m: {} for m in modes}
    for row_file in sorted((out_dir / "rows").glob("*.json")):
        data = json.loads(row_file.read_text(encoding="utf-8"))
        mode = data["mode"]
        for r in data["rows"]:
            per_mode[mode].setdefault(r["attack"], []).append(r)

    attack_order = [a["name"] for a in _attack_variants("x")] + (
        ["translate_roundtrip"] if do_translate else []
    )
    summary = {m: [_agg(per_mode[m].get(a, []), a) for a in attack_order] for m in modes}

    _write_summary(out_dir, summary, modes)
    _write_human_baseline(out_dir, engines, human_dir)
    print(f"[done] 结果目录: {out_dir}")


def _write_summary(out_dir: Path, summary: dict, modes: list[str]) -> None:
    header = ["attack"] + [f"{m}_z(mean±std)" for m in modes] + [f"{m}_detect" for m in modes]
    rows = []
    for a in summary[modes[0]]:
        row = [a["attack"]]
        for m in modes:
            r = next(x for x in summary[m] if x["attack"] == a["attack"])
            row.append(f"{r['z_mean']}±{r['z_std']}" if r["z_mean"] is not None else "-")
        for m in modes:
            r = next(x for x in summary[m] if x["attack"] == a["attack"])
            row.append(f"{r['detect_rate']}" if r["detect_rate"] is not None else "-")
        rows.append(row)

    with open(out_dir / "summary.csv", "w", encoding="utf-8-sig", newline="") as f:
        import csv
        csv.writer(f).writerows([header] + rows)

    lines = ["| 攻击 | " + " | ".join(f"{m} z(均值±σ)" for m in modes) +
             " | " + " | ".join(f"{m} 检出率" for m in modes) + " |",
             "| --- | " + " | ".join(["---"] * len(modes) * 2) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(str(c) for c in row) + " |")
    (out_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def _write_human_baseline(out_dir: Path, engines: dict, human_dir: Path | None) -> None:
    texts = _load_human_texts(human_dir)
    if not texts:
        return
    header = ["mode", "n", "z_mean", "z_std", "z_min", "z_max", "fp_rate@4"]
    rows = []
    for mode, engine in engines.items():
        zs = [engine.detect_watermark(t)["z_score"] for t in texts]
        fp = sum(1 for z in zs if z > engine.detection_threshold) / len(zs)
        rows.append([mode, len(zs), round(statistics.mean(zs), 3),
                     round(statistics.pstdev(zs), 3), round(min(zs), 3),
                     round(max(zs), 3), round(fp, 3)])
    with open(out_dir / "human_baseline.csv", "w", encoding="utf-8-sig", newline="") as f:
        import csv
        csv.writer(f).writerows([header] + rows)
    md = ["| 模式 | 样本数 | z 均值 | z 标准差 | z 最小 | z 最大 | 误报率@z>4 |",
          "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        md.append("| " + " | ".join(map(str, r)) + " |")
    (out_dir / "human_baseline.md").write_text("\n".join(md), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="水印基准测试 (论文实验数据)")
    parser.add_argument("--samples", type=int, default=5, help="样本数 (主题数)")
    parser.add_argument("--modes", type=str, default="char_bigram,dual_anchor",
                        help="逗号分隔的 hash_mode 列表")
    parser.add_argument("--delta", type=float, default=4.0)
    parser.add_argument("--out", type=str, default="results/watermark_benchmark")
    parser.add_argument("--translate", action="store_true", help="启用机器翻译回译攻击")
    parser.add_argument("--synthetic", action="store_true", help="离线合成候选 (冒烟)")
    parser.add_argument("--human-dir", type=str, default=None, help="额外人类文本目录 (*.txt)")
    args = parser.parse_args()

    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    asyncio.run(run(Path(args.out), modes, args.samples, args.delta,
                    args.translate, args.synthetic,
                    Path(args.human_dir) if args.human_dir else None))


if __name__ == "__main__":
    main()
