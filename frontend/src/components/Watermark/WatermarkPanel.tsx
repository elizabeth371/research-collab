import { useCallback, useEffect, useState } from 'react';
import type {
  DocumentWatermarkParams,
  LLMGenerateResult,
  RobustnessResult,
  WatermarkDetectionResult,
} from '@shared/types';
import {
  detectDocumentWatermark,
  detectWatermark,
  exportEvidencePackage,
  generateWatermarkedText,
  getDocWatermarkParams,
  getWatermarkRecords,
  runRobustnessTest,
  updateDocWatermarkParams,
  type EvidenceFormat,
  type WatermarkRecordItem,
} from '../../lib/api';
import { appendAiText } from '../../lib/yjs';
import { getCollabSession } from '../../lib/collab';

/**
 * 水印检测面板
 * ------------------------------------------------------------------
 * 功能:
 *  1. 检测整个协作文档的文本是否包含 Kirchenbauer AI 水印,
 *     检测动作会写入 WatermarkRecord 与溯源链日志 (可追溯)
 *  2. AI 写作 + 水印注入演示: 真实 LLM 生成带水印文本并立即自检,
 *     可一键插入文档 (蓝色 AI 标记) —— 步骤 9/10 闭环
 *  3. 对抗鲁棒性实验: 对带水印文本施加攻击矩阵 (删除/截断/同义改写/
 *     噪声/乱序/可选回译), 展示检出衰减 —— 步骤 11 (论文实验数据)
 *  4. 文档水印参数: 每文档独立密钥 (指纹/hex) + γ/δ 滑块, 变更留痕 —— 步骤 12
 *  5. 支持粘贴任意文本进行检测
 *  6. 可视化置信度 (进度条 + 判定徽标 + z 值/绿名单占比统计量)
 *  7. 展示该文档的水印检测历史记录
 */
interface WatermarkPanelProps {
  docId: string;
  getDocText: () => string;
}

