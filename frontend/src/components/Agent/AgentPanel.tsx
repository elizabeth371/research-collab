import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { AgentMessage, AgentStatus, AgentType } from '@shared/types';
import { AgentStatus as AgentStatusEnum } from '@shared/types';
import { triggerAgent, getAgentMessages } from '../../lib/api';
import { appendAiText } from '../../lib/yjs';
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
                  disabled
                  className="mt-3 w-full text-xs py-1.5 rounded-md bg-slate-100 text-slate-400 cursor-not-allowed"
                >
                  质量总控 · 编排时自动运行
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
