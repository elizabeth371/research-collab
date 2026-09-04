/**
 * Agent Tab 公共子组件
 * ==================================================
 * TabMessageStream: 每个 Tab 独立的对话消息流 (渲染逻辑一致, 数据各自独立)
 * TabHandoffCard:   跨 Tab 数据流转可视化卡片 (顶部提示)
 *
 * 均为纯展示组件, 不持有流程状态。
 */

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import type { AgentType } from '@shared/types';
import type { ChatItem } from './AgentTabs';

/** Agent 气泡元数据 (头像/名称/配色, 与原 AgentPanel 一致) */
const AGENT_META: Record<
  AgentType,
  { label: string; emoji: string; bubble: string; avatar: string }
> = {
  research: {
    label: 'Research Agent',
    emoji: '🔬',
    bubble: 'border-blue-200 bg-blue-50',
    avatar: 'border-blue-200 bg-blue-50',
  },
  writer: {
    label: 'Writer Agent',
    emoji: '✍️',
    bubble: 'border-emerald-200 bg-emerald-50',
    avatar: 'border-emerald-200 bg-emerald-50',
  },
  supervisor: {
    label: 'Supervisor Agent',
    emoji: '🧠',
    bubble: 'border-purple-200 bg-purple-50',
    avatar: 'border-purple-200 bg-purple-50',
  },
};

interface TabMessageStreamProps {
  thread: ChatItem[];
  /** 空列表时的引导文案 */
  emptyHint: string;
  /** 本 Tab 正在执行时的进度文案 (为空则不渲染进度气泡) */
  busyText?: string;
  /** spinner 强调色类 (如 'border-t-accent') */
  spinnerClass?: string;
}

/** 单个 Tab 的独立消息流 (用户气泡 + Agent 气泡 + 忙碌进度) */
export const TabMessageStream = forwardRef<HTMLDivElement, TabMessageStreamProps>(
  function TabMessageStream({ thread, emptyHint, busyText, spinnerClass }, ref) {
    return (
      <div
        ref={ref}
        className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2.5 slim-scroll min-h-0"
      >
        {thread.length === 0 && (
          <div className="text-[11px] text-slate-400 leading-relaxed mt-1">
            {emptyHint}
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
                className={`w-7 h-7 rounded-lg border flex items-center justify-center text-sm shrink-0 mt-0.5 shadow-sm ${
                  AGENT_META[m.agentType ?? 'supervisor']?.avatar ??
                  AGENT_META.supervisor.avatar
                }`}
              >
                {AGENT_META[m.agentType ?? 'supervisor']?.emoji ?? '🧠'}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[10px] text-slate-400">
                    {AGENT_META[m.agentType ?? 'supervisor']?.label ??
                      'Supervisor Agent'}
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
                  className={`rounded-xl rounded-tl-sm border text-[11px] leading-relaxed px-2.5 py-2 text-slate-700 whitespace-pre-wrap break-words ${
                    AGENT_META[m.agentType ?? 'supervisor']?.bubble ??
                    AGENT_META.supervisor.bubble
                  }`}
                >
                  {m.content}
                </div>
              </div>
            </div>
          )
        )}

        {busyText && (
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span
              className={`inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-300 animate-spin shrink-0 ${
                spinnerClass ?? 'border-t-accent'
              }`}
            />
            {busyText}
          </div>
        )}
      </div>
    );
  }
);

interface TabHandoffCardProps {
  /** 卡片主题色 (边框/背景类) */
  cardClass: string;
  /** 徽章类 (如 'bg-emerald-100 text-emerald-700') */
  chipClass?: string;
  children: ReactNode;
}

/** 跨 Tab 数据交接卡片 (对话框顶部, 展示上游步骤传入的数据) */
export function TabHandoffCard({ cardClass, chipClass, children }: TabHandoffCardProps) {
  return (
    <div className={`mx-3 mt-2.5 rounded-lg border px-3 py-2 ${cardClass}`}>
      {chipClass ? (
        <span
          className={`inline-block text-[9px] font-semibold px-1.5 py-px rounded-full mb-1 ${chipClass}`}
        >
          跨 Tab 数据交接
        </span>
      ) : null}
      {children}
    </div>
  );
}
