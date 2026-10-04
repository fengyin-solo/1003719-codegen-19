import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { exchangeState, saveExchangeState } from './store'
import type {
  AttachmentRecord,
  ExchangeLog,
  ImportFailure,
  ImportReport,
  PlanContent,
  PlanVersionRecord,
  ReviewItem,
} from './types'
import {
  contentChecksum,
  downloadTextFile,
  nowText,
  parseCsv,
  sameContent,
  stampedName,
  toCsv,
  todayText,
} from './util'

const PLAN_KEY = 'plan'
const CALIBRATION_KEY = 'calibration'

// 附件清单必须带齐的列：缺列连失败行都定位不了，直接终止；缺值的行才走失败清单。
const REQUIRED_COLUMNS = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排']
const TEMPLATE_HEADERS = [...REQUIRED_COLUMNS, '版本日期']
const CALIBRATION_PENDING = '待送检'

// 方案可执行状态：集中在这里，页面与服务共用同一套判定。
const PLAN_STATUS = {
  drafting: '编制中',
  pending: '待审批',
  approved: '已批准',
  revised: '已修订',
  abolished: '已废止',
} as const

export type ServiceResult = { ok: boolean; message: string }

function nextId(state = exchangeState()): number {
  state.seq += 1
  return state.seq
}

function addLog(state: ReturnType<typeof exchangeState>, kind: ExchangeLog['kind'], message: string, detail?: string): void {
  state.logs.unshift({ id: nextId(state), time: nowText(), kind, message, detail })
  if (state.logs.length > 100) {
    state.logs.length = 100
  }
}

function planRows(): EntryRow[] {
  return listRows(PLAN_KEY)
}

function findPlan(planCode: string): EntryRow | undefined {
  return planRows().find((row) => String(row['方案编号'] ?? '').trim() === planCode.trim())
}

function contentOf(row: EntryRow): PlanContent {
  return {
    方案名称: String(row['方案名称'] ?? ''),
    适用范围: String(row['适用范围'] ?? ''),
    监测项目: String(row['监测项目'] ?? ''),
    测次安排: String(row['测次安排'] ?? ''),
  }
}

function versionsOf(state: ReturnType<typeof exchangeState>, planId: number): PlanVersionRecord[] {
  return state.versions
    .filter((version) => version.planId === planId)
    .sort((a, b) => a.versionNo - b.versionNo)
}

function latestVersion(state: ReturnType<typeof exchangeState>, planId: number): PlanVersionRecord | undefined {
  const versions = versionsOf(state, planId)
  return versions.length > 0 ? versions[versions.length - 1] : undefined
}

/** 最新的批准留档版本：在线版本与附件冲突时以它为准。 */
function latestApprovedVersion(
  state: ReturnType<typeof exchangeState>,
  planId: number,
): PlanVersionRecord | undefined {
  const approved = versionsOf(state, planId).filter((version) => version.approved)
  return approved.length > 0 ? approved[approved.length - 1] : undefined
}

/* -------------------------------- 版本履历 -------------------------------- */

export function listPlanVersions(planId?: number): PlanVersionRecord[] {
  const state = exchangeState()
  const versions = planId === undefined
    ? [...state.versions]
    : state.versions.filter((version) => version.planId === planId)
  return versions.sort((a, b) => b.id - a.id)
}

export function listAttachments(): AttachmentRecord[] {
  return [...exchangeState().attachments].sort((a, b) => b.id - a.id)
}

export function listFailures(): ImportFailure[] {
  return [...exchangeState().failures].sort((a, b) => b.id - a.id)
}

export function listLogs() {
  return [...exchangeState().logs].sort((a, b) => b.id - a.id)
}

/* -------------------------------- 附件导入 -------------------------------- */

function normalizeContent(raw: Record<string, string>): PlanContent {
  return {
    方案名称: (raw['方案名称'] ?? '').trim(),
    适用范围: (raw['适用范围'] ?? '').trim(),
    监测项目: (raw['监测项目'] ?? '').trim(),
    测次安排: (raw['测次安排'] ?? '').trim(),
  }
}

/**
 * 导入附件清单：
 * - 缺字段只让当前行进失败清单，其余行继续；失败行保留原文，修正后重传即从失败处继续。
 * - 同内容重复导入只形成一个版本。
 * - 与已批准在线版本冲突时以批准版本为准，附件不采用。
 * - 废止方案的附件只做只读留痕，按原日期兼容，不改数据。
 */
