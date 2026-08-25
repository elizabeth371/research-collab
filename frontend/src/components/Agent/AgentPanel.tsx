import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { AgentMessage, AgentStatus, AgentType, ReviewResult } from '@shared/types';
import { AgentStatus as AgentStatusEnum } from '@shared/types';
import { triggerAgent, getAgentMessages, reviewDocument, polishText } from '../../lib/api';
import { appendAiText, AUTHOR_AI } from '../../lib/yjs';
import { getCollabSession } from '../../lib/collab';

/**
 * Agent 交互面板
 * ------------------------------------------------------------------
 * 左侧边栏:
 *  - 三个 Agent 卡片: ResearchAgent / WriterAgent / SupervisorAgent
 *  - 触发按钮 -> POST /api/agents/invoke (LangGraph 编排)
 *  - 会话完成后拉取真实消息展示思考过程
 *  - Writer 产出自动以 author=ai 写入 Yjs 文档 (蓝色高亮)
 */
interface AgentPanelProps {
  docId: string;
  username: string;
  ydoc: Y.Doc;
}

const AGENT_META: Record<
  AgentType,
  { label: string; emoji: string; description: string; color: string }
> = {
  research: {
    label: 'Research Agent',
    emoji: '🔬',
    description: '文献检索与资料分析',
    color: 'border-blue-200',
  },
  writer: {
    label: 'Writer Agent',
    emoji: '✍️',
    description: '论文撰写与润色',
    color: 'border-emerald-200',
  },
  supervisor: {
    label: 'Supervisor Agent',
    emoji: '🧠',
    description: '内容质量总控',
    color: 'border-purple-200',
  },
};

const STATUS_META: Record<AgentStatus, { label: string; dot: string }> = {
  idle: { label: '空闲', dot: 'bg-gray-400' },
  running: { label: '运行中', dot: 'bg-blue-500 animate-pulse' },
  waiting_human: { label: '等待人工', dot: 'bg-amber-500 animate-pulse' },
  completed: { label: '已完成', dot: 'bg-green-500' },
  error: { label: '出错', dot: 'bg-red-500' },
};

