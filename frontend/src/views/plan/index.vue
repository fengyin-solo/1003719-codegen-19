<template>
  <section class="page" data-module="plan">
    <header class="page-head">
      <div>
        <h2>测报方案管理</h2>
        <p class="page-desc">维护测报方案的适用范围、监测项目、测次安排；档案交换台负责附件清单导入、待审批方案包下载与版本留档。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :class="{ primary: tab === 'ledger' }" @click="tab = 'ledger'">方案台账</button>
        <button class="btn" type="button" :class="{ primary: tab === 'exchange' }" @click="switchExchange">档案交换台</button>
      </div>
    </header>

    <!-- ── 方案台账 ── -->
    <template v-if="tab === 'ledger'">
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
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
        <button class="btn" type="button" @click="exportRows">导出测报方案清单</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>生效版本</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>
              <span class="tag" :class="statusTag(String(row.status))">{{ row.status }}</span>
            </td>
            <td>
              <button class="link" type="button" @click="openVersions(String(row['方案编号']))">
                <template v-if="versionOf(String(row['方案编号']))">
                  第{{ versionOf(String(row['方案编号']))!.versionId }}版
                  <em class="src-note">[{{ versionOf(String(row['方案编号']))!.source }}]</em>
                </template>
                <template v-else>查看版本</template>
              </button>
            </td>
            <td class="row-actions">
              <template v-if="String(row.status) === '已废止'">
                <span class="hint-text">已按原日期只读保留</span>
              </template>
              <button
                v-for="action in actionsFor(String(row.status))"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 3" class="empty-state">暂无测报方案数据，可从档案交换台上传附件清单</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条测报方案记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>

    <!-- ── 档案交换台 ── -->
    <template v-else>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">版本档案总数</span>
          <strong class="stat-value">{{ summary.versions }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">在线登记版</span>
          <strong class="stat-value">{{ summary.online }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">附件导入版</span>
          <strong class="stat-value">{{ summary.attachment }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">冲突留档（以批准版为准）</span>
          <strong class="stat-value">{{ summary.conflicts }}</strong>
        </article>
      </div>

      <section class="exchange-panel">
        <h3>① 上传附件清单</h3>
        <p class="panel-hint">
          清单须含方案编号、方案名称、适用范围、监测项目、测次安排等列；重复导入同内容只形成一个版本，
          缺字段的行整行挂起，补录后从失败处继续导入。在线版本与附件冲突时，已批准版本继续生效，附件仅留档。
        </p>
        <div class="upload-box">
          <input ref="fileInput" class="btn" type="file" accept=".csv,text/csv" @change="onFilePicked" />
          <button class="btn" type="button" @click="downloadTemplate">下载清单模板</button>
          <button class="btn primary" type="button" @click="downloadPackage">下载待审批方案包</button>
        </div>
        <p v-if="importNote" class="ok-text">{{ importNote }}</p>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

        <table v-if="lastImport" class="data-table import-result">
          <thead>
            <tr><th>接收行数</th><th>形成新版本</th><th>重复导入（未另出版本）</th><th>失败挂起</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{{ lastImport.received }}</td>
              <td>{{ lastImport.imported }}</td>
              <td>{{ lastImport.deduped }}</td>
              <td :class="{ 'error-text': failedItems.length > 0 }">{{ failedItems.length }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="failedItems.length" class="repair-box">
          <h4>失败行补录（从失败处继续，已导入的行不受影响）</h4>
          <div v-for="item in failedItems" :key="item.rowNo" class="repair-item">
            <p class="error-text">第 {{ item.rowNo }} 行：{{ item.message }}</p>
            <div v-if="item.missing.length" class="repair-grid">
              <label v-for="field in repairFields" :key="field">
                <span :class="{ required: item.missing.includes(field) }">{{ field }}</span>
                <input v-model="item.draft[fieldMap(field)]" :placeholder="item.missing.includes(field) ? `必录：${field}` : field" />
              </label>
            </div>
            <div class="repair-actions">
              <button v-if="item.missing.length" class="btn small primary" type="button" @click="continueImport(item)">
                补录并从该行继续导入
              </button>
              <button class="btn small ghost" type="button" @click="dropFailure(item)">放弃该行</button>
            </div>
          </div>
        </div>
      </section>

      <section class="exchange-panel">
        <h3>② 方案版本档案</h3>
        <p class="panel-hint">按方案编号归组；高亮为当前生效版本（有批准版以批准版为准），废止方案按原始日期只读保留。</p>
        <article v-for="(versions, code) in groups" :key="code" class="version-group">
          <h4>{{ code }} · {{ versionOf(String(code))?.planName ?? '—' }}</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>版本</th><th>来源</th><th>版本状态</th><th>原始日期</th>
                <th>适用范围</th><th>监测项目</th><th>测次安排</th><th>指纹</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="version in versions"
                :key="version.versionId"
                :class="{ 'version-current': isCurrent(String(code), version.versionId), 'version-readonly': version.status === '已废止' }"
              >
                <td>
                  第{{ version.versionId }}版
                  <span v-if="isCurrent(String(code), version.versionId)" class="tag approve">生效中</span>
                </td>
                <td><span class="tag" :class="version.source === '在线登记' ? 'online' : 'attach'">{{ version.source }}</span></td>
                <td><span class="tag" :class="versionStatusTag(version.status)">{{ version.status }}</span></td>
                <td>{{ version.originalDate }}</td>
                <td>{{ version.scope }}</td>
                <td>{{ version.monitorItems }}</td>
                <td>{{ version.frequency }}</td>
                <td><code>{{ version.hash }}</code></td>
              </tr>
            </tbody>
          </table>
          <p v-if="conflictNote(versions)" class="hint-text">{{ conflictNote(versions) }}</p>
        </article>
        <p v-if="!Object.keys(groups).length" class="empty-state">暂无版本档案</p>
      </section>

      <section class="exchange-panel">
        <h3>③ 交换记录</h3>
        <ul class="log-list">
          <li v-for="(log, index) in logs" :key="index" class="log-line">
            <span class="log-time">{{ log.time }}</span>
            <span class="tag" :class="log.kind === '方案废止' ? 'danger' : log.kind === '方案批准' ? 'approve' : 'attach'">{{ log.kind }}</span>
            <span>{{ log.message }}</span>
          </li>
        </ul>
        <p v-if="!logs.length" class="empty-state">暂无导入、下载与审批记录</p>
      </section>
    </template>

    <!-- ── 版本抽屉 ── -->
    <div v-if="drawerCode" class="drawer-mask" @click.self="closeDrawer">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>{{ drawerCode }} 版本对照</h3>
          <button class="btn small ghost" type="button" @click="closeDrawer">返回</button>
        </header>
        <p class="panel-hint">在线版本与附件冲突时以批准版本为准；切换方案或前往其他页面再返回，仍停留在选中的版本。</p>
        <ol class="version-timeline">
          <li
            v-for="version in drawerVersions"
            :key="version.versionId"
            :class="{ selected: version.versionId === selectedVersionId, readonly: version.status === '已废止' }"
          >
            <button class="version-pick" type="button" @click="selectVersion(version)">
              <strong>第{{ version.versionId }}版</strong>
              <span class="tag" :class="version.source === '在线登记' ? 'online' : 'attach'">{{ version.source }}</span>
              <span class="tag" :class="versionStatusTag(version.status)">{{ version.status }}</span>
              <span class="src-note">原始日期 {{ version.originalDate }}</span>
            </button>
            <dl v-if="version.versionId === selectedVersionId" class="version-detail">
              <dt>方案名称</dt><dd>{{ version.planName }}</dd>
              <dt>适用范围</dt><dd>{{ version.scope }}</dd>
              <dt>监测项目</dt><dd>{{ version.monitorItems }}</dd>
              <dt>测次安排</dt><dd>{{ version.frequency }}</dd>
              <dt>编制人</dt><dd>{{ version.editor }}</dd>
              <dt>批准人</dt><dd>{{ version.approver || '—' }}</dd>
              <dt v-if="version.note">说明</dt><dd v-if="version.note">{{ version.note }}</dd>
            </dl>
          </li>
        </ol>
        <footer class="drawer-foot">
          <RouterLink class="btn" to="/calibration" @click="goCalibration">前往仪器检定查看联动复核事项</RouterLink>
        </footer>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  approvePlan,
  currentPlanVersion,
  downloadAttachmentTemplate,
  downloadEntries,
  downloadPendingPackage,
  exchangeLogs,
  exchangeSummary,
  importAttachment,
  listEntries,
  moduleMeta,
  parseAttachmentCsv,
  planVersionGroups,
  rememberPlanVersion,
  rememberedPlan,
  clearRememberedPlan,
  repairFailure,
  runAction as applyAction,
} from '@/api/local-service'
import type { AttachmentFailure, AttachmentRow, EntryRow, ExchangeLog, PlanVersion } from '@/data/types'

const meta = moduleMeta('plan')
const columns = meta.fields
const filterFields = columns.slice(0, 3)
const statuses = meta.statuses

const tab = ref<'ledger' | 'exchange'>('ledger')
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const importNote = ref('')
const filters = ref<Record<string, string>>({})
const groups = ref<Record<string, PlanVersion[]>>({})
const logs = ref<ExchangeLog[]>([])
const lastImport = ref<{ received: number; imported: number; deduped: number } | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '方案总数', value: rows.value.length },
  { label: '已批准方案', value: rows.value.filter((row) => String(row.status) === '已批准').length },
  { label: '待审批方案', value: rows.value.filter((row) => String(row.status) === '待审批').length },
])
const summary = computed(() => exchangeSummary())

