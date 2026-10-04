import { MODULE_BY_KEY } from '@/data/modules'
import { appendLog, exchangeState, resetExchange, saveExchange } from '@/data/exchange-store'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  AttachmentFailure,
  AttachmentRow,
  EntryRow,
  ImportResult,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PlanVersion,
  PlanVersionStatus,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '废止', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const PLAN_KEY = 'plan'
const CALIBRATION_KEY = 'calibration'
// 附件清单表头：前五项是必录字段，缺一项该行失败；编制人、原日期缺省时按默认值继续。
const ATTACHMENT_HEADERS = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排', '编制人', '原日期'] as const
const ATTACHMENT_REQUIRED = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排'] as const

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 已废止方案按原日期只读兼容：废止后任何流转动作都不再受理。
  if (key === PLAN_KEY && current === '已废止') {
    return { ok: false, message: `方案 ${String(rows[index]['方案编号'] ?? id)} 已废止，按原日期只读保留，不能再做「${action}」` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === PLAN_KEY && action === '废止方案') {
    markPlanAbolished(String(next[index]['方案编号'] ?? ''))
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === PLAN_KEY) {
    resetExchange()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ── 测报方案 · 档案交换台 ─────────────────────────────────────────────
// 约定：在线登记的方案记录与附件导入各自沉淀为「版本」，按方案编号归组；
// 版本内容由适用范围、监测项目、测次安排等字段决定，重复导入只形成一个版本。

function todayText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// 稳定内容指纹：同一份附件重复导入得到相同 hash，据此判定「重复导入」。
function contentHash(parts: string[]): string {
  const text = parts.join('\u0001')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

type VersionContent = {
  planName: string
  scope: string
  monitorItems: string
  frequency: string
  editor: string
  originalDate: string
}

function versionContent(version: PlanVersion): VersionContent {
  return {
    planName: version.planName,
    scope: version.scope,
    monitorItems: version.monitorItems,
    frequency: version.frequency,
    editor: version.editor,
    originalDate: version.originalDate,
  }
}

function versionHash(content: VersionContent): string {
  return contentHash([
    content.planName,
    content.scope,
    content.monitorItems,
    content.frequency,
    content.editor,
    content.originalDate,
  ])
}

function mapStatus(rowStatus: string): PlanVersionStatus {
  if (rowStatus === '已批准') {
    return '已批准'
  }
  if (rowStatus === '已废止') {
    return '已废止'
  }
  return '待审批'
}

// 首次使用版本功能时，把现有在线登记记录补成各方案的第一版（在线登记版）。
function ensureBaselines(): void {
  const state = exchangeState()
  const known = new Set(state.versions.map((version) => version.planCode))
  for (const row of listRows(PLAN_KEY)) {
    const planCode = String(row['方案编号'] ?? '')
    if (!planCode || known.has(planCode)) {
      continue
    }
    const content: VersionContent = {
      planName: String(row['方案名称'] ?? ''),
      scope: String(row['适用范围'] ?? ''),
      monitorItems: String(row['监测项目'] ?? ''),
      frequency: String(row['测次安排'] ?? ''),
      editor: String(row['编制人'] ?? ''),
      originalDate: String(row['原始日期'] ?? todayText()),
    }
    state.seq += 1
    state.versions.push({
      versionId: state.seq,
      planCode,
      ...content,
      source: '在线登记',
      status: mapStatus(String(row.status)),
      hash: versionHash(content),
      createdAt: todayText(),
    })
  }
  saveExchange(state)
}

export function planVersionGroups(): Record<string, PlanVersion[]> {
  ensureBaselines()
  const groups: Record<string, PlanVersion[]> = {}
  for (const version of exchangeState().versions) {
    ;(groups[version.planCode] ??= []).push(version)
  }
  for (const versions of Object.values(groups)) {
    versions.sort((a, b) => a.versionId - b.versionId)
  }
  return groups
}

function latestApprovedVersion(versions: PlanVersion[]): PlanVersion | undefined {
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    if (versions[i].status === '已批准') {
      return versions[i]
    }
  }
  return undefined
}

// 页面上当前生效的版本：在线与附件冲突时以批准版本为准，其次取最新一版。
export function currentPlanVersion(versions: PlanVersion[]): PlanVersion | undefined {
  return latestApprovedVersion(versions) ?? versions[versions.length - 1]
}

// 解析附件清单 CSV：返回有效行与失败行，失败行带着缺了哪些字段，供页面就地补录后重试。
export function parseAttachmentCsv(text: string): { rows: AttachmentRow[]; failures: AttachmentFailure[] } {
  const cleaned = text.replace(/^﻿/, '')
  const lines = cleaned.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    throw new Error('附件清单是空文件，请先按模板填写后再上传')
  }
  const splitLine = (line: string): string[] => {
    const cells: string[] = []
    let current = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"'
            i += 1
          } else {
            quoted = false
          }
        } else {
          current += ch
        }
      } else if (ch === '"') {
        quoted = true
      } else if (ch === ',') {
        cells.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    cells.push(current.trim())
    return cells
  }
  const headers = splitLine(lines[0])
  const missingHeaders = ATTACHMENT_HEADERS.filter((header) => !headers.includes(header))
  if (missingHeaders.length > 0) {
    throw new Error(`附件表头缺少列：${missingHeaders.join('、')}`)
  }
  const rows: AttachmentRow[] = []
  const failures: AttachmentFailure[] = []
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const cells = splitLine(lines[lineIndex])
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (ATTACHMENT_HEADERS.includes(header as (typeof ATTACHMENT_HEADERS)[number])) {
        record[header] = cells[index] ?? ''
      }
    })
    const missing = ATTACHMENT_REQUIRED.filter((field) => (record[field] ?? '').trim() === '')
    if (missing.length > 0) {
      failures.push({
        rowNo: lineIndex + 1,
        missing: [...missing],
        raw: {
          planCode: record['方案编号'],
          planName: record['方案名称'],
          scope: record['适用范围'],
          monitorItems: record['监测项目'],
          frequency: record['测次安排'],
          editor: record['编制人'],
          originalDate: record['原日期'],
        },
        message: `第 ${lineIndex + 1} 行缺少：${missing.join('、')}`,
      })
      continue
    }
    rows.push({
      rowNo: lineIndex + 1,
      planCode: record['方案编号'],
      planName: record['方案名称'],
      scope: record['适用范围'],
      monitorItems: record['监测项目'],
      frequency: record['测次安排'],
      editor: record['编制人'] || '未填报',
      originalDate: record['原日期'] || todayText(),
    })
  }
  return { rows, failures }
}

