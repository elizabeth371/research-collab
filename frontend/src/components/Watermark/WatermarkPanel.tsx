import { useCallback, useEffect, useState } from 'react';
import type { WatermarkDetectionResult } from '@shared/types';
import {
  detectDocumentWatermark,
  detectWatermark,
  getWatermarkRecords,
  type WatermarkRecordItem,
} from '../../lib/api';

/**
 * 水印检测面板
 * ------------------------------------------------------------------
 * 功能:
 *  1. 检测整个协作文档的文本是否包含 Kirchenbauer AI 水印,
 *     检测动作会写入 WatermarkRecord 与溯源链日志 (可追溯)
 *  2. 支持粘贴任意文本进行检测
 *  3. 可视化置信度 (进度条 + 判定徽标)
 *  4. 展示该文档的水印检测历史记录
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
              <div className="text-slate-400">绿名单命中</div>
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
