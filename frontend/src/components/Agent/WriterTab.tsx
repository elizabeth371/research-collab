/**
 * 写作专家 Tab (Writer Agent 工作区)
 * ==================================================
 * 独立对话框: 接收调研助手移交的确认文献 -> Writer 生成结构化
 * Markdown 正文 -> 预览/编辑 -> 写入文档 -> 提交审核。
 * 本 Tab 按钮统一为绿色 (写作主题色)。
 */

import { markdownToHtml } from '../../lib/markdown';
import type { AgentFlowStage } from '../../lib/agentFlow';
import { AGENT_TAB_MAP, type ChatItem } from './AgentTabs';
import { TabHandoffCard, TabMessageStream } from './TabShared';
import { stageIndex } from './ResearchTab';
import type { SearchPaper } from '../../lib/api';

export interface WriterTabProps {
  thread: ChatItem[];
  stage: AgentFlowStage;
  busy: boolean;
  /** 调研助手移交的确认文献 (跨 Tab 数据流转) */
  references: SearchPaper[];
  topic: string;
  writingText: string;
  onWritingTextChange: (v: string) => void;
  writingEditMode: boolean;
  onWritingEditModeChange: (v: boolean) => void;
  docWritten: boolean;
  writtenSnapshot: string;
  writeMsg: string | null;
  error: string | null;
  onWriteToDoc: () => void;
  onSubmitReview: () => void;
}

export function WriterTab({
  thread,
  stage,
  busy,
  references,
  topic,
  writingText,
  onWritingTextChange,
  writingEditMode,
  onWritingEditModeChange,
  docWritten,
  writtenSnapshot,
  writeMsg,
  error,
  onWriteToDoc,
  onSubmitReview,
}: WriterTabProps) {
  const { theme } = AGENT_TAB_MAP.writer;
  const idx = stageIndex(stage);
  const received = references.length > 0;
  const started = idx >= stageIndex('writing');

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 交接卡片: 调研助手确认文献后自动显示「已接收 X 篇文献」 */}
      {received && (
        <TabHandoffCard cardClass={theme.card} chipClass={theme.chip}>
          <p className="text-[11px] font-medium text-slate-700">
            📥 已接收 {references.length} 篇文献
            {!started && '（待开始写作）'}
            {stage === 'writing' && '（正在用于撰写…）'}
            {idx > stageIndex('writing') && '（已完成撰写）'}
          </p>
          <ul className="mt-1 space-y-0.5 max-h-20 overflow-y-auto slim-scroll">
            {references.map((r) => (
              <li
                key={r.id}
                className="text-[10px] text-slate-500 truncate"
                title={r.title}
              >
                · {r.title}
              </li>
            ))}
          </ul>
        </TabHandoffCard>
      )}

      <TabMessageStream
        thread={thread}
        emptyHint="写作专家：等待调研助手移交确认文献。文献确认后，点击「确认文献」即在此生成结构化正文。"
        busyText={
          stage === 'writing'
            ? `正在组织文献综述…（基于 ${references.length} 篇确认文献撰写结构化正文）`
            : undefined
        }
        spinnerClass={theme.spinner}
      />

      {/* 操作区 (按钮绿色) */}
      <div className="border-t border-slate-200 px-3 pt-2.5 pb-3 space-y-2">
        {error && (
          <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {/* 尚未收到文献: 引导先去调研助手 */}
        {!received && idx < stageIndex('writing') && (
          <p className="text-[11px] text-slate-400 leading-relaxed">
            还没有收到文献。请先切换到「📚 调研助手」完成检索并确认文献，
            确认后本 Tab 顶部会出现交接卡片，即可开始写作。
          </p>
        )}

        {/* 写作失败回退到 SEARCH_DONE: 引导重新确认重试 */}
        {received && stage === 'search_done' && (
          <p className="text-[10px] text-amber-600 leading-relaxed">
            上一次写作未完成或已回退：请返回「📚 调研助手」重新点击
            「确认文献 → 移交写作专家」重试。
          </p>
        )}

        {/* WRITE_DONE: Markdown 预览/编辑双模式 + 写入文档 + 提交审核 */}
        {stage === 'write_done' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-600">
                ✍️ 生成正文 · {writingText.length} 字
                {topic ? ` · 主题「${topic}」` : ''}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onWritingEditModeChange(false)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    !writingEditMode
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  预览
                </button>
                <button
                  onClick={() => onWritingEditModeChange(true)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    writingEditMode
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  编辑
                </button>
              </div>
            </div>

            {writingEditMode ? (
              <textarea
                value={writingText}
                onChange={(e) => onWritingTextChange(e.target.value)}
                rows={10}
                placeholder="Markdown 正文（# 标题 / ## 参考文献 / ## 正文）…"
                className="w-full text-[11px] font-mono leading-relaxed p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 resize-y slim-scroll"
              />
            ) : (
              <div
                className="agent-md max-h-64 overflow-y-auto slim-scroll rounded-md border border-slate-200 bg-white p-2.5"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(writingText) }}
              />
            )}

            {docWritten && writtenSnapshot !== writingText && (
              <p className="text-[10px] text-amber-600">
                写入后又编辑了正文：再次点击「写入文档」会把更新版本追加到文档末尾。
              </p>
            )}
            {writeMsg && <p className="text-[10px] text-slate-500">{writeMsg}</p>}

            <div className="flex gap-1.5">
              <button
                onClick={onWriteToDoc}
                disabled={busy || !writingText.trim()}
                className={`flex-1 text-[11px] font-medium px-2 py-2 rounded-lg transition-colors ${theme.btnOutline}`}
              >
                📄 写入文档（AI 蓝色标记）
              </button>
              <button
                onClick={onSubmitReview}
                disabled={busy}
                className={`flex-1 text-[11px] font-medium px-2 py-2 rounded-lg transition-colors ${theme.btn}`}
              >
                提交审核 → 移交审核导师
              </button>
            </div>
          </div>
        )}

        {/* 已提交审核之后: 只读提示 */}
        {idx > stageIndex('write_done') && (
          <p className="text-[10px] text-slate-400 leading-relaxed">
            正文已提交审核。审核意见与 AIGC 检测结果请在「🎓 审核导师」查看；
            如需重新写作，可在流程完成后点击「开始新一轮流程」。
          </p>
        )}
      </div>
    </div>
  );
}
