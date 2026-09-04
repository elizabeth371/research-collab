import { memo, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { AgentMessage, AgentStatus, ReviewResult, RewriteResult } from '@shared/types';
import { AgentStatus as AgentStatusEnum, AgentType } from '@shared/types';
import { triggerAgent, getAgentState, getAgentMessages, reviewDocument, polishText, rewriteDocument, detectDocumentWatermark } from '../../lib/api';
import { appendAiText, AUTHOR_AI } from '../../lib/yjs';
import { docToMarkdown } from '../../lib/markdown';
import { getCollabSession } from '../../lib/collab';

/**
 * Agent 群聊左栏
 * ------------------------------------------------------------------
 * 将原「单触发面板」升级为群聊式时间流:
 *  - 用户指令与三个 Agent 的回复按时间顺序排列为聊天气泡
 *  - 同一文档内的多轮对话复用后端会话 (session_id), 消息在同一线程累积
 *  - 每轮发送 = 一次 LangGraph 编排 (research -> writer -> supervisor),
 *    三个 Agent 依次发言; Writer 产出自动以 author=ai 写入 Yjs (蓝色高亮)
 *  - 「开始审稿」将审稿结果以 Supervisor 消息入列, 并保留红牌卡片/润色该段
 */

/** 一条群聊消息 (用户气泡 / Agent 气泡 / 审稿入列消息) */
interface ChatItem {
  id: string;
  role: 'user' | 'agent';
  agentType?: AgentType;
  content: string;
  createdAt: string;
  /** 步骤 10: Writer 产出是否已注入 AI 水印 (显示「已加水印」徽章) */
  watermarked?: boolean;
}

/** 会话/线程缓存: 按文档保存, 切换文档或组件重挂载后群聊不丢失 (服务端会话存内存) */
const sessionCache = new Map<string, string>();
const threadCache = new Map<string, ChatItem[]>();

/** 缓存上限: 只保留最近使用的 N 个文档线程, 防止长会话内存无界增长 */
const MAX_CACHED_DOCS = 20;

/** LRU 写入 (Map 按插入序淘汰最旧): 重写已有键时先删再插, 保证其"新鲜" */
function cacheSet<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED_DOCS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

interface AgentPanelProps {
  docId: string;
  username: string;
  ydoc: Y.Doc;
}

const AGENT_META: Record<
  AgentType,
  { label: string; emoji: string; description: string; bubble: string; avatar: string }
> = {
  research: {
    label: 'Research Agent',
    emoji: '🔬',
    description: '文献检索与资料分析',
    bubble: 'border-blue-200 bg-blue-50',
    avatar: 'border-blue-200 bg-blue-50',
  },
  writer: {
    label: 'Writer Agent',
    emoji: '✍️',
    description: '论文撰写与润色',
    bubble: 'border-emerald-200 bg-emerald-50',
    avatar: 'border-emerald-200 bg-emerald-50',
  },
  supervisor: {
    label: 'Supervisor Agent',
    emoji: '🧠',
    description: '内容质量总控',
    bubble: 'border-purple-200 bg-purple-50',
    avatar: 'border-purple-200 bg-purple-50',
  },
};

const STATUS_META: Record<AgentStatus, { label: string; dot: string }> = {
  idle: { label: '空闲', dot: 'bg-gray-300' },
  running: { label: '运行中', dot: 'bg-blue-500 animate-pulse' },
  waiting_human: { label: '等待人工', dot: 'bg-amber-500 animate-pulse' },
  completed: { label: '已完成', dot: 'bg-green-500' },
  error: { label: '出错', dot: 'bg-red-500' },
};

const ALL_RUNNING: Record<AgentType, AgentStatus> = {
  research: AgentStatusEnum.RUNNING,
  writer: AgentStatusEnum.RUNNING,
  supervisor: AgentStatusEnum.RUNNING,
};
const ALL_COMPLETED: Record<AgentType, AgentStatus> = {
  research: AgentStatusEnum.COMPLETED,
  writer: AgentStatusEnum.COMPLETED,
  supervisor: AgentStatusEnum.COMPLETED,
};

// memo: props (docId/username/ydoc) 在无关 App 状态变化时不变, 跳过重渲染
export const AgentPanel = memo(function AgentPanel({ docId, username, ydoc }: AgentPanelProps) {
  const [statuses, setStatuses] = useState<Record<AgentType, AgentStatus>>({
    research: AgentStatusEnum.IDLE,
    writer: AgentStatusEnum.IDLE,
    supervisor: AgentStatusEnum.IDLE,
  });
  const [thread, setThread] = useState<ChatItem[]>(() => threadCache.get(docId) ?? []);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ---- 审稿人红牌状态 (保留卡片 + 润色该段) ----
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [polishingPara, setPolishingPara] = useState<number | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  // ---- 审稿红牌 -> 自动重写 (前后对比 + 应用) ----
  const [rewriting, setRewriting] = useState(false);
  const [rewriteResult, setRewriteResult] = useState<RewriteResult | null>(null);

  const ydocRef = useRef(ydoc);
  ydocRef.current = ydoc;
  const docIdRef = useRef(docId);
  docIdRef.current = docId;
  const sessionIdRef = useRef<string | null>(sessionCache.get(docId) ?? null);
  const threadRef = useRef<HTMLDivElement>(null);

  /** 切换文档时恢复该文档的群聊线程与会话 */
  useEffect(() => {
    setThread(threadCache.get(docId) ?? []);
    sessionIdRef.current = sessionCache.get(docId) ?? null;
    setReview(null);
    setReviewMsg(null);
    setRewriteResult(null);
  }, [docId]);

  /** 追加消息到线程 (同步写回缓存, 按 id 去重) */
  const appendThread = (items: ChatItem[]) => {
    setThread((prev) => {
      const ids = new Set(prev.map((i) => i.id));
      const next = [...prev];
      for (const it of items) {
        if (!ids.has(it.id)) {
          next.push(it);
          ids.add(it.id);
        }
      }
      cacheSet(threadCache, docId, next);
      return next;
    });
  };

  // 新消息到达时自动滚动到底部
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [thread, busy]);

  /** 发送指令: 触发一次完整编排, 三个 Agent 依次入列发言 */
  const handleSend = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt('');
    setError(null);
    setBusy(true);
    setStatuses(ALL_RUNNING);
    appendThread([
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      // 群聊会话: 首次不传 session_id, 之后复用同一会话实现多轮追问
      const requestDocId = docId;
      const { session_id: sessionId } = await triggerAgent(
        AgentType.RESEARCH,
        requestDocId,
        text,
        sessionIdRef.current ?? undefined
      );
      sessionIdRef.current = sessionId;
      cacheSet(sessionCache, requestDocId, sessionId);

      // 编排在后端后台任务中运行 (invoke 返回 202): 轮询会话状态直至完成
      const POLL_INTERVAL_MS = 400;
      const POLL_TIMEOUT_MS = 120_000;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let finalStatus = '';
      while (Date.now() < deadline) {
        // 请求期间用户切换了文档: 放弃本次结果, 避免把 AI 产物写进别的文档
        if (docIdRef.current !== requestDocId) {
          return;
        }
        const state = await getAgentState(sessionId);
        if (state.status === 'completed' || state.status === 'failed') {
          finalStatus = state.status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (finalStatus === 'failed') {
        throw new Error('Agent 编排执行失败, 请查看后端日志');
      }

      const { messages: msgs } = await getAgentMessages(sessionId);
      // 轮询期间切换了文档: 结果留存在会话中, 不写入当前界面与文档
      if (docIdRef.current !== requestDocId) {
        return;
      }
      appendThread(
        msgs.map((m) => ({
          id: m.id,
          role: 'agent' as const,
          agentType: m.agentType,
          content: m.content,
          createdAt: m.createdAt ?? new Date().toISOString(),
          watermarked: m.watermarked,
        }))
      );

      // Writer 产出: 以 AI 作者身份写入 Yjs 文档 (蓝色高亮)
      // 审稿红牌触发自动重写时会出现多条 Writer 消息, 取最后一条 (最终修订版)
      const writerMsgs = msgs.filter((m) => m.agentType === AgentType.WRITER);
      const writerMsg = writerMsgs[writerMsgs.length - 1];
      if (writerMsg?.content) {
        appendAiText(getCollabSession(docId).editor, ydocRef.current, writerMsg.content);
      }
      setStatuses(ALL_COMPLETED);
    } catch (e) {
      setStatuses({ ...ALL_RUNNING, research: AgentStatusEnum.ERROR });
      setError(e instanceof Error ? e.message : '协同处理失败');
    } finally {
      setBusy(false);
    }
  };

  /** 审稿人: 对文档当前全文执行红牌/黄牌分级审查 (结果入列 Supervisor 消息) */
  const handleReview = async () => {
    if (!docId || reviewing) return;
    setReviewing(true);
    setReviewMsg(null);
    setRewriteResult(null);
    const requestDocId = docId;
    try {
      const result = await reviewDocument(requestDocId);
      if (docIdRef.current !== requestDocId) return;
      setReview(result);
      const summary =
        result.redCards > 0
          ? `🟥 审稿完成：红牌 ${result.redCards} 项 / 黄牌 ${result.yellowCards} 项，存在严重问题，请优先修改下方卡片。`
          : result.yellowCards > 0
            ? `⚠️ 审稿完成：无红牌问题，${result.yellowCards} 条黄牌建议，详见下方卡片。`
            : '✅ 审稿通过：格式规范，无红牌无黄牌。';
      appendThread([
        {
          id: `review-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: summary,
          createdAt: new Date().toISOString(),
        },
      ]);

      // 水印检测不再作为独立功能入口: 仅当审稿通过 (无红牌) 后自动触发,
      // 作为整个流程的最终步骤 (结果持久化 WatermarkRecord + 溯源链日志)
      if (result.passed) {
        try {
          const det = await detectDocumentWatermark(requestDocId);
          if (docIdRef.current !== requestDocId) return;
          appendThread([
            {
              id: `wm-auto-${Date.now()}`,
              role: 'agent',
              agentType: AgentType.SUPERVISOR,
              content: `🔍 自动水印检测（最终步骤）：全文判定为「${
                det.isAiGenerated ? 'AI 生成 · 含水印' : '人类创作'
              }」，z=${det.zScore.toFixed(2)}（阈值 4.0），AI 置信度 ${Math.round(
                det.confidence * 100
              )}%。检测已留痕，可在右侧「水印检测」历史记录中复核。`,
              createdAt: new Date().toISOString(),
            },
          ]);
        } catch (e) {
          if (docIdRef.current !== requestDocId) return;
          appendThread([
            {
              id: `wm-auto-err-${Date.now()}`,
              role: 'agent',
              agentType: AgentType.SUPERVISOR,
              content: `⚠️ 自动水印检测暂不可用：${
                e instanceof Error ? e.message : '未知错误'
              }`,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      }
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

  /** 审稿红牌 -> 自动重写: 后端按红牌问题规则修复, 返回前后对比 */
  const handleRewrite = async () => {
    if (!docId || rewriting) return;
    setRewriting(true);
    setReviewMsg(null);
    try {
      const editor = getCollabSession(docId).editor;
      // 传当前编辑器内容 (含未落库的编辑), 后端优先使用
      const text = editor ? docToMarkdown(editor.state.doc) : undefined;
      const result = await rewriteDocument(docId, text);
      setRewriteResult(result);
      if (result.engine === 'noop') {
        setReviewMsg('✅ 当前文档无红牌问题，无需重写');
        return;
      }
      appendThread([
        {
          id: `rewrite-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: `🔄 审稿自动重写完成：红牌 ${result.redCardsBefore} → ${result.redCardsAfter} 项${
            result.passedAfter ? '，已全部修复' : '，仍有剩余（可人工修正）'
          }。下方可查看变更明细并应用到文档。`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      setReviewMsg(e instanceof Error ? e.message : '自动重写失败');
    } finally {
      setRewriting(false);
    }
  };

  /** 将重写后的 Markdown 解析为带 author=ai 标记的 Tiptap 内容 (标题 + 段落) */
  const markdownToAuthorContent = (md: string, author: string) => {
    const blocks: unknown[] = [];
    let paraLines: string[] = [];
    const flush = () => {
      if (paraLines.length > 0) {
        blocks.push({
          type: 'paragraph',
          content: [
            { type: 'text', text: paraLines.join('\n'), marks: [{ type: 'author', attrs: { author } }] },
          ],
        });
        paraLines = [];
      }
    };
    for (const line of md.split('\n')) {
      const head = line.match(/^(#{1,6})\s+(.+)$/);
      if (head) {
        flush();
        blocks.push({
          type: 'heading',
          attrs: { level: head[1].length },
          content: [
            { type: 'text', text: head[2], marks: [{ type: 'author', attrs: { author } }] },
          ],
        });
      } else if (line.trim()) {
        paraLines.push(line);
      } else {
        flush();
      }
    }
    flush();
    return blocks;
  };

  /** 应用重写版本: 整篇替换为 AI 蓝色标记内容 */
  const handleApplyRewrite = () => {
    if (!rewriteResult) return;
    const editor = getCollabSession(docId).editor;
    if (!editor) return;
    editor.commands.setContent(
      markdownToAuthorContent(rewriteResult.rewritten, AUTHOR_AI),
      true
    );
    setReviewMsg(
      '✅ 重写版本已应用到文档（AI 蓝色标记），可重新审稿复查'
    );
    setRewriteResult(null);
    setReview(null);
  };

  return (
    <aside className="w-80 shrink-0 flex flex-col bg-white border-r border-gray-200 h-full min-h-0">
      {/* 面板标题 */}
      <div className="px-4 py-3 border-b border-slate-200">
        <h2 className="panel-title text-base">Agent 群聊</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          多智能体协同 · 同一文档内支持多轮追问
        </p>
      </div>

      {/* 三个 Agent 状态点 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-slate-50/60">
        {(Object.keys(AGENT_META) as AgentType[]).map((type) => (
          <span
            key={type}
            title={AGENT_META[type].description}
            className="inline-flex items-center gap-1 text-[10px] text-slate-500"
          >
            <span>{AGENT_META[type].emoji}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${STATUS_META[statuses[type] ?? 'idle'].dot}`}
            />
            <span>{STATUS_META[statuses[type] ?? 'idle'].label}</span>
          </span>
        ))}
      </div>

      {/* 群聊消息流 */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 slim-scroll min-h-0">
        {thread.length === 0 && (
          <div className="text-[11px] text-slate-400 leading-relaxed mt-2">
            向群里发送指令（如「检索水印算法文献并总结」），三个 Agent 将依次
            🔬 检索文献 → ✍️ 起草内容 → 🧠 审阅质量。发送多轮指令可继续追问。
          </div>
        )}

        {thread.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[88%] rounded-xl rounded-tr-sm bg-slate-800 text-white text-xs leading-relaxed px-3 py-2 whitespace-pre-wrap break-words">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex gap-2 items-start">
              <span
                className={`w-7 h-7 rounded-lg border flex items-center justify-center text-sm shrink-0 mt-0.5 shadow-sm ${AGENT_META[m.agentType ?? AgentType.SUPERVISOR]?.avatar ?? AGENT_META.supervisor.avatar}`}
              >
                {AGENT_META[m.agentType ?? AgentType.SUPERVISOR]?.emoji ?? AGENT_META.supervisor.emoji}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[10px] text-slate-400">
                    {AGENT_META[m.agentType ?? AgentType.SUPERVISOR]?.label ?? AGENT_META.supervisor.label}
                  </span>
                  {m.watermarked && (
                    <span
                      title="本段由真实 LLM 生成并经 logprobs 重采样注入字符级 AI 水印"
                      className="text-[9px] font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-px"
                    >
                      🔵 已加水印
                    </span>
                  )}
                </div>
                <div
                  className={`rounded-xl rounded-tl-sm border text-[11px] leading-relaxed px-2.5 py-2 text-slate-700 whitespace-pre-wrap break-words ${AGENT_META[m.agentType ?? AgentType.SUPERVISOR]?.bubble ?? AGENT_META.supervisor.bubble}`}
                >
                  {m.content}
                </div>
              </div>
            </div>
          )
        )}

        {busy && (
          <div className="flex gap-2 items-center text-[11px] text-slate-400">
            <span className="w-7 h-7 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center text-sm shrink-0 animate-pulse">
              🤖
            </span>
            正在协同处理…（🔬 检索 → ✍️ 起草 → 🧠 审阅）
          </div>
        )}
      </div>

      {/* 审稿结果 (审稿人红牌卡片 + 润色该段) */}
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

              {/* 红牌 -> 自动重写 (由 Supervisor 判定, 一键修复红牌问题) */}
              {review.redCards > 0 && !rewriteResult && (
                <button
                  onClick={() => void handleRewrite()}
                  disabled={rewriting}
                  className="mt-2 w-full text-[11px] font-medium px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {rewriting ? '🔄 重写中，请稍候...' : '🔄 自动重写（一键修复全部红牌）'}
                </button>
              )}

              <div className="mt-2 space-y-2 max-h-56 overflow-y-auto slim-scroll">
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
                        onClick={() => handlePolishParagraph(issue.paraIndex!)}
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
                      onClick={() => setRewriteResult(null)}
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
                      onClick={handleApplyRewrite}
                      className="mt-2 w-full text-[11px] font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                    >
                      ✓ 应用到文档（AI 蓝色标记）
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 快速动作: 仅保留检索/审稿; 撰写走主对话流程 (确认文献后再写作) */}
      <div className="flex items-center gap-1.5 px-4 pt-2.5 border-t border-slate-100">
        <button
          onClick={() => setPrompt('帮我检索关于 AI 水印 (watermark) 与版权溯源的文献并总结')}
          className="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
        >
          🔬 检索文献
        </button>
        <button
          onClick={handleReview}
          disabled={reviewing}
          className="text-[11px] px-2 py-1 rounded-md border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-40 transition-colors"
        >
          {reviewing ? '审稿中...' : '🧠 开始审稿'}
        </button>
      </div>

      {/* 指令输入区 */}
      <div className="border-t border-slate-200 p-3">
        {error && (
          <div className="mb-2 text-[11px] text-red-500 bg-red-50 rounded px-2 py-1">
            {error}
          </div>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="给 Agent 群发指令，如：检索关于水印算法的文献并总结…（Enter 发送 / Shift+Enter 换行）"
          rows={2}
          className="w-full text-xs p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <p className="text-[10px] text-slate-400">
            当前用户: {username} · AI 产出将自动以蓝色高亮写入文档
          </p>
          <button
            onClick={() => void handleSend()}
            disabled={busy || !prompt.trim()}
            className="text-[11px] font-medium px-3 py-1 rounded-md bg-ink text-white hover:bg-ink-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? '处理中...' : '发送'}
          </button>
        </div>
      </div>
    </aside>
  );
});
