/**
 * Agent 写作流程左栏 —— 三标签页容器 (任务 F)
 * ------------------------------------------------------------------
 * 顶部三个 Tab (调研助手 / 写作专家 / 审核导师) 各自拥有独立的对话
 * 消息列表与视觉区域, 但共享同一个全局流程状态机 (lib/agentFlow.ts):
 *   ① 调研助手: 检索 -> 勾选 -> 确认文献 (蓝色)
 *   ② 写作专家: 接收文献 -> Writer 撰写 -> 预览/编辑 -> 提交审核 (绿色)
 *   ③ 审核导师: 审稿红牌/黄牌 -> 确认并检测 -> 最终报告 (橙色)
 *
 * 容器持有全部流程状态与 handler (逻辑与串行挂起-确认模式一致,
 * 任何 Agent 不自动触发下一步); 三个子 Tab 为纯展示组件,
 * 切换 Tab 不卸载容器, 历史与进行中的任务均不丢失。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
import { docToMarkdown } from '../../lib/markdown';
import { getCollabSession } from '../../lib/collab';
import { AGENT_TABS, type AgentTabKey, type ChatItem } from './AgentTabs';
import { ResearchTab } from './ResearchTab';
import { WriterTab } from './WriterTab';
import { ReviewTab } from './ReviewTab';

/** 线程缓存: 每文档、每 Tab 独立保存 (切换 Tab / 重挂载后历史不丢失) */
const threadCache = new Map<string, ChatItem[]>();

/** 缓存上限: 只保留最近使用的 N 个键, 防止长会话内存无界增长 */
const MAX_CACHED_KEYS = 60;

/** LRU 写入 (Map 按插入序淘汰最旧): 重写已有键时先删再插, 保证其"新鲜" */
function cacheSet<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

const threadKey = (docId: string, tab: AgentTabKey) => `${docId}:${tab}`;

interface AgentPanelProps {
  docId: string;
  username: string;
  ydoc: Y.Doc;
}

const STATUS_META: Record<AgentStatus, { label: string; dot: string }> = {
  idle: { label: '空闲', dot: 'bg-gray-300' },
  running: { label: '运行中', dot: 'bg-blue-500 animate-pulse' },
  waiting_human: { label: '等待人工', dot: 'bg-amber-500 animate-pulse' },
  completed: { label: '已完成', dot: 'bg-green-500' },
  error: { label: '出错', dot: 'bg-red-500' },
};