export function AgentPanel({ docId, username, ydoc }: AgentPanelProps) {
  const [statuses, setStatuses] = useState<Record<AgentType, AgentStatus>>({
    research: AgentStatusEnum.IDLE,
    writer: AgentStatusEnum.IDLE,
    supervisor: AgentStatusEnum.IDLE,
  });
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<AgentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ---- 审稿人红牌状态 ----
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [polishingPara, setPolishingPara] = useState<number | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const ydocRef = useRef(ydoc);
  ydocRef.current = ydoc;

  /** 触发 Agent: 调用后端 LangGraph 编排, 完成后拉取会话消息 */
  const handleTrigger = async (type: AgentType) => {
    if (!prompt.trim()) {
      setError('请输入研究/写作指令');
      return;
    }
    setError(null);
    setBusy(type);
    setStatuses((s) => ({ ...s, [type]: AgentStatusEnum.RUNNING }));

    try {
      const { session_id: sessionId } = await triggerAgent(type, docId, prompt);

      // 后端为同步执行, invoke 返回即完成; 拉取真实会话消息
      const { messages: msgs } = await getAgentMessages(sessionId);
      setMessages((prev) => [...prev, ...msgs]);

      // 一次编排经过 research -> writer -> supervisor, 三个节点均已完成
      setStatuses({
        research: AgentStatusEnum.COMPLETED,
        writer: AgentStatusEnum.COMPLETED,
        supervisor: AgentStatusEnum.COMPLETED,
      });

      // Writer 产出: 以 AI 作者身份写入 Yjs 文档 (蓝色高亮)
      // 经 Tiptap editor 通道插入 (PM transaction), 避免 ySyncPlugin
      // synchronize 回写丢弃直接 fragment 操作的内容。
      const writerMsg = msgs.find((m) => m.agentType === 'writer');
      if (writerMsg?.content) {
        appendAiText(getCollabSession(docId).editor, ydocRef.current, writerMsg.content);
      }
    } catch (e) {
      setStatuses((s) => ({ ...s, [type]: AgentStatusEnum.ERROR }));
      setError(e instanceof Error ? e.message : '触发失败');
    } finally {
      setBusy(null);
    }
  };

  /** 审稿人: 对文档当前全文执行红牌/黄牌分级审查 */
  const handleReview = async () => {
    if (!docId || reviewing) return;
    setReviewing(true);
    setReviewMsg(null);
    try {
      const result = await reviewDocument(docId);
      setReview(result);
    } catch (e) {
      setReviewMsg(e instanceof Error ? e.message : '审稿失败');
    } finally {
      setReviewing(false);
    }
  };

  /** 取编辑器第 N 个顶层块 (1 起) 的文本与内容范围 */
  const getBlockAt = (
    paraIndex: number
  ): { text: string; from: number; to: number } | null => {
    const editor = getCollabSession(docId).editor;
    if (!editor) return null;
    let found: { text: string; from: number; to: number } | null = null;
    let idx = 0;
    editor.state.doc.forEach((node: any, offset: number) => {
      idx += 1;
      if (idx === paraIndex) {
        found = {
          text: node.textContent,
          from: offset + 1,
          to: offset + node.nodeSize - 1,
        };
      }
    });
    return found;
  };

  /** 按审稿意见润色指定段落 (AI 蓝色替换) */
  const handlePolishParagraph = async (paraIndex: number) => {
    const block = getBlockAt(paraIndex);
    if (!block || !block.text.trim()) return;
    setPolishingPara(paraIndex);
    setReviewMsg(null);
    try {
      const result = await polishText(docId, block.text.trim());
      if (result.stats.changeCount === 0) {
        setReviewMsg(`第 ${paraIndex} 段已符合学术规范，无需润色`);
        return;
      }
      const editor = getCollabSession(docId).editor;
      editor?.commands.insertContentAt(
        { from: block.from, to: block.to },
        {
          type: 'text',
          text: result.polished,
          // 与 appendText 相同的 author mark 结构 (蓝色 AI 标记)
          marks: [{ type: 'author', attrs: { author: AUTHOR_AI } }],
        },
        { updateSelection: false }
      );
      setReviewMsg(
        `第 ${paraIndex} 段已润色（${result.stats.engine === 'llm' ? 'LLM 语义润色 · ' : '规则引擎 · '}${result.stats.changeCount} 处优化），可重新审稿复查`
      );
    } catch (e) {
      setReviewMsg('润色失败，请稍后重试');
    } finally {
      setPolishingPara(null);
    }
  };

  return (
    <aside className="w-80 shrink-0 flex flex-col bg-white border-r border-gray-200">
      {/* 面板标题 */}
      <div className="px-5 py-4 border-b border-slate-200">
        <h2 className="panel-title text-base">Agent 面板</h2>
        <p className="text-xs text-slate-400 mt-0.5">LangGraph 多智能体协同编排</p>
      </div>

      {/* Agent 状态卡片列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 slim-scroll">
        {(Object.keys(AGENT_META) as AgentType[]).map((type) => {
          const meta = AGENT_META[type];
          const status = statuses[type] ?? 'idle';
          const statusMeta = STATUS_META[status];
          const agentMsgs = messages.filter((m) => m.agentType === type);

          return (
            <div
              key={type}
              className={`border rounded-lg p-3 bg-slate-50/60 hover:bg-slate-50 transition-colors ${meta.color}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-base shadow-sm shrink-0">
                    {meta.emoji}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {meta.label}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {meta.description}
                    </div>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                  <span className={`w-2 h-2 rounded-full ${statusMeta.dot}`} />
                  {statusMeta.label}
                </span>
              </div>

              {/* 触发按钮 */}
              {type !== 'supervisor' ? (
                <button
                  onClick={() => handleTrigger(type)}
                  disabled={busy !== null}
                  className="mt-3 w-full text-xs font-medium py-1.5 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {busy === type
                    ? '运行中...'
                    : type === 'research'
                      ? '启动文献检索'
                      : '启动论文写作'}
                </button>
              ) : (
                <button
                  onClick={handleReview}
                  disabled={reviewing}
                  className="mt-3 w-full text-xs font-medium py-1.5 rounded-md bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {reviewing ? '审稿中...' : '开始审稿 · 红牌检查'}
                </button>
              )}

              {/* 思考过程输出 */}
              {agentMsgs.length > 0 && (
                <div className="mt-3 space-y-2 max-h-48 overflow-y-auto slim-scroll">
                  {agentMsgs.map((msg) => (
                    <div
                      key={msg.id}
                      className="text-[11px] leading-relaxed bg-white border border-slate-100 rounded p-2 text-slate-600"
                    >
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 审稿结果 (审稿人红牌检查) */}
      {(review || reviewing) && (
        <div className="border-t border-slate-200 px-4 py-3 bg-slate-50/50">
          {reviewing && !review && (
            <div className="text-xs text-slate-500">审稿人正在检查文档规范...</div>
          )}
          {review && (
            <>
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

              <div className="mt-2 space-y-2 max-h-64 overflow-y-auto slim-scroll">
                {review.issues.map((issue, i) => (
                  <div
                    key={i}
                    className={`review-card review-card-${issue.level}`}
                  >
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
                        onClick={() => handlePolishParagraph(issue.paraIndex!)}
                        disabled={polishingPara !== null}
                        className="review-polish-btn"
                      >
                        {polishingPara === issue.paraIndex
                          ? '润色中...'
                          : '润色该段'}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {reviewMsg && (
                <div className="mt-2 text-[11px] text-slate-500">{reviewMsg}</div>
              )}
            </>
          )}
        </div>
      )}

      {/* 指令输入区 */}
      <div className="border-t border-slate-200 p-4">
        {error && (
          <div className="mb-2 text-[11px] text-red-500 bg-red-50 rounded px-2 py-1">
            {error}
          </div>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="输入给 Agent 的指令，如：检索关于水印算法的文献并总结…"
          rows={3}
          className="w-full text-xs p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
        />
        <p className="mt-1 text-[10px] text-slate-400">
          当前用户: {username} · AI 产出将自动以蓝色高亮写入文档
        </p>
      </div>
    </aside>
  );
}