export function importAttachmentList(filename: string, text: string): ImportReport {
  const state = exchangeState()
  const { headers, rows } = parseCsv(text)
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !headers.includes(column))
  if (missingColumns.length > 0) {
    throw new Error(`附件清单缺少必需列：${missingColumns.join('、')}，请使用模板补全后重新上传`)
  }

  const report: ImportReport = {
    filename,
    total: rows.length,
    adopted: 0,
    duplicated: 0,
    conflict: 0,
    readonlyAbolished: 0,
    failed: [],
    details: [],
  }
  const plans = planRows()
  const planNext = [...plans]

  rows.forEach((raw, index) => {
    const line = index + 2
    const planCode = (raw['方案编号'] ?? '').trim()
    const reasons = REQUIRED_COLUMNS.filter((column) => !(raw[column] ?? '').trim()).map(
      (column) => `缺少字段「${column}」`,
    )
    if (reasons.length > 0) {
      report.failed.push({
        id: nextId(state),
        filename,
        line,
        raw,
        reasons,
        createdAt: nowText(),
      })
      report.details.push(`第${line}行：导入失败，${reasons.join('；')}（已保留，可从失败处继续）`)
      return
    }

    const rowIndex = planNext.findIndex((row) => String(row['方案编号'] ?? '').trim() === planCode)
    if (rowIndex < 0) {
      report.failed.push({
        id: nextId(state),
        filename,
        line,
        raw,
        reasons: [`方案编号「${planCode}」在册方案中不存在`],
        createdAt: nowText(),
      })
      report.details.push(`第${line}行：导入失败，方案编号「${planCode}」不存在`)
      return
    }

    const plan = planNext[rowIndex]
    const planId = Number(plan.id)
    const content = normalizeContent(raw)
    const checksum = contentChecksum(content)
    const versionDate = (raw['版本日期'] ?? '').trim() || todayText()

    // 同一份附件内容之前已处理过：无论当时采用与否，都只保留一个版本/一条留痕。
    const existed = state.attachments.find(
      (item) => item.planCode === planCode && item.checksum === checksum,
    )
    if (existed) {
      report.duplicated += 1
      report.details.push(`第${line}行：${planCode} 附件内容与「${existed.filename}」重复，未再形成版本`)
      return
    }

    const status = String(plan.status)
    if (status === PLAN_STATUS.abolished) {
      state.attachments.push({
        id: nextId(state),
        filename,
        planCode,
        content,
        checksum,
        versionDate,
        importedAt: nowText(),
        status: '废止只读兼容',
        note: '方案已废止，附件按原日期只读兼容，不改数据',
      })
      report.readonlyAbolished += 1
      report.details.push(`第${line}行：${planCode} 方案已废止，附件只读留痕（原日期 ${versionDate}）`)
      return
    }

    const approvedVersion = latestApprovedVersion(state, planId)
    if (approvedVersion && !sameContent(approvedVersion.content, content)) {
      state.attachments.push({
        id: nextId(state),
        filename,
        planCode,
        content,
        checksum,
        versionDate,
        importedAt: nowText(),
        status: '冲突未采用',
        note: `与已批准的第${approvedVersion.versionNo}版冲突，以批准版本为准`,
      })
      report.conflict += 1
      report.details.push(
        `第${line}行：${planCode} 附件与已批准第${approvedVersion.versionNo}版冲突，以批准版本为准，附件不采用`,
      )
      return
    }

    // 采用附件：回写在册方案，并形成新的附件版本。
    const nextVersionNo = (latestVersion(state, planId)?.versionNo ?? 0) + 1
    const updated: EntryRow = {
      ...plan,
      方案名称: content.方案名称,
      适用范围: content.适用范围,
      监测项目: content.监测项目,
      测次安排: content.测次安排,
    }
    planNext[rowIndex] = updated
    state.versions.push({
      id: nextId(state),
      planId,
      planCode,
      versionNo: nextVersionNo,
      source: '附件',
      approved: false,
      adopted: true,
      readOnly: false,
      content,
      checksum,
      attachmentName: filename,
      originalDate: versionDate,
      createdAt: nowText(),
      note: `附件「${filename}」导入采用`,
    })
    state.attachments.push({
      id: nextId(state),
      filename,
      planCode,
      content,
      checksum,
      versionDate,
      importedAt: nowText(),
      status: '已采用',
      note: `形成第${nextVersionNo}版`,
    })
    report.adopted += 1
    report.details.push(`第${line}行：${planCode} 附件已采用，形成第${nextVersionNo}版`)
  })

  // 本次新失败行追加进失败清单；成功补导的旧失败行自动清掉，体现“从失败处继续”。
  // 只要某个方案编号本次已经处理成功，就把该方案编号上遗留的失败行一并结案。
  const resolvedCodes = new Set<string>()
  rows.forEach((raw) => {
    const code = (raw['方案编号'] ?? '').trim()
    const complete = code && REQUIRED_COLUMNS.every((column) => (raw[column] ?? '').trim())
    if (complete && !report.failed.some((failure) => failure.raw === raw)) {
      resolvedCodes.add(code)
    }
  })
  state.failures = [
    ...state.failures.filter((failure) => !resolvedCodes.has((failure.raw['方案编号'] ?? '').trim())),
    ...report.failed,
  ]

  saveRows(PLAN_KEY, planNext)
  addLog(
    state,
    '导入',
    `附件清单「${filename}」导入完成：采用 ${report.adopted}、重复 ${report.duplicated}、冲突 ${report.conflict}、废止兼容 ${report.readonlyAbolished}、失败 ${report.failed.length}`,
  )
  saveExchangeState(state)
  return report
}