// 失败行在页面上补录后回到这里：仍有缺字段的继续留在失败列表，从失败处继续而不是整单作废。
export function repairFailure(
  failure: AttachmentFailure,
  patch: Partial<AttachmentRow>,
): { row: AttachmentRow } | { failure: AttachmentFailure } {
  const merged = { ...failure.raw, ...patch } as Partial<AttachmentRow>
  const requiredKey: Record<(typeof ATTACHMENT_REQUIRED)[number], keyof AttachmentRow> = {
    方案编号: 'planCode',
    方案名称: 'planName',
    适用范围: 'scope',
    监测项目: 'monitorItems',
    测次安排: 'frequency',
  }
  const missing = ATTACHMENT_REQUIRED.filter((field) => String(merged[requiredKey[field]] ?? '').trim() === '')
  if (missing.length > 0) {
    return {
      failure: {
        ...failure,
        raw: merged,
        missing: [...missing],
        message: `第 ${failure.rowNo} 行仍缺少：${missing.join('、')}`,
      },
    }
  }
  return {
    row: {
      rowNo: failure.rowNo,
      planCode: String(merged.planCode),
      planName: String(merged.planName),
      scope: String(merged.scope),
      monitorItems: String(merged.monitorItems),
      frequency: String(merged.frequency),
      editor: String(merged.editor ?? '').trim() || '未填报',
      originalDate: String(merged.originalDate ?? '').trim() || todayText(),
    },
  }
}

type RowOutcome =
  | { kind: 'created'; version: PlanVersion }
  | { kind: 'deduped'; version: PlanVersion }
  | { kind: 'conflict'; version: PlanVersion }
  | { kind: 'rejected'; message: string }

// 落一行附件：返回它最终形成的版本，或被废止方案拒收的原因。
function applyAttachmentRow(state: ReturnType<typeof exchangeState>, row: AttachmentRow): RowOutcome {
  const rows = listRows(PLAN_KEY)
  const planRow = rows.find((item) => String(item['方案编号'] ?? '') === row.planCode)
  if (planRow && String(planRow.status) === '已废止') {
    return { kind: 'rejected', message: `方案 ${row.planCode} 已废止，按原日期只读保留，附件不再接收` }
  }
  const versions = state.versions.filter((version) => version.planCode === row.planCode)
  const content: VersionContent = {
    planName: row.planName,
    scope: row.scope,
    monitorItems: row.monitorItems,
    frequency: row.frequency,
    editor: row.editor,
    originalDate: row.originalDate,
  }
  const hash = versionHash(content)
  // 重复导入：内容指纹与已有任一版本一致，只认原版本，不再生成新版本。
  const duplicate = versions.find((version) => version.hash === hash)
  if (duplicate) {
    return { kind: 'deduped', version: duplicate }
  }
  const approved = latestApprovedVersion(versions)
  // 在线版本已批准时，附件内容与之冲突：附件留档待裁，在线批准版本继续生效。
  const status: PlanVersionStatus = approved ? '冲突留档' : '待审批'
  state.seq += 1
  const version: PlanVersion = {
    versionId: state.seq,
    planCode: row.planCode,
    ...content,
    source: '附件导入',
    status,
    hash,
    note: approved
      ? `与已批准的第 ${approved.versionId} 版内容冲突，按规则以批准版本为准，附件仅留档`
      : undefined,
    createdAt: todayText(),
  }
  state.versions.push(version)
  if (!planRow) {
    const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1
    const created: EntryRow = {
      id: nextId,
      status: '待审批',
      pending: true,
      abnormal: false,
      '方案编号': row.planCode,
      '方案名称': row.planName,
      '适用范围': row.scope,
      '监测项目': row.monitorItems,
      '测次安排': row.frequency,
      '编制人': row.editor,
      '原始日期': row.originalDate,
    }
    saveRows(PLAN_KEY, [...rows, created])
  }
  return { kind: approved ? 'conflict' : 'created', version }
}

