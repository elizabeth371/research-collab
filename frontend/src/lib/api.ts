import type {
  Document,
  DocumentWatermarkParams,
  LLMGenerateResult,
  RobustnessResult,
  WatermarkDetectionResult,
  AgentMessage,
  AgentType,
  PolishChange,
  PolishResult,
  ReviewIssue,
  ReviewResult,
  RewriteChange,
  RewriteResult,
} from '@shared/types';

/**
 * 后端 API 客户端
 * -----------------
 * 与 FastAPI 后端对齐 (见 /backend/api/*.py):
 *   - 响应为裸 JSON (无 {success, data} 包装)
 *   - Agent 触发: POST /api/agents/invoke
 *   - Agent 消息: GET  /api/agents/sessions/{session_id}/messages
 *   - 水印检测:   POST /api/watermark/detect
 */

/** 后端 API 基础路径 */
const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API ${path} 请求失败: ${res.status} ${res.statusText}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

/** 后端 DocumentOut 原始响应 (snake_case) */
interface BackendDocument {
  id: string;
  title: string;
  owner_id: string;
  content: string;
  watermark_status: number;
  agent_session_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** 将后端 snake_case 文档响应映射为共享 camelCase 类型 */
const mapDocument = (raw: BackendDocument): Document => ({
  id: raw.id,
  title: raw.title,
  ownerId: raw.owner_id,
  content: raw.content,
  watermarkStatus: raw.watermark_status as Document['watermarkStatus'],
  agentSessionId: raw.agent_session_id,
  // 后端当前不返回协作者列表, 映射为空数组 (共享类型占位字段)
  collaborators: [],
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

/** 获取文档列表 */
export const listDocuments = async () => {
  const raw = await request<BackendDocument[]>('/documents');
  return raw.map(mapDocument);
};

/** 获取单个文档 */
export const getDocument = async (docId: string) => {
  const raw = await request<BackendDocument>(`/documents/${docId}`);
  return mapDocument(raw);
};

/** 创建文档 */
export const createDocument = async (payload: {
  title: string;
  ownerId: string;
  content?: string;
}) => {
  const raw = await request<BackendDocument>('/documents', {
    method: 'POST',
    // 后端 DocumentCreate 为 snake_case: title / owner_id / content
    body: JSON.stringify({
      title: payload.title,
      owner_id: payload.ownerId,
      content: payload.content ?? '',
    }),
  });
  return mapDocument(raw);
};

/** 更新文档 (标题 / 内容); operatorId 用于溯源链操作日志 */
export const updateDocument = (
  docId: string,
  payload: { title?: string; content?: string; operatorId?: string }
) =>
  request<Document>(`/documents/${docId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...(payload.title !== undefined && { title: payload.title }),
      ...(payload.content !== undefined && { content: payload.content }),
      ...(payload.operatorId !== undefined && {
        operator_id: payload.operatorId,
      }),
    }),
  });

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** 后端 /api/agents/invoke 的响应结构 */
export interface AgentInvokeResponse {
  accepted: boolean;
  session_id: string;
  message: string;
}

/** 后端 /api/agents/sessions/{id}/messages 的响应结构 */
export interface AgentMessagesResponse {
  session_id: string;
  messages: AgentMessage[];
  total: number;
}

/**
 * 触发 Agent 运行 (research / writer / supervisor)
 * 字段与后端 AgentInvokeRequest 对齐: doc_id, agent_type, instruction
 */
export const triggerAgent = (
  agentType: AgentType,
  docId: string,
  prompt: string,
  sessionId?: string
) =>
  request<AgentInvokeResponse>('/agents/invoke', {
    method: 'POST',
    body: JSON.stringify({
      agent_type: agentType,
      doc_id: docId,
      instruction: prompt,
      // 群聊会话: 传入已有 session_id 时在同一线程内追加多轮消息
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
  });

/** 获取 Agent 会话历史消息 (用于前端回放流式思考过程) */
export const getAgentMessages = (sessionId: string) =>
  request<AgentMessagesResponse>(
    `/agents/sessions/${sessionId}/messages`
  );

// ---------------------------------------------------------------------------
// 写稿人润色 / 审稿人红牌
// ---------------------------------------------------------------------------

/** 后端 /api/agents/polish 的原始响应 (snake_case, 见 api/agents.py) */
interface BackendPolishResponse {
  polished: string;
  changes: Array<{ type: PolishChange['type']; before: string; after: string }>;
  stats: {
    chars_before: number;
    chars_after: number;
    change_count: number;
    engine?: 'llm' | 'rule'; // 实际生效引擎 (配置 LLM Key 后为 llm)
  };
}

/** 写稿人润色: 对选中文本/段落执行学术化润色 (返回润色结果与变更清单) */
export const polishText = async (
  docId: string,
  text: string
): Promise<PolishResult> => {
  const raw = await request<BackendPolishResponse>('/agents/polish', {
    method: 'POST',
    body: JSON.stringify({ doc_id: docId, text }),
  });
  return {
    polished: raw.polished,
    changes: raw.changes,
    stats: {
      charsBefore: raw.stats.chars_before,
      charsAfter: raw.stats.chars_after,
      changeCount: raw.stats.change_count,
      ...(raw.stats.engine ? { engine: raw.stats.engine } : {}),
    },
  };
};

/** 后端 /api/agents/review 的原始响应 (snake_case) */
interface BackendReviewResponse {
  doc_id: string;
  passed: boolean;
  issues: Array<{
    level: ReviewIssue['level'];
    message: string;
    para_index?: number | null;
  }>;
  red_cards: number;
  yellow_cards: number;
  stats: Record<string, unknown>;
}

/** 审稿人红牌检查: 对文档当前全文执行红牌/黄牌分级审查 */
export const reviewDocument = async (
  docId: string
): Promise<ReviewResult> => {
  const raw = await request<BackendReviewResponse>('/agents/review', {
    method: 'POST',
    body: JSON.stringify({ doc_id: docId }),
  });
  return {
    docId: raw.doc_id,
    passed: raw.passed,
    issues: raw.issues.map((i) => ({
      level: i.level,
      message: i.message,
      paraIndex: i.para_index ?? null,
    })),
    redCards: raw.red_cards,
    yellowCards: raw.yellow_cards,
    stats: raw.stats,
  };
};

/** 后端 /api/agents/rewrite 的原始响应 (snake_case) */
interface BackendRewriteResponse {
  doc_id: string;
  rewritten: string;
  changes: Array<{
    type: RewriteChange['type'];
    before: string;
    after: string;
    para_index?: number | null;
  }>;
  red_cards_before: number;
  red_cards_after: number;
  passed_after: boolean;
  engine: RewriteResult['engine'];
}

/** 审稿红牌 -> 自动重写: 对文档当前全文执行规则修复并返回前后对比 */
export const rewriteDocument = async (
  docId: string,
  text?: string
): Promise<RewriteResult> => {
  const raw = await request<BackendRewriteResponse>('/agents/rewrite', {
    method: 'POST',
    body: JSON.stringify(text ? { doc_id: docId, text } : { doc_id: docId }),
  });
  return {
    docId: raw.doc_id,
    rewritten: raw.rewritten,
    changes: raw.changes.map((c) => ({
      type: c.type,
      before: c.before,
      after: c.after,
      paraIndex: c.para_index ?? null,
    })),
    redCardsBefore: raw.red_cards_before,
    redCardsAfter: raw.red_cards_after,
    passedAfter: raw.passed_after,
    engine: raw.engine,
  };
};

// ---------------------------------------------------------------------------
// 系统初始化 / 溯源链
// ---------------------------------------------------------------------------

/** /api/bootstrap 响应: 演示用户/文档与文档列表 */
export interface BootstrapResponse {
  demo_user_id: string;
  demo_doc_id: string;
  documents: Array<{
    id: string;
    title: string;
    owner_id: string;
    content: string;
    watermark_status: number;
    created_at: string;
    updated_at: string;
  }>;
}

/** 获取系统初始化数据 (演示用户 + 文档列表) */
export const fetchBootstrap = () => request<BootstrapResponse>('/bootstrap');

/** 溯源链条目 (后端 OpLogOut, snake_case) */
export interface ProvenanceEntry {
  id: string;
  doc_id: string;
  user_id: string;
  op_type: string;
  operation: Record<string, unknown>;
  prev_hash: string;
  current_hash: string;
  created_at: string;
}

/** 获取文档溯源哈希链 */
export const getProvenance = (docId: string) =>
  request<ProvenanceEntry[]>(`/watermark/documents/${docId}/provenance`);

/** 校验溯源链完整性 */
export const verifyProvenance = (docId: string) =>
  request<{ doc_id: string; valid: boolean; checked: number }>(
    `/watermark/documents/${docId}/provenance/verify`
  );

// ---------------------------------------------------------------------------
// 水印检测
// ---------------------------------------------------------------------------

/** 后端 /api/watermark/detect 的原始响应 (snake_case) */
interface BackendDetectResponse {
  is_ai_generated: boolean;
  confidence: number;
  watermark_chars: number;
  model_name?: string | null;
  z_score?: number;
  green_fraction?: number;
  num_tokens_scored?: number;
}

/**
 * 水印检测 (Kirchenbauer 解码)
 * 将后端 snake_case 响应映射为共享类型 WatermarkDetectionResult。
 */
export const detectWatermark = async (text: string): Promise<WatermarkDetectionResult> => {
  const raw = await request<BackendDetectResponse>('/watermark/detect', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });

  // 与 shared/types.ts 的 WatermarkDetectionResult 对齐
  return {
    docId: '',
    watermarkChars: raw.watermark_chars,
    confidence: raw.confidence,
    isAiGenerated: raw.is_ai_generated,
    latencyMs: 0,
    zScore: raw.z_score ?? 0,
    greenFraction: raw.green_fraction ?? 0,
    numTokensScored: raw.num_tokens_scored ?? 0,
  };
};

// ---------------------------------------------------------------------------
// 文献检索
// ---------------------------------------------------------------------------

/** 文献条目 (后端 LiteratureOut, snake_case) */
export interface LiteratureItem {
  id: string;
  title: string;
  authors: string;
  year: number;
  source: string;
  abstract: string;
  keywords: string;
  url?: string | null;
}

/** 检索文献 (关键词匹配标题/摘要/关键词) */
export const searchLiterature = (
  q: string,
  limit = 10
): Promise<LiteratureItem[]> =>
  request<LiteratureItem[]>(
    `/literature/search?q=${encodeURIComponent(q)}&limit=${limit}`
  );

/** 生成文献引文 (GB/T 7714 + BibTeX) */
export const getCitation = (
  litId: string
): Promise<{ citation: string; bibtex: string }> =>
  request<{ citation: string; bibtex: string }>(
    `/literature/${litId}/citation`
  );

// ---------------------------------------------------------------------------
// 导出 / 水印记录
// ---------------------------------------------------------------------------

/** 导出文档为 Markdown (含溯源元数据), 返回文本内容 */
export const exportDocument = async (docId: string): Promise<string> => {
  const res = await fetch(`${BASE_URL}/documents/${docId}/export`);
  if (!res.ok) {
    throw new Error(`导出失败: ${res.status} ${res.statusText}`);
  }
  return await res.text();
};

// ---------------------------------------------------------------------------
// 段落批注 (师门共研)
// ---------------------------------------------------------------------------
export interface CommentItem {
  id: string;
  doc_id: string;
  para_index: number;
  para_snapshot: string;
  author: string;
  content: string;
  created_at: string;
}

/** 列出文档全部批注 */
export const getComments = (docId: string) =>
  request<CommentItem[]>(`/documents/${docId}/comments`);

/** 新增批注 (锚定段落序号 + 段落文本快照) */
export const addComment = (
  docId: string,
  payload: {
    paraIndex: number;
    paraSnapshot: string;
    author: string;
    content: string;
  }
) =>
  request<CommentItem>(`/documents/${docId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      para_index: payload.paraIndex,
      para_snapshot: payload.paraSnapshot,
      author: payload.author,
      content: payload.content,
    }),
  });

/** 删除批注 */
export const deleteComment = (docId: string, commentId: string) =>
  request<void>(`/documents/${docId}/comments/${commentId}`, {
    method: 'DELETE',
  });

/** 文档级水印检测: 检测全文并持久化 WatermarkRecord + 溯源链日志 */
export const detectDocumentWatermark = async (
  docId: string
): Promise<WatermarkDetectionResult> => {
  const raw = await request<BackendDetectResponse>(
    `/watermark/documents/${docId}/detect`,
    { method: 'POST' }
  );
  // 与 detectWatermark 相同: 后端 DetectResponse 为 snake_case, 需映射
  return {
    docId,
    watermarkChars: raw.watermark_chars,
    confidence: raw.confidence,
    isAiGenerated: raw.is_ai_generated,
    latencyMs: 0,
    zScore: raw.z_score ?? 0,
    greenFraction: raw.green_fraction ?? 0,
    numTokensScored: raw.num_tokens_scored ?? 0,
  };
};

/**
 * 真实 LLM 生成 + 水印注入 (POST /api/watermark/generate-llm)
 * 需后端配置 LLM_API_KEY; 无 Key / 调用失败时后端返回 503 (抛错)。
 * 步骤 12: 传入 docId 时使用该文档的独立密钥/参数注入 (插入后可检出)。
 */
export const generateWatermarkedText = async (
  prompt: string,
  maxTokens = 300,
  docId?: string
): Promise<LLMGenerateResult> => {
  const raw = await request<{
    text: string;
    chars: number;
    engine: string;
    doc_id?: string | null;
    detect: BackendDetectResponse;
  }>('/watermark/generate-llm', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      max_tokens: maxTokens,
      ...(docId ? { doc_id: docId } : {}),
    }),
  });
  return {
    text: raw.text,
    chars: raw.chars,
    engine: raw.engine,
    docId: raw.doc_id ?? null,
    detect: {
      docId: '',
      watermarkChars: raw.detect.watermark_chars,
      confidence: raw.detect.confidence,
      isAiGenerated: raw.detect.is_ai_generated,
      latencyMs: 0,
      zScore: raw.detect.z_score ?? 0,
      greenFraction: raw.detect.green_fraction ?? 0,
      numTokensScored: raw.detect.num_tokens_scored ?? 0,
    },
  };
};