export function downloadFailureTemplate(): void {
  const failures = exchangeState().failures
  const headers = [...TEMPLATE_HEADERS, '失败原因']
  const rows = failures.map((failure) => ({
    方案编号: failure.raw['方案编号'] ?? '',
    方案名称: failure.raw['方案名称'] ?? '',
    适用范围: failure.raw['适用范围'] ?? '',
    监测项目: failure.raw['监测项目'] ?? '',
    测次安排: failure.raw['测次安排'] ?? '',
    版本日期: failure.raw['版本日期'] ?? '',
    失败原因: failure.reasons.join('；'),
  }))
  downloadTextFile(
    stampedName('附件清单-失败行', 'csv'),
    toCsv(headers, rows),
  )
}

export function downloadImportTemplate(): void {
  const rows = [
    {
      方案编号: 'PLAN-0001',
      方案名称: '示例：XX站汛期测报方案',
      适用范围: '示例：XX水文站测验河段',
      监测项目: '示例：水位、流量、雨量',
      测次安排: '示例：汛期每日2次，洪水过程加测',
      版本日期: todayText(),
    },
  ]
  downloadTextFile('附件清单导入模板.csv', toCsv(TEMPLATE_HEADERS, rows))
}

/* -------------------------------- 审批流转 -------------------------------- */

function persistPlanRows(next: EntryRow[]): void {
  saveRows(PLAN_KEY, next)
}

export function submitPlanForApproval(id: number): ServiceResult {
  const state = exchangeState()
  const rows = planRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这份测报方案' }
  }
  const current = String(rows[index].status)
  if (current === PLAN_STATUS.pending) {
    return { ok: false, message: '该方案已在待审批，不用重复提交' }
  }
  if (current === PLAN_STATUS.approved) {
    return { ok: false, message: '该方案已经批准，无需再次提交' }
  }
  if (current === PLAN_STATUS.abolished) {
    return { ok: false, message: '该方案已废止，按原日期只读兼容，不能再提交' }
  }
  rows[index] = { ...rows[index], status: PLAN_STATUS.pending, pending: true, abnormal: false }
  persistPlanRows(rows)
  addLog(state, '审批', `方案「${rows[index]['方案编号']}」提交审批`)
  saveExchangeState(state)
  return { ok: true, message: '方案已提交审批' }
}

