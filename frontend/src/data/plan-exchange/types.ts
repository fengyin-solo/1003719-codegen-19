/** 测报方案档案交换台的数据结构：版本履历、附件清单、导入失败行、检定复核事项、交换日志。 */

/** 方案正文：交换台比对在线版本与附件版本时只看这四块内容。 */
export type PlanContent = {
  方案名称: string
  适用范围: string
  监测项目: string
  测次安排: string
}

/** 方案版本：在线编辑或附件导入都会形成一条版本，废止后整条冻结为只读。 */
export type PlanVersionRecord = {
  id: number
  planId: number
  planCode: string
  versionNo: number
  /** 在线：系统内编制/批准留档；附件：由上传的附件清单形成。 */
  source: '在线' | '附件'
  /** 批准留档的版本；在线与附件冲突时以最新批准版本为准。 */
  approved: boolean
  /** 附件版本是否被采用：与已批准在线版本冲突时为 false。 */
  adopted: boolean
  /** 方案废止后版本按原日期只读兼容，不再允许改动。 */
  readOnly: boolean
  content: PlanContent
  checksum: string
  attachmentName?: string
  /** 版本形成时的原始日期，废止兼容时保持不变。 */
  originalDate: string
  createdAt: string
  note?: string
}

/** 已上传的附件清单条目。 */
export type AttachmentRecord = {
  id: number
  filename: string
  planCode: string
  content: PlanContent
  checksum: string
  versionDate: string
  importedAt: string
  /** 已采用：形成附件版本并回写方案；重复跳过：内容重复不另成版本；
   * 冲突未采用：以在线批准版本为准；废止只读兼容：废止方案只留痕不改数据。 */
  status: '已采用' | '重复跳过' | '冲突未采用' | '废止只读兼容'
  note?: string
}

/** 导入失败的清单行：保留原始内容和原因，修正后重新上传即可从失败处继续。 */
export type ImportFailure = {
  id: number
  filename: string
  line: number
  raw: Record<string, string>
  reasons: string[]
  createdAt: string
}

export type ImportReport = {
  filename: string
  total: number
  adopted: number
  duplicated: number
  conflict: number
  readonlyAbolished: number
  failed: ImportFailure[]
  details: string[]
}

/** 方案批准后，联动到仪器检定入口的复核待办。 */
export type ReviewItem = {
  id: number
  module: 'calibration'
  entryId: number
  entryLabel: string
  planId: number
  planCode: string
  planName: string
  content: string
  createdAt: string
  done: boolean
}

export type ExchangeLog = {
  id: number
  time: string
  kind: '导入' | '导出' | '审批' | '版本'
  message: string
  detail?: string
}

export type ExchangeState = {
  seq: number
  initialized: boolean
  versions: PlanVersionRecord[]
  attachments: AttachmentRecord[]
  failures: ImportFailure[]
  reviews: ReviewItem[]
  logs: ExchangeLog[]
}
