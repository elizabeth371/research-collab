/**
 * Agent 写作流程状态机 (严格串行挂起-确认模式)
 * ==================================================
 * 定义 9 个状态与合法流转表。设计约束:
 *   - 任何 Agent 都不得自动触发下一步: 三个 Agent 的调用全部由用户
 *     显式点击按钮发起 (前端只在对应挂起状态渲染该按钮);
 *   - 除用户操作外不存在其它流转入口, transition() 之外的任何路径
 *     都会抛错 (防止误用导致乱序执行);
 *   - 状态流转只做校验与推进, 不负责副作用 (副作用在组件 handler 内);
 *
 * 状态流转总表:
 *   IDLE           --用户点击「搜索」--> SEARCHING
 *   SEARCHING      --搜索返回--> SEARCH_DONE (失败回到 IDLE)
 *   SEARCH_DONE    --勾选≥1篇 + 点击「确认文献」--> WRITING
 *   WRITING        --Writer 生成完毕--> WRITE_DONE (失败回 SEARCH_DONE)
 *   WRITE_DONE     --用户点击「提交审核」--> REVIEWING
 *   REVIEWING      --审核返回意见--> REVIEW_DONE (失败回 WRITE_DONE)
 *   REVIEW_DONE    --用户点击「确认并检测」--> CHECKING
 *                  --(有红牌时) 点击「重新提交审核」--> REVIEWING
 *   CHECKING       --AIGC 检测完成--> DONE (失败回 REVIEW_DONE 可重试)
 *   DONE           --用户点击「开始新一轮」--> IDLE
 */

export type AgentFlowStage =
  | 'idle'
  | 'searching'
  | 'search_done'
  | 'writing'
  | 'write_done'
  | 'reviewing'
  | 'review_done'
  | 'checking'
  | 'done';

/** 用户显式操作 (全部由按钮点击产生) */
export type AgentFlowAction =
  | 'begin_search' // IDLE -> SEARCHING
  | 'search_succeeded' // SEARCHING -> SEARCH_DONE
  | 'search_failed' // SEARCHING -> IDLE
  | 'confirm_literature' // SEARCH_DONE -> WRITING
  | 'writing_succeeded' // WRITING -> WRITE_DONE
  | 'writing_failed' // WRITING -> SEARCH_DONE
  | 'submit_review' // WRITE_DONE -> REVIEWING
  | 'review_succeeded' // REVIEWING -> REVIEW_DONE
  | 'review_failed' // REVIEWING -> WRITE_DONE
  | 'resubmit_review' // REVIEW_DONE(有红牌) -> REVIEWING
  | 'confirm_detect' // REVIEW_DONE -> CHECKING
  | 'detect_succeeded' // CHECKING -> DONE
  | 'detect_failed' // CHECKING -> REVIEW_DONE
  | 'reset'; // 任意状态 -> IDLE

/** 合法流转表: 源状态 -> {动作 -> 目标状态} */
const FLOW_TRANSITIONS: Record<
  AgentFlowStage,
  Partial<Record<AgentFlowAction, AgentFlowStage>>
> = {
  idle: { begin_search: 'searching', reset: 'idle' },
  searching: {
    search_succeeded: 'search_done',
    search_failed: 'idle',
    reset: 'idle',
  },
  search_done: {
    confirm_literature: 'writing',
    reset: 'idle',
  },
  writing: {
    writing_succeeded: 'write_done',
    writing_failed: 'search_done',
    reset: 'idle',
  },
  write_done: { submit_review: 'reviewing', reset: 'idle' },
  reviewing: {
    review_succeeded: 'review_done',
    review_failed: 'write_done',
    reset: 'idle',
  },
  review_done: {
    confirm_detect: 'checking',
    // 有红牌时允许修改正文后再次提交审核 (不改变已产生的审稿结果状态)
    resubmit_review: 'reviewing',
    reset: 'idle',
  },
  checking: {
    detect_succeeded: 'done',
    detect_failed: 'review_done',
    reset: 'idle',
  },
  done: { reset: 'idle' },
};

/**
 * 状态流转: 校验 (state, action) 是否在合法流转表内并返回下一状态。
 * 非法流转直接抛错 —— 严格模式下跳过步骤会被前端兜底拦截。
 */
export function flowTransition(
  stage: AgentFlowStage,
  action: AgentFlowAction
): AgentFlowStage {
  const next = FLOW_TRANSITIONS[stage]?.[action];
  if (!next) {
    throw new Error(`非法流程流转: ${stage} --${action}--> ?`);
  }
  return next;
}

/** 正在调用 Agent / 联网的“忙碌”状态 (渲染进度动画) */
export const FLOW_BUSY_STAGES: ReadonlySet<AgentFlowStage> = new Set([
  'searching',
  'writing',
  'reviewing',
  'checking',
]);

/** 挂起-确认状态: 该状态下唯一能推进下一步的是用户按钮 (无自动流转) */
export const FLOW_HOLD_STAGES: ReadonlySet<AgentFlowStage> = new Set([
  'search_done',
  'write_done',
  'review_done',
  'done',
]);

export interface AgentFlowStepMeta {
  /** 步骤序号, 用于进度文案 (1-9) */
  step: number;
  /** 简短状态名 (展示用) */
  label: string;
}

/** 各状态的展示元信息 */
export const AGENT_FLOW_META: Record<AgentFlowStage, AgentFlowStepMeta> = {
  idle: { step: 1, label: '① 初始' },
  searching: { step: 2, label: '② 搜索中' },
  search_done: { step: 3, label: '③ 待确认文献' },
  writing: { step: 4, label: '④ 撰写中' },
  write_done: { step: 5, label: '⑤ 待提交审核' },
  reviewing: { step: 6, label: '⑥ 审核中' },
  review_done: { step: 7, label: '⑦ 待确认并检测' },
  checking: { step: 8, label: '⑧ AIGC 检测中' },
  done: { step: 9, label: '✅ 流程完成' },
};
