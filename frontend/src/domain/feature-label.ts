/**
 * 行为特征标签版本的纯计算内核。
 *
 * 这一层不依赖 Vue、localStorage 或页面，只做四件事：
 * 1. 把特征模板与标签规则绑定成一次可复算的试算（行为特征向量 + 标签命中 + 覆盖率）。
 * 2. 生成绑定键与向量摘要，保证标签命中、覆盖率和特征模板版本严格绑定。
 * 3. 对同一输出字段的发布请求做仲裁，保证一个字段只服务一份可追溯的命中结果。
 * 4. 给行动标签侧输出带特征模板版本、标签版本来源的向量清单。
 *
 * 页面与本地数据层只负责取出输入、把结果存回去。
 */

export type PublishPolicy = 'publish-order' | 'field-business-order'

export const PUBLISH_POLICY_LABELS: Record<PublishPolicy, string> = {
  'publish-order': '模板发布完成顺序',
  'field-business-order': '字段占用业务顺序',
}

export type VersionStatus = '草稿' | '试算中' | '已发布' | '已替换' | '已归档'

export type HitStatus = '试算' | '已发布' | '字段冲突' | '已替换' | '已归档'

export type ConflictType = '字段冲突' | '重复回执'

export type ConflictStatus = '待处理' | '已归档'

export type MigrationStatus = '待迁移' | '已迁移'

export type FeatureTemplateInput = {
  code: string
  name: string
  type: string
  logic: string
  windowDays: number
  aggregate: string
  outputField: string
  fill: string
  status: string
  version: string
  businessVersion: string
  businessOrder: number
}

export type LabelRuleInput = {
  code: string
  name: string
  category: string
  eventGroup: string
  frequency: string
  period: string
  level: string
  businessLine: string
  status: string
  version: string
  businessVersion: string
}

export type BehaviorFeatureVector = {
  templateCode: string
  templateVersion: string
  windowDays: number
  aggregate: string
  outputField: string
  sampleSize: number
  nonMissing: number
  coverage: number
  mean: number
  p50: number
  p90: number
  min: number
  max: number
  digest: string
  values: number[]
}

export type LabelHit = {
  ruleCode: string
  ruleVersion: string
  ruleName: string
  metricName: string
  threshold: number
  direction: 'gte' | 'lte'
  hitCount: number
  hitRate: number
}

export type HitResult = {
  code: string
  versionCode: string
  businessVersion: string
  batchCode: string
  templateCode: string
  templateVersion: string
  templateName: string
  templateBusinessOrder: number
  outputField: string
  bindingKey: string
  vector: BehaviorFeatureVector
  sampleSize: number
  nonMissing: number
  coverage: number
  labelHits: LabelHit[]
  status: HitStatus
  createdAt: string
  publishedAt: string
  publishOrder: number
}

export type FeatureLabelVersion = {
  code: string
  businessVersion: string
  batchCode: string
  templateCode: string
  templateName: string
  templateVersion: string
  templateBusinessOrder: number
  outputField: string
  ruleCodes: string[]
  ruleVersions: Record<string, string>
  ruleNames: Record<string, string>
  bindingKey: string
  hitCode: string
  vectorDigest: string
  status: VersionStatus
  createdAt: string
  createdBy: string
  publishedAt: string
  archivedAt: string
  publishOrder: number
  reviewOk: boolean
  reviewedAt: string
  reviewSummary: string
}

export type ConflictTicket = {
  code: string
  type: ConflictType
  status: ConflictStatus
  businessVersion: string
  outputField: string
  templateCode: string
  templateVersion: string
  hitCode: string
  versionCode: string
  winningTemplateCode: string
  winningVersionCode: string
  winningHitCode: string
  policy: PublishPolicy | ''
  message: string
  detail: string
  createdAt: string
  updatedAt: string
}

export type MigrationItem = {
  code: string
  status: MigrationStatus
  ruleCode: string
  ruleName: string
  fromHitCode: string
  fromVersionCode: string
  fromTemplateCode: string
  fromTemplateVersion: string
  toHitCode: string
  toVersionCode: string
  toTemplateCode: string
  toTemplateVersion: string
  businessVersion: string
  outputField: string
  createdAt: string
  migratedAt: string
}

export type FeatureLabelState = {
  versions: FeatureLabelVersion[]
  hits: HitResult[]
  conflicts: ConflictTicket[]
  migrations: MigrationItem[]
  sequences: {
    version: number
    hit: number
    conflict: number
    migration: number
    publish: number
  }
}