export function abolishPlan(id: number): ServiceResult {
  const state = exchangeState()
  const rows = planRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这份测报方案' }
  }
  const current = String(rows[index].status)
  if (current === PLAN_STATUS.abolished) {
    return { ok: false, message: '该方案已经是废止状态' }
  }
  if (current === PLAN_STATUS.pending) {
    return { ok: false, message: '待审批方案需先完成审批，不能直接废止' }
  }
  const planCode = String(rows[index]['方案编号'] ?? '')
  rows[index] = {
    ...rows[index],
    status: PLAN_STATUS.abolished,
    pending: false,
    abnormal: false,
    废止日期: todayText(),
  }
  // 全部历史版本冻结为只读，原始形成日期保持不变。
  state.versions
    .filter((version) => version.planId === id)
    .forEach((version) => {
      version.readOnly = true
      version.note = version.approved ? `${version.note ?? ''}（方案废止，按原日期只读兼容）`.trim() : version.note
    })
  persistPlanRows(rows)
  addLog(state, '审批', `方案「${planCode}」废止，历史版本按原日期只读兼容`)
  saveExchangeState(state)
  return { ok: true, message: '方案已废止，历史版本按原日期只读保留' }
}

// 在途锁：批准按钮连点/并发提交时，只有第一个请求能进入生效区间。
const approvingIds = new Set<number>()

/**
 * 批准方案：
 * - 并发提交只生效一次（在途锁 + 状态幂等校验）。
 * - 批准后最新内容形成批准留档版本，在线与附件冲突时以它为准。
 * - 其他入口（仪器检定）的检定待办一并新增复核事项。
 */
export function approvePlan(id: number, operator: string): Promise<ServiceResult> {
  if (approvingIds.has(id)) {
    return Promise.resolve({ ok: false, message: '该方案正在批准中，请勿重复提交' })
  }
  const rows = planRows()
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return Promise.resolve({ ok: false, message: '没有找到这份测报方案' })
  }
  if (String(row.status) !== PLAN_STATUS.pending) {
    return Promise.resolve({
      ok: false,
      message: `方案当前为「${row.status}」，仅待审批方案可以批准`,
    })
  }

  approvingIds.add(id)
  // 模拟审批落库的网络耗时，给并发点击留出可验证窗口；真实后端可直接换成 await 请求。
  return new Promise((resolve) => {
    window.setTimeout(() => {
      try {
        const state = exchangeState()
        const latestRows = planRows()
        const index = latestRows.findIndex((item) => Number(item.id) === id)
        // 二次确认：即便锁被绕过（多标签页等），已不是待审批也不再生效。
        if (index < 0 || String(latestRows[index].status) !== PLAN_STATUS.pending) {
          resolve({ ok: false, message: '方案审批状态已变化，本次重复提交未生效' })
          return
        }

        const plan = latestRows[index]
        const planCode = String(plan['方案编号'] ?? '')
        const content = contentOf(plan)
        const checksum = contentChecksum(content)
        const latest = latestVersion(state, id)

        // 最新版本即当前内容：直接标记为批准留档；否则补一条在线批准版本。
        if (latest && latest.checksum === checksum) {
          latest.approved = true
          latest.note = `${latest.note ?? ''}（已批准留档）`.replace('（已批准留档）（已批准留档）', '（已批准留档）')
        } else {
          state.versions.push({
            id: nextId(state),
            planId: id,
            planCode,
            versionNo: (latest?.versionNo ?? 0) + 1,
            source: '在线',
            approved: true,
            adopted: true,
            readOnly: false,
            content,
            checksum,
            originalDate: todayText(),
            createdAt: nowText(),
            note: '批准时形成在线批准版本',
          })
        }

        latestRows[index] = {
          ...plan,
          status: PLAN_STATUS.approved,
          pending: false,
          abnormal: false,
          批准人: operator,
          批准日期: todayText(),
        }

        // 联动仪器检定入口：所有待送检待办各新增一条复核事项（已存在未完成的不重复生成）。
        const calibrationRows = listRows(CALIBRATION_KEY)
        const createdReviews: ReviewItem[] = []
        calibrationRows
          .filter((item) => String(item.status) === CALIBRATION_PENDING)
          .forEach((item) => {
            const duplicated = state.reviews.some(
              (review) =>
                !review.done &&
                review.planId === id &&
                review.module === 'calibration' &&
                review.entryId === Number(item.id),
            )
            if (duplicated) {
              return
            }
            const label = `${String(item['仪器编号'] ?? '')} ${String(item['仪器名称'] ?? '')}`.trim()
            state.reviews.push({
              id: nextId(state),
              module: 'calibration',
              entryId: Number(item.id),
              entryLabel: label,
              planId: id,
              planCode,
              planName: content.方案名称,
              content: `依据已批准方案「${content.方案名称}」复核仪器检定安排（适用范围：${content.适用范围}）`,
              createdAt: nowText(),
              done: false,
            })
            createdReviews.push(state.reviews[state.reviews.length - 1])
          })

        persistPlanRows(latestRows)
        addLog(
          state,
          '审批',
          `方案「${planCode}」已批准，新增仪器检定复核事项 ${createdReviews.length} 项`,
        )
        saveExchangeState(state)
        resolve({
          ok: true,
          message:
            createdReviews.length > 0
              ? `方案已批准，并向仪器检定待办新增 ${createdReviews.length} 项复核事项`
              : '方案已批准',
        })
      } finally {
        approvingIds.delete(id)
      }
    }, 260)
  })
}

