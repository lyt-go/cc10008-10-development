/**
 * 行为特征标签版本的验收脚本：直接驱动纯计算流程，不依赖浏览器。
 * 运行：npx tsx scripts/verify-feature-label.ts（或通过 vitest）
 */

import assert from 'node:assert/strict'

import {
  arbitratePublish,
  buildBindingKey,
  computeVectorDigest,
  createBehaviorVector,
  evaluateLabelHits,
  PUBLISH_POLICY_LABELS,
  type FeatureTemplateInput,
  type LabelRuleInput,
} from '../src/domain/feature-label'
import {
  archivePublishedVersionInState,
  emptyFeatureLabelState,
  labelPanelRows,
  labelVectorEntries,
  publishVersionsInState,
  requestTrialInState,
  verifyVersion,
  type PublishRequest,
} from '../src/domain/feature-label-flow'

const BV = 'BV-2026-Q4'
const NOW = '2026-11-17T09:00:00.000Z'

const templateA: FeatureTemplateInput = {
  code: 'FEAT-0001',
  name: '近7日活跃天数',
  type: '数值型',
  logic: '统计用户近7日有行为的天数并归一化到0-100',
  windowDays: 7,
  aggregate: 'COUNT_DISTINCT',
  outputField: 'user_active_score',
  fill: '0',
  status: '已发布',
  version: 'v1.0.0',
  businessVersion: BV,
  businessOrder: 1,
}

const templateB: FeatureTemplateInput = {
  ...templateA,
  code: 'FEAT-0002',
  name: '近7日活跃得分',
  logic: '按事件权重加权统计近7日活跃得分',
  aggregate: 'WEIGHTED_AVG',
  status: '模板评审中',
  businessOrder: 2,
}

const templateC: FeatureTemplateInput = {
  code: 'FEAT-0003',
  name: '高价值用户识别度',
  type: '数值型',
  logic: '结合付费、复访与分享行为计算高价值识别度',
  windowDays: 30,
  aggregate: 'SCORE_SUM',
  outputField: 'user_value_score',
  fill: '0',
  status: '已发布',
  version: 'v2.3.0',
  businessVersion: BV,
  businessOrder: 3,
}

const rules: LabelRuleInput[] = [
  {
    code: 'ACTI-0001',
    name: '高活跃用户',
    category: '活跃度',
    eventGroup: '页面浏览',
    frequency: '>= 35',
    period: '近7日',
    level: 'A',
    businessLine: '内容线',
    status: '已生效',
    version: 'v1.0.0',
    businessVersion: BV,
  },
  {
    code: 'ACTI-0002',
    name: '活跃流失预警',
    category: '流失预警',
    eventGroup: '访问频次',
    frequency: '<= 45',
    period: '近7日',
    level: 'B',
    businessLine: '内容线',
    status: '规则评审中',
    version: 'v1.1.0',
    businessVersion: BV,
  },
  {
    code: 'ACTI-0003',
    name: '高价值转化用户',
    category: '价值分层',
    eventGroup: '付费转化',
    frequency: '>= 60',
    period: '近30日',
    level: 'A',
    businessLine: '交易线',
    status: '已生效',
    version: 'v2.0.0',
    businessVersion: BV,
  },
]

function trial(state: ReturnType<typeof emptyFeatureLabelState>, template: FeatureTemplateInput, ruleCodes: string[]) {
  return requestTrialInState(state, {
    template,
    rules: rules.filter((rule) => ruleCodes.includes(rule.code)),
    businessVersion: BV,
    actor: '验收脚本',
    now: NOW,
  })
}

const TEMPLATE_BY_CODE: Record<string, FeatureTemplateInput> = {
  'FEAT-0001': templateA,
  'FEAT-0002': templateB,
  'FEAT-0003': templateC,
}

/** 发布时附带实时模板/规则，模拟页面从清单里取数：有 subjects 会再走一遍复核。 */
function makePublishRequest(
  state: ReturnType<typeof emptyFeatureLabelState>,
  versionCodes: string[],
  policy: PublishRequest['policy'],
  now = NOW,
): PublishRequest {
  const subjects: PublishRequest['subjects'] = {}
  for (const code of versionCodes) {
    const version = state.versions.find((item) => item.code === code)
    const template = version ? TEMPLATE_BY_CODE[version.templateCode] : undefined
    if (version && template) {
      subjects[code] = {
        template,
        rules: rules.filter((rule) => version.ruleCodes.includes(rule.code)),
      }
    }
  }
  return {
    versionCodes,
    policy,
    actor: '验收脚本',
    now,
    subjects,
    businessVersion: BV,
  }
}