export type PublishCandidate = {
  versionCode: string
  hitCode: string
  templateCode: string
  templateVersion: string
  templateBusinessOrder: number
  outputField: string
  businessVersion: string
  publishOrder: number
  publishedBefore: boolean
  ruleCodes: string[]
  ruleNames: Record<string, string>
}

export type PublishMigrationPlan = {
  ruleCode: string
  ruleName: string
  fromHitCode: string
  fromVersionCode: string
  toHitCode: string
  toVersionCode: string
}

export type PublishPlan<T extends PublishCandidate = PublishCandidate> = {
  policy: PublishPolicy
  winner: T
  losers: T[]
  replaced: T | null
  migrations: PublishMigrationPlan[]
}

export type TrialBuildInput = {
  versionCode: string
  hitCode: string
  businessVersion: string
  batchCode: string
  template: FeatureTemplateInput
  rules: LabelRuleInput[]
  createdAt: string
  createdBy: string
}

/** FNV-1a：纯前端、同步、稳定，用来生成绑定键摘要与样本种子。 */
export function hashText(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) {
    return sorted[lower]
  }
  const weight = position - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

/**
 * 由模板编码、模板版本、业务版本和输出字段共同决定样本。
 * 同样的模板版本一定得到同样的向量，模板或版本一变，摘要随之变化。
 */
export function createBehaviorVector(template: FeatureTemplateInput): BehaviorFeatureVector {
  const seed = hashText(
    `${template.code}|${template.version}|${template.businessVersion}|${template.outputField}|${template.windowDays}|${template.aggregate}`,
  )
  const random = mulberry32(seed)
  const sampleSize = 160 + (seed % 80)
  const missingRate = 0.03 + ((seed >>> 7) % 120) / 1000
  const missingCount = Math.max(6, Math.round(sampleSize * missingRate))
  const center = 34 + ((seed >>> 11) % 44)
  const spread = 12 + ((seed >>> 17) % 22)
  const missingIndexes = new Set<number>()
  while (missingIndexes.size < missingCount) {
    missingIndexes.add(Math.floor(random() * sampleSize))
  }
  const values: number[] = []
  for (let index = 0; index < sampleSize; index += 1) {
    const noise = (random() + random() + random()) / 3 - 0.5
    const value = Math.min(100, Math.max(0, center + noise * 2 * spread))
    if (!missingIndexes.has(index)) {
      values.push(round(value))
    }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const nonMissing = values.length
  const coverage = sampleSize === 0 ? 0 : round(nonMissing / sampleSize, 4)
  const mean = nonMissing === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / nonMissing)
  return {
    templateCode: template.code,
    templateVersion: template.version,
    windowDays: template.windowDays,
    aggregate: template.aggregate,
    outputField: template.outputField,
    sampleSize,
    nonMissing,
    coverage,
    mean,
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    min: sorted.length ? round(sorted[0]) : 0,
    max: sorted.length ? round(sorted[sorted.length - 1]) : 0,
    digest: '',
    values,
  }
}

export function sortedRules(rules: LabelRuleInput[]): LabelRuleInput[] {
  return [...rules].sort((left, right) => left.code.localeCompare(right.code))
}

export function evaluateLabelHits(vector: BehaviorFeatureVector, rules: LabelRuleInput[]): LabelHit[] {
  return sortedRules(rules).map((rule) => {
    const matched = rule.frequency.match(/(\d+(?:\.\d+)?)/)
    const threshold = matched ? Number(matched[1]) : 20 + (hashText(rule.code) % 60)
    const direction: 'gte' | 'lte' = /≤|<=|小于|低于|不超过/.test(rule.frequency) ? 'lte' : 'gte'
    const hitCount = vector.values.filter((value) =>
      direction === 'gte' ? value >= threshold : value <= threshold,
    ).length
    return {
      ruleCode: rule.code,
      ruleVersion: rule.version,
      ruleName: rule.name,
      metricName: rule.eventGroup,
      threshold,
      direction,
      hitCount,
      hitRate: vector.nonMissing === 0 ? 0 : round(hitCount / vector.nonMissing, 4),
    }
  })
}

function ruleSignature(rules: LabelRuleInput[]): string {
  return sortedRules(rules)
    .map((rule) => `${rule.code}:${rule.version}`)
    .join(',')
}

