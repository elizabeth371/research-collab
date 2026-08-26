#!/usr/bin/env bash
# =============================================================================
# 智溯 · 一键演示脚本 (版权溯源全流程走查)
# =============================================================================
# 用法:
#   bash scripts/demo.sh [BASE_URL]
#     BASE_URL 默认 http://localhost:8000 (本地后端) 或 http://localhost (经 Nginx)
#
# 演示内容 (全部只读 + 一次检测留痕, 不创建文档):
#   1. 健康检查
#   2. 文档列表
#   3. 水印检测: 测试样例文档 (应判 AI 生成, z>4)
#   4. 水印检测: 演示文档     (应判人类创作)
#   5. 每文档水印参数与密钥指纹
#   6. 溯源哈希链完整性校验 (valid=true)
#   7. 对抗鲁棒性攻击矩阵 (6 类攻击, z 衰减)
#   8. 版权证据包导出 (PDF/Markdown/JSON + package_hash 校验)
#
# 注: 文件读写一律走 bash 重定向/stdin, 兼容 Git Bash (Windows) 路径。
# =============================================================================

set -u
BASE="${1:-http://localhost:8000}"
OUT="$(pwd)/demo-output"
mkdir -p "$OUT"

DEMO_ID="00000000-0000-4000-8000-0000000000a1"
SAMPLE_ID="ddaf2f58-a9a2-45ca-83ce-3d7718d4a0c7"

PASS=0
FAIL=0

step() { echo; echo "════════ $1 ════════"; }
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# python 以 UTF-8 读 stdin (兼容 Windows 默认 GBK 控制台)
PY_READ='import json,sys; sys.stdout.reconfigure(encoding="utf-8"); d=json.loads(sys.stdin.buffer.read().decode("utf-8"))'

step "1. 健康检查"
if curl -s --max-time 5 "$BASE/api/health" | grep -q '"ok"\|"status"'; then
  ok "后端在线: $BASE"
else
  bad "后端不可达: $BASE (请先启动后端或 docker compose up)"
  echo "  无法继续演示, 退出。"
  exit 1
fi

step "2. 文档列表"
DOCS="$(curl -s "$BASE/api/documents")"
echo "$DOCS" | python -c "
import json, sys
d = json.loads(sys.stdin.buffer.read().decode('utf-8'))
docs = d if isinstance(d, list) else d.get('items', d.get('documents', []))
for x in docs:
    print(f'  - {x[\"id\"]}  {x[\"title\"]}')
"
echo "$DOCS" | grep -q "$SAMPLE_ID" && ok "测试样例文档存在" || bad "测试样例文档缺失"

step "3. 水印检测: 测试样例文档 (含水印, 应判 AI)"
R3="$(curl -s -X POST "$BASE/api/watermark/documents/$SAMPLE_ID/detect")"
echo "$R3" | python -c "
$PY_READ
print(f'  AI生成: {d[\"is_ai_generated\"]} | z={d[\"z_score\"]:.2f} (阈值4.0) | 置信度={d[\"confidence\"]:.2f} | 模型: {d[\"model_name\"]}')
"
echo "$R3" | grep -q '"is_ai_generated":true' && ok "含水印文档检出 AI" || bad "含水印文档未被检出"

step "4. 水印检测: 演示文档 (纯文本, 应判人类)"
R4="$(curl -s -X POST "$BASE/api/watermark/documents/$DEMO_ID/detect")"
echo "$R4" | python -c "
$PY_READ
print(f'  AI生成: {d[\"is_ai_generated\"]} | z={d[\"z_score\"]:.2f}')
"
echo "$R4" | grep -q '"is_ai_generated":false' && ok "纯文本文档不误判" || bad "纯文本文档误判"

