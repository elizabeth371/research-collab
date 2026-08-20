# 第三方开源代码声明 (THIRD-PARTY NOTICES)

本项目在科研核心模块中依据以下开源项目的算法实现进行升级与适配。
所有被引用/参考的代码均遵守其原始许可证要求（保留版权声明与许可文本）。

---

## 1. lm-watermarking（A Watermark for Large Language Models）

- **项目**: [github.com/jwkirchenbauer/lm-watermarking](https://github.com/jwkirchenbauer/lm-watermarking)
- **论文**: Kirchenbauer J, Geiping J, Wen Y, et al. *A Watermark for Large Language Models*[J]. ICML 2023. [arXiv:2301.10226](https://arxiv.org/abs/2301.10226)
- **许可证**: Apache License 2.0
- **版权声明**: Copyright 2023 Authors of "A Watermark for Large Language Models"
- **使用方式**: 本项目的 `backend/services/watermark_engine.py` 按论文方法重新实现，
  算法结构（绿名单生成 `_seed_rng`/`_get_greenlist_ids`、检测统计
  `_compute_z_score`/`_compute_p_value`、unique-bigram 去重检测）与该官方
  实现一致。许可证全文见 `THIRD_PARTY/LICENSE-lm-watermarking.txt`。

---

## 2. MarkLLM（Open-Source LLM Watermarking Toolkit）

- **项目**: [github.com/THU-BPM/MarkLLM](https://github.com/THU-BPM/MarkLLM)
- **论文**: Panerati L, et al. *MarkLLM: An Open-Source Toolkit for LLM
  Watermarking*[C]. EMNLP 2024 Demo. [arXiv:2405.10051](https://arxiv.org/abs/2405.10051)
- **许可证**: Apache License 2.0
- **使用方式**: 作为后续扩展的算法来源参考（KGW 家族多方案、鲁棒性评估工具），
  当前版本未直接引入其代码；若后续集成，将同步在本声明中补充许可文本。

---

## 3. arXiv API（文献实时检索）

- **服务**: [export.arxiv.org/api/query](https://export.arxiv.org/api/query)
- **许可证**: arXiv API 为公开开放接口（arXiv Terms of Use），
  本项目仅作为检索数据源调用，不复制其代码。

---

## 许可证合规说明

1. 所有 Apache-2.0 许可代码的版权声明均已保留（见各文件头）。
2. 项目根目录 `THIRD_PARTY/` 保存被引用项目的许可证全文。
3. 若需对项目进行闭源商用分发，Apache-2.0 允许，但必须保留本声明与
   THIRD_PARTY 目录内容。
