import { memo, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type {
  AgentStatus,
  ReviewResult,
  RewriteResult,
  WatermarkDetectionResult,
} from '@shared/types';
import { AgentStatus as AgentStatusEnum, AgentType } from '@shared/types';
import {
  triggerAgent,
  getAgentState,
  getAgentMessages,
  reviewDocument,
  polishText,
  rewriteDocument,
  detectDocumentWatermark,
  searchLiterature,
  type SearchPaper,
} from '../../lib/api';
import {
  AGENT_FLOW_META,
  FLOW_BUSY_STAGES,
  flowTransition,
  type AgentFlowAction,
  type AgentFlowStage,
} from '../../lib/agentFlow';
import { appendAiMarkdown, AUTHOR_AI } from '../../lib/yjs';
import { docToMarkdown, markdownToHtml } from '../../lib/markdown';
import { getCollabSession } from '../../lib/collab';

/**
 * Agent 串行写作流程左栏 (严格挂起-确认模式)
 * ------------------------------------------------------------------
 * 三个 Agent (搜索 / Writer / 审核) 之间不存在自动串联: 每一步都挂在
 * 用户按钮上, 由用户显式点击后才调用对应 Agent (状态机见 lib/agentFlow.ts):
 *   ① 搜索文献(Search Agent) -> ② 勾选并确认文献 -> ③ Writer 撰写
 *   -> ④ 提交审核 -> ⑤ 确认并检测(AIGC 水印, 最终步骤) -> 完成
 *  - 勾选的文献元数据 (title/abstract/authors/url/source) 作为 references
 *    显式传给后端, 完整进入 Writer 的 prompt;
 *  - Writer 正文以 author=ai 写入 Yjs (蓝色高亮), 并在左侧留下聊天气泡回放;
 *  - 审稿结果保留红牌卡片 + 「润色该段」, 红牌可一键自动重写后人工应用。
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

/** 线程缓存: 按文档保存, 切换文档或组件重挂载后历史对话不丢失 */
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

// memo: props (docId/username/ydoc) 在无关 App 状态变化时不变, 跳过重渲染
export const AgentPanel = memo(function AgentPanel({ docId, username, ydoc }: AgentPanelProps) {
  const [statuses, setStatuses] = useState<Record<AgentType, AgentStatus>>({
    research: AgentStatusEnum.IDLE,
    writer: AgentStatusEnum.IDLE,
    supervisor: AgentStatusEnum.IDLE,
  });
  const [thread, setThread] = useState<ChatItem[]>(() => threadCache.get(docId) ?? []);
  const [error, setError] = useState<string | null>(null);
  // ---- 严格串行流程状态机 (9 态, 流转表见 lib/agentFlow.ts) ----
  const [stage, setStage] = useState<AgentFlowStage>('idle');
  const [topic, setTopic] = useState('');
  const [results, setResults] = useState<SearchPaper[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [references, setReferences] = useState<SearchPaper[]>([]);
  const [writingText, setWritingText] = useState('');
  // ---- Writer 结构化输出展示 (预览/编辑双模式) ----
  /** 附加要求 (字数/格式等, 随 writer_input 提交, 可选) */
  const [extraReq, setExtraReq] = useState('');
  /** write_done: true=编辑模式 (可编辑文本框), false=Markdown 预览 */
  const [writingEditMode, setWritingEditMode] = useState(false);
  /** 本轮正文是否已写入文档 (防止重复追加) */
  const [docWritten, setDocWritten] = useState(false);
  /** 已写入文档的正文版本 (判断写入后是否有未同步的编辑) */
  const [writtenSnapshot, setWrittenSnapshot] = useState('');
  /** write_done 区操作反馈文案 */
  const [writeMsg, setWriteMsg] = useState<string | null>(null);
  const [detection, setDetection] = useState<WatermarkDetectionResult | null>(
    null
  );
  // ---- 审稿人红牌状态 (保留卡片 + 润色该段) ----
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [polishingPara, setPolishingPara] = useState<number | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  // ---- 审稿红牌 -> 自动重写 (前后对比 + 应用) ----
  const [rewriting, setRewriting] = useState(false);
  const [rewriteResult, setRewriteResult] = useState<RewriteResult | null>(null);

  const ydocRef = useRef(ydoc);
  ydocRef.current = ydoc;
  const docIdRef = useRef(docId);
  docIdRef.current = docId;
  const threadRef = useRef<HTMLDivElement>(null);

  // 步骤正在调用 Agent / 联网: 禁用全部按钮并渲染进度动画
  const busy = FLOW_BUSY_STAGES.has(stage);

  /** 切换文档: 恢复该文档的历史线程, 并将流程状态机重置回 IDLE */
  useEffect(() => {
    setThread(threadCache.get(docId) ?? []);
    setStage('idle');
    setTopic('');
    setResults([]);
    setSelectedIds([]);
    setReferences([]);
    setExtraReq('');
    setWritingText('');
    setWritingEditMode(false);
    setDocWritten(false);
    setWrittenSnapshot('');
    setWriteMsg(null);
    setDetection(null);
    setReview(null);
    setReviewMsg(null);
    setRewriteResult(null);
    setError(null);
    setStatuses({
      research: AgentStatusEnum.IDLE,
      writer: AgentStatusEnum.IDLE,
      supervisor: AgentStatusEnum.IDLE,
    });
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

  /** 状态机流转入口: 校验 (stage, action) 合法后推进; 非法跳步直接拦截 */
  const go = (action: AgentFlowAction): boolean => {
    try {
      setStage((s) => flowTransition(s, action));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '流程状态异常');
      return false;
    }
  };

  /** 重置本轮流程 (DONE/任意状态 -> IDLE, 可开始新一轮) */
  const handleResetFlow = () => {
    setStage('idle');
    setResults([]);
    setSelectedIds([]);
    setReferences([]);
    setExtraReq('');
    setWritingText('');
    setWritingEditMode(false);
    setDocWritten(false);
    setWrittenSnapshot('');
    setWriteMsg(null);
    setDetection(null);
    setReview(null);
    setRewriteResult(null);
    setReviewMsg(null);
    setError(null);
  };

  /** ① 搜索步骤: IDLE + 用户点击「搜索」-> SEARCHING -> SEARCH_DONE */
  const handleSearch = async () => {
    const keyword = topic.trim();
    if (!keyword || busy || stage !== 'idle') return;
    const requestDocId = docId;
    setError(null);
    setResults([]);
    setSelectedIds([]);
    if (!go('begin_search')) return;
    appendThread([
      {
        id: `query-${Date.now()}`,
        role: 'user',
        content: keyword,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStatuses({
      research: AgentStatusEnum.RUNNING,
      writer: AgentStatusEnum.IDLE,
      supervisor: AgentStatusEnum.IDLE,
    });
    try {
      const res = await searchLiterature(keyword, 10);
      if (docIdRef.current !== requestDocId) return;
      if (res.status === 'success') {
        const data = res.data ?? [];
        setResults(data);
        appendThread([
          {
            id: `search-done-${Date.now()}`,
            role: 'agent',
            agentType: AgentType.RESEARCH,
            content:
              data.length > 0
                ? `🔬 搜索完成：共检索到 ${data.length} 篇相关文献。请在下方勾选至少 1 篇后点击「确认文献 → Writer 开始写作」。`
                : '🔬 搜索完成：未找到相关文献，请更换关键词后重新搜索。',
            createdAt: new Date().toISOString(),
          },
        ]);
        if (data.length === 0) {
          setError('未检索到相关文献，请更换关键词后重新搜索');
        }
        setStatuses({
          research: AgentStatusEnum.COMPLETED,
          writer: AgentStatusEnum.IDLE,
          supervisor: AgentStatusEnum.IDLE,
        });
        go('search_succeeded');
      } else {
        setError(res.message || '检索失败');
        setStatuses({
          research: AgentStatusEnum.ERROR,
          writer: AgentStatusEnum.IDLE,
          supervisor: AgentStatusEnum.IDLE,
        });
        go('search_failed');
      }
    } catch (e) {
      if (docIdRef.current !== requestDocId) return;
      setError(e instanceof Error ? e.message : '检索失败，请稍后重试');
      setStatuses({
        research: AgentStatusEnum.ERROR,
        writer: AgentStatusEnum.IDLE,
        supervisor: AgentStatusEnum.IDLE,
      });
      go('search_failed');
    }
  };

  /** 勾选文献 (仅 SEARCH_DONE 状态允许) */
  const handleToggleSelect = (id: string) => {
    if (stage !== 'search_done') return;
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  /** ③ SEARCH_DONE: 勾选 >=1 篇 + 点击「确认文献」-> WRITING (只跑 Writer) */
  const handleConfirmLiterature = async () => {
    if (stage !== 'search_done' || busy) return;
    const refs = results.filter((r) => selectedIds.includes(r.id));
    if (refs.length === 0) return;
    const requestDocId = docId;
    const writeTopic = topic.trim() || 'AI 水印与版权溯源';
    setError(null);
    setReferences(refs);
    if (!go('confirm_literature')) return;
    appendThread([
      {
        id: `confirm-${Date.now()}`,
        role: 'user',
        content: `确认 ${refs.length} 篇文献，请 Writer 基于这些文献撰写正文。`,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStatuses({
      research: AgentStatusEnum.COMPLETED,
      writer: AgentStatusEnum.RUNNING,
      supervisor: AgentStatusEnum.IDLE,
    });

    // Writer 结构化输入契约: {user_topic, confirmed_literature,
    // additional_requirements} 随请求显式提交; references 冗余提交兼容旧字段。
    // 后端据此生成结构化 Markdown 正文 (# 标题 + ## 参考文献 + ## 正文)。
    const instruction =
      `请基于用户确认的 ${refs.length} 篇文献，围绕主题「${writeTopic}」` +
      '撰写规范的中文学术文献综述；输出 Markdown 纯文本正文：开头以 # 标题起，' +
      '随后 ## 参考文献（按 [1]、[2] 编号列出确认文献），再 ## 正文' +
      '（300-600 字，行文中以 [n] 对应引用）。' +
      (extraReq.trim() ? `用户附加要求：${extraReq.trim()}` : '');
    try {
      const { session_id: sessionId } = await triggerAgent(
        AgentType.WRITER,
        requestDocId,
        instruction,
        undefined,
        refs,
        {
          user_topic: writeTopic,
          confirmed_literature: refs,
          additional_requirements: extraReq,
        }
      );

      // Writer 单节点在后台任务中执行 (invoke 返回 202): 轮询直至完成
      const POLL_INTERVAL_MS = 400;
      const POLL_TIMEOUT_MS = 120_000;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let finalStatus = '';
      while (Date.now() < deadline) {
        if (docIdRef.current !== requestDocId) return;
        const state = await getAgentState(sessionId);
        if (state.status === 'completed' || state.status === 'failed') {
          finalStatus = state.status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!finalStatus) throw new Error('Writer Agent 执行超时');
      if (finalStatus === 'failed') {
        throw new Error('Writer Agent 执行失败，请查看后端日志');
      }

      const { messages: msgs } = await getAgentMessages(sessionId);
      if (docIdRef.current !== requestDocId) return;
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

      // 正文: 先进入面板「预览/编辑」区 (Markdown 渲染, 可手动修改),
      // 由用户显式点击「写入文档」或「提交审核」时才写入 Yjs —— 保证
      // 最终落库/送审的就是用户确认过的版本
      const writerMsgs = msgs.filter((m) => m.agentType === AgentType.WRITER);
      const writerMsg = writerMsgs[writerMsgs.length - 1];
      const text = writerMsg?.content ?? '';
      setWritingText(text);
      setWritingEditMode(false);
      setDocWritten(false);
      setStatuses({
        research: AgentStatusEnum.COMPLETED,
        writer: AgentStatusEnum.COMPLETED,
        supervisor: AgentStatusEnum.IDLE,
      });
      go('writing_succeeded');
    } catch (e) {
      if (docIdRef.current !== requestDocId) return;
      setError(e instanceof Error ? e.message : 'Writer 撰写失败');
      setStatuses({
        research: AgentStatusEnum.COMPLETED,
        writer: AgentStatusEnum.ERROR,
        supervisor: AgentStatusEnum.IDLE,
      });
      go('writing_failed'); // 回到 SEARCH_DONE 可重新确认重试
    }
  };

  /**
   * WRITE_DONE: 把面板当前正文 (可能已被用户编辑) 写入文档。
   * 结构化 Markdown 插入 (标题/参考文献/正文按真实排版渲染, AI 蓝色标记);
   * 追加语义 —— 写入后继续编辑可再次写入更新版本。
   */
  const handleWriteToDoc = (): boolean => {
    if (!writingText.trim()) {
      setWriteMsg('⚠️ 正文为空，无法写入文档');
      return false;
    }
    const editor = getCollabSession(docId).editor;
    const ok = appendAiMarkdown(editor, ydocRef.current, writingText);
    if (ok) {
      setDocWritten(true);
      setWrittenSnapshot(writingText);
      setWriteMsg('✅ 已写入文档（AI 蓝色标记 · 结构化排版）');
    } else {
      setWriteMsg('⚠️ 写入失败：编辑器未就绪，请稍后重试');
    }
    return ok;
  };

  /** 审核结果摘要文案 (Supervisor 消息入列) */
  const reviewSummaryText = (result: ReviewResult): string =>
    result.redCards > 0
      ? `🟥 审稿完成：红牌 ${result.redCards} 项 / 黄牌 ${result.yellowCards} 项，存在严重问题，请优先修改下方卡片。`
      : result.yellowCards > 0
        ? `⚠️ 审稿完成：无红牌问题，${result.yellowCards} 条黄牌建议，详见下方卡片。`
        : '✅ 审稿通过：格式规范，无红牌无黄牌。';

  /** ⑤/⑦ 审核步骤: 只运行审核 Agent (规则红牌引擎), 完成后挂起等待用户 */
  const runReview = async (action: 'submit_review' | 'resubmit_review') => {
    const requestDocId = docId;
    setError(null);
    setRewriteResult(null);
    setReview(null); // 重新审核时先隐藏旧卡片, 避免展示过期意见
    setReviewMsg(null);
    if (!go(action)) return;
    appendThread([
      {
        id: `review-act-${Date.now()}`,
        role: 'user',
        content: action === 'submit_review' ? '提交审核' : '重新提交审核',
        createdAt: new Date().toISOString(),
      },
    ]);
    setStatuses({
      research: AgentStatusEnum.COMPLETED,
      writer: AgentStatusEnum.COMPLETED,
      supervisor: AgentStatusEnum.RUNNING,
    });
    try {
      // Writer -> 审核 数据传递: 审查对象 = 面板内用户最终确认的正文
      // (可能已手动编辑), 显式传 text, 不受文档落库时序影响;
      // 面板正文缺失时退回编辑器当前内容
      const editor = getCollabSession(requestDocId).editor;
      const reviewText = writingText.trim()
        ? writingText
        : editor
          ? docToMarkdown(editor.state.doc)
          : undefined;
      const result = await reviewDocument(requestDocId, reviewText);
      if (docIdRef.current !== requestDocId) return;
      setReview(result);
      appendThread([
        {
          id: `review-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: reviewSummaryText(result),
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatuses({
        research: AgentStatusEnum.COMPLETED,
        writer: AgentStatusEnum.COMPLETED,
        supervisor: AgentStatusEnum.COMPLETED,
      });
      go('review_succeeded');
    } catch (e) {
      if (docIdRef.current !== requestDocId) return;
      setReviewMsg(e instanceof Error ? e.message : '审核失败，请稍后重试');
      appendThread([
        {
          id: `review-err-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: `⚠️ 审核未完成：${e instanceof Error ? e.message : '未知错误'}`,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatuses({
        research: AgentStatusEnum.COMPLETED,
        writer: AgentStatusEnum.COMPLETED,
        supervisor: AgentStatusEnum.ERROR,
      });
      go('review_failed'); // 回到 WRITE_DONE, 可修改后再次提交审核
    }
  };

  /** WRITE_DONE: 「提交审核」按钮入口 (未写入文档时先同步最终版本) */
  const handleSubmitReview = () => {
    if (stage !== 'write_done' || busy) return;
    if (!docWritten) {
      // 文档尚无本轮正文: 先写入用户确认的最终版本,
      // 保证流程末端的文档级 AIGC 检测与审核对象一致
      if (!handleWriteToDoc()) return;
    }
    setWriteMsg(null);
    void runReview('submit_review');
  };

  /** REVIEW_DONE 且存在红牌: 「重新提交审核」按钮入口 (人工修改后可复审) */
  const handleResubmitReview = () => {
    if (stage !== 'review_done' || busy) return;
    void runReview('resubmit_review');
  };

  /** ⑦ REVIEW_DONE: 「确认并检测」-> CHECKING (AIGC 水印检测, 无自动下一步) */
  const handleConfirmDetect = async () => {
    if (stage !== 'review_done' || busy) return;
    const requestDocId = docId;
    setError(null);
    if (!go('confirm_detect')) return;
    appendThread([
      {
        id: `detect-act-${Date.now()}`,
        role: 'user',
        content: '确认并检测（AIGC 水印检测）',
        createdAt: new Date().toISOString(),
      },
    ]);
    try {
      // 审核 -> 检测: 检测对象 = Writer 生成正文所在文档 (每文档独立密钥口径)
      const det = await detectDocumentWatermark(requestDocId);
      if (docIdRef.current !== requestDocId) return;
      setDetection(det);
      appendThread([
        {
          id: `detect-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: `🔍 AIGC 水印检测（最终步骤）：判定为「${
            det.isAiGenerated ? 'AI 生成 · 含水印' : '人类创作'
          }」，z=${det.zScore.toFixed(2)}（阈值 4.0），AI 置信度 ${Math.round(
            det.confidence * 100
          )}%，已留痕至溯源链与检测历史。`,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatuses({
        research: AgentStatusEnum.COMPLETED,
        writer: AgentStatusEnum.COMPLETED,
        supervisor: AgentStatusEnum.COMPLETED,
      });
      go('detect_succeeded');
    } catch (e) {
      if (docIdRef.current !== requestDocId) return;
      setError(
        `AIGC 检测暂不可用：${e instanceof Error ? e.message : '未知错误'}`
      );
      appendThread([
        {
          id: `detect-err-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: `⚠️ AIGC 水印检测未完成：${
            e instanceof Error ? e.message : '未知错误'
          }`,
          createdAt: new Date().toISOString(),
        },
      ]);
      go('detect_failed'); // 回到 REVIEW_DONE, 可再次点击重试
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
        <h2 className="panel-title text-base">Agent 写作流程</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          搜索 → 写作 → 审核 → 检测 · 每步等待 {username} 确认
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
            串行流程：① 搜索文献 → ② 勾选确认 → ③ Writer 撰写 → ④ 提交审核 →
            ⑤ 确认并 AIGC 检测。每一步都由你点击按钮触发，Agent 不会自动进入下一步。
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
            {stage === 'searching' && '搜索 Agent 正在联网检索…'}
            {stage === 'writing' && '正在组织文献综述…'}
            {stage === 'reviewing' && '审核 Agent 正在检查…'}
            {stage === 'checking' && 'AIGC 水印检测执行中…'}
          </div>
        )}
      </div>

      {/* 审稿结果 (审稿人红牌卡片 + 润色该段); 审核完成 (REVIEW_DONE) 后展示 */}
      {review && (
        <div className="border-t border-slate-200 px-4 py-3 bg-slate-50/50">
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
        </div>
      )}

      {/* 流程操作台: 严格串行挂起-确认 (按钮随状态机显隐/禁用) */}
      <div className="border-t border-slate-200 px-4 pt-2.5 pb-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium text-slate-500">
            Agent 流程 · {AGENT_FLOW_META[stage].label}
          </span>
          {busy && (
            <span className="text-[10px] text-accent animate-pulse">
              正在调用 Agent，请勿重复操作…
            </span>
          )}
        </div>

        {error && (
          <div className="text-[11px] text-red-500 bg-red-50 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        {/* IDLE: 输入检索主题/写作要求 -> 点击「搜索」进入 SEARCHING */}
        {stage === 'idle' && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-slate-400 leading-relaxed">
              输入科研主题/写作要求后点击「搜索」：Agent 只会执行你点击的下一步，
              不会自动串联后续步骤。
            </p>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSearch();
                }
              }}
              placeholder="例如：AI 文本水印 / CRDT 协同 / 多 Agent 科研协作…"
              rows={2}
              className="w-full text-xs p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
            />
            <button
              onClick={() => void handleSearch()}
              disabled={busy || !topic.trim()}
              className="w-full text-xs font-medium px-3 py-2 rounded-lg bg-ink text-white hover:bg-ink-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              🔬 搜索文献（搜索 Agent）
            </button>
          </div>
        )}

        {/* SEARCHING / WRITING / REVIEWING / CHECKING: 进度提示 */}
        {(stage === 'searching' ||
          stage === 'writing' ||
          stage === 'reviewing' ||
          stage === 'checking') && (
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-300 border-t-accent animate-spin" />
            {stage === 'searching' && '搜索 Agent 正在联网检索文献…'}
            {stage === 'writing' &&
              `正在组织文献综述…（基于 ${references.length} 篇确认文献撰写结构化正文）`}
            {stage === 'reviewing' && '审核 Agent 正在检查正文规范（红牌/黄牌）…'}
            {stage === 'checking' && '正在执行 AIGC 水印检测（最终步骤）…'}
          </div>
        )}

        {/* SEARCH_DONE: 展示文献列表(可勾选) + 「确认文献」按钮 */}
        {stage === 'search_done' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-600">
                文献结果（{results.length}）
              </span>
              <button
                onClick={handleResetFlow}
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
                          onChange={() => handleToggleSelect(item.id)}
                          className="w-3.5 h-3.5 accent-accent mt-0.5"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] leading-snug text-slate-700 line-clamp-2">
                            {item.title}
                          </span>
                          <span className="block text-[10px] text-slate-400 mt-0.5">
                            {(item.authors ?? []).slice(0, 3).join('、') ||
                              '佚名'}
                            {item.source ? ` · ${item.source}` : ''}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* 附加要求 (可选): 随 writer_input.additional_requirements 提交 */}
            <input
              value={extraReq}
              onChange={(e) => setExtraReq(e.target.value)}
              placeholder="附加要求（可选）：如正文不少于 500 字、突出方法对比…"
              className="w-full text-[11px] px-2.5 py-1.5 rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <div className="flex items-center justify-between pt-1.5 border-t border-slate-100">
              <span className="text-[10px] text-slate-400">
                已选 {selectedIds.length} 篇（文献元数据将显式传入 Writer）
              </span>
              <button
                onClick={() => void handleConfirmLiterature()}
                disabled={busy || selectedIds.length === 0}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                确认文献 → Writer 开始写作
              </button>
            </div>
          </div>
        )}

        {/* WRITE_DONE: Markdown 预览/编辑双模式 + 写入文档 + 提交审核 */}
        {stage === 'write_done' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-600">
                ✍️ 生成正文 · {writingText.length} 字
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setWritingEditMode(false)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    !writingEditMode
                      ? 'bg-accent text-white'
                      : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  预览
                </button>
                <button
                  onClick={() => setWritingEditMode(true)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                    writingEditMode
                      ? 'bg-accent text-white'
                      : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  编辑
                </button>
              </div>
            </div>

            {writingEditMode ? (
              /* 编辑模式: 可编辑文本框 (提交审核前允许手动修改) */
              <textarea
                value={writingText}
                onChange={(e) => setWritingText(e.target.value)}
                rows={10}
                placeholder="Markdown 正文（# 标题 / ## 参考文献 / ## 正文）…"
                className="w-full text-[11px] font-mono leading-relaxed p-2.5 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-y slim-scroll"
              />
            ) : (
              /* 预览模式: Markdown 渲染 (markdown-it, html:false 已防注入) */
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
                onClick={handleWriteToDoc}
                disabled={busy || !writingText.trim()}
                className="flex-1 text-[11px] font-medium px-2 py-2 rounded-lg border border-accent text-accent hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                📄 写入文档（AI 蓝色标记）
              </button>
              <button
                onClick={handleSubmitReview}
                disabled={busy}
                className="flex-1 text-[11px] font-medium px-2 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                提交审核（审核 Agent）
              </button>
            </div>
          </div>
        )}

        {/* REVIEW_DONE: 「确认并检测」/「重新提交审核」(红牌时) */}
        {stage === 'review_done' && (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              🧠 审核意见见上方卡片。
              {review && !review.passed
                ? '存在红牌问题：可修改正文后点击「重新提交审核」，或直接执行最终 AIGC 检测。'
                : '点击下方按钮执行 AIGC 水印检测作为最终步骤。'}
            </p>
            {review && !review.passed && (
              <button
                onClick={handleResubmitReview}
                disabled={busy}
                className="w-full text-[11px] font-medium px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                重新提交审核
              </button>
            )}
            <button
              onClick={() => void handleConfirmDetect()}
              disabled={busy}
              className="w-full text-[11px] font-medium px-3 py-2 rounded-lg bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                ⚠️ 检测步骤未产生可用结果，请点击下方按钮重试或开始新一轮。
              </p>
            )}
            <button
              onClick={handleResetFlow}
              className="w-full text-[11px] font-medium px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 transition-colors"
            >
              开始新一轮流程
            </button>
          </div>
        )}
      </div>
    </aside>
  );
});