function actionsFor(status: string): string[] {
  if (status === '编制中') {
    return ['提交审批', '废止方案']
  }
  if (status === '待审批') {
    return ['批准方案']
  }
  if (status === '已批准' || status === '已修订') {
    return ['废止方案']
  }
  return []
}

function statusTag(status: string): string {
  if (status === '已批准') {
    return 'approve'
  }
  if (status === '已废止') {
    return 'danger'
  }
  if (status === '待审批') {
    return 'warn'
  }
  return 'muted'
}

function versionStatusTag(status: PlanVersion['status']): string {
  if (status === '已批准') {
    return 'approve'
  }
  if (status === '已废止') {
    return 'danger'
  }
  if (status === '冲突留档') {
    return 'warn'
  }
  return 'muted'
}

function versionOf(code: string): PlanVersion | undefined {
  return currentPlanVersion(groups.value[code] ?? [])
}

function isCurrent(code: string, versionId: number): boolean {
  return versionOf(code)?.versionId === versionId
}

function conflictNote(versions: PlanVersion[]): string | undefined {
  return versions.find((version) => version.status === '冲突留档')?.note
}

function refreshGroups() {
  groups.value = planVersionGroups()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result =
    action === '批准方案'
      ? approvePlan(Number(row.id))
      : applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
  refreshGroups()
  refreshLogs()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测报方案列表读取失败'
  }
  refreshGroups()
}