export function WatermarkPanel({ docId, getDocText }: WatermarkPanelProps) {
  const [customText, setCustomText] = useState('');
  const [result, setResult] = useState<WatermarkDetectionResult | null>(null);
  const [records, setRecords] = useState<WatermarkRecordItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- AI 写作 + 水印生成演示状态 ----
  const [genPrompt, setGenPrompt] = useState(
    '请撰写一段约 150 字的中文简介，介绍 AI 生成内容水印如何保障科研诚信与版权溯源。'
  );
  const [genResult, setGenResult] = useState<LLMGenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);

  // ---- 对抗鲁棒性实验状态 (步骤 11) ----
  const [robResult, setRobResult] = useState<RobustnessResult | null>(null);
  const [robLoading, setRobLoading] = useState(false);
  const [robError, setRobError] = useState<string | null>(null);
  const [robIncludeTranslation, setRobIncludeTranslation] = useState(false);

  // ---- 文档水印参数状态 (步骤 12) ----
  const [wmParams, setWmParams] = useState<DocumentWatermarkParams | null>(null);
  const [gammaVal, setGammaVal] = useState(0.5);
  const [deltaVal, setDeltaVal] = useState(4.0);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramsSaving, setParamsSaving] = useState(false);
  const [paramsMsg, setParamsMsg] = useState<string | null>(null);
  const [paramsErr, setParamsErr] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  // ---- 版权证据包导出状态 (步骤 13) ----
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  /** 导出版权证据包 (PDF / Markdown / JSON), 触发浏览器下载 */
  const doExport = async (fmt: EvidenceFormat) => {
    setExportMsg(null);
    setExportErr(null);
    setExporting(true);
    try {
      const { blob, filename } = await exportEvidencePackage(docId, fmt);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportMsg(`已导出 ${filename} (${(blob.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : '证据包导出失败');
    } finally {
      setExporting(false);
    }
  };

  const refreshParams = useCallback(async () => {
    if (!docId) return;
    setParamsLoading(true);
    try {
      const p = await getDocWatermarkParams(docId);
      setWmParams(p);
      setGammaVal(p.gamma);
      setDeltaVal(p.delta);
      setParamsErr(null);
    } catch {
      // 参数加载失败不阻断主流程
    } finally {
      setParamsLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    // docId 切换时先清空旧文档参数, 避免异步加载期间显示上一文档的陈旧指纹/密钥
    setWmParams(null);
    setParamsMsg(null);
    setParamsErr(null);
    setShowKey(false);
    refreshParams();
  }, [refreshParams]);

  /** 保存文档水印参数 (γ / δ), 写溯源链日志 */
  const saveParams = async () => {
    if (!wmParams) return;
    setParamsMsg(null);
    setParamsErr(null);
    setParamsSaving(true);
    try {
      const p = await updateDocWatermarkParams(docId, {
        gamma: gammaVal,
        delta: deltaVal,
      });
      setWmParams(p);
      setGammaVal(p.gamma);
      setDeltaVal(p.delta);
      setParamsMsg(
        `已保存 γ=${p.gamma.toFixed(2)} / δ=${p.delta.toFixed(1)}，变更已写入溯源链`
      );
    } catch (e) {
      setParamsErr(e instanceof Error ? e.message : '保存参数失败');
    } finally {
      setParamsSaving(false);
    }
  };

  /** 重新生成文档独立密钥 (旧密钥注入的水印将无法再检出) */
  const regenerateKey = async () => {
    if (!wmParams) return;
    setParamsMsg(null);
    setParamsErr(null);
    setParamsSaving(true);
    try {
      const p = await updateDocWatermarkParams(docId, { regenerateKey: true });
      setWmParams(p);
      setParamsMsg('已生成新独立密钥（指纹已变更），此后再注入的水印用新密钥');
    } catch (e) {
      setParamsErr(e instanceof Error ? e.message : '重新生成密钥失败');
    } finally {
      setParamsSaving(false);
    }
  };

  const refreshRecords = useCallback(async () => {
    try {
      const data = await getWatermarkRecords(docId);
      setRecords(data.records);
    } catch {
      // 历史记录加载失败不阻断主流程
    }
  }, [docId]);

  useEffect(() => {
    refreshRecords();
  }, [refreshRecords]);

  const runDetect = async (text: string, persist: boolean) => {
    if (!text.trim()) {
      setError('没有可检测的文本');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const started = performance.now();
      const r = persist
        ? await detectDocumentWatermark(docId)
        : await detectWatermark(text);
      setResult({ ...r, latencyMs: Math.round(performance.now() - started) });
      if (persist) {
        await refreshRecords();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '检测失败');
    } finally {
      setLoading(false);
    }
  };

  const confidencePct = result ? Math.round(result.confidence * 100) : 0;

  /** 真实 LLM 生成带水印文本并立即自检 (步骤 9 能力的前端入口) */
  const runGenerate = async () => {
    if (!genPrompt.trim()) {
      setGenError('请输入写作指令');
      return;
    }
    setGenError(null);
    setInserted(false);
    setGenerating(true);
    try {
      const started = performance.now();
      // 500 token (~500字): z 随 sqrt(文本长度) 增长, 提高检出余量 (z 实测 4-11)
      // 步骤 12: 传 docId 使用文档独立密钥/参数注入, 插入文档后检测口径一致
      const r = await generateWatermarkedText(genPrompt.trim(), 500, docId);
      r.detect.latencyMs = Math.round(performance.now() - started);
      setGenResult(r);
    } catch (e) {
      setGenError(
        e instanceof Error ? e.message : '生成失败（请确认后端已配置 LLM API Key）'
      );
    } finally {
      setGenerating(false);
    }
  };

  /** 将生成的带水印文本以 AI 蓝色标记插入文档末尾 (自动进入协同/溯源链) */
  const insertGenerated = () => {
    if (!genResult) return;
    const session = getCollabSession(docId);
    const ok = appendAiText(session.editor, session.ydoc, genResult.text);
    if (ok) {
      setInserted(true);
    }
  };

  /** 对抗鲁棒性实验: 对指定文本施加攻击矩阵, 度量检测衰减 (步骤 11) */
  const runRobustness = async (text: string) => {
    if (!text.trim()) {
      setRobError('没有可测试的文本');
      return;
    }
    setRobError(null);
    setRobResult(null);
    setRobLoading(true);
    try {
      // 步骤 12: 传 docId 使检测口径与文档密钥一致 (生成/插入/检测闭环)
      const r = await runRobustnessTest(text, robIncludeTranslation, docId);
      setRobResult(r);
    } catch (e) {
      setRobError(e instanceof Error ? e.message : '鲁棒性测试失败');
    } finally {
      setRobLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="panel-title text-sm">AIGC 水印检测</h3>
        <p className="text-[11px] text-slate-400 mt-0.5">
          Kirchenbauer 绿名单算法 · 判定文本是否为 AI 生成
        </p>
      </div>

      {/* 操作按钮 */}
      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={() => runDetect(getDocText(), true)}
          disabled={loading}
          className="w-full text-xs font-medium py-2 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? '检测中...' : '检测当前文档全文并留痕'}
        </button>
      </div>

      {/* 文档水印参数 (步骤 12: 每文档独立密钥) */}
      <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-700">
            🔑 文档水印参数
          </h4>
          {paramsLoading && (
            <span className="text-[10px] text-slate-400">加载中...</span>
          )}
          {wmParams && (
            <span className="text-[10px] font-mono text-slate-400">
              指纹 {wmParams.key_fingerprint}
            </span>
          )}
        </div>

        {wmParams ? (
          <div className="space-y-2">
            {/* γ 滑块 */}
            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                <span>绿名单比例 γ</span>
                <span className="font-mono font-medium text-slate-700">
                  {gammaVal.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.95}
                step={0.05}
                value={gammaVal}
                onChange={(e) => setGammaVal(Number(e.target.value))}
                className="w-full accent-slate-700"
              />
            </div>
            {/* δ 滑块 */}
            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                <span>注入强度 δ (LLM 重采样偏移)</span>
                <span className="font-mono font-medium text-slate-700">
                  {deltaVal.toFixed(1)}
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={8}
                step={0.5}
                value={deltaVal}
                onChange={(e) => setDeltaVal(Number(e.target.value))}
                className="w-full accent-slate-700"
              />
            </div>
            {/* 独立密钥 */}
            <div>
              <button
                onClick={() => setShowKey((v) => !v)}
                className="text-[10px] text-slate-500 hover:text-slate-700 underline underline-offset-2"
              >
                {showKey ? '隐藏密钥' : '显示密钥 (64 hex)'}
              </button>
              {showKey && (
                <div className="mt-1 font-mono text-[10px] text-slate-500 bg-white rounded border border-slate-200 px-2 py-1.5 break-all select-all">
                  {wmParams.secret_key_hex}
                </div>
              )}
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={() => void saveParams()}
                disabled={paramsSaving}
                className="flex-1 text-[11px] font-medium py-1.5 rounded-md bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {paramsSaving ? '保存中...' : '保存参数并留痕'}
              </button>
              <button
                onClick={() => void regenerateKey()}
                disabled={paramsSaving}
                className="flex-1 text-[11px] font-medium py-1.5 rounded-md border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                重新生成密钥
              </button>
            </div>
            <p className="text-[9px] leading-relaxed text-slate-400">
              ⚠️ 重新生成密钥后，旧密钥注入的水印将无法再检出（新注入的内容用新密钥）。参数与密钥变更均写入溯源链。
            </p>
            {paramsMsg && (
              <div className="text-[10px] text-green-600 bg-green-50 rounded px-2 py-1.5">
                ✅ {paramsMsg}
              </div>
            )}
            {paramsErr && (
              <div className="text-[10px] text-red-500 bg-red-50 rounded px-2 py-1.5">
                {paramsErr}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-slate-400">文档参数加载失败或不可用</p>
        )}
      </div>

      {/* 版权证据包导出 (步骤 13) */}
      <div className="rounded-lg border border-emerald-100 bg-emerald-50/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-emerald-800">
            📦 版权证据包导出
          </h4>
          <span className="text-[10px] text-emerald-500">PDF · Markdown · JSON</span>
        </div>
        <p className="text-[10px] text-emerald-700/70 leading-relaxed">
          将文档全文、水印参数与密钥指纹、检测历史、溯源链及哈希链校验结果打包，
          附 package_hash 完整性校验，可存档或作为版权归属审计材料提交。
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            onClick={() => void doExport('pdf')}
            disabled={exporting}
            className="text-[11px] font-medium py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            PDF
          </button>
          <button
            onClick={() => void doExport('md')}
            disabled={exporting}
            className="text-[11px] font-medium py-1.5 rounded-md border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Markdown
          </button>
          <button
            onClick={() => void doExport('json')}
            disabled={exporting}
            className="text-[11px] font-medium py-1.5 rounded-md border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            JSON
          </button>
        </div>
        {exporting && (
          <p className="text-[10px] text-emerald-600">证据包生成中...</p>
        )}
        {exportMsg && (
          <div className="text-[10px] text-green-600 bg-green-50 rounded px-2 py-1.5 break-all">
            ✅ {exportMsg}
          </div>
        )}
        {exportErr && (
          <div className="text-[10px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {exportErr}
          </div>
        )}
      </div>

      {/* AI 写作 + 水印注入演示 (步骤 10 闭环) */}
      <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-blue-800">
            ✍️ AI 写作 + 水印注入演示
          </h4>
          <span className="text-[10px] text-blue-400">真实 LLM · logprobs 重采样</span>
        </div>
        <textarea
          value={genPrompt}
          onChange={(e) => setGenPrompt(e.target.value)}
          rows={2}
          className="w-full text-xs p-2 rounded-md border border-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-300/40 resize-none bg-white"
        />
        <button
          onClick={() => void runGenerate()}
          disabled={generating || !genPrompt.trim()}
          className="w-full text-xs font-medium py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? 'DeepSeek 生成中...' : '生成带水印文本并自检'}
        </button>

        {genError && (
          <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {genError}
          </div>
        )}

        {genResult && (
          <div className="bg-white rounded-md border border-blue-100 p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                  genResult.detect.isAiGenerated
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-amber-100 text-amber-700'
                }`}
              >
                {genResult.detect.isAiGenerated
                  ? '✅ 已注入水印 (可检出)'
                  : '⚠️ 未达检出阈值 (建议加长文本)'}
              </span>
              <span className="text-[10px] text-slate-400">
                z={genResult.detect.zScore.toFixed(2)} · 文本 {genResult.chars} 字
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap break-words max-h-28 overflow-y-auto slim-scroll">
              {genResult.text}
            </p>
            <button
              onClick={insertGenerated}
              disabled={inserted}
              className="w-full text-[11px] font-medium py-1 rounded-md border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              {inserted ? '✅ 已插入文档末尾 (蓝色 AI 标记)' : '插入到文档末尾'}
            </button>
          </div>
        )}
      </div>

      {/* 对抗鲁棒性实验 (步骤 11) */}
      <div className="rounded-lg border border-amber-100 bg-amber-50/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-amber-800">
            🧪 水印对抗鲁棒性实验
          </h4>
          <span className="text-[10px] text-amber-500">攻击矩阵 · 论文实验数据</span>
        </div>
        <p className="text-[10px] text-amber-700/70 leading-relaxed">
          对带水印文本施加 6 类内容攻击（随机删除 / 截断 / 同义改写 / 噪声 /
          局部乱序 / 可选机器翻译回译），度量 z 统计量衰减与检出率，生成论文实验表。
        </p>
        <div className="grid grid-cols-1 gap-1.5">
          <button
            onClick={() => void runRobustness(getDocText())}
            disabled={robLoading}
            className="w-full text-[11px] font-medium py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {robLoading ? '攻击矩阵计算中...' : '对当前文档全文运行攻击矩阵'}
          </button>
          {genResult && (
            <button
              onClick={() => void runRobustness(genResult.text)}
              disabled={robLoading}
              className="w-full text-[11px] font-medium py-1.5 rounded-md border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              对刚生成的带水印文本运行
            </button>
          )}
          <label className="flex items-center gap-1.5 text-[10px] text-amber-700/80 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={robIncludeTranslation}
              onChange={(e) => setRobIncludeTranslation(e.target.checked)}
              className="accent-amber-600"
            />
            包含机器翻译回译攻击（真实 DeepSeek zh→en→zh，耗时较长）
          </label>
        </div>

        {robError && (
          <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {robError}
          </div>
        )}

        {robResult && (
          <div className="bg-white rounded-md border border-amber-100 p-2.5 space-y-2">
            {/* 汇总 */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] font-semibold text-slate-700">
                {robResult.baseline.is_ai_generated
                  ? '基线可检出，攻击后统计量衰减如下'
                  : '基线未检出（文本不含水印或过短），下表为各攻击后判定'}
              </span>
              <span className="text-[10px] text-slate-400">
                {robResult.text_len} 字
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <div className="bg-amber-50 rounded border border-amber-100 px-1 py-1.5">
                <div className="text-[9px] text-amber-500">检出 {robResult.summary.detected}/{robResult.summary.attacked}</div>
                <div className="text-[11px] font-semibold text-amber-800">
                  {(robResult.summary.detected_ratio * 100).toFixed(0)}%
                </div>
              </div>
              <div className="bg-amber-50 rounded border border-amber-100 px-1 py-1.5">
                <div className="text-[9px] text-amber-500">平均 z</div>
                <div className="text-[11px] font-semibold text-amber-800">
                  {robResult.summary.avg_z.toFixed(2)}
                </div>
              </div>
              <div className="bg-amber-50 rounded border border-amber-100 px-1 py-1.5">
                <div className="text-[9px] text-amber-500">最小 z</div>
                <div className="text-[11px] font-semibold text-amber-800">
                  {robResult.summary.min_z.toFixed(2)}
                </div>
              </div>
            </div>
            {robResult.translation_failed && (
              <div className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
                机器翻译回译未执行成功（未配置 API Key 或调用失败），已跳过该项。
              </div>
            )}

            {/* 攻击矩阵表 */}
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-slate-400 border-b border-slate-100">
                  <th className="text-left font-medium py-1 pr-1">攻击</th>
                  <th className="text-right font-medium py-1 px-1">保留率</th>
                  <th className="text-right font-medium py-1 px-1">z 值</th>
                  <th className="text-right font-medium py-1 px-1">绿名单</th>
                  <th className="text-right font-medium py-1 pl-1">判定</th>
                </tr>
              </thead>
              <tbody>
                {robResult.attacks.map((a) => (
                  <tr
                    key={a.name}
                    className={`border-b border-slate-50 ${
                      a.name === 'no_attack' ? 'bg-blue-50/50' : ''
                    }`}
                  >
                    <td className="text-left py-1 pr-1 text-slate-600">{a.label}</td>
                    <td className="text-right py-1 px-1 text-slate-500">
                      {a.name === 'no_attack' ? '100%' : `${(a.chars_retained * 100).toFixed(0)}%`}
                    </td>
                    <td
                      className={`text-right py-1 px-1 font-medium ${
                        a.z_score > 4 ? 'text-blue-700' : 'text-green-700'
                      }`}
                    >
                      {a.z_score.toFixed(2)}
                    </td>
                    <td className="text-right py-1 px-1 text-slate-500">
                      {Math.round(a.green_fraction * 100)}%
                    </td>
                    <td className="text-right py-1 pl-1">
                      <span
                        className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${
                          a.is_ai_generated
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-green-100 text-green-700'
                        }`}
                      >
                        {a.is_ai_generated ? 'AI' : '人类'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 自定义文本检测 */}
      <div>
        <textarea
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="或粘贴待检测文本..."
          rows={3}
          className="w-full text-xs p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
        />
        <button
          onClick={() => runDetect(customText, false)}
          disabled={loading || !customText.trim()}
          className="mt-1.5 w-full text-xs py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          检测粘贴的文本
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      {/* 检测结果 */}
      {result && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">判定结果</span>
            <span
              className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                result.isAiGenerated
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-green-100 text-green-700'
              }`}
            >
              {result.isAiGenerated ? 'AI 生成 (含水印)' : '人类创作'}
            </span>
          </div>

          {/* 置信度进度条 */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
              <span>AI 置信度</span>
              <span className="font-medium text-slate-700">{confidencePct}%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  result.isAiGenerated ? 'bg-blue-500' : 'bg-green-500'
                }`}
                style={{ width: `${Math.max(confidencePct, 2)}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-white rounded border border-slate-100 px-2 py-1.5">
              <div className="text-slate-400">z 统计量</div>
              <div className="text-slate-700 font-medium">
                {result.zScore.toFixed(2)}
                <span className="text-slate-400 font-normal"> (阈值 4.0)</span>
              </div>
            </div>
            <div className="bg-white rounded border border-slate-100 px-2 py-1.5">
              <div className="text-slate-400">绿名单命中</div>
              <div className="text-slate-700 font-medium">
                {Math.round(result.greenFraction * 100)}%
                <span className="text-slate-400 font-normal">
                  {' '}· {result.numTokensScored} 对
                </span>
              </div>
            </div>
            <div className="bg-white rounded border border-slate-100 px-2 py-1.5">
              <div className="text-slate-400">水印字符</div>
              <div className="text-slate-700 font-medium">
                {result.watermarkChars} 字符
              </div>
            </div>
            <div className="bg-white rounded border border-slate-100 px-2 py-1.5">
              <div className="text-slate-400">检测耗时</div>
              <div className="text-slate-700 font-medium">
                {result.latencyMs} ms
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 历史记录 */}
      <div>
        <h4 className="text-xs font-semibold text-slate-600 mb-1.5">
          检测历史记录 ({records.length})
        </h4>
        {records.length === 0 ? (
          <p className="text-[11px] text-slate-400">
            暂无记录 · 点击"检测当前文档全文并留痕"后自动生成
          </p>
        ) : (
          <ul className="space-y-1.5">
            {records.slice(-5).reverse().map((r) => (
              <li
                key={r.id}
                className="text-[11px] bg-slate-50 border border-slate-100 rounded px-2.5 py-1.5 flex items-center justify-between"
              >
                <span className="text-slate-600">
                  {new Date(r.created_at).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="text-slate-400">
                  {r.model_name} · γ={r.gamma}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