// 上传附件清单：有效行全部落版本，缺字段行原样带回供补录，已通过的行不因失败行回滚。
export function importAttachment(rows: AttachmentRow[]): ImportResult {
  ensureBaselines()
  const state = exchangeState()
  let imported = 0
  let deduped = 0
  const groups = new Set<string>()
  const versions: PlanVersion[] = []
  const failures: AttachmentFailure[] = []
  for (const row of rows) {
    const outcome = applyAttachmentRow(state, row)
    groups.add(row.planCode)
    if (outcome.kind === 'created' || outcome.kind === 'conflict') {
      imported += 1
      versions.push(outcome.version)
    } else if (outcome.kind === 'deduped') {
      deduped += 1
      versions.push(outcome.version)
    } else {
      failures.push({
        rowNo: row.rowNo,
        missing: [],
        raw: row,
        message: outcome.message,
      })
    }
  }
  saveExchange(state)
  appendLog({
    kind: '附件导入',
    message: `附件清单导入 ${rows.length} 行：形成新版本 ${imported} 个，重复导入 ${deduped} 行，失败 ${failures.length} 行`,
  })
  return {
    received: rows.length,
    imported,
    deduped,
    failed: failures.length,
    groups: [...groups],
    failures,
    versions,
  }
}

// 批准后联动：其他入口（仪器检定）里在办的检定待办，一并新增方案复核事项。
function addCalibrationReview(planCode: string): number {
  const rows = listRows(CALIBRATION_KEY)
  const openStatuses = ['待送检', '送检中']
  let touched = 0
  const next = rows.map((row) => {
    if (!openStatuses.includes(String(row.status))) {
      return row
    }
    const item = `方案 ${planCode} 批准后复核事项（${todayText()}）`
    const existing = String(row['复核事项'] ?? '')
    if (existing.includes(item)) {
      return row
    }
    touched += 1
    return { ...row, '复核事项': existing ? `${existing}；${item}` : item }
  })
  if (touched > 0) {
    saveRows(CALIBRATION_KEY, next)
  }
  return touched
}

