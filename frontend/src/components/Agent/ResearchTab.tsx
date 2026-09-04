/**
 * 调研助手 Tab (搜索 Agent 工作区)
 * ==================================================
 * 独立对话框: 检索主题输入 -> 联网搜索 -> 文献勾选 -> 确认文献。
 * 本 Tab 按钮统一为蓝色 (搜索主题色)。
 * 流程动作仍由容器 (AgentPanel) 的 handler 驱动, 共享全局状态机。
 */

import type { AgentFlowStage } from '../../lib/agentFlow';
import { AGENT_TAB_MAP, type ChatItem } from './AgentTabs';
import { TabHandoffCard, TabMessageStream } from './TabShared';
import type { SearchPaper } from '../../lib/api';

/** 状态顺序 (判断当前阶段是否已越过某一状态) */
export const STAGE_ORDER: AgentFlowStage[] = [
  'idle',
  'searching',
  'search_done',
  'writing',
  'write_done',
  'reviewing',
  'review_done',
  'checking',
  'done',
];

export const stageIndex = (s: AgentFlowStage): number => STAGE_ORDER.indexOf(s);

export interface ResearchTabProps {
  thread: ChatItem[];
  stage: AgentFlowStage;
  busy: boolean;
  topic: string;
  onTopicChange: (v: string) => void;
  results: SearchPaper[];
  selectedIds: string[];
  extraReq: string;
  onExtraReqChange: (v: string) => void;
  /** 已确认文献 (阶段越过 search_done 后在顶部展示只读卡片) */
  references: SearchPaper[];
  error: string | null;
  onSearch: () => void;
  onToggleSelect: (id: string) => void;
  onConfirm: () => void;
  onReset: () => void;
}

export function ResearchTab({
  thread,
  stage,
  busy,
  topic,
  onTopicChange,
  results,
  selectedIds,
  extraReq,
  onExtraReqChange,
  references,
  error,
  onSearch,
  onToggleSelect,
  onConfirm,
  onReset,
}: ResearchTabProps) {
  const { theme } = AGENT_TAB_MAP.research;
  const confirmed = stageIndex(stage) > stageIndex('search_done');

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 交接可见性: 文献已确认并移交写作专家后, 顶部展示只读卡片 */}
      {confirmed && references.length > 0 && (
        <TabHandoffCard cardClass={theme.card} chipClass={theme.chip}>
          <p className="text-[11px] font-medium text-slate-700">
            ✅ 已确认 {references.length} 篇文献，已移交「写作专家」
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
        emptyHint="调研助手：输入科研主题开始文献检索。每一步都由你点击按钮触发，Agent 不会自动进入下一步。"
        busyText={stage === 'searching' ? '搜索 Agent 正在联网检索文献…' : undefined}
        spinnerClass={theme.spinner}
      />

      {/* 操作区 (按钮蓝色) */}
      <div className="border-t border-slate-200 px-3 pt-2.5 pb-3 space-y-2">
        {error && (
          <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {/* IDLE: 输入检索主题 -> 搜索 */}
        {stage === 'idle' && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-slate-400 leading-relaxed">
              输入科研主题/写作要求后点击「搜索」：Agent 只会执行你点击的下一步。
            </p>
            <textarea
              value={topic}
              onChange={(e) => onTopicChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSearch();
                }
              }}
              placeholder="例如：AI 文本水印 / CRDT 协同 / 多 Agent 科研协作…"
              rows={2}
              className="w-full text-xs p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
            />
            <button
              onClick={onSearch}
              disabled={busy || !topic.trim()}
              className={`w-full text-xs font-medium px-3 py-2 rounded-lg transition-colors ${theme.btn}`}
            >
              🔬 搜索文献（搜索 Agent）
            </button>
          </div>
        )}

        {/* SEARCH_DONE: 勾选文献 + 附加要求 + 确认文献 */}
        {stage === 'search_done' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-600">
                文献结果（{results.length}）
              </span>
              <button
                onClick={onReset}
                className="text-[10px] text-slate-400 underline underline-offset-2 hover:text-slate-600"
              >
                重新搜索
              </button>
            </div>
            {results.length === 0 ? (
              <p className="text-[11px] text-slate-400 py-2">
                未找到文献，请点击「重新搜索」更换关键词。
              </p>
            ) : (
              <ul className="space-y-1.5 max-h-44 overflow-y-auto slim-scroll pr-0.5">
                {results.map((item) => {
                  const checked = selectedIds.includes(item.id);
                  return (
                    <li key={item.id}>
                      <label
                        className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                          checked
                            ? 'border-accent bg-accent/5'
                            : 'border-slate-200 bg-slate-50/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleSelect(item.id)}
                          className="w-3.5 h-3.5 accent-accent mt-0.5"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] leading-snug text-slate-700 line-clamp-2">
                            {item.title}
                          </span>
                          <span className="block text-[10px] text-slate-400 mt-0.5">
                            {(item.authors ?? []).slice(0, 3).join('、') || '佚名'}
                            {item.source ? ` · ${item.source}` : ''}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <input
              value={extraReq}
              onChange={(e) => onExtraReqChange(e.target.value)}
              placeholder="附加要求（可选）：如正文不少于 500 字、突出方法对比…"
              className="w-full text-[11px] px-2.5 py-1.5 rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <div className="flex items-center justify-between pt-1.5 border-t border-slate-100">
              <span className="text-[10px] text-slate-400">
                已选 {selectedIds.length} 篇（将移交写作专家）
              </span>
              <button
                onClick={onConfirm}
                disabled={busy || selectedIds.length === 0}
                className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-opacity ${theme.btn}`}
              >
                确认文献 → 移交写作专家
              </button>
            </div>
          </div>
        )}

        {/* 已越过检索阶段: 只读提示 (流程在后续 Tab 继续) */}
        {confirmed && (
          <p className="text-[10px] text-slate-400 leading-relaxed">
            检索与文献确认已完成。写作/审核进度请切换到「写作专家」「审核导师」查看；
            如需重新开始，可在审核完成后点击「开始新一轮流程」。
          </p>
        )}
      </div>
    </div>
  );
}
