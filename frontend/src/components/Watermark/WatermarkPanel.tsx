import { memo, useCallback, useEffect, useState } from 'react';
import type { DocumentWatermarkParams, RobustnessResult } from '@shared/types';
import {
  exportEvidencePackage,
  getDocWatermarkParams,
  getWatermarkRecords,
  runRobustnessTest,
  updateDocWatermarkParams,
  type EvidenceFormat,
  type WatermarkRecordItem,
} from '../../lib/api';

/**
 * 水印检测结果与工具面板
 * ------------------------------------------------------------------
 * 说明: 水印检测已不再作为独立功能入口提供手动按钮, 而是由 Agent 审稿
 * 「审核通过」后自动触发 (见 AgentPanel.handleReview 的最终步骤), 结果
 * 持久化 WatermarkRecord + 溯源链日志。本面板负责展示与配套:
 *  1. 文档水印参数: 每文档独立密钥 (指纹/hex) + γ/δ 滑块, 变更留痕 —— 步骤 12
 *  2. 版权证据包导出: PDF / Markdown / JSON (含 package_hash) —— 步骤 13
 *  3. 对抗鲁棒性实验: 对带水印文本施加攻击矩阵 (删除/截断/同义改写/
 *     噪声/乱序/可选回译), 展示检出衰减 —— 步骤 11 (论文实验数据)
 *  4. 展示该文档的自动水印检测历史记录 (每条对应一次审核通过后的检测)
 */
interface WatermarkPanelProps {
  docId: string;
  getDocText: () => string;
  /** 文档导出策略为 deny 时禁用证据包导出 (后端同样 403 拦截) */
  exportDenied?: boolean;
}

// memo: props (docId/getDocText/exportDenied) 在无关 App 状态变化时不变
export const WatermarkPanel = memo(function WatermarkPanel({
  docId,
  getDocText,
  exportDenied = false,
}: WatermarkPanelProps) {
  const [records, setRecords] = useState<WatermarkRecordItem[]>([]);

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

  /**
   * 刷新文档水印参数。
   * isCancelled: 文档切换/组件卸载时置真, 丢弃过期响应,
   * 防止旧文档的异步响应覆盖新文档的指纹/参数 (竞态守卫)。
   */
  const refreshParams = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!docId) return;
      setParamsLoading(true);
      try {
        const p = await getDocWatermarkParams(docId);
        if (isCancelled()) return;
        setWmParams(p);
        setGammaVal(p.gamma);
        setDeltaVal(p.delta);
        setParamsErr(null);
      } catch {
        // 参数加载失败不阻断主流程
      } finally {
        if (!isCancelled()) setParamsLoading(false);
      }
    },
    [docId]
  );

  useEffect(() => {
    // docId 切换时先清空旧文档参数, 避免异步加载期间显示上一文档的陈旧指纹/密钥
    let cancelled = false;
    setWmParams(null);
    setParamsMsg(null);
    setParamsErr(null);
    setShowKey(false);
    refreshParams(() => cancelled);
    return () => {
      cancelled = true;
    };
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

  /** 刷新检测历史记录 (支持取消守卫, 见 refreshParams) */
  const refreshRecords = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      try {
        const data = await getWatermarkRecords(docId);
        if (isCancelled()) return;
        setRecords(data.records);
      } catch {
        // 历史记录加载失败不阻断主流程
      }
    },
    [docId]
  );

  useEffect(() => {
    let cancelled = false;
    setRecords([]);
    refreshRecords(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshRecords]);

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
          审核通过后自动检测 · 本区为参数 / 证据 / 实验工具与历史记录
        </p>
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
        {exportDenied && (
          <p className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
            🔒 文档已设置禁止导出（权限管理），证据包导出已禁用。
          </p>
        )}
        <div className="grid grid-cols-3 gap-1.5">
          <button
            onClick={() => void doExport('pdf')}
            disabled={exporting || exportDenied}
            className="text-[11px] font-medium py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            PDF
          </button>
          <button
            onClick={() => void doExport('md')}
            disabled={exporting || exportDenied}
            className="text-[11px] font-medium py-1.5 rounded-md border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Markdown
          </button>
          <button
            onClick={() => void doExport('json')}
            disabled={exporting || exportDenied}
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

      {/* 自动检测历史记录 */}
      <div>
        <h4 className="text-xs font-semibold text-slate-600 mb-1.5">
          检测历史记录 ({records.length})
        </h4>
        {records.length === 0 ? (
          <p className="text-[11px] text-slate-400">
            暂无记录 · 审稿通过后将自动触发检测并留痕
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
});