// memo: props (docId/username/ydoc) 在无关 App 状态变化时不变, 跳过重渲染
export const AgentPanel = memo(function AgentPanel({ docId, username, ydoc }: AgentPanelProps) {
  // ---- 当前激活的 Tab (纯展示层状态; 不影响流程状态机) ----
  const [activeTab, setActiveTab] = useState<AgentTabKey>('research');

  const [statuses, setStatuses] = useState<Record<AgentType, AgentStatus>>({
    research: AgentStatusEnum.IDLE,
    writer: AgentStatusEnum.IDLE,
    supervisor: AgentStatusEnum.IDLE,
  });
  // ---- 三个 Tab 各自独立的消息列表 (切换不清空) ----
  const [threads, setThreads] = useState<Record<AgentTabKey, ChatItem[]>>(() => ({
    research: threadCache.get(threadKey(docId, 'research')) ?? [],
    writer: threadCache.get(threadKey(docId, 'writer')) ?? [],
    review: threadCache.get(threadKey(docId, 'review')) ?? [],
  }));
  const [error, setError] = useState<string | null>(null);
  // ---- 全局共享且唯一的流程状态机 (9 态, 流转表见 lib/agentFlow.ts) ----
  const [stage, setStage] = useState<AgentFlowStage>('idle');
  const [topic, setTopic] = useState('');
  const [results, setResults] = useState<SearchPaper[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [references, setReferences] = useState<SearchPaper[]>([]);
  const [writingText, setWritingText] = useState('');
  // ---- Writer 结构化输出展示 (预览/编辑双模式) ----
  const [extraReq, setExtraReq] = useState('');
  const [writingEditMode, setWritingEditMode] = useState(false);
  const [docWritten, setDocWritten] = useState(false);
  const [writtenSnapshot, setWrittenSnapshot] = useState('');
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
  const researchScrollRef = useRef<HTMLDivElement>(null);
  const writerScrollRef = useRef<HTMLDivElement>(null);
  const reviewScrollRef = useRef<HTMLDivElement>(null);

  // 步骤正在调用 Agent / 联网: 禁用全部按钮并渲染进度动画
  const busy = FLOW_BUSY_STAGES.has(stage);

  /** 切换文档: 恢复该文档各 Tab 的历史线程, 并将流程状态机重置回 IDLE */
  useEffect(() => {
    setThreads({
      research: threadCache.get(threadKey(docId, 'research')) ?? [],
      writer: threadCache.get(threadKey(docId, 'writer')) ?? [],
      review: threadCache.get(threadKey(docId, 'review')) ?? [],
    });
    setActiveTab('research');
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

  /** 追加消息到指定 Tab 的线程 (同步写回缓存, 按 id 去重) */
  const appendThread = (tab: AgentTabKey, items: ChatItem[]) => {
    setThreads((prev) => {
      const cur = prev[tab];
      const ids = new Set(cur.map((i) => i.id));
      const next = [...cur];
      for (const it of items) {
        if (!ids.has(it.id)) {
          next.push(it);
          ids.add(it.id);
        }
      }
      cacheSet(threadCache, threadKey(docId, tab), next);
      return { ...prev, [tab]: next };
    });
  };

  // 新消息到达时自动滚动当前激活线程到底部
  useEffect(() => {
    const el =
      activeTab === 'research'
        ? researchScrollRef.current
        : activeTab === 'writer'
          ? writerScrollRef.current
          : reviewScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [threads, busy, activeTab]);

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

  /** 重置本轮流程 (任意状态 -> IDLE, 可开始新一轮; 不清空三个 Tab 的历史) */
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
    setActiveTab('research');
  };

  /** ① 调研助手: IDLE + 用户点击「搜索」-> SEARCHING -> SEARCH_DONE */
  const handleSearch = async () => {
    const keyword = topic.trim();
    if (!keyword || busy || stage !== 'idle') return;
    const requestDocId = docId;
    setError(null);
    setResults([]);
    setSelectedIds([]);
    if (!go('begin_search')) return;
    appendThread('research', [
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
        appendThread('research', [
          {
            id: `search-done-${Date.now()}`,
            role: 'agent',
            agentType: AgentType.RESEARCH,
            content:
              data.length > 0
                ? `🔬 搜索完成：共检索到 ${data.length} 篇相关文献。请勾选至少 1 篇后点击「确认文献 → 移交写作专家」。`
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

  /** ② SEARCH_DONE: 勾选 >=1 篇 + 点击「确认文献」-> WRITING (只跑 Writer) */
  const handleConfirmLiterature = async () => {
    if (stage !== 'search_done' || busy) return;
    const refs = results.filter((r) => selectedIds.includes(r.id));
    if (refs.length === 0) return;
    const requestDocId = docId;
    const writeTopic = topic.trim() || 'AI 水印与版权溯源';
    setError(null);
    setReferences(refs);
    if (!go('confirm_literature')) return;
    // 跨 Tab 交接: 文献确认消息入调研助手线程, 写作启动消息入写作专家线程
    appendThread('research', [
      {
        id: `confirm-${Date.now()}`,
        role: 'user',
        content: `确认 ${refs.length} 篇文献，移交写作专家撰写正文。`,
        createdAt: new Date().toISOString(),
      },
    ]);
    appendThread('writer', [
      {
        id: `recv-${Date.now()}`,
        role: 'user',
        content: `已接收 ${refs.length} 篇确认文献，请围绕主题「${writeTopic}」撰写结构化正文。`,
        createdAt: new Date().toISOString(),
      },
    ]);
    // 用户此刻的注意力移交给写作专家
    setActiveTab('writer');
    setStatuses({
      research: AgentStatusEnum.COMPLETED,
      writer: AgentStatusEnum.RUNNING,
      supervisor: AgentStatusEnum.IDLE,
    });

    // Writer 结构化输入契约: {user_topic, confirmed_literature,
    // additional_requirements} 随请求显式提交; references 冗余提交兼容旧字段。
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
        'writer',
        msgs.map((m) => ({
          id: m.id,
          role: 'agent' as const,
          agentType: m.agentType,
          content: m.content,
          createdAt: m.createdAt ?? new Date().toISOString(),
          watermarked: m.watermarked,
        }))
      );

      // 正文进入面板「预览/编辑」区 (Markdown 渲染, 可手动修改),
      // 由用户显式点击「写入文档」或「提交审核」时才写入 Yjs
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
   * 结构化 Markdown 插入 (标题/参考文献/正文按真实排版渲染, AI 蓝色标记)。
   */
  const handleWriteToDoc = (textOverride?: string): boolean => {
    const text = (textOverride ?? writingText).trim();
    if (!text) {
      setWriteMsg('⚠️ 正文为空，无法写入文档');
      return false;
    }
    const editor = getCollabSession(docId).editor;
    const ok = appendAiMarkdown(editor, ydocRef.current, text);
    if (ok) {
      setDocWritten(true);
      setWrittenSnapshot(text);
      setWriteMsg('✅ 已写入文档（AI 蓝色标记 · 结构化排版）');
    } else {
      setWriteMsg('⚠️ 写入失败：编辑器未就绪，请稍后重试');
    }
    return ok;
  };

  /** 审核结果摘要文案 (入审核导师线程) */
  const reviewSummaryText = (result: ReviewResult): string =>
    result.redCards > 0
      ? `🟥 审稿完成：红牌 ${result.redCards} 项 / 黄牌 ${result.yellowCards} 项，存在严重问题，请优先修改下方卡片。`
      : result.yellowCards > 0
        ? `⚠️ 审稿完成：无红牌问题，${result.yellowCards} 条黄牌建议，详见下方卡片。`
        : '✅ 审稿通过：格式规范，无红牌无黄牌。';

  /** ④/⑥ 审核步骤: 只运行审核 Agent (规则红牌引擎), 完成后挂起等待用户 */
  const runReview = async (action: 'submit_review' | 'resubmit_review') => {
    const requestDocId = docId;
    setError(null);
    setRewriteResult(null);
    setReview(null); // 重新审核时先隐藏旧卡片, 避免展示过期意见
    setReviewMsg(null);
    if (!go(action)) return;
    appendThread('review', [
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
      // (可能已手动编辑), 显式传 text, 不受文档落库时序影响
      const editor = getCollabSession(requestDocId).editor;
      const reviewText = writingText.trim()
        ? writingText
        : editor
          ? docToMarkdown(editor.state.doc)
          : undefined;
      const result = await reviewDocument(requestDocId, reviewText);
      if (docIdRef.current !== requestDocId) return;
      setReview(result);
      appendThread('review', [
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
      appendThread('review', [
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

  /**
   * WRITE_DONE: 「提交审核」按钮入口 (未写入文档时先同步最终版本)。
   * @param switchToReviewTab 从写作专家/审核导师点击时切到审核导师展示进度
   */
  const handleSubmitReview = (switchToReviewTab = true) => {
    if (stage !== 'write_done' || busy) return;
    if (!docWritten) {
      // 文档尚无本轮正文: 先写入用户确认的最终版本,
      // 保证流程末端的文档级 AIGC 检测与审核对象一致
      if (!handleWriteToDoc()) return;
    }
    setWriteMsg(null);
    if (switchToReviewTab) setActiveTab('review');
    void runReview('submit_review');
  };

  /** REVIEW_DONE 且存在红牌: 「重新提交审核」按钮入口 (人工修改后可复审) */
  const handleResubmitReview = () => {
    if (stage !== 'review_done' || busy) return;
    void runReview('resubmit_review');
  };

  /** ⑥ REVIEW_DONE: 「确认并检测」-> CHECKING (AIGC 水印检测, 无自动下一步) */
  const handleConfirmDetect = async () => {
    if (stage !== 'review_done' || busy) return;
    const requestDocId = docId;
    setError(null);
    if (!go('confirm_detect')) return;
    appendThread('review', [
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
      appendThread('review', [
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
      appendThread('review', [
        {
          id: `detect-err-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: `⚠️ AIGC 检测未完成：${
            e instanceof Error ? e.message : '未知错误'
          }`,
          createdAt: new Date().toISOString(),
        },
      ]);
      go('detect_failed'); // 回退到 REVIEW_DONE 可重试
    }
  };

  /** 取文档第 N 个顶层块 (1 起) 的文本与范围, 供「润色该段」定位 */
  const getBlockAt = (
    paraIndex: number
  ): { text: string; from: number; to: number } | null => {
    const editor = getCollabSession(docId).editor;
    if (!editor) return null;
    let idx = 0;
    let found: { text: string; from: number; to: number } | null = null;
    editor.state.doc.forEach((node, offset) => {
      idx += 1;
      if (idx === paraIndex && found === null) {
        found = { text: node.textContent, from: offset, to: offset + node.nodeSize };
      }
    });
    return found;
  };

  /** 审稿卡片「润色该段」: 对指定段落调用写稿人润色并原地替换 (AI 蓝色标记) */
  const handlePolishParagraph = async (paraIndex: number) => {
    if (polishingPara !== null) return;
    const block = getBlockAt(paraIndex);
    if (!block || !block.text.trim()) {
      setReviewMsg(`⚠️ 第 ${paraIndex} 段为空或不存在，无法润色`);
      return;
    }
    setPolishingPara(paraIndex);
    setReviewMsg(null);
    try {
      const result = await polishText(docId, block.text);
      if (!result.polished || result.polished === block.text) {
        setReviewMsg(`第 ${paraIndex} 段已符合规范，无需润色`);
        return;
      }
      const editor = getCollabSession(docId).editor;
      editor?.chain().focus()
        .deleteRange({ from: block.from, to: block.to })
        .insertContentAt(block.from, {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: result.polished,
              marks: [{ type: 'author', attrs: { author: AUTHOR_AI } }],
            },
          ],
        })
        .run();
      setReviewMsg(
        `✅ 第 ${paraIndex} 段已润色（${result.stats.changeCount} 处变更，AI 蓝色标记）`
      );
    } catch (e) {
      setReviewMsg(`润色失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setPolishingPara(null);
    }
  };

  /** 审稿红牌 -> 自动重写: 规则修复全文红牌, 结果进入前后对比卡片 */
  const handleRewrite = async () => {
    if (rewriting) return;
    setRewriting(true);
    setReviewMsg(null);
    try {
      const editor = getCollabSession(docId).editor;
      const text = editor ? docToMarkdown(editor.state.doc) : undefined;
      const result = await rewriteDocument(docId, text);
      setRewriteResult(result);
      appendThread('review', [
        {
          id: `rewrite-${Date.now()}`,
          role: 'agent',
          agentType: AgentType.SUPERVISOR,
          content: `🔄 自动重写完成：红牌 ${result.redCardsBefore} → ${result.redCardsAfter} 项，共 ${result.changes.length} 处变更，请核对后应用。`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      setReviewMsg(e instanceof Error ? e.message : '自动重写失败');
    } finally {
      setRewriting(false);
    }
  };

  /** 应用重写版本: 整篇替换为 AI 蓝色标记内容 (标题 + 段落结构) */
  const handleApplyRewrite = () => {
    if (!rewriteResult) return;
    const editor = getCollabSession(docId).editor;
    if (!editor) return;
    // 复用与旧版一致的轻量 Markdown -> Tiptap JSON (标题 + 段落, author 标记)
    const blocks: unknown[] = [];
    let paraLines: string[] = [];
    const flush = () => {
      if (paraLines.length > 0) {
        blocks.push({
          type: 'paragraph',
          content: [
            { type: 'text', text: paraLines.join('\n'), marks: [{ type: 'author', attrs: { author: AUTHOR_AI } }] },
          ],
        });
        paraLines = [];
      }
    };
    for (const line of rewriteResult.rewritten.split('\n')) {
      const head = line.match(/^(#{1,6})\s+(.+)$/);
      if (head) {
        flush();
        blocks.push({
          type: 'heading',
          attrs: { level: head[1].length },
          content: [
            { type: 'text', text: head[2], marks: [{ type: 'author', attrs: { author: AUTHOR_AI } }] },
          ],
        });
      } else if (line.trim()) {
        paraLines.push(line);
      } else {
        flush();
      }
    }
    flush();
    editor.commands.setContent(blocks, true);
    setReviewMsg('✅ 重写版本已应用到文档（AI 蓝色标记），可重新审稿复查');
    setRewriteResult(null);
    setReview(null);
  };

  /** 审核导师交接卡片用稿件标题: 取正文一级标题, 缺省回退主题 */
  const manuscriptTitle = useMemo(() => {
    const m = writingText.match(/^#\s+(.+)$/m);
    return m?.[1]?.trim() || topic.trim() || '未命名稿件';
  }, [writingText, topic]);

  return (
    <aside className="w-80 xl:w-96 shrink-0 flex flex-col bg-white border-r border-gray-200 h-full min-h-0">
      {/* 面板标题 + 全局状态机进度 (三个 Tab 共享) */}
      <div className="px-4 py-3 border-b border-slate-200">
        <div className="flex items-center justify-between gap-2">
          <h2 className="panel-title text-base">Agent 写作流程</h2>
          <span className="text-[10px] font-medium text-slate-500 bg-slate-100 rounded-full px-2 py-0.5 whitespace-nowrap">
            {AGENT_FLOW_META[stage].label}
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-0.5">
          搜索 → 写作 → 审核 → 检测 · 每步等待 {username} 确认
        </p>
      </div>

      {/* 三个 Agent 状态点 (共享视图) */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-slate-50/60">
        {AGENT_TABS.map((t) => {
          const st = statuses[t.agentType];
          return (
            <span
              key={t.key}
              className="flex items-center gap-1 text-[10px] text-slate-500"
              title={STATUS_META[st]?.label}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_META[st]?.dot}`} />
              {t.emoji} {t.name}
            </span>
          );
        })}
      </div>

      {/* ======== 顶部三标签页 (点击完全切换中间主体) ======== */}
      <div className="flex border-b border-slate-200 shrink-0">
        {AGENT_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex-1 py-2.5 text-xs font-medium border-b-2 border-transparent transition-colors ${
              activeTab === t.key
                ? t.theme.active
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span className="mr-1">{t.emoji}</span>
            {t.name}
          </button>
        ))}
      </div>

      {/* ======== 当前 Tab 工作区 (独立对话框; 条件渲染, 状态保留在容器) ======== */}
      {activeTab === 'research' && (
        <ResearchTab
          thread={threads.research}
          stage={stage}
          busy={busy}
          topic={topic}
          onTopicChange={setTopic}
          results={results}
          selectedIds={selectedIds}
          extraReq={extraReq}
          onExtraReqChange={setExtraReq}
          references={references}
          error={error}
          onSearch={() => void handleSearch()}
          onToggleSelect={handleToggleSelect}
          onConfirm={() => void handleConfirmLiterature()}
          onReset={handleResetFlow}
        />
      )}

      {activeTab === 'writer' && (
        <WriterTab
          thread={threads.writer}
          stage={stage}
          busy={busy}
          references={references}
          topic={topic}
          writingText={writingText}
          onWritingTextChange={setWritingText}
          writingEditMode={writingEditMode}
          onWritingEditModeChange={setWritingEditMode}
          docWritten={docWritten}
          writtenSnapshot={writtenSnapshot}
          writeMsg={writeMsg}
          error={error}
          onWriteToDoc={() => void handleWriteToDoc()}
          onSubmitReview={() => handleSubmitReview(true)}
        />
      )}

      {activeTab === 'review' && (
        <ReviewTab
          thread={threads.review}
          stage={stage}
          busy={busy}
          manuscriptTitle={manuscriptTitle}
          review={review}
          reviewMsg={reviewMsg}
          rewriting={rewriting}
          rewriteResult={rewriteResult}
          polishingPara={polishingPara}
          detection={detection}
          error={error}
          onSubmitReview={() => handleSubmitReview(false)}
          onResubmit={handleResubmitReview}
          onConfirmDetect={() => void handleConfirmDetect()}
          onPolishParagraph={(i) => void handlePolishParagraph(i)}
          onRewrite={() => void handleRewrite()}
          onDismissRewrite={() => setRewriteResult(null)}
          onApplyRewrite={handleApplyRewrite}
          onReset={handleResetFlow}
        />
      )}
    </aside>
  );
});
