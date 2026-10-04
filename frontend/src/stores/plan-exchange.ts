import { defineStore } from 'pinia'

import type {
  AttachmentRecord,
  ExchangeLog,
  ImportFailure,
  ImportReport,
  PlanVersionRecord,
  ReviewItem,
} from '@/data/plan-exchange/types'
import {
  abolishPlan as abolish,
  approvePlan as approve,
  completeReview,
  downloadFailureTemplate,
  downloadImportTemplate,
  downloadPendingPackage,
  importAttachmentList,
  isApproving,
  listAttachments,
  listFailures,
  listLogs,
  listPlanVersions,
  listReviews,
  submitPlanForApproval,
  type ServiceResult,
} from '@/data/plan-exchange/service'

type TabKey = 'ledger' | 'exchange'

// 交换台的界面状态放进 store：从交换台返回台账、再进别的页面回来，标签页与版本筛选都还在。
export const usePlanExchangeStore = defineStore('plan-exchange', {
  state: () => ({
    activeTab: 'exchange' as TabKey,
    versionFilter: '' as string | number,
    notice: '' as string,
    noticeOk: true as boolean,
    lastReport: null as ImportReport | null,
    // 读取数据时做一次浅拷贝，保证服务层落库后页面能感知到变化。
    versions: [] as PlanVersionRecord[],
    attachments: [] as AttachmentRecord[],
    failures: [] as ImportFailure[],
    reviews: [] as ReviewItem[],
    logs: [] as ExchangeLog[],
  }),
  getters: {
    pendingReviewCount: (state) => state.reviews.filter((review) => !review.done).length,
  },
  actions: {
    setTab(tab: TabKey) {
      this.activeTab = tab
    },
    setVersionFilter(value: string) {
      this.versionFilter = value === '' ? '' : Number(value)
    },
    setNotice(message: string, ok = true) {
      this.notice = message
      this.noticeOk = ok
    },
    clearNotice() {
      this.notice = ''
    },
    refresh() {
      this.versions = listPlanVersions()
      this.attachments = listAttachments()
      this.failures = listFailures()
      this.reviews = listReviews(true)
      this.logs = listLogs()
    },
    submit(id: number) {
      const result = submitPlanForApproval(id)
      this.setNotice(result.message, result.ok)
      this.refresh()
      return result
    },
    abolish(id: number) {
      const result = abolish(id)
      this.setNotice(result.message, result.ok)
      this.refresh()
      return result
    },
    async approve(id: number, operator: string) {
      if (isApproving(id)) {
        const result: ServiceResult = { ok: false, message: '该方案正在批准中，请勿重复提交' }
        this.setNotice(result.message, false)
        return result
      }
      const result = await approve(id, operator)
      this.setNotice(result.message, result.ok)
      this.refresh()
      return result
    },
    importFile(filename: string, text: string) {
      try {
        const report = importAttachmentList(filename, text)
        this.lastReport = report
        const summary = `导入完成：采用 ${report.adopted} 份、重复跳过 ${report.duplicated} 份、冲突未采用 ${report.conflict} 份、废止只读 ${report.readonlyAbolished} 份、失败 ${report.failed.length} 行`
        this.setNotice(summary, report.failed.length === 0)
        this.refresh()
        return report
      } catch (error) {
        this.setNotice(error instanceof Error ? error.message : '附件清单解析失败', false)
        return null
      }
    },
    downloadPackage() {
      const result = downloadPendingPackage()
      this.setNotice(result.message, result.ok)
      this.refresh()
    },
    downloadFailures() {
      downloadFailureTemplate()
    },
    downloadTemplate() {
      downloadImportTemplate()
    },
    finishReview(id: number): ServiceResult {
      const result = completeReview(id)
      this.setNotice(result.message, result.ok)
      this.refresh()
      return result
    },
  },
})

export type { TabKey }
