/**
 * 行为特征标签版本的服务层：把本地持久化、模板/规则清单和纯计算流程串起来。
 * 「特征工程」与「行动标签」两个页面都只调这里，跨模块数据流因此只有一份。
 */

import { listRows } from '@/data/local-store'
import {
  loadFeatureLabelState,
  resetFeatureLabelState,
  saveFeatureLabelState,
} from '@/data/feature-label-store'
import type {
  FeatureLabelState,
  FeatureTemplateInput,
  HitResult,
  LabelRuleInput,
  PublishPolicy,
} from '@/domain/feature-label'
import {
  archiveConflictInState,
  archivePublishedVersionInState,
  labelPanelRows,
  labelVectorEntries,
  migrateLabelsInState,
  publishVersionsInState,
  requestTrialInState,
  reviewVersionInState,
  verifyVersion,
  type PublishItemOutcome,
  type PublishSubject,
  type ReviewOutcome,
  type TrialOutcome,
} from '@/domain/feature-label-flow'

export type TrialRequestPayload = {
  templateCode: string
  ruleCodes: string[]
  businessVersion?: string
}

export type TrialResponse = {
  outcome: TrialOutcome
  state: FeatureLabelState
}

export function featureTemplates(): FeatureTemplateInput[] {
  return listRows('feature').map((row) => ({
    code: String(row['模板编号'] ?? ''),
    name: String(row['特征名称'] ?? ''),
    type: String(row['特征类型'] ?? ''),
    logic: String(row['计算逻辑'] ?? ''),
    windowDays: Number(row['时间窗口天'] ?? 7) || 7,
    aggregate: String(row['聚合函数'] ?? ''),
    outputField: String(row['输出字段名'] ?? ''),
    fill: String(row['缺失值填充'] ?? ''),
    status: String(row.status),
    version: String(row['模板版本'] ?? 'v1.0.0'),
    businessVersion: String(row['业务版本'] ?? ''),
    businessOrder: Number(row['字段归属顺序'] ?? 0) || 0,
  }))
}

export function labelRules(): LabelRuleInput[] {
  return listRows('action').map((row) => ({
    code: String(row['规则编号'] ?? ''),
    name: String(row['标签名称'] ?? ''),
    category: String(row['标签类别'] ?? ''),
    eventGroup: String(row['触发事件组'] ?? ''),
    frequency: String(row['频率条件'] ?? ''),
    period: String(row['统计周期'] ?? ''),
    level: String(row['标签等级'] ?? ''),
    businessLine: String(row['生效业务线'] ?? ''),
    status: String(row.status),
    version: String(row['规则版本'] ?? 'v1.0.0'),
    businessVersion: String(row['业务版本'] ?? ''),
  }))
}

export function featureLabelState(): FeatureLabelState {
  return loadFeatureLabelState()
}

export function currentBusinessVersions(): string[] {
  const values = new Set<string>()
  for (const template of featureTemplates()) {
    if (template.businessVersion) {
      values.add(template.businessVersion)
    }
  }
  for (const rule of labelRules()) {
    if (rule.businessVersion) {
      values.add(rule.businessVersion)
    }
  }
  for (const version of loadFeatureLabelState().versions) {
    if (version.businessVersion) {
      values.add(version.businessVersion)
    }
  }
  return [...values].sort()
}

function resolveBusinessVersion(requested?: string): string {
  if (requested && requested.trim()) {
    return requested.trim()
  }
  const versions = currentBusinessVersions()
  return versions[0] ?? 'BV-2026-Q4'
}

export function trialFeatureLabel(payload: TrialRequestPayload, now = new Date().toISOString()): TrialResponse {
  const template = featureTemplates().find((item) => item.code === payload.templateCode)
  if (!template) {
    return {
      state: loadFeatureLabelState(),
      outcome: { ok: false, duplicate: false, message: `没有找到特征模板 ${payload.templateCode}` },
    }
  }
  const rulesByCode = new Map(labelRules().map((rule) => [rule.code, rule]))
  const selected: LabelRuleInput[] = []
  for (const code of payload.ruleCodes) {
    const rule = rulesByCode.get(code)
    if (!rule) {
      return {
        state: loadFeatureLabelState(),
        outcome: { ok: false, duplicate: false, message: `没有找到标签规则 ${code}` },
      }
    }
    selected.push(rule)
  }
  if (selected.length === 0) {
    return {
      state: loadFeatureLabelState(),
      outcome: { ok: false, duplicate: false, message: '请至少选择一条标签规则参与试算' },
    }
  }
  const businessVersion = resolveBusinessVersion(payload.businessVersion)
  const result = requestTrialInState(loadFeatureLabelState(), {
    template,
    rules: selected,
    businessVersion,
    actor: '值班管理员',
    now,
  })
  const saved = saveFeatureLabelState(result.state)
  return { state: saved, outcome: result.outcome }
}

