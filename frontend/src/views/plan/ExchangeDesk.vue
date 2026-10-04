<template>
  <section class="exchange">
    <div class="exchange-toolbar">
      <div class="upload-group">
        <label class="btn primary upload-btn">
          上传附件清单（CSV）
          <input ref="fileInput" type="file" accept=".csv,text/csv" hidden @change="onFilePicked" />
        </label>
        <button class="btn" type="button" @click="store.downloadTemplate()">下载清单模板</button>
        <button
          class="btn"
          type="button"
          :disabled="store.failures.length === 0"
          @click="store.downloadFailures()"
        >
          下载失败行（{{ store.failures.length }}）
        </button>
      </div>
      <button class="btn primary" type="button" @click="store.downloadPackage()">
        下载待审批方案包
      </button>
    </div>

    <p class="hint">
      规则：附件与已批准的在线版本冲突时以批准版本为准；同内容重复导入只形成一个版本；
      废止方案的附件按原日期只读留痕；缺字段行进失败清单，补齐后重新上传即从失败处继续。
    </p>

    <p v-if="store.notice" :class="['notice', store.noticeOk ? 'ok' : 'bad']">{{ store.notice }}</p>

    <template v-if="store.lastReport">
      <h3 class="block-title">本次导入结果</h3>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">清单总行数</span>
          <strong class="stat-value">{{ store.lastReport.total }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">采用形成新版本</span>
          <strong class="stat-value">{{ store.lastReport.adopted }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">重复跳过</span>
          <strong class="stat-value">{{ store.lastReport.duplicated }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">冲突未采用</span>
          <strong class="stat-value">{{ store.lastReport.conflict }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">废止只读兼容</span>
          <strong class="stat-value">{{ store.lastReport.readonlyAbolished }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">失败行</span>
          <strong class="stat-value" :class="{ 'text-bad': store.lastReport.failed.length > 0 }">
            {{ store.lastReport.failed.length }}
          </strong>
        </article>
      </div>
      <ul class="detail-list">
        <li v-for="(detail, index) in store.lastReport.details" :key="index">{{ detail }}</li>
      </ul>
    </template>

    <h3 class="block-title">待审批方案包内容（含适用范围、监测项目、测次安排）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>方案编号</th>
          <th>方案名称</th>
          <th>适用范围</th>
          <th>监测项目</th>
          <th>测次安排</th>
          <th>当前版本</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in pendingPlans" :key="String(row.id)">
          <td>{{ row['方案编号'] }}</td>
          <td>{{ row['方案名称'] }}</td>
          <td>{{ row['适用范围'] }}</td>
          <td>{{ row['监测项目'] }}</td>
          <td>{{ row['测次安排'] }}</td>
          <td>{{ currentVersionLabel(Number(row.id)) }}</td>
        </tr>
        <tr v-if="pendingPlans.length === 0">
          <td colspan="6" class="empty-state">暂无待审批方案，方案包暂无可下载内容</td>
        </tr>
      </tbody>
    </table>

    <div class="two-col">
      <div>
        <h3 class="block-title">附件清单记录</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>方案编号</th>
              <th>附件文件</th>
              <th>适用范围</th>
              <th>监测项目</th>
              <th>测次安排</th>
              <th>处理结果</th>
              <th>附件日期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in store.attachments" :key="item.id">
              <td>{{ item.planCode }}</td>
              <td>{{ item.filename }}</td>
              <td>{{ item.content.适用范围 }}</td>
              <td>{{ item.content.监测项目 }}</td>
              <td>{{ item.content.测次安排 }}</td>
              <td>
                <span :class="['badge', attachmentBadgeClass(item.status)]">{{ item.status }}</span>
                <span v-if="item.note" class="cell-note">{{ item.note }}</span>
              </td>
              <td>{{ item.versionDate }}</td>
            </tr>
            <tr v-if="store.attachments.length === 0">
              <td colspan="7" class="empty-state">尚未上传附件清单</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <h3 class="block-title">
          导入失败清单
          <button
            v-if="store.failures.length > 0"
            class="link"
            type="button"
            @click="store.downloadFailures()"
          >
            下载修正
          </button>
        </h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>来源文件/行号</th>
              <th>方案编号</th>
              <th>失败原因</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in store.failures" :key="item.id">
              <td>{{ item.filename }} · 第{{ item.line }}行</td>
              <td>{{ item.raw['方案编号'] || '—' }}</td>
              <td>{{ item.reasons.join('；') }}</td>
              <td>{{ item.createdAt }}</td>
            </tr>
            <tr v-if="store.failures.length === 0">
              <td colspan="4" class="empty-state">没有失败行，或失败行补齐重传后已从失败处继续</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <h3 class="block-title">
      方案版本履历
      <select
        :value="store.versionFilter === '' ? '' : String(store.versionFilter)"
        class="version-filter"
        @change="onVersionFilterChange"
      >
        <option value="">全部方案</option>
        <option v-for="option in planOptions" :key="option.id" :value="String(option.id)">
          {{ option.label }}
        </option>
      </select>
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>方案编号</th>
          <th>版本</th>
          <th>来源</th>
          <th>方案名称</th>
          <th>适用范围</th>
          <th>监测项目</th>
          <th>测次安排</th>
          <th>批准留档</th>
          <th>状态</th>
          <th>原日期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="version in filteredVersions" :key="version.id">
          <td>{{ version.planCode }}</td>
          <td>第{{ version.versionNo }}版</td>
          <td>
            {{ version.source }}
            <span v-if="version.attachmentName" class="cell-note">{{ version.attachmentName }}</span>
          </td>
          <td>{{ version.content.方案名称 }}</td>
          <td>{{ version.content.适用范围 }}</td>
          <td>{{ version.content.监测项目 }}</td>
          <td>{{ version.content.测次安排 }}</td>
          <td>
            <span :class="['badge', version.approved ? 'badge-green' : 'badge-gray']">
              {{ version.approved ? '已批准' : '未批准' }}
            </span>
          </td>
          <td>
            <span v-if="version.readOnly" class="badge badge-gray">只读兼容</span>
            <span v-else-if="version.adopted" class="badge badge-blue">现行采用</span>
            <span v-else class="badge badge-orange">冲突未采用</span>
          </td>
          <td>{{ version.originalDate }}</td>
        </tr>
        <tr v-if="filteredVersions.length === 0">
          <td colspan="10" class="empty-state">暂无版本履历</td>
        </tr>
      </tbody>
    </table>
    <p class="hint">
      在线版本与附件冲突时，以「批准留档」的最新版本为准；方案废止后所有版本冻结为只读，形成日期保持原日期不变。
    </p>

    <h3 class="block-title">批准联动的仪器检定复核事项（{{ pendingReviewCount }} 项待办）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>仪器检定待办</th>
          <th>来源方案</th>
          <th>复核内容</th>
          <th>生成时间</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="review in store.reviews" :key="review.id">
          <td>{{ review.entryLabel }}</td>
          <td>{{ review.planCode }} {{ review.planName }}</td>
          <td>{{ review.content }}</td>
          <td>{{ review.createdAt }}</td>
          <td>
            <span :class="['badge', review.done ? 'badge-green' : 'badge-orange']">
              {{ review.done ? '已复核' : '待复核' }}
            </span>
          </td>
          <td>
            <button v-if="!review.done" class="link" type="button" @click="store.finishReview(review.id)">
              完成复核
            </button>
            <span v-else class="cell-note">已办结</span>
          </td>
        </tr>
        <tr v-if="store.reviews.length === 0">
          <td colspan="6" class="empty-state">方案批准后，仪器检定入口的待送检待办会在这里一并新增复核事项</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">交换日志</h3>
    <ul class="log-list">
      <li v-for="log in store.logs.slice(0, 12)" :key="log.id">
        <span class="log-time">{{ log.time }}</span>
        <span :class="['badge', 'badge-blue']">{{ log.kind }}</span>
        <span>{{ log.message }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { listEntries } from '@/api/local-service'
import { usePlanExchangeStore } from '@/stores/plan-exchange'

const store = usePlanExchangeStore()
const fileInput = ref<HTMLInputElement | null>(null)

const pendingPlans = computed(() =>
  listEntries('plan')
    .items.filter((row) => String(row.status) === '待审批'),
)

const planOptions = computed(() => {
  const unique = new Map<number, string>()
  for (const version of store.versions) {
    if (!unique.has(version.planId)) {
      unique.set(version.planId, `${version.planCode} ${version.content.方案名称}`)
    }
  }
  return [...unique.entries()].map(([id, label]) => ({ id, label }))
})

const filteredVersions = computed(() =>
  store.versionFilter === ''
    ? store.versions
    : store.versions.filter((version) => version.planId === store.versionFilter),
)

const pendingReviewCount = computed(() => store.reviews.filter((review) => !review.done).length)

function currentVersionLabel(planId: number): string {
  const version = store.versions
    .filter((item) => item.planId === planId)
    .sort((a, b) => b.versionNo - a.versionNo)[0]
  return version ? `第${version.versionNo}版（${version.source}）` : '第1版（在线）'
}

function onVersionFilterChange(event: Event) {
  store.setVersionFilter((event.target as HTMLSelectElement).value)
}

function attachmentBadgeClass(status: string): string {
  if (status === '已采用') {
    return 'badge-green'
  }
  if (status === '重复跳过') {
    return 'badge-gray'
  }
  if (status === '冲突未采用') {
    return 'badge-orange'
  }
  return 'badge-blue'
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    store.importFile(file.name, String(reader.result ?? ''))
    input.value = ''
  }
  reader.onerror = () => {
    store.setNotice('附件清单读取失败，请重试', false)
    input.value = ''
  }
  reader.readAsText(file, 'utf-8')
}
</script>
