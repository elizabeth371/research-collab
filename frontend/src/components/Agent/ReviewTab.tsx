/**
 * 审核导师 Tab (审核 Agent 工作区)
 * ==================================================
 * 独立对话框: 接收写作专家移交的稿件 -> 红牌/黄牌审稿意见 ->
 * 确认并执行 AIGC 水印检测 (最终步骤) -> 最终报告。
 * 本 Tab 按钮统一为橙色 (审核主题色)。
 */

import type {
  ReviewResult,
  RewriteResult,
  WatermarkDetectionResult,
} from '@shared/types';
import type { AgentFlowStage } from '../../lib/agentFlow';
import { AGENT_TAB_MAP, type ChatItem } from './AgentTabs';
import { TabHandoffCard, TabMessageStream } from './TabShared';
import { stageIndex } from './ResearchTab';

export interface ReviewTabProps {
  thread: ChatItem[];
  stage: AgentFlowStage;
  busy: boolean;
  /** 待审核稿件标题 (正文一级标题, 跨 Tab 交接展示) */
  manuscriptTitle: string;
  review: ReviewResult | null;
  reviewMsg: string | null;
  rewriting: boolean;
  rewriteResult: RewriteResult | null;
  polishingPara: number | null;
  detection: WatermarkDetectionResult | null;
  error: string | null;
  /** write_done 阶段在本 Tab 直接提交审核 */
  onSubmitReview: () => void;
  onResubmit: () => void;
  onConfirmDetect: () => void;
  onPolishParagraph: (paraIndex: number) => void;
  onRewrite: () => void;
  /** 收起重写结果卡片 (不清空流程) */
  onDismissRewrite: () => void;
  onApplyRewrite: () => void;
  onReset: () => void;
}

