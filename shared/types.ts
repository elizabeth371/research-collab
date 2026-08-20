/**
 * 前后端共享类型定义
 * 面向科研诚信的多Agent实时协同与版权溯源系统
 */

// ==================== 用户 ====================

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: UserRole;
  createdAt: string; // ISO 8601
}

export enum UserRole {
  ADMIN = 'admin',
  RESEARCHER = 'researcher',
  COLLABORATOR = 'collaborator',
  AI_AGENT = 'ai_agent', // AI Agent 在系统中也以特殊用户身份参与
}

// ==================== 文档 ====================

export interface Document {
  id: string;
  title: string;
  ownerId: string;
  /** 协同状态快照 (Yjs Update 二进制序列化为 base64) */
  yjsState?: string | null;
  /** 文档当前内容 (明文快照，便于快速预览) */
  content: string;
  /** 水印标识: 0-未检测 1-存在AI水印 2-纯人类创作 */
  watermarkStatus: WatermarkStatus;
  /** 关联的 Agent 会话 ID */
  agentSessionId?: string | null;
  collaborators: string[]; // userId 列表
  createdAt: string;
  updatedAt: string;
}

export enum WatermarkStatus {
  UNKNOWN = 0,
  AI_WATERMARKED = 1,
  HUMAN = 2,
}

// ==================== 操作日志 (版权溯源) ====================

/**
 * 操作日志形成哈希链:
 * prev_hash -> current_hash(sha256(prev_hash + operation_json + timestamp))
 * 任一历史操作被篡改，整条链即断裂，可被服务端校验。
 */
export interface OpLog {
  id: string;
  docId: string;
  userId: string;
  /** 操作类型: insert | delete | replace | ai_generate | watermark_checked */
  opType: string;
  /** 操作内容 (JSONB) */
  operation: Record<string, unknown>;
  prevHash: string;
  currentHash: string;
  createdAt: string;
}

// ==================== Agent 消息 ====================

export enum AgentType {
  RESEARCH = 'research',
  WRITER = 'writer',
  SUPERVISOR = 'supervisor',
}

export enum AgentStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  WAITING_HUMAN = 'waiting_human',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export interface AgentState {
  type: AgentType;
  status: AgentStatus;
  /** 目标文档 ID */
  docId?: string;
  /** 当前思考步骤描述 */
  currentStep?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Agent 实时流式消息 (通过 WebSocket / SSE 推送) */
export interface AgentMessage {
  id: string;
  sessionId: string;
  agentType: AgentType;
  role: 'agent' | 'human' | 'system';
  content: string;
  /** 思考过程标签: planning | search | reasoning | writing | review | done */
  phase: string;
  createdAt: string;
}

// ==================== 水印检测结果 ====================

export interface WatermarkDetectionResult {
  docId: string;
  /** 检测到的水印字符数 */
  watermarkChars: number;
  /** 置信度 0~1 */
  confidence: number;
  /** 是否判定为 AI 生成 */
  isAiGenerated: boolean;
  /** 检测耗时 ms */
  latencyMs: number;
}

// ==================== API 通用响应 ====================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** WebSocket 消息协议 */
export type WsMessage =
  | { type: 'connected'; clientId: string; docId: string }
  | { type: 'agent_update'; payload: AgentMessage }
  | { type: 'agent_state'; payload: AgentState }
  | { type: 'sync_ready'; docId: string; clientCount: number }
  | { type: 'error'; message: string };