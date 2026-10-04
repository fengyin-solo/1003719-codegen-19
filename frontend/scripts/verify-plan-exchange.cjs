/* 纯 Node 验证：不跑页面，直接驱动 plan-exchange 服务层，逐条核对需求规则。 */
const assert = require('node:assert')

// ---- 浏览器 API 桩 ----
const memory = new Map()
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
}
globalThis.window = globalThis
globalThis.Blob = class { constructor(parts) { this.parts = parts } }
let downloadCount = 0
globalThis.URL = { createObjectURL: () => `blob:${++downloadCount}`, revokeObjectURL: () => {} }
globalThis.document = {
  createElement: () => ({ click() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
}
const timers = []
globalThis.setTimeout = (fn, ms) => {
  timers.push(fn)
  return timers.length
}
function flushTimers() {
  while (timers.length) {
    timers.shift()()
  }
}

async function main() {
  const esbuild = require('/workspace/frontend/node_modules/esbuild')
  const result = await esbuild.build({
    entryPoints: ['/workspace/frontend/src/data/plan-exchange/service.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    alias: { '@': '/workspace/frontend/src' },
  })
  const code = result.outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  const svc = mod.exports

  // ---- 读取种子状态 ----
  svc.listPlanVersions() // 触发懒初始化播种
  const store = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  assert.strictEqual(store.versions.length, 4, '初始应有4份方案版本履历')
  const abolishedVersion = store.versions.find((v) => v.planCode === 'PLAN-2023-008')
  assert.strictEqual(abolishedVersion.readOnly, true, '废止方案版本初始即只读')
  assert.strictEqual(abolishedVersion.originalDate, '2023-06-02', '废止版本保持原批准日期')

  // ---- 场景1：提交审批 ----
  let r = svc.submitPlanForApproval(1)
  assert.ok(r.ok, '编制中方案可提交审批')
  r = svc.submitPlanForApproval(1)
  assert.ok(!r.ok && /重复提交/.test(r.message), '重复提交被幂等拦截')

  // ---- 场景2：并发批准只生效一次 ----
  const p1 = svc.approvePlan(1, '值班管理员')
  assert.ok(svc.isApproving(1), '首次批准进入在途状态')
  const p2 = svc.approvePlan(1, '值班管理员') // 在途期间并发提交
  const rr2 = await p2
  assert.ok(!rr2.ok && /正在批准中/.test(rr2.message), '并发提交被在途锁拦截')
  flushTimers()
  const rr1 = await p1
  assert.ok(rr1.ok, '首次批准生效')
  const storeAfter = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  // 仪器检定种子数据里有1条待送检
  assert.strictEqual(storeAfter.reviews.length, 1, '批准后应给检定待办新增1项复核事项')
  assert.match(storeAfter.reviews[0].content, /适用范围/, '复核事项应携带适用范围信息')
  // 批准落库后再次批准
  const p3 = svc.approvePlan(1, '值班管理员')
  flushTimers()
  const rr3 = await p3
  assert.ok(!rr3.ok && !/正在批准/.test(rr3.message), '批准完成后的重复提交按状态幂等拒绝')
  assert.strictEqual(
    JSON.parse(memory.get('hydrology-monitor-station:plan-exchange')).reviews.length,
    1,
    '重复批准不得重复新增复核事项',
  )

  // ---- 场景3：附件导入 - 各种分支 ----
  // 3a. 缺必需列：整体报错
  assert.throws(
    () => svc.importAttachmentList('bad.csv', '方案编号,方案名称\nX,Y'),
    /缺少必需列/,
    '缺列的清单应直接报错',
  )

  // 3b. 缺字段行进失败清单，正常行继续采用
  const csvWithMissing = [
    '方案编号,方案名称,适用范围,监测项目,测次安排,版本日期',
    'PLAN-2026-002,西岭站水库调度测报方案（附件修订）,西岭水库全流域,水位/流量/雨量,每日3次,2026-09-20',
    'PLAN-2026-002,,缺名称,监测,测次,2026-09-20',
    'PLAN-999,不存在方案,范围,项目,测次,2026-09-20',
  ].join('\n')
  const rep = svc.importAttachmentList('list1.csv', csvWithMissing)
  assert.strictEqual(rep.total, 3)
  assert.strictEqual(rep.adopted, 1, '正常行应采用')
  assert.strictEqual(rep.failed.length, 2, '缺字段行与不存在编号行都应失败')
  assert.strictEqual(svc.listFailures().length, 2, '失败行应入失败清单')
  // 待审批方案（无批准版本）被附件更新
  const s1 = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  const v2 = s1.versions.filter((v) => v.planId === 2)
  assert.strictEqual(v2.length, 2, '待审批方案采用附件后形成第2版')
  assert.strictEqual(v2[1].source, '附件')

  // 3c. 重复导入同一内容只形成一个版本
  const rep2 = svc.importAttachmentList('list1-dup.csv', csvWithMissing)
  assert.strictEqual(rep2.adopted, 0, '重复内容不再采用')
  assert.strictEqual(rep2.duplicated, 1, '重复内容计为跳过')
  const s2 = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  assert.strictEqual(s2.versions.filter((v) => v.planId === 2).length, 2, '重复导入不新增版本')

  // 3d. 与已批准在线版本冲突：以批准版本为准
  const conflictCsv = [
    '方案编号,方案名称,适用范围,监测项目,测次安排,版本日期',
    'PLAN-2026-001,东河方案-附件乱改版,错误范围,错误项目,错误测次,2026-10-01',
  ].join('\n')
  const rep3 = svc.importAttachmentList('conflict.csv', conflictCsv)
  assert.strictEqual(rep3.conflict, 1, '与批准版本冲突应计为冲突未采用')
  const s3 = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  const conflictAtt = s3.attachments.find((a) => a.filename === 'conflict.csv')
  assert.strictEqual(conflictAtt.status, '冲突未采用')
  const rowsAfterConflict = JSON.parse(memory.get('hydrology-monitor-station:entries')).plan
  const plan1 = rowsAfterConflict.find((p) => p.id === 1)
  assert.strictEqual(plan1['方案名称'], '东河水文站2026年汛期测报方案', '冲突时在线批准版本内容不得被附件覆盖')
  assert.strictEqual(plan1.status, '已批准', '方案保持已批准')

  // 3e. 废止方案附件：只读兼容、不改数据
  const abolishCsv = [
    '方案编号,方案名称,适用范围,监测项目,测次安排,版本日期',
    'PLAN-2023-008,废止方案附件改,新范围,新项目,新测次,2026-10-02',
  ].join('\n')
  const rep4 = svc.importAttachmentList('abolish.csv', abolishCsv)
  assert.strictEqual(rep4.readonlyAbolished, 1)
  const s4 = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  const abolishAtt = s4.attachments.find((a) => a.filename === 'abolish.csv')
  assert.strictEqual(abolishAtt.status, '废止只读兼容')
  const plan4 = JSON.parse(memory.get('hydrology-monitor-station:entries')).plan.find((p) => p.id === 4)
  assert.strictEqual(plan4['方案名称'], '北滩站2023年应急监测预案', '废止方案数据不得被附件改动')
  const abolishVersions = s4.versions.filter((v) => v.planId === 4)
  assert.ok(abolishVersions.every((v) => v.readOnly), '废止方案版本全部只读')
  assert.ok(abolishVersions.every((v) => v.originalDate === '2023-06-02'), '原日期保持不变')

  // ---- 场景4：从失败处继续 ----
  // 修正后重传：缺字段行补齐、不存在编号仍失败；旧失败行对已补齐方案结案
  const resumeCsv = [
    '方案编号,方案名称,适用范围,监测项目,测次安排,版本日期',
    'PLAN-2026-002,西岭站水库调度测报方案（补齐版）,西岭水库全流域,水位/流量/雨量,每日4次,2026-09-25',
    'PLAN-999,不存在方案,范围,项目,测次,2026-09-20',
  ].join('\n')
  const rep5 = svc.importAttachmentList('resume.csv', resumeCsv)
  assert.strictEqual(rep5.failed.length, 1, '仍只保留尚未解决的失败行')
  // 之前 PLAN-2026-002 缺字段的失败行应已结案
  const failures = svc.listFailures()
  assert.ok(failures.every((f) => f.raw['方案编号'] === 'PLAN-999'), '已补齐的旧失败行应被移除')

  // ---- 场景5：废止操作冻结全部历史版本 ----
  const r5 = svc.abolishPlan(1)
  assert.ok(r5.ok)
  const s5 = JSON.parse(memory.get('hydrology-monitor-station:plan-exchange'))
  const p1versions = s5.versions.filter((v) => v.planId === 1)
  assert.ok(p1versions.every((v) => v.readOnly), '废止后全部历史版本只读')
  // 废止方案再次提交被拒
  const r6 = svc.submitPlanForApproval(1)
  assert.ok(!r6.ok && /只读/.test(r6.message))

  // ---- 场景6：待审批方案包下载（2号当前仍为待审批） ----
  const r7 = svc.downloadPendingPackage()
  assert.ok(r7.ok)
  assert.ok(downloadCount >= 1, '应触发方案包文件下载')

  // ---- 场景7：复核事项可办结 ----
  const pending = svc.listReviews()
  assert.strictEqual(pending.length, 1)
  const r8 = svc.completeReview(pending[0].id)
  assert.ok(r8.ok)
  assert.strictEqual(svc.listReviews().length, 0)

  console.log('全部业务规则验证通过 ✔')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
