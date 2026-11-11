/**
 * 稿件体检向导 (上传文档后触发)
 * ==================================================
 * 两个独立步骤, 每步由用户显式确认:
 *   ① 全文逐段润色 —— 预览 -> 应用 (写回文档) 或跳过
 *   ② 水印鉴定 —— 对当前正文检测 AIGC 水印, 输出 z 值/绿名单命中/判定
 *
 * 顺序说明: 润色会改写字符, 若先注水印再润色会破坏水印统计;
 * 因此体检顺序固定为「润色 -> 鉴定」。
 */

import { useEffect, useState } from 'react';
import type { WatermarkDetectionResult } from '@shared/types';
import {
  detectDocumentWatermark,
  polishDocument,
  updateDocument,
  type AuditPolishResult,
} from '../../lib/api';

interface ManuscriptAuditModalProps {
  docId: string;
  title: string;
  /** 初始文本 (上传时直接传入; 缺省由后端读取文档内容) */
  initialText?: string;
  /** 操作者 (写入溯源链) */
  operatorId?: string;
  open: boolean;
  onClose: () => void;
  /** 润色已应用: 通知 App 刷新文档并重载编辑器 */
  onApplied: () => void;
}

export function ManuscriptAuditModal({
  docId,
  title,
  initialText,
  operatorId,
  open,
  onClose,
  onApplied,
}: ManuscriptAuditModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [polishing, setPolishing] = useState(false);
  const [polished, setPolished] = useState<AuditPolishResult | null>(null);
  const [polishErr, setPolishErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<WatermarkDetectionResult | null>(
    null
  );
  const [detectErr, setDetectErr] = useState<string | null>(null);

  // 打开新文档时重置向导状态
  useEffect(() => {
    if (open) {
      setStep(1);
      setPolishing(false);
      setPolished(null);
      setPolishErr(null);
      setApplying(false);
      setApplied(false);
      setDetecting(false);
      setDetection(null);
      setDetectErr(null);
    }
  }, [open, docId]);

  if (!open) return null;

  const runPolish = async () => {
    if (polishing) return;
    setPolishing(true);
    setPolishErr(null);
    try {
      const res = await polishDocument(docId, initialText);
      setPolished(res);
    } catch (e) {
      setPolishErr(e instanceof Error ? e.message : '润色失败，请稍后重试');
    } finally {
      setPolishing(false);
    }
  };

  const applyPolish = async () => {
    if (!polished || applying) return;
    setApplying(true);
    try {
      await updateDocument(docId, {
        content: polished.polished,
        ...(operatorId ? { operatorId } : {}),
      });
      setApplied(true);
      onApplied();
      setStep(2);
    } catch (e) {
      setPolishErr(e instanceof Error ? e.message : '应用失败，请稍后重试');
    } finally {
      setApplying(false);
    }
  };

  const runDetect = async () => {
    if (detecting) return;
    setDetecting(true);
    setDetectErr(null);
    try {
      const text = applied && polished ? polished.polished : initialText;
      const det = await detectDocumentWatermark(docId, text);
      setDetection(det);
    } catch (e) {
      setDetectErr(e instanceof Error ? e.message : '水印鉴定失败');
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-white rounded-xl shadow-2xl border border-slate-200">
        {/* 头部 */}
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="panel-title text-base">🔍 稿件体检 · 《{title}》</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              ① 全文润色 → ② 水印鉴定 · 每步由你确认
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-sm"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* 步骤指示 */}
        <div className="flex border-b border-slate-100 text-[11px]">
          <button
            onClick={() => setStep(1)}
            className={`flex-1 py-2 font-medium transition-colors ${
              step === 1
                ? 'text-emerald-600 border-b-2 border-emerald-500 bg-emerald-50/50'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            ① 全文润色
          </button>
          <button
            onClick={() => setStep(2)}
            className={`flex-1 py-2 font-medium transition-colors ${
              step === 2
                ? 'text-orange-600 border-b-2 border-orange-500 bg-orange-50/50'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            ② 水印鉴定
          </button>
        </div>

        <div className="flex-1 overflow-y-auto slim-scroll px-5 py-4 space-y-3">
          {step === 1 && (
            <>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                对全文逐段做学术化润色：保留标题层级与 [n] 文献编号，清理口语化
                与冗余表达。润色结果先预览，你确认后才会写回文档。
              </p>
              {!polished && (
                <button
                  onClick={() => void runPolish()}
                  disabled={polishing}
                  className="w-full text-xs font-medium px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  {polishing ? '正在逐段润色（约 30-60 秒）…' : '开始全文润色'}
                </button>
              )}
              {polishErr && (
                <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
                  {polishErr}
                </div>
              )}
              {polished && (
                <>
                  <div className="flex items-center gap-3 text-[10px] text-slate-500">
                    <span className="px-2 py-0.5 rounded-full bg-slate-100">
                      引擎：{polished.stats.engine === 'llm' ? 'LLM' : '规则'}
                    </span>
                    <span>
                      {polished.stats.charsBefore} 字 → {polished.stats.charsAfter} 字
                    </span>
                    <span>{polished.stats.paragraphs} 段</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto slim-scroll rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap break-words">
                    {polished.polished}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void applyPolish()}
                      disabled={applying}
                      className="flex-1 text-xs font-medium px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                    >
                      {applying ? '应用中…' : '应用润色到文档'}
                    </button>
                    <button
                      onClick={() => setStep(2)}
                      className="flex-1 text-xs font-medium px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      跳过润色，直接鉴定
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                对当前{applied ? '已润色' : ''}正文执行 AIGC 水印检测：
                统计绿名单命中推断文本是否由带水印的模型生成，结果会写入溯源链。
              </p>
              {!detection && (
                <button
                  onClick={() => void runDetect()}
                  disabled={detecting}
                  className="w-full text-xs font-medium px-3 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
                >
                  {detecting ? '正在鉴定…' : '开始水印鉴定'}
                </button>
              )}
              {detectErr && (
                <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
                  {detectErr}
                </div>
              )}
              {detection && (
                <div className="rounded-lg border border-orange-200 bg-orange-50/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700">
                      {detection.isAiGenerated
                        ? '判定：AI 生成 · 含水印'
                        : '判定：未检出 AI 水印'}
                    </span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        detection.isAiGenerated
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-green-100 text-green-700'
                      }`}
                    >
                      z = {detection.zScore.toFixed(2)}（阈值 4.0）
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
                    <div className="bg-white rounded border border-orange-100 px-1 py-1.5">
                      <div className="text-slate-400">绿名单命中</div>
                      <div className="font-mono font-semibold text-slate-700">
                        {Math.round(detection.greenFraction * 100)}%
                      </div>
                    </div>
                    <div className="bg-white rounded border border-orange-100 px-1 py-1.5">
                      <div className="text-slate-400">AI 置信度</div>
                      <div className="font-mono font-semibold text-slate-700">
                        {Math.round(detection.confidence * 100)}%
                      </div>
                    </div>
                    <div className="bg-white rounded border border-orange-100 px-1 py-1.5">
                      <div className="text-slate-400">评分字符对</div>
                      <div className="font-mono font-semibold text-slate-700">
                        {detection.numTokensScored}
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    检测记录已写入溯源链与检测历史，可在右侧「水印检测」面板复核。
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 text-xs font-medium px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  返回润色
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 text-xs font-medium px-3 py-2 rounded-lg bg-ink text-white hover:bg-ink-hover transition-colors"
                >
                  完成
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
