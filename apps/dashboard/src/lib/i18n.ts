/**
 * 中英文术语映射 —— 仅用于显示。原始数据（API / WebSocket）始终使用英文 key。
 */

export const stageLabels: Record<string, string> = {
  'requirement-analysis': '需求分析',
  design: '方案设计',
  implementation: '实施',
  verification: '验证',
};

export function stageLabel(name: string): string {
  return stageLabels[name] ?? name;
}

export const requirementStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  awaiting_gate: '待审核',
  awaiting_changes: '请求修改',
  done: '已完成',
  failed: '已失败',
};

export const stageExecutionStatusLabels: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  awaiting_gate: '待审核',
  gate_approved: '已放行',
  gate_rejected: '已驳回',
  succeeded: '已完成',
  failed: '已失败',
  skipped: '已跳过',
};

export const prStatusLabels: Record<string, string> = {
  open: '已开启',
  merged: '已合并',
  closed: '已关闭',
  changes_requested: '请求修改',
};

/** 简短的相对时间，例：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.round(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.round(diff / hour)} 小时前`;
  return `${Math.round(diff / day)} 天前`;
}

/** 把 ID 显示成 mono 短码（前 8 位） */
export function shortId(id: string, n = 8): string {
  return id.length > n ? id.slice(0, n) : id;
}