step "5. 每文档水印参数与密钥指纹"
R5="$(curl -s "$BASE/api/watermark/documents/$SAMPLE_ID/params")"
echo "$R5" | python -c "
$PY_READ
print(f'  γ={d[\"gamma\"]}  δ={d[\"delta\"]}  密钥指纹: {d[\"key_fingerprint\"]}')
"
echo "$R5" | grep -q '"key_fingerprint"' && ok "参数与密钥指纹可查" || bad "参数查询失败"

step "6. 溯源哈希链完整性校验"
R6="$(curl -s "$BASE/api/watermark/documents/$DEMO_ID/provenance/verify")"
echo "  $R6"
echo "$R6" | grep -q '"valid":true' && ok "演示文档溯源链完整 (哈希链未断裂)" || bad "溯源链校验失败"

step "7. 对抗鲁棒性攻击矩阵 (测试样例全文, 6 类攻击)"
DOCJSON="$(curl -s "$BASE/api/documents/$SAMPLE_ID")"
R7="$(printf '%s' "$DOCJSON" | python -c "
import json, sys
doc = json.loads(sys.stdin.buffer.read().decode('utf-8'))
sys.stdout.buffer.write(json.dumps(
    {'text': doc.get('content', ''), 'include_translation': False},
    ensure_ascii=False,
).encode('utf-8'))
" | curl -s -X POST "$BASE/api/watermark/robustness" -H "Content-Type: application/json" --data-binary @-)"
printf '%s' "$R7" > "$OUT/robust_result.json"
echo "$R7" | python -c "
$PY_READ
print(f'  基线 z={d[\"baseline\"][\"z_score\"]:.2f}  检出率 {d[\"summary\"][\"detected\"]}/{d[\"summary\"][\"attacked\"]}  平均 z={d[\"summary\"][\"avg_z\"]:.2f}  最小 z={d[\"summary\"][\"min_z\"]:.2f}')
for a in d['attacks']:
    print(f'    - {a[\"label\"]:<14} 保留 {a[\"chars_retained\"]*100:5.1f}%  z={a[\"z_score\"]:6.2f}  判定 {\"AI\" if a[\"is_ai_generated\"] else \"人类\"}')
"
echo "$R7" | grep -q '"attacks"' && ok "攻击矩阵返回 (详情见 demo-output/robust_result.json)" || bad "攻击矩阵失败"

step "8. 版权证据包导出 (PDF / Markdown / JSON)"
for fmt in pdf md json; do
  curl -s "$BASE/api/watermark/documents/$DEMO_ID/evidence?format=$fmt" > "$OUT/evidence.$fmt"
done
PDF_HEAD="$(head -c 4 "$OUT/evidence.pdf")"
echo "  PDF:  $(wc -c < "$OUT/evidence.pdf") bytes, 文件头 $PDF_HEAD"
[ "$PDF_HEAD" = "%PDF" ] && ok "PDF 证据包合法" || bad "PDF 文件头异常"
grep -q "版权证据包" "$OUT/evidence.md" && ok "Markdown 证据包含关键章节" || bad "Markdown 证据包内容异常"
cat "$OUT/evidence.json" | python -c "
import json, sys, hashlib
d = json.loads(sys.stdin.buffer.read().decode('utf-8'))
core = {k: v for k, v in d.items() if k != 'package_hash'}
canon = json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
print(f'  JSON: 链校验={d[\"provenance\"][\"chain_valid\"][\"valid\"]}  package_hash={d[\"package_hash\"][:16]}...')
assert hashlib.sha256(canon.encode('utf-8')).hexdigest() == d['package_hash'], 'package_hash 不一致'
print('  ✅ package_hash 离线重算一致')
" && ok "JSON 证据包结构完整且哈希可校验" || bad "JSON 证据包校验失败"

echo
echo "════════ 演示汇总: ✅ $PASS 项通过 / ❌ $FAIL 项失败 ════════"
echo "证据包输出目录: $OUT/ (evidence.pdf / evidence.md / evidence.json / robust_result.json)"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