export function isApproving(id: number): boolean {
  return approvingIds.has(id)
}

/* -------------------------------- 方案包下载 ------------------------------- */

/** 下载待审批方案包：方案主表 + 附件清单两份 CSV，均含适用范围、监测项目、测次安排。 */
export function downloadPendingPackage(): ServiceResult {
  const state = exchangeState()
  const pending = planRows().filter((row) => String(row.status) === PLAN_STATUS.pending)
  if (pending.length === 0) {
    return { ok: false, message: '当前没有待审批方案，无需下载方案包' }
  }
  const planHeaders = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排', '编制人', '当前版本']
  const planCsvRows = pending.map((row) => {
    const planId = Number(row.id)
    const latest = latestVersion(state, planId)
    return {
      方案编号: String(row['方案编号'] ?? ''),
      方案名称: String(row['方案名称'] ?? ''),
      适用范围: String(row['适用范围'] ?? ''),
      监测项目: String(row['监测项目'] ?? ''),
      测次安排: String(row['测次安排'] ?? ''),
      编制人: String(row['编制人'] ?? ''),
      当前版本: latest ? `第${latest.versionNo}版（${latest.source}）` : '第1版（在线）',
    }
  })
  const pendingCodes = new Set(planCsvRows.map((row) => row.方案编号))
  const attachmentHeaders = ['方案编号', '附件文件', '适用范围', '监测项目', '测次安排', '附件日期', '采用状态']
  const attachmentCsvRows = state.attachments
    .filter((item) => pendingCodes.has(item.planCode))
    .map((item) => ({
      方案编号: item.planCode,
      附件文件: item.filename,
      适用范围: item.content.适用范围,
      监测项目: item.content.监测项目,
      测次安排: item.content.测次安排,
      附件日期: item.versionDate,
      采用状态: item.status,
    }))

  downloadTextFile(stampedName('待审批方案包', 'csv'), toCsv(planHeaders, planCsvRows))
  if (attachmentCsvRows.length > 0) {
    // 错开一个事件循环，避免浏览器合并连续下载。
    window.setTimeout(() => {
      downloadTextFile(stampedName('待审批方案包-附件清单', 'csv'), toCsv(attachmentHeaders, attachmentCsvRows))
    }, 120)
  }
  addLog(state, '导出', `下载待审批方案包：含 ${pending.length} 份待审批方案、${attachmentCsvRows.length} 份附件`)
  saveExchangeState(state)
  return {
    ok: true,
    message:
      attachmentCsvRows.length > 0
        ? `方案包已下载（${pending.length} 份方案，另附 ${attachmentCsvRows.length} 份附件清单）`
        : `方案包已下载（${pending.length} 份待审批方案）`,
  }
}

/* -------------------------------- 检定复核事项 ------------------------------ */

export function listReviews(includeDone = false): ReviewItem[] {
  const reviews = [...exchangeState().reviews].sort((a, b) => b.id - a.id)
  return includeDone ? reviews : reviews.filter((review) => !review.done)
}

export function completeReview(id: number): ServiceResult {
  const state = exchangeState()
  const review = state.reviews.find((item) => item.id === id)
  if (!review) {
    return { ok: false, message: '没有找到这条复核事项' }
  }
  if (review.done) {
    return { ok: false, message: '该复核事项已完成' }
  }
  review.done = true
  addLog(state, '审批', `方案「${review.planCode}」联动的仪器检定复核事项已完成：${review.entryLabel}`)
  saveExchangeState(state)
  return { ok: true, message: '复核事项已完成' }
}
