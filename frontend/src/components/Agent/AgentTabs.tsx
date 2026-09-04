/**
 * Agent 三标签页导航元数据 (任务 F)
 * ==================================================
 * 顶部三个 Tab 对应三个 Agent 的独立工作区:
 *   调研助手 (搜索 Agent) / 写作专家 (Writer Agent) / 审核导师 (审核 Agent)
 *
 * 约束: 三个 Tab 共享同一个全局流程状态机 (lib/agentFlow.ts 的 stage),
 * 但各自维护独立的消息列表; 本文件只定义展示层元数据与主题色,
 * 不包含任何流程逻辑。
 */

import { AgentType } from '@shared/types';

export type AgentTabKey = 'research' | 'writer' | 'review';

/** 一条对话消息 (每个 Tab 各自维护一份) */
export interface ChatItem {
  id: string;
  role: 'user' | 'agent';
  agentType?: AgentType;
  content: string;
  createdAt: string;
  /** Writer 产出是否已注入 AI 水印 (显示「已加水印」徽章) */
  watermarked?: boolean;
}

/** 单个 Tab 的主题色 (搜索=蓝 / 写作=绿 / 审核=橙) */
export interface AgentTabTheme {
  /** Tab 激活态: 文字色 + 下划线 + 浅色背景 */
  active: string;
  /** 主按钮 (实底) */
  btn: string;
  /** 次按钮 (描边) */
  btnOutline: string;
  /** 交接卡片边框/背景 */
  card: string;
  /** 小徽章 */
  chip: string;
  /** 进度动画强调色 (spinner 边框) */
  spinner: string;
}

export interface AgentTabMeta {
  key: AgentTabKey;
  /** Tab 名称 */
  name: string;
  /** 图标 */
  emoji: string;
  /** 对应 Agent */
  agentType: AgentType;
  /** 一句话职责描述 (副标题) */
  description: string;
  theme: AgentTabTheme;
}

/** 三个 Tab 的展示元数据 (顺序即渲染顺序) */
export const AGENT_TABS: AgentTabMeta[] = [
  {
    key: 'research',
    name: '调研助手',
    emoji: '📚',
    agentType: AgentType.RESEARCH,
    description: '文献检索与确认',
    theme: {
      active: 'text-accent border-accent bg-accent/5',
      btn: 'bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed',
      btnOutline:
        'border border-accent text-accent hover:bg-accent/5 disabled:opacity-40 disabled:cursor-not-allowed',
      card: 'border-accent/30 bg-accent/5',
      chip: 'bg-accent/10 text-accent',
      spinner: 'border-t-accent',
    },
  },
  {
    key: 'writer',
    name: '写作专家',
    emoji: '✍️',
    agentType: AgentType.WRITER,
    description: '结构化正文撰写',
    theme: {
      active: 'text-emerald-600 border-emerald-500 bg-emerald-50',
      btn: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed',
      btnOutline:
        'border border-emerald-500 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed',
      card: 'border-emerald-200 bg-emerald-50/60',
      chip: 'bg-emerald-100 text-emerald-700',
      spinner: 'border-t-emerald-500',
    },
  },
  {
    key: 'review',
    name: '审核导师',
    emoji: '🎓',
    agentType: AgentType.SUPERVISOR,
    description: '审稿与 AIGC 检测',
    theme: {
      active: 'text-orange-600 border-orange-500 bg-orange-50',
      btn: 'bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed',
      btnOutline:
        'border border-orange-400 text-orange-600 hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed',
      card: 'border-orange-200 bg-orange-50/70',
      chip: 'bg-orange-100 text-orange-700',
      spinner: 'border-t-orange-500',
    },
  },
];

export const AGENT_TAB_MAP = Object.fromEntries(
  AGENT_TABS.map((t) => [t.key, t])
) as Record<AgentTabKey, AgentTabMeta>;