/** 绑定键把模板编码、模板版本、业务版本、输出字段和标签规则版本绑在一起。 */
export function buildBindingKey(
  template: FeatureTemplateInput,
  rules: LabelRuleInput[],
  businessVersion: string,
): string {
  return [
    `${template.code}@${template.version}`,
    businessVersion,
    template.outputField,
    ruleSignature(rules),
  ].join('|')
}

/** 向量摘要参与复核：模板版本、业务版本、样本值和标签规则版本任一变化都会对不上。 */
export function computeVectorDigest(
  template: FeatureTemplateInput,
  rules: LabelRuleInput[],
  businessVersion: string,
  vector: BehaviorFeatureVector,
): string {
  const payload = [
    template.code,
    template.version,
    businessVersion,
    template.outputField,
    String(template.windowDays),
    template.aggregate,
    String(vector.sampleSize),
    String(vector.nonMissing),
    vector.values.map((value) => value.toFixed(2)).join(','),
    ruleSignature(rules),
  ].join('#')
  return `VD-${hashText(payload).toString(16).padStart(8, '0').toUpperCase()}`
}

export function buildTrial(input: TrialBuildInput): {
  version: FeatureLabelVersion
  hit: HitResult
} {
  const rules = sortedRules(input.rules)
  const vector = createBehaviorVector(input.template)
  const labelHits = evaluateLabelHits(vector, rules)
  vector.digest = computeVectorDigest(input.template, rules, input.businessVersion, vector)
  const bindingKey = buildBindingKey(input.template, rules, input.businessVersion)
  const ruleVersions = Object.fromEntries(rules.map((rule) => [rule.code, rule.version]))
  const ruleNames = Object.fromEntries(rules.map((rule) => [rule.code, rule.name]))
  const version: FeatureLabelVersion = {
    code: input.versionCode,
    businessVersion: input.businessVersion,
    batchCode: input.batchCode,
    templateCode: input.template.code,
    templateName: input.template.name,
    templateVersion: input.template.version,
    templateBusinessOrder: input.template.businessOrder,
    outputField: input.template.outputField,
    ruleCodes: rules.map((rule) => rule.code),
    ruleVersions,
    ruleNames,
    bindingKey,
    hitCode: input.hitCode,
    vectorDigest: vector.digest,
    status: '试算中',
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    publishedAt: '',
    archivedAt: '',
    publishOrder: 0,
    reviewOk: false,
    reviewedAt: '',
    reviewSummary: '',
  }
  const hit: HitResult = {
    code: input.hitCode,
    versionCode: input.versionCode,
    businessVersion: input.businessVersion,
    batchCode: input.batchCode,
    templateCode: input.template.code,
    templateVersion: input.template.version,
    templateName: input.template.name,
    templateBusinessOrder: input.template.businessOrder,
    outputField: input.template.outputField,
    bindingKey,
    vector,
    sampleSize: vector.sampleSize,
    nonMissing: vector.nonMissing,
    coverage: vector.coverage,
    labelHits,
    status: '试算',
    createdAt: input.createdAt,
    publishedAt: '',
    publishOrder: 0,
  }
  return { version, hit }
}

/** 同一输出字段的候选发布请求：按策略选唯一赢家，其余候选保留但不得发布。 */
export function arbitratePublish<T extends PublishCandidate>(
  candidates: T[],
  policy: PublishPolicy,
): PublishPlan<T> {
  if (candidates.length === 0) {
    throw new Error('没有可仲裁的发布候选')
  }
  const ordered = [...candidates].sort((left, right) => {
    if (policy === 'publish-order') {
      return (
        left.publishOrder - right.publishOrder ||
        left.templateCode.localeCompare(right.templateCode)
      )
    }
    return (
      left.templateBusinessOrder - right.templateBusinessOrder ||
      left.publishOrder - right.publishOrder ||
      left.templateCode.localeCompare(right.templateCode)
    )
  })
  const winner = ordered[0]
  const losers = ordered.slice(1)
  const replaced =
    policy === 'field-business-order'
      ? losers.find((candidate) => candidate.publishedBefore) ?? null
      : null
  const migrations: PublishMigrationPlan[] = replaced
    ? replaced.ruleCodes.map((ruleCode) => ({
        ruleCode,
        ruleName: replaced.ruleNames[ruleCode] ?? ruleCode,
        fromHitCode: replaced.hitCode,
        fromVersionCode: replaced.versionCode,
        toHitCode: winner.hitCode,
        toVersionCode: winner.versionCode,
      }))
    : []
  return { policy, winner, losers, replaced, migrations }
}
