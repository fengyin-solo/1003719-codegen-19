/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ── 档案交换台（测报方案）──────────────────────────────────────────────
// 附件交换台围绕「方案版本」工作：在线登记与附件导入各成一版，按方案编号归组。
export type PlanVersionStatus =
  | '待审批'
  | '已批准'
  | '已废止'
  | '冲突留档'

export type PlanVersion = {
  versionId: number
  planCode: string
  planName: string
  scope: string
  monitorItems: string
  frequency: string
  editor: string
  approver?: string
  originalDate: string
  source: '在线登记' | '附件导入'
  status: PlanVersionStatus
  hash: string
  note?: string
  createdAt: string
}

export type AttachmentRow = {
  rowNo: number
  planCode: string
  planName: string
  scope: string
  monitorItems: string
  frequency: string
  editor: string
  originalDate: string
}

export type AttachmentFailure = {
  rowNo: number
  missing: string[]
  raw: Partial<AttachmentRow>
  message: string
}

export type ImportResult = {
  received: number
  imported: number
  deduped: number
  failed: number
  groups: string[]
  failures: AttachmentFailure[]
  versions: PlanVersion[]
}

export type ExchangeLog = {
  time: string
  kind: '附件导入' | '包下载' | '方案批准' | '方案废止'
  planCode?: string
  message: string
}

export type ExchangeState = {
  versions: PlanVersion[]
  seq: number
  logs: ExchangeLog[]
  approvedKeys: string[]
  inflightApprove: number | null
  activeCode: string
  activeVersionId: number | null
}