export function ReviewTab({
  thread,
  stage,
  busy,
  manuscriptTitle,
  review,
  reviewMsg,
  rewriting,
  rewriteResult,
  polishingPara,
  detection,
  error,
  onSubmitReview,
  onResubmit,
  onConfirmDetect,
  onPolishParagraph,
  onRewrite,
  onDismissRewrite,
  onApplyRewrite,
  onReset,
}: ReviewTabProps) {
  const { theme } = AGENT_TAB_MAP.review;
  const idx = stageIndex(stage);
  const hasManuscript = idx >= stageIndex('write_done');

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 交接卡片: 写作完成并提交审核后显示「待审核稿件」 */}
      {hasManuscript && (
        <TabHandoffCard cardClass={theme.card} chipClass={theme.chip}>
          <p className="text-[11px] font-medium text-slate-700">
            📄{' '}
            {stage === 'write_done'
              ? '待审核稿件'
              : stage === 'reviewing'
                ? '正在审核稿件'
                : '已审核稿件'}
            ：《{manuscriptTitle}》
          </p>
          {stage === 'write_done' && (
            <p className="text-[10px] text-slate-500 mt-0.5">
              由「写作专家」移交。点击下方「提交审核」开始红牌/黄牌检查。
            </p>
          )}
        </TabHandoffCard>
      )}

      <TabMessageStream
        thread={thread}
        emptyHint="审核导师：稿件提交审核后，这里显示红牌/黄牌意见与最终 AIGC 水印检测结果。"
        busyText={
          stage === 'reviewing'
            ? '审核 Agent 正在检查正文规范（红牌/黄牌）…'
            : stage === 'checking'
              ? '正在执行 AIGC 水印检测（最终步骤）…'
              : undefined
        }
        spinnerClass={theme.spinner}
      />

      {/* 审稿结果 (红牌卡片 + 润色该段 + 自动重写) */}
      {review && (
        <div className="border-t border-slate-200 px-3 py-2.5 bg-slate-50/50">
          {review.redCards > 0 ? (
            <div className="review-banner review-banner-red" role="alert">
              🟥 审稿人红牌警告 · {review.redCards} 项严重问题，请优先修改
            </div>
          ) : review.yellowCards > 0 ? (
            <div className="review-banner review-banner-amber">
              ⚠️ 无红牌问题 · {review.yellowCards} 条黄牌建议
            </div>
          ) : (
            <div className="review-banner review-banner-green">
              ✅ 审稿通过：格式规范，无红牌无黄牌
            </div>
          )}

          {review.redCards > 0 && !rewriteResult && (
            <button
              onClick={onRewrite}
              disabled={rewriting}
              className="mt-2 w-full text-[11px] font-medium px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {rewriting ? '🔄 重写中，请稍候...' : '🔄 自动重写（一键修复全部红牌）'}
            </button>
          )}

          <div className="mt-2 space-y-2 max-h-48 overflow-y-auto slim-scroll">
            {review.issues.map((issue, i) => (
              <div key={i} className={`review-card review-card-${issue.level}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`review-tag review-tag-${issue.level}`}>
                    {issue.level === 'error'
                      ? '红牌'
                      : issue.level === 'warning'
                        ? '黄牌'
                        : '提示'}
                  </span>
                  {issue.paraIndex != null && (
                    <span className="text-[10px] text-slate-400">
                      第 {issue.paraIndex} 段
                    </span>
                  )}
                </div>
                <p className="review-card-msg">{issue.message}</p>
                {issue.paraIndex != null && (
                  <button
                    onClick={() => onPolishParagraph(issue.paraIndex!)}
                    disabled={polishingPara !== null}
                    className="review-polish-btn"
                  >
                    {polishingPara === issue.paraIndex ? '润色中...' : '润色该段'}
                  </button>
                )}
              </div>
            ))}
          </div>

          {reviewMsg && (
            <div className="mt-2 text-[11px] text-slate-500">{reviewMsg}</div>
          )}

          {/* 重写结果: 变更前后对比 + 新版预览 + 应用到文档 */}
          {rewriteResult && (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-white">
              <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-slate-100">
                <span className="text-[11px] font-medium text-emerald-700">
                  📝 重写版本 · 红牌 {rewriteResult.redCardsBefore} →{' '}
                  {rewriteResult.redCardsAfter} 项
                  {rewriteResult.passedAfter ? ' ✅' : ' ⚠️'}
                </span>
                <button
                  onClick={onDismissRewrite}
                  className="text-[10px] text-slate-400 hover:text-slate-600"
                >
                  收起
                </button>
              </div>

              {rewriteResult.changes.length > 0 && (
                <ul className="px-2.5 py-1.5 space-y-1 max-h-24 overflow-y-auto slim-scroll">
                  {rewriteResult.changes.map((c, i) => (
                    <li key={i} className="text-[10px] leading-relaxed text-slate-600">
                      <span className="text-slate-400 line-through">{c.before}</span>
                      <span className="mx-1 text-emerald-600">→</span>
                      <span className="text-emerald-700">{c.after}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="px-2.5 py-1.5 border-t border-slate-100">
                <div className="text-[10px] text-slate-400 mb-1">新版预览</div>
                <div className="max-h-32 overflow-y-auto slim-scroll rounded bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600 whitespace-pre-wrap break-words">
                  {rewriteResult.rewritten}
                </div>
                <button
                  onClick={onApplyRewrite}
                  className="mt-2 w-full text-[11px] font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                >
                  ✓ 应用到文档（AI 蓝色标记）
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 操作区 (按钮橙色) */}
      <div className="border-t border-slate-200 px-3 pt-2.5 pb-3 space-y-2">
        {error && (
          <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {/* 尚无稿件: 引导 */}
        {!hasManuscript && (
          <p className="text-[11px] text-slate-400 leading-relaxed">
            还没有收到稿件。请先在「📚 调研助手」检索确认文献、在「✍️ 写作专家」
            生成正文并点击「提交审核」，稿件会移交到这里。
          </p>
        )}

        {/* WRITE_DONE: 稿件待审核 -> 提交审核 */}
        {stage === 'write_done' && (
          <button
            onClick={onSubmitReview}
            disabled={busy}
            className={`w-full text-[11px] font-medium px-3 py-2 rounded-lg transition-colors ${theme.btn}`}
          >
            提交审核（审核 Agent）
          </button>
        )}

        {/* REVIEW_DONE: 确认并检测 / 重新提交审核 */}
        {stage === 'review_done' && (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              🎓 审核意见见上方卡片。
              {review && !review.passed
                ? '存在红牌问题：可修改正文后点击「重新提交审核」，或直接执行最终 AIGC 检测。'
                : '点击下方按钮执行 AIGC 水印检测作为最终步骤。'}
            </p>
            {review && !review.passed && (
              <button
                onClick={onResubmit}
                disabled={busy}
                className="w-full text-[11px] font-medium px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                重新提交审核
              </button>
            )}
            <button
              onClick={onConfirmDetect}
              disabled={busy}
              className={`w-full text-[11px] font-medium px-3 py-2 rounded-lg transition-colors ${theme.btn}`}
            >
              确认并检测（AIGC 水印检测）
            </button>
          </div>
        )}

        {/* DONE: 最终检测报告 + 新一轮 */}
        {stage === 'done' && (
          <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5">
            {detection ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-emerald-800">
                    ✅ 流程完成 · 最终报告
                  </span>
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      detection.isAiGenerated
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {detection.isAiGenerated ? 'AI 生成 · 含水印' : '人类创作'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                  <div className="bg-white rounded border border-emerald-100 px-1 py-1">
                    <div className="text-slate-400">z 统计量</div>
                    <div className="font-mono font-semibold text-slate-700">
                      {detection.zScore.toFixed(2)}
                    </div>
                  </div>
                  <div className="bg-white rounded border border-emerald-100 px-1 py-1">
                    <div className="text-slate-400">AI 置信度</div>
                    <div className="font-mono font-semibold text-slate-700">
                      {Math.round(detection.confidence * 100)}%
                    </div>
                  </div>
                  <div className="bg-white rounded border border-emerald-100 px-1 py-1">
                    <div className="text-slate-400">绿名单命中</div>
                    <div className="font-mono font-semibold text-slate-700">
                      {Math.round(detection.greenFraction * 100)}%
                    </div>
                  </div>
                </div>
                <p className="text-[10px] text-emerald-700/70">
                  检测结果已留痕至溯源链与检测历史，可在右侧面板复核。
                </p>
              </>
            ) : (
              <p className="text-[11px] text-amber-600">
                ⚠️ 检测步骤未产生可用结果，请开始新一轮流程重试。
              </p>
            )}
            <button
              onClick={onReset}
              className="w-full text-[11px] font-medium px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 transition-colors"
            >
              开始新一轮流程
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