// ---------------------------------------------------------------
// 场景 1：FEAT-0003 试算 —— 标签命中、覆盖率与模板版本严格绑定
// ---------------------------------------------------------------
const scenario1 = trial(emptyFeatureLabelState(), templateC, ['ACTI-0003'])
assert.equal(scenario1.outcome.ok, true, 'FEAT-0003 试算应当成功')
if (!scenario1.outcome.ok) {
  throw new Error('试算失败')
}
const hitC = scenario1.outcome.hit
const versionC = scenario1.outcome.version

assert.equal(hitC.templateCode, 'FEAT-0003')
assert.equal(hitC.vector.templateVersion, 'v2.3.0')
assert.equal(versionC.templateVersion, 'v2.3.0')
assert.equal(hitC.vector.templateCode, 'FEAT-0003')
assert.equal(hitC.outputField, 'user_value_score')
assert.equal(versionC.businessVersion, BV)
assert.ok(hitC.sampleSize > 0)
assert.ok(hitC.coverage > 0 && hitC.coverage < 1)
assert.equal(hitC.coverage, Number((hitC.nonMissing / hitC.sampleSize).toFixed(4)))
assert.equal(hitC.labelHits.length, 1)
assert.equal(hitC.labelHits[0].ruleCode, 'ACTI-0003')
assert.equal(hitC.labelHits[0].ruleVersion, 'v2.0.0')
assert.deepEqual(versionC.ruleVersions, { 'ACTI-0003': 'v2.0.0' })

const verifyC = verifyVersion({
  version: versionC,
  hit: hitC,
  template: templateC,
  rules: rules.filter((rule) => rule.code === 'ACTI-0003'),
  businessVersion: BV,
})
assert.equal(verifyC.ok, true, `FEAT-0003 按同一业务版本复核应通过：${verifyC.summary}`)

// 模板版本变化后复核必须失败
const bumpedC: FeatureTemplateInput = { ...templateC, version: 'v2.4.0' }
const verifyBumped = verifyVersion({
  version: versionC,
  hit: hitC,
  template: bumpedC,
  rules: rules.filter((rule) => rule.code === 'ACTI-0003'),
  businessVersion: BV,
})
assert.equal(verifyBumped.ok, false, '模板版本变化后复核必须失败')
assert.ok(verifyBumped.reasons.some((reason) => reason.includes('特征模板当前版本')))

// 业务版本变化后复核必须失败
const verifyWrongBv = verifyVersion({
  version: versionC,
  hit: hitC,
  template: templateC,
  rules: rules.filter((rule) => rule.code === 'ACTI-0003'),
  businessVersion: 'BV-2026-Q3',
})
assert.equal(verifyWrongBv.ok, false, '业务版本不一致时复核必须失败')

// 同版本重算稳定（标签命中与覆盖率可复现）
const vectorAgain = createBehaviorVector(templateC)
assert.equal(vectorAgain.digest, '')
assert.deepEqual(vectorAgain.values, hitC.vector.values)
assert.deepEqual(evaluateLabelHits(vectorAgain, rules.filter((rule) => rule.code === 'ACTI-0003')), hitC.labelHits)

// ---------------------------------------------------------------
// 场景 2：两个模板争用同一输出字段 + 同一批标签同时试算
// ---------------------------------------------------------------
let sharedState = emptyFeatureLabelState()
const trialA = trial(sharedState, templateA, ['ACTI-0001', 'ACTI-0002'])
assert.equal(trialA.outcome.ok, true)
sharedState = trialA.state
const trialB = trial(sharedState, templateB, ['ACTI-0001', 'ACTI-0002'])
assert.equal(trialB.outcome.ok, true)
sharedState = trialB.state
if (!trialA.outcome.ok || !trialB.outcome.ok) {
  throw new Error('两个模板的试算都应当成功')
}
const versionA = trialA.outcome.version
const versionB = trialB.outcome.version
assert.notEqual(versionA.bindingKey, versionB.bindingKey)
assert.equal(versionA.ruleCodes.join(','), versionB.ruleCodes.join(','))