// ── 档案交换台 ──
const fileInput = ref<HTMLInputElement | null>(null)

type FailedItem = {
  rowNo: number
  missing: string[]
  message: string
  draft: Record<string, string>
}

const failedItems = ref<FailedItem[]>([])
const repairFields = ['方案编号', '方案名称', '适用范围', '监测项目', '测次安排'] as const
const fieldKey: Record<(typeof repairFields)[number], keyof AttachmentRow> = {
  方案编号: 'planCode',
  方案名称: 'planName',
  适用范围: 'scope',
  监测项目: 'monitorItems',
  测次安排: 'frequency',
}
function fieldMap(field: string): keyof AttachmentRow {
  return fieldKey[field as (typeof repairFields)[number]]
}

function toFailureItem(failure: AttachmentFailure): FailedItem {
  return {
    rowNo: failure.rowNo,
    missing: failure.missing,
    message: failure.message,
    draft: {
      planCode: failure.raw.planCode ?? '',
      planName: failure.raw.planName ?? '',
      scope: failure.raw.scope ?? '',
      monitorItems: failure.raw.monitorItems ?? '',
      frequency: failure.raw.frequency ?? '',
      editor: failure.raw.editor ?? '',
      originalDate: failure.raw.originalDate ?? '',
    },
  }
}

