import type { ExchangeState, ExchangeLog } from './types'

// 档案交换台的数据独立存一份：方案版本、导入/下载/批准日志都在这里，重置测报方案时一并清空。
const STORAGE_KEY = 'hydrology-monitor-station:plan-exchange'
const LOG_LIMIT = 100

function defaultState(): ExchangeState {
  return {
    versions: [],
    seq: 0,
    logs: [],
    approvedKeys: [],
    inflightApprove: null,
    activeCode: '',
    activeVersionId: null,
  }
}

let cache: ExchangeState | null = null

export function exchangeState(): ExchangeState {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = defaultState()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = defaultState()
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ExchangeState>
    cache = { ...defaultState(), ...parsed }
  } catch {
    cache = defaultState()
  }
  return cache
}

export function saveExchange(state: ExchangeState = exchangeState()): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function appendLog(entry: Omit<ExchangeLog, 'time'>): void {
  const state = exchangeState()
  const log: ExchangeLog = { ...entry, time: timestamp() }
  state.logs = [log, ...state.logs].slice(0, LOG_LIMIT)
  saveExchange(state)
}

export function resetExchange(): ExchangeState {
  const fresh = defaultState()
  saveExchange(fresh)
  return fresh
}

export function exchangeStorageKey(): string {
  return STORAGE_KEY
}

export function timestamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}