// 批准方案：并发提交只生效一次——按方案维度加在途锁，落库后再用批准指纹幂等挡重复提交。
export function approvePlan(id: number): ActionResult {
  const meta = moduleMeta(PLAN_KEY)
  const rows = listRows(PLAN_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const plan = rows[index]
  if (String(plan.status) === '已废止') {
    return { ok: false, message: `方案 ${String(plan['方案编号'] ?? id)} 已废止，按原日期只读保留` }
  }
  ensureBaselines()
  const state = exchangeState()
  if (state.inflightApprove === id) {
    return { ok: false, message: '该方案正在批准中，请勿重复提交' }
  }
  const planCode = String(plan['方案编号'] ?? '')
  const versions = state.versions
    .filter((version) => version.planCode === planCode)
    .sort((a, b) => a.versionId - b.versionId)
  const candidate = versions[versions.length - 1]
  const idemKey = `${planCode}@${candidate?.versionId ?? 0}@${candidate?.hash ?? 'online'}`
  if (state.approvedKeys.includes(idemKey)) {
    return { ok: false, message: `方案 ${planCode} 的这一版已批准过，并发提交只生效一次` }
  }
  if (String(plan.status) === '已批准' && (!candidate || candidate.status === '已批准')) {
    state.approvedKeys.push(idemKey)
    saveExchange(state)
    return { ok: false, message: `方案 ${planCode} 已是已批准状态，无需重复批准` }
  }
  state.inflightApprove = id
  const effective = candidate ?? ((): PlanVersion => {
    state.seq += 1
    const created: PlanVersion = {
      versionId: state.seq,
      planCode,
      planName: String(plan['方案名称'] ?? ''),
      scope: String(plan['适用范围'] ?? ''),
      monitorItems: String(plan['监测项目'] ?? ''),
      frequency: String(plan['测次安排'] ?? ''),
      editor: String(plan['编制人'] ?? ''),
      approver: '',
      originalDate: String(plan['原始日期'] ?? todayText()),
      source: '在线登记',
      status: '待审批',
      hash: '',
      createdAt: todayText(),
    }
    created.hash = versionHash(versionContent(created))
    state.versions.push(created)
    return created
  })()
  const approvedVersion: PlanVersion = {
    ...effective,
    status: '已批准',
    approver: '值班管理员',
  }
  const versionIndex = state.versions.findIndex((version) => version.versionId === effective.versionId)
  state.versions[versionIndex] = approvedVersion
  // 批准版本成为唯一准本：更早的冲突留档版本保持留档，页面以批准版本为准展示。
  const updatedRow: EntryRow = {
    ...plan,
    status: '已批准',
    pending: false,
    abnormal: false,
    '方案名称': approvedVersion.planName,
    '适用范围': approvedVersion.scope,
    '监测项目': approvedVersion.monitorItems,
    '测次安排': approvedVersion.frequency,
    '原始日期': approvedVersion.originalDate,
  }
  const nextRows = [...rows]
  nextRows[index] = updatedRow
  saveRows(PLAN_KEY, nextRows)
  const reviewCount = addCalibrationReview(planCode)
  state.approvedKeys.push(idemKey)
  state.inflightApprove = null
  saveExchange(state)
  appendLog({
    kind: '方案批准',
    planCode,
    message: `方案 ${planCode} 第 ${approvedVersion.versionId} 版（${approvedVersion.source}）已批准；检定待办新增复核事项 ${reviewCount} 条`,
  })
  return {
    ok: true,
    message: `方案 ${planCode} 已批准第 ${approvedVersion.versionId} 版，仪器检定待办已联动新增 ${reviewCount} 条复核事项`,
  }
}

// 废止方案：版本同步标记只读，原始日期保留不变，供后续按原日期查阅。
function markPlanAbolished(planCode: string): void {
  if (!planCode) {
    return
  }
  const state = exchangeState()
  let marked = 0
  for (const version of state.versions) {
    if (version.planCode === planCode && version.status !== '已废止') {
      version.status = '已废止'
      version.note = '方案已废止，按原日期只读兼容'
      marked += 1
    }
  }
  saveExchange(state)
  if (marked > 0) {
    appendLog({ kind: '方案废止', planCode, message: `方案 ${planCode} 废止，${marked} 个版本转为按原日期只读保留` })
  }
}

// 下载待审批方案包：只装当前状态为待审批的方案，内容含适用范围、监测项目、测次安排。
export function buildPendingPackage(): { filename: string; content: string } {
  const rows = listRows(PLAN_KEY).filter((row) => String(row.status) === '待审批')
  const header = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排', '编制人', '原始日期']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(header.map((field) => csvEscape(String(row[field] ?? ''))).join(','))
  }
  return { filename: `待审批测报方案包-${todayText()}.csv`, content: `\ufeff${lines.join('\n')}` }
}

export function downloadPendingPackage(): { count: number } {
  const { filename, content } = buildPendingPackage()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  const count = listRows(PLAN_KEY).filter((row) => String(row.status) === '待审批').length
  appendLog({ kind: '包下载', message: `下载待审批方案包 ${filename}，含 ${count} 个方案` })
  return { count }
}

// 附件清单模板：让上传方知道表头与必录列。
export function downloadAttachmentTemplate(): void {
  const header = [...ATTACHMENT_HEADERS]
  const sample = ['PLAN-2026-09', '示例站2026年测报方案', '示例站基本断面', '水位、流量', '水位每日08时；流量每月2次', '张水文', '2026-09-01']
  const content = `﻿${[header.join(','), sample.join(',')].join('\n')}`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '测报方案附件清单模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 返回后保留方案版本：页面把当前查看的版本记下，跨路由往返后仍定位在这一版。
export function rememberPlanVersion(planCode: string, versionId: number): void {
  const state = exchangeState()
  state.activeCode = planCode
  state.activeVersionId = versionId
  saveExchange(state)
}

export function clearRememberedPlan(): void {
  const state = exchangeState()
  state.activeCode = ''
  state.activeVersionId = null
  saveExchange(state)
}

export function rememberedPlan(): { planCode: string; versionId: number | null } {
  const state = exchangeState()
  return { planCode: state.activeCode, versionId: state.activeVersionId }
}

export function exchangeLogs() {
  return exchangeState().logs
}

export function exchangeSummary() {
  ensureBaselines()
  const state = exchangeState()
  return {
    versions: state.versions.length,
    online: state.versions.filter((version) => version.source === '在线登记').length,
    attachment: state.versions.filter((version) => version.source === '附件导入').length,
    conflicts: state.versions.filter((version) => version.status === '冲突留档').length,
  }
}