// 重复提交：只保留首个命中结果，其余进入冲突队列
const duplicate = requestTrialInState(sharedState, {
  template: templateA,
  rules: rules.filter((rule) => ['ACTI-0001', 'ACTI-0002'].includes(rule.code)),
  businessVersion: BV,
  actor: '验收脚本',
  now: NOW,
})
assert.equal(duplicate.outcome.ok, false)
if (duplicate.outcome.ok) {
  throw new Error('重复试算不应成功')
}
assert.equal(duplicate.outcome.duplicate, true)
assert.equal(duplicate.outcome.conflict.type, '重复回执')
assert.equal(duplicate.outcome.conflict.hitCode, trialA.outcome.hit.code)
assert.equal(duplicate.state.hits.filter((hit) => hit.bindingKey === versionA.bindingKey).length, 1)

// 复核两个版本（模板状态不影响复核）
for (const built of [trialA, trialB]) {
  if (!built.outcome.ok) {
    continue
  }
  const reviewed = verifyVersion({
    version: built.outcome.version,
    hit: built.outcome.hit,
    template: built.outcome.version.templateCode === 'FEAT-0001' ? templateA : templateB,
    rules: rules.filter((rule) => ['ACTI-0001', 'ACTI-0002'].includes(rule.code)),
    businessVersion: BV,
  })
  assert.equal(reviewed.ok, true, reviewed.summary)
}

const reviewedState = {
  ...duplicate.state,
  versions: duplicate.state.versions.map((version) => ({ ...version, reviewOk: true })),
}

// ---------------------------------------------------------------
// 场景 3A：模板发布完成顺序 —— 先发布者保留命中结果，后者收冲突单、保留草稿
// ---------------------------------------------------------------
{
  const first = publishVersionsInState(reviewedState, {
    ...makePublishRequest(reviewedState, [versionA.code], 'publish-order', '2026-11-17T09:10:00.000Z'),
  })
  const firstItem = first.outcome.items.find((item) => item.versionCode === versionA.code)
  assert.ok(firstItem?.ok, '第一个发布请求应成功')
  const versionAAfterFirst = first.state.versions.find((version) => version.code === versionA.code)
  const versionBAfterFirst = first.state.versions.find((version) => version.code === versionB.code)

  const second = publishVersionsInState(first.state, {
    ...makePublishRequest(first.state, [versionB.code, versionA.code], 'publish-order', '2026-11-17T09:20:00.000Z'),
  })
  const itemB = second.outcome.items.find((item) => item.versionCode === versionB.code)
  const itemA = second.outcome.items.find((item) => item.versionCode === versionA.code)
  assert.equal(itemB?.ok, false)
  assert.equal(itemB?.status, '字段冲突')
  assert.equal(itemA?.status, '重复回执', '已发布的版本重复提交应回到冲突队列')
  const versionBAfter = second.state.versions.find((version) => version.code === versionB.code)
  const versionAAfter = second.state.versions.find((version) => version.code === versionA.code)
  assert.equal(versionBAfter?.status, '草稿', '冲突模板必须保留草稿')
  assert.equal(versionAAfter?.status, '已发布', '先发布模板的版本保持已发布')
  const publishedHits = second.state.hits.filter((hit) => hit.status === '已发布')
  assert.equal(publishedHits.length, 1, '一个输出字段只允许一份已发布命中结果')
  assert.equal(publishedHits[0].templateCode, 'FEAT-0001')
  const conflict = second.state.conflicts.find((ticket) => ticket.code === itemB?.conflictCode)
  assert.ok(conflict)
  assert.equal(conflict.outputField, 'user_active_score')
  assert.equal(conflict.winningTemplateCode, 'FEAT-0001')
  assert.ok(conflict.detail.includes('一次只允许发布一份命中结果'))
  assert.equal(
    itemA?.conflictCode ? second.state.conflicts.find((t) => t.code === itemA.conflictCode)?.type : '',
    '重复回执',
  )
  assert.ok(versionAAfterFirst && versionBAfterFirst)
  assert.equal(second.state.migrations.length, 0, '发布顺序策略不产生迁移单')
  console.log('场景 3A 通过：先发布模板保留结果，后到模板生成字段冲突单并保留草稿')
}