async function onFilePicked(event: Event) {
  errorMessage.value = ''
  importNote.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  let parsed: ReturnType<typeof parseAttachmentCsv>
  try {
    const text = await file.text()
    parsed = parseAttachmentCsv(text)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '附件清单读取失败'
    return
  } finally {
    if (fileInput.value) {
      fileInput.value.value = ''
    }
  }
  if (parsed.rows.length === 0) {
    errorMessage.value = '附件清单没有可导入的有效行，请补录失败行'
  } else {
    const result = importAttachment(parsed.rows)
    lastImport.value = { received: result.received, imported: result.imported, deduped: result.deduped }
    importNote.value = `本次接收 ${result.received} 行：形成新版本 ${result.imported} 个，重复导入 ${result.deduped} 行，失败挂起 ${result.failed} 行。`
  }
  failedItems.value = [...failedItems.value, ...parsed.failures.map(toFailureItem)]
  refreshGroups()
  refreshLogs()
}

function continueImport(item: FailedItem) {
  const pseudoFailure: AttachmentFailure = {
    rowNo: item.rowNo,
    missing: item.missing,
    raw: item.draft as Partial<AttachmentRow>,
    message: item.message,
  }
  const repaired = repairFailure(pseudoFailure, item.draft as Partial<AttachmentRow>)
  if ('failure' in repaired) {
    item.missing = repaired.failure.missing
    item.message = repaired.failure.message
    return
  }
  const result = importAttachment([repaired.row])
  const rejected = result.failures.find((failure) => failure.rowNo === item.rowNo)
  if (rejected) {
    item.missing = []
    item.message = rejected.message
    return
  }
  failedItems.value = failedItems.value.filter((failure) => failure.rowNo !== item.rowNo)
  importNote.value = `第 ${item.rowNo} 行已从失败处继续导入完成（当前批形成新版本 ${result.imported} 个，重复 ${result.deduped} 行）。`
  refreshGroups()
  refreshLogs()
}

function dropFailure(item: FailedItem) {
  failedItems.value = failedItems.value.filter((failure) => failure.rowNo !== item.rowNo)
}

function downloadTemplate() {
  downloadAttachmentTemplate()
}

function downloadPackage() {
  const { count } = downloadPendingPackage()
  importNote.value = `待审批方案包已下载，包含 ${count} 个待审批方案（含适用范围、监测项目、测次安排）。`
  refreshLogs()
}

function switchExchange() {
  tab.value = 'exchange'
  refreshGroups()
  refreshLogs()
}

function refreshLogs() {
  logs.value = exchangeLogs()
}

// ── 版本抽屉：返回后保留方案版本 ──
const drawerCode = ref<string | null>(null)
const selectedVersionId = ref<number | null>(null)
const drawerVersions = computed<PlanVersion[]>(() => (drawerCode.value ? groups.value[drawerCode.value] ?? [] : []))

function openVersions(code: string) {
  refreshGroups()
  drawerCode.value = code
  const remembered = rememberedPlan()
  const within = (groups.value[code] ?? []).some((version) => version.versionId === remembered.versionId)
  const initial = within && remembered.planCode === code
    ? remembered.versionId
    : versionOf(code)?.versionId ?? null
  selectedVersionId.value = initial
  if (initial !== null) {
    rememberPlanVersion(code, initial)
  }
}

function selectVersion(version: PlanVersion) {
  selectedVersionId.value = version.versionId
  rememberPlanVersion(version.planCode, version.versionId)
}

function closeDrawer() {
  drawerCode.value = null
  clearRememberedPlan()
}

function goCalibration() {
  // 版本选择已在 selectVersion 时记住；从检定页返回台账会自动重新打开本抽屉定位到该版。
}

onMounted(() => {
  reload()
  refreshLogs()
  const remembered = rememberedPlan()
  if (remembered.planCode && (groups.value[remembered.planCode]?.length ?? 0) > 0 && remembered.versionId !== null) {
    drawerCode.value = remembered.planCode
    selectedVersionId.value = remembered.versionId
  }
})
</script>
