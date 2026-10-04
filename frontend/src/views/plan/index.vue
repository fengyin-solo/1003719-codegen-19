<template>
  <section class="page" data-module="plan">
    <header class="page-head">
      <div>
        <h2>测报方案管理</h2>
        <p class="page-desc">
          维护测报方案登记、审批与版本流转；档案交换台支持上传附件清单、下载待审批方案包，
          在线版本与附件冲突时以批准版本为准，废止方案按原日期只读兼容。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记测报方案</button>
        <button class="btn" type="button" @click="exportRows">导出测报方案清单</button>
      </div>
    </header>

    <div class="tab-bar">
      <button
        type="button"
        :class="['tab', store.activeTab === 'ledger' ? 'active' : '']"
        @click="store.setTab('ledger')"
      >
        方案台账
      </button>
      <button
        type="button"
        :class="['tab', store.activeTab === 'exchange' ? 'active' : '']"
        @click="store.setTab('exchange')"
      >
        档案交换台
        <span v-if="pendingReviewCount > 0" class="tab-badge">{{ pendingReviewCount }}</span>
      </button>
    </div>

    <ExchangeDesk v-if="store.activeTab === 'exchange'" />

    <template v-else>
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
        <article class="stat-card stat-accent">
          <span class="stat-label">待复核事项（仪器检定入口）</span>
          <strong class="stat-value">{{ pendingReviewCount }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <p v-if="store.notice" :class="['notice', store.noticeOk ? 'ok' : 'bad']">{{ store.notice }}</p>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前版本</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ versionLabel(Number(row.id)) }}</td>
            <td>
              {{ row.status }}
              <span v-if="String(row.status) === '已废止'" class="cell-note">只读兼容</span>
            </td>
            <td class="row-actions">
              <template v-if="String(row.status) === '编制中' || String(row.status) === '已修订'">
                <button class="link" type="button" @click="doSubmit(row)">提交审批</button>
                <button class="link danger" type="button" @click="doAbolish(row)">废止方案</button>
              </template>
              <template v-else-if="String(row.status) === '待审批'">
                <button
                  class="link"
                  type="button"
                  :disabled="approvingId === Number(row.id)"
                  @click="doApprove(row)"
                >
                  {{ approvingId === Number(row.id) ? '批准中…' : '批准方案' }}
                </button>
              </template>
              <template v-else-if="String(row.status) === '已批准'">
                <button class="link danger" type="button" @click="doAbolish(row)">废止方案</button>
                <button class="link" type="button" @click="goVersions(row)">查看版本</button>
              </template>
              <template v-else>
                <button class="link" type="button" @click="goVersions(row)">只读查看版本</button>
              </template>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 3" class="empty-state">暂无测报方案数据，可先登记测报方案</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条测报方案记录</span>
        <span class="cell-note">批准方案后，仪器检定待办会一并新增复核事项；并发提交只生效一次</span>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import { usePlanExchangeStore } from '@/stores/plan-exchange'
import { isApproving } from '@/data/plan-exchange/service'
import type { EntryRow } from '@/data/types'

import ExchangeDesk from './ExchangeDesk.vue'

const session = useSessionStore()
const store = usePlanExchangeStore()

const columns = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排', '编制人', '批准人']
const statuses = ['编制中', '待审批', '已批准', '已修订', '已废止']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const approvingId = ref<number | null>(null)

const stats = computed(() => [
  { label: '方案总数', value: rows.value.length },
  { label: '已批准方案', value: rows.value.filter((row) => String(row.status) === '已批准').length },
  { label: '待审批方案', value: rows.value.filter((row) => String(row.status) === '待审批').length },
])

const pendingReviewCount = computed(() =>
  store.reviews.filter((review) => !review.done).length,
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function versionLabel(planId: number): string {
  const version = store.versions
    .filter((item) => item.planId === planId)
    .sort((a, b) => b.versionNo - a.versionNo)[0]
  if (!version) {
    return '第1版（在线）'
  }
  const suffix = version.approved ? '·已批准' : version.readOnly ? '·只读' : ''
  return `第${version.versionNo}版（${version.source}）${suffix}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('plan')
}

function openCreate() {
  store.setNotice('测报方案登记入口尚未接入审批流', false)
}

function doSubmit(row: EntryRow) {
  const result = store.submit(Number(row.id))
  if (result.ok) {
    reload()
  }
}

function doAbolish(row: EntryRow) {
  const result = store.abolish(Number(row.id))
  if (result.ok) {
    reload()
  }
}

async function doApprove(row: EntryRow) {
  const id = Number(row.id)
  if (isApproving(id) || approvingId.value === id) {
    store.setNotice('该方案正在批准中，请勿重复提交', false)
    return
  }
  approvingId.value = id
  try {
    const result = await store.approve(id, session.operator)
    if (result.ok) {
      reload()
    }
  } finally {
    if (approvingId.value === id) {
      approvingId.value = null
    }
  }
}

function goVersions(row: EntryRow) {
  store.setVersionFilter(String(row.id))
  store.setTab('exchange')
}

function reload() {
  try {
    const payload = listEntries('plan', filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 服务层若清理了在途锁但页面还没刷新，兜底恢复按钮状态。
    if (approvingId.value !== null && !isApproving(approvingId.value)) {
      approvingId.value = null
    }
  } catch (error) {
    store.setNotice(error instanceof Error ? error.message : '测报方案列表读取失败', false)
  }
}

onMounted(() => {
  store.refresh()
  reload()
})
</script>
