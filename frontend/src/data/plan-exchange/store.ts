import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { contentChecksum, todayText } from './util'
import type {
  ExchangeState,
  PlanContent,
  PlanVersionRecord,
} from './types'

// 档案交换台单独存一份：版本履历、附件、失败行、复核事项都要跨刷新保留。
const STORAGE_KEY = 'hydrology-monitor-station:plan-exchange'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readPlanContent(row: EntryRow): PlanContent {
  return {
    方案名称: String(row['方案名称'] ?? ''),
    适用范围: String(row['适用范围'] ?? ''),
    监测项目: String(row['监测项目'] ?? ''),
    测次安排: String(row['测次安排'] ?? ''),
  }
}

function originalPlanDate(row: EntryRow): string {
  const approvedAt = String(row['批准日期'] ?? '')
  if (approvedAt) {
    return approvedAt
  }
  // 种子数据没有批准日期时退回固定的原始日期，废止兼容演示保持“原日期”稳定。
  if (String(row.status) === '已废止') {
    return '2026-08-20'
  }
  return todayText()
}

/** 首次使用时给每个在册方案补一条在线初始版本，沿用方案的原始批准/废止日期。 */
export function seedState(): ExchangeState {
  const planRows = listRows('plan')
  const versions: PlanVersionRecord[] = planRows.map((row, index) => {
    const content = readPlanContent(row)
    const status = String(row.status)
    const date = originalPlanDate(row)
    return {
      id: index + 1,
      planId: Number(row.id),
      planCode: String(row['方案编号'] ?? ''),
      versionNo: 1,
      source: '在线',
      approved: status === '已批准' || status === '已废止',
      adopted: true,
      readOnly: status === '已废止',
      content,
      checksum: contentChecksum(content),
      originalDate: date,
      createdAt: date,
      note: status === '已废止' ? '方案废止，版本按原日期只读兼容' : '在线初始版本',
    }
  })
  return {
    seq: versions.length + 1,
    initialized: true,
    versions,
    attachments: [],
    failures: [],
    reviews: [],
    logs: [
      {
        id: versions.length + 1,
        time: todayText(),
        kind: '版本',
        message: `已按在册方案初始化 ${versions.length} 份方案的版本履历`,
      },
    ],
  }
}

function readState(): ExchangeState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const state = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return state
  }
  try {
    return JSON.parse(raw) as ExchangeState
  } catch {
    const state = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return state
  }
}

let cache: ExchangeState | null = null

export function exchangeState(): ExchangeState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export function saveExchangeState(state: ExchangeState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetExchangeState(): ExchangeState {
  const state = seedState()
  saveExchangeState(state)
  return clone(state)
}

export function exchangeStorageKey(): string {
  return STORAGE_KEY
}