// ---------------------------------------------------------------
// 场景 3B：字段占用业务顺序 —— 字段归属模板替换结果，被替换标签进入待迁移清单
// ---------------------------------------------------------------
{
  // 先让 FEAT-0002（字段归属顺序 2）发布成功
  const first = publishVersionsInState(reviewedState, {
    ...makePublishRequest(reviewedState, [versionB.code], 'field-business-order', '2026-11-17T09:10:00.000Z'),
  })
  assert.ok(first.outcome.items.find((item) => item.versionCode === versionB.code)?.ok)
  const firstPublished = first.state.hits.filter((hit) => hit.status === '已发布')
  assert.equal(firstPublished.length, 1)
  assert.equal(firstPublished[0].templateCode, 'FEAT-0002')

  // 再让 FEAT-0001（字段归属顺序 1）发布：应当替换掉 FEAT-0002
  const second = publishVersionsInState(first.state, {
    ...makePublishRequest(first.state, [versionA.code], 'field-business-order', '2026-11-17T09:30:00.000Z'),
  })
  const itemA = second.outcome.items.find((item) => item.versionCode === versionA.code)
  assert.ok(itemA?.ok, '字段归属更靠前的模板应当发布成功')
  assert.equal(itemA?.replacedHitCode, trialB.outcome.ok ? trialB.outcome.hit.code : '')
  const versionBAfter = second.state.versions.find((version) => version.code === versionB.code)
  const hitBAfter = second.state.hits.find((hit) => hit.templateCode === 'FEAT-0002' && hit.outputField === 'user_active_score')
  assert.equal(versionBAfter?.status, '已替换')
  assert.equal(second.state.hits.filter((hit) => hit.status === '已发布' && hit.outputField === 'user_active_score').length, 1)
  assert.equal(hitBAfter?.status, '已替换')
  assert.equal(second.state.migrations.length, versionB.ruleCodes.length, '被替换标签应全部进入待迁移清单')
  assert.ok(second.state.migrations.every((item) => item.status === '待迁移'))
  assert.ok(second.state.migrations.every((item) => item.fromTemplateCode === 'FEAT-0002' && item.toTemplateCode === 'FEAT-0001'))
  console.log('场景 3B 通过：字段归属模板替换结果，被替换标签进入待迁移清单')
}

// ---------------------------------------------------------------
// 场景 4：行动标签清单只从已发布命中结果取向量，并保留来源版本
// ---------------------------------------------------------------
{
  const state = publishVersionsInState(reviewedState, {
    ...makePublishRequest(reviewedState, [versionA.code], 'publish-order', '2026-11-17T09:40:00.000Z'),
  }).state
  const entries = labelVectorEntries(state)
  assert.equal(entries.length, 1, '标签侧只应看到已发布的命中结果')
  assert.equal(entries[0].templateCode, 'FEAT-0001')
  assert.equal(entries[0].templateVersion, 'v1.0.0')
  assert.equal(entries[0].businessVersion, BV)
  assert.equal(entries[0].hitCode, trialA.outcome.ok ? trialA.outcome.hit.code : '')
  assert.ok(entries[0].bindingKey.includes('FEAT-0001@v1.0.0'))
  assert.equal(entries[0].labelHits.length, 2)
  assert.ok(entries[0].labelHits.every((hit) => hit.ruleVersion))

  const rows = labelPanelRows(state)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.templateVersion === 'v1.0.0'))
  assert.ok(rows.every((row) => row.ruleVersion && row.vectorDigest.startsWith('VD-')))

  const hitA = state.hits.find((hit) => hit.code === entries[0].hitCode)
  assert.ok(hitA)
  assert.deepEqual(entries[0].vector, hitA.vector, '标签侧拿到的向量必须与命中结果一致')
  console.log('场景 4 通过：行动标签清单从已发布命中结果取向量，并保留特征模板与标签版本来源')
}

// ---------------------------------------------------------------
// 场景 5：绑定键与向量摘要对版本敏感
// ---------------------------------------------------------------
{
  const base = buildBindingKey(templateC, rules, BV)
  assert.equal(base, buildBindingKey(templateC, rules, BV))
  assert.notEqual(base, buildBindingKey({ ...templateC, version: 'v2.4.0' }, rules, BV))
  assert.notEqual(base, buildBindingKey(templateC, rules, 'BV-2026-Q3'))
  assert.notEqual(
    base,
    buildBindingKey(templateC, rules.map((rule) => ({ ...rule, version: `${rule.version}-patch` })), BV),
  )
  const vector = createBehaviorVector(templateC)
  const digest = computeVectorDigest(templateC, rules, BV, vector)
  assert.ok(digest.startsWith('VD-'))
  assert.notEqual(digest, computeVectorDigest({ ...templateC, version: 'v2.4.0' }, rules, BV, vector))

  const plan = arbitratePublish(
    [
      { versionCode: 'V1', hitCode: 'H1', templateCode: 'FEAT-0002', templateVersion: 'v1.0.0', templateBusinessOrder: 2, outputField: 'f', businessVersion: BV, publishOrder: 1, publishedBefore: true, ruleCodes: [], ruleNames: {} },
      { versionCode: 'V2', hitCode: 'H2', templateCode: 'FEAT-0001', templateVersion: 'v1.0.0', templateBusinessOrder: 1, outputField: 'f', businessVersion: BV, publishOrder: 2, publishedBefore: false, ruleCodes: [], ruleNames: {} },
    ],
    'field-business-order',
  )
  assert.equal(plan.winner.versionCode, 'V2')
  assert.equal(plan.replaced?.versionCode, 'V1')
  assert.equal(PUBLISH_POLICY_LABELS['publish-order'], '模板发布完成顺序')
  console.log('场景 5 通过：绑定键与向量摘要对模板版本、业务版本、规则版本敏感')
}

// ---------------------------------------------------------------
// 场景 6：跨业务版本也不能让同一输出字段出现两份已发布命中结果；
//         归档释放字段后才允许另一业务版本发布。
// ---------------------------------------------------------------
{
  const otherBv = 'BV-2027-Q1'
  const templateANext = { ...templateA, businessVersion: otherBv }
  const ruleNext = { ...rules[0], businessVersion: otherBv, version: 'v1.0.1' }
  const sameField = { ...templateB, businessVersion: otherBv, version: 'v1.2.0' }

  const basePublish = publishVersionsInState(reviewedState, {
    ...makePublishRequest(reviewedState, [versionA.code], 'publish-order', '2026-11-17T11:00:00.000Z'),
  }).state
  const owner = basePublish.hits.find((hit) => hit.status === '已发布')
  assert.ok(owner)
  assert.equal(owner.outputField, 'user_active_score')

  const nextTrial = requestTrialInState(basePublish, {
    template: sameField,
    rules: [ruleNext],
    businessVersion: otherBv,
    actor: '验收脚本',
    now: '2026-11-17T11:05:00.000Z',
  })
  assert.equal(nextTrial.outcome.ok, true)
  if (!nextTrial.outcome.ok) {
    throw new Error('跨版本试算失败')
  }
  const reviewedNext = {
    ...nextTrial.state,
    versions: nextTrial.state.versions.map((version) => ({ ...version, reviewOk: true })),
  }
  const blocked = publishVersionsInState(reviewedNext, {
    versionCodes: [nextTrial.outcome.version.code],
    policy: 'publish-order',
    actor: '验收脚本',
    now: '2026-11-17T11:10:00.000Z',
    subjects: { [nextTrial.outcome.version.code]: { template: sameField, rules: [ruleNext] } },
    businessVersion: otherBv,
  })
  const blockedItem = blocked.outcome.items[0]
  assert.equal(blockedItem.ok, false, '跨业务版本争用同一字段也必须被拦住')
  assert.equal(blockedItem.status, '字段冲突')
  assert.equal(
    blocked.state.hits.filter((hit) => hit.status === '已发布' && hit.outputField === 'user_active_score').length,
    1,
    '同一输出字段全局只允许一份已发布命中结果',
  )

  // 归档释放字段后再发布
  const archived = archivePublishedVersionInState(blocked.state, owner.versionCode, '2026-11-17T11:20:00.000Z')
  assert.equal(archived.ok, true, archived.message)
  const retried = publishVersionsInState(archived.state, {
    versionCodes: [nextTrial.outcome.version.code],
    policy: 'publish-order',
    actor: '验收脚本',
    now: '2026-11-17T11:25:00.000Z',
    subjects: { [nextTrial.outcome.version.code]: { template: sameField, rules: [ruleNext] } },
    businessVersion: otherBv,
  })
  assert.equal(retried.outcome.items[0].ok, true, retried.outcome.items[0].message)
  const live = retried.state.hits.filter((hit) => hit.status === '已发布' && hit.outputField === 'user_active_score')
  assert.equal(live.length, 1)
  assert.equal(live[0].businessVersion, otherBv)
  assert.equal(
    labelVectorEntries(retried.state).filter((entry) => entry.outputField === 'user_active_score').length,
    1,
    '标签侧仍只看到一份该字段的命中结果',
  )
  assert.equal(templateANext.businessVersion, otherBv)
  console.log('场景 6 通过：跨业务版本争用同一字段仍只保留一份已发布命中结果，归档释放后可重新发布')
}

console.log('全部验收场景通过')