export function reviewFeatureLabelVersion(
  versionCode: string,
  businessVersion: string,
  now = new Date().toISOString(),
): { state: FeatureLabelState; outcome: ReviewOutcome } {
  const state = loadFeatureLabelState()
  const version = state.versions.find((item) => item.code === versionCode)
  const hit = state.hits.find((item) => item.versionCode === versionCode)
  if (!version || !hit) {
    return {
      state,
      outcome: {
        ok: false,
        reasons: [`没有找到版本 ${versionCode} 的试算结果`],
        summary: `没有找到版本 ${versionCode} 的试算结果`,
        coverage: 0,
        hitCount: 0,
        templateVersion: '',
        vectorDigest: '',
        version: version ?? null,
      },
    }
  }
  const template = featureTemplates().find((item) => item.code === version.templateCode)
  const rules = version.ruleCodes
    .map((code) => labelRules().find((rule) => rule.code === code))
    .filter((rule): rule is LabelRuleInput => Boolean(rule))
  if (!template) {
    return {
      state,
      outcome: {
        ok: false,
        reasons: [`没有找到版本绑定的特征模板 ${version.templateCode}`],
        summary: `没有找到版本绑定的特征模板 ${version.templateCode}`,
        coverage: 0,
        hitCount: 0,
        templateVersion: version.templateVersion,
        vectorDigest: version.vectorDigest,
        version,
      },
    }
  }
  const result = reviewVersionInState(state, {
    version,
    hit,
    template,
    rules,
    businessVersion: businessVersion || version.businessVersion,
    now,
  })
  const saved = saveFeatureLabelState(result.state)
  return { state: saved, outcome: { ...result.outcome, version: saved.versions.find((item) => item.code === versionCode) ?? version } }
}

function subjectsFor(
  state: FeatureLabelState,
  versionCodes: string[],
): Record<string, PublishSubject | undefined> {
  const templates = new Map(featureTemplates().map((template) => [template.code, template]))
  const rules = new Map(labelRules().map((rule) => [rule.code, rule]))
  const subjects: Record<string, PublishSubject | undefined> = {}
  for (const code of versionCodes) {
    const version = state.versions.find((item) => item.code === code)
    if (!version) {
      continue
    }
    const template = templates.get(version.templateCode)
    const versionRules = version.ruleCodes
      .map((ruleCode) => rules.get(ruleCode))
      .filter((rule): rule is LabelRuleInput => Boolean(rule))
    if (template && versionRules.length === version.ruleCodes.length) {
      subjects[code] = { template, rules: versionRules }
    }
  }
  return subjects
}

export function publishFeatureLabelVersions(
  versionCodes: string[],
  policy: PublishPolicy,
  businessVersion: string,
  now = new Date().toISOString(),
): {
  state: FeatureLabelState
  items: PublishItemOutcome[]
  migrations: number
  policy: PublishPolicy
} {
  const state = loadFeatureLabelState()
  const result = publishVersionsInState(state, {
    versionCodes,
    policy,
    actor: '值班管理员',
    now,
    subjects: subjectsFor(state, versionCodes),
    businessVersion: businessVersion || resolveBusinessVersion(),
  })
  const saved = saveFeatureLabelState(result.state)
  return {
    state: saved,
    items: result.outcome.items,
    migrations: result.outcome.migrations.length,
    policy: result.outcome.policy,
  }
}

export function verifyFeatureLabelVersion(
  versionCode: string,
  businessVersion: string,
): ReviewOutcome | null {
  const state = loadFeatureLabelState()
  const version = state.versions.find((item) => item.code === versionCode)
  const hit = state.hits.find((item) => item.versionCode === versionCode)
  if (!version || !hit) {
    return null
  }
  const template = featureTemplates().find((item) => item.code === version.templateCode)
  const rules = version.ruleCodes
    .map((code) => labelRules().find((rule) => rule.code === code))
    .filter((rule): rule is LabelRuleInput => Boolean(rule))
  if (!template) {
    return null
  }
  const result = verifyVersion({
    version,
    hit,
    template,
    rules,
    businessVersion: businessVersion || version.businessVersion,
  })
  return { ...result, version }
}

export function migrateFeatureLabelItems(codes: string[], now = new Date().toISOString()) {
  const result = migrateLabelsInState(loadFeatureLabelState(), codes, now)
  const saved = saveFeatureLabelState(result.state)
  return { state: saved, migrated: result.migrated }
}

export function archiveFeatureLabelConflict(code: string, now = new Date().toISOString()) {
  const result = archiveConflictInState(loadFeatureLabelState(), code, now)
  const saved = saveFeatureLabelState(result.state)
  return { state: saved, ok: result.ok }
}

export function archiveFeatureLabelVersion(code: string, now = new Date().toISOString()) {
  const result = archivePublishedVersionInState(loadFeatureLabelState(), code, now)
  const saved = saveFeatureLabelState(result.state)
  return { state: saved, ok: result.ok, message: result.message }
}

export function actionLabelPanelRows(state: FeatureLabelState = loadFeatureLabelState()) {
  return labelPanelRows(state)
}

export function actionLabelVectorEntries(state: FeatureLabelState = loadFeatureLabelState()) {
  return labelVectorEntries(state)
}

export function resetFeatureLabel() {
  return resetFeatureLabelState()
}

export function versionHit(state: FeatureLabelState, versionCode: string): HitResult | undefined {
  return state.hits.find((hit) => hit.versionCode === versionCode)
}

export type { ReviewOutcome, TrialOutcome }