/**
 * 水印对抗鲁棒性实验 (POST /api/watermark/robustness)
 * 对已注入水印的文本施加攻击矩阵 (删除/截断/同义替换/噪声/乱序/可选回译),
 * 返回基线 + 各攻击后的 z 统计量与检出判定, 供论文实验表与面板可视化。
 * 步骤 12: 传入 docId 时用文档独立密钥检测 (与生成端一致)。
 */
export const runRobustnessTest = async (
  text: string,
  includeTranslation = false,
  docId?: string
): Promise<RobustnessResult> =>
  request<RobustnessResult>('/watermark/robustness', {
    method: 'POST',
    body: JSON.stringify({
      text,
      include_translation: includeTranslation,
      ...(docId ? { doc_id: docId } : {}),
    }),
  });

/** 获取文档水印参数 (γ / δ / 独立密钥指纹, 步骤 12) */
export const getDocWatermarkParams = (
  docId: string
): Promise<DocumentWatermarkParams> =>
  request<DocumentWatermarkParams>(
    `/watermark/documents/${docId}/params`
  );

/** 更新文档水印参数 (γ / δ / 重新生成密钥, 步骤 12) */
export const updateDocWatermarkParams = (
  docId: string,
  payload: { gamma?: number; delta?: number; regenerateKey?: boolean }
): Promise<DocumentWatermarkParams> =>
  request<DocumentWatermarkParams>(
    `/watermark/documents/${docId}/params`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...(payload.gamma !== undefined && { gamma: payload.gamma }),
        ...(payload.delta !== undefined && { delta: payload.delta }),
        ...(payload.regenerateKey !== undefined && {
          regenerate_key: payload.regenerateKey,
        }),
      }),
    }
  );

/** 水印记录条目 (后端 WatermarkRecord, snake_case) */
export interface WatermarkRecordItem {
  id: string;
  model_name: string;
  gamma: number;
  delta: number;
  created_at: string;
}

/** 获取文档的水印检测历史记录 */
export const getWatermarkRecords = (
  docId: string
): Promise<{ doc_id: string; records: WatermarkRecordItem[] }> =>
  request<{ doc_id: string; records: WatermarkRecordItem[] }>(
    `/watermark/documents/${docId}/records`
  );