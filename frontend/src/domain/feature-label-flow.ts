/**
 * 行为特征标签版本的状态流转：试算、复核、发布仲裁、迁移。
 *
 * 全部是「传入状态 → 返回新状态」的纯函数，页面和 localStorage 只做搬运，
 * 因此同一套规则可以在浏览器里跑，也可以在脚本里复算验收。
 */

import {
  arbitratePublish,
  buildBindingKey,
  buildTrial,
  computeVectorDigest,
  createBehaviorVector,
  evaluateLabelHits,
  hashText,
  PUBLISH_POLICY_LABELS,
  sortedRules,
  type BehaviorFeatureVector,
  type ConflictTicket,
  type FeatureLabelState,
  type FeatureLabelVersion,
  type FeatureTemplateInput,
  type HitResult,
  type LabelHit,
  type LabelRuleInput,
  type MigrationItem,
  type PublishPolicy,
} from './feature-label'

export type TrialRequest = {
  template: FeatureTemplateInput
  rules: LabelRuleInput[]
  businessVersion: string
  actor: string
  now: string
}

export type TrialOutcome =
  | { ok: true; duplicate: false; version: FeatureLabelVersion; hit: HitResult }
  | { ok: false; duplicate: true; conflict: ConflictTicket; message: string }
  | { ok: false; duplicate: false; message: string }

export type VerifyRequest = {
  version: FeatureLabelVersion
  hit: HitResult
  template: FeatureTemplateInput
  rules: LabelRuleInput[]
  businessVersion: string
}

export type VerifyOutcome = {
  ok: boolean
  reasons: string[]
  summary: string
  coverage: number
  hitCount: number
  templateVersion: string
  vectorDigest: string
}

export type ReviewOutcome = VerifyOutcome & {
  version: FeatureLabelVersion | null
}

export type PublishSubject = {
  template: FeatureTemplateInput
  rules: LabelRuleInput[]
}

export type PublishRequest = {
  versionCodes: string[]
  policy: PublishPolicy
  actor: string
  now: string
  /** 从特征模板/标签规则清单实时读到的数据；有值时发布前再复核一次，防止模板已改动。 */
  subjects?: Record<string, PublishSubject | undefined>
  businessVersion: string
}

export type PublishItemStatus = '已发布' | '字段冲突' | '重复回执' | '拒绝'

export type PublishItemOutcome = {
  ok: boolean
  versionCode: string
  hitCode: string
  templateCode: string
  outputField: string
  status: PublishItemStatus
  conflictCode: string
  replacedHitCode: string
  message: string
}

export type PublishOutcome = {
  items: PublishItemOutcome[]
  migrations: MigrationItem[]
  policy: PublishPolicy
}

export type LabelPanelRow = {
  hitCode: string
  versionCode: string
  businessVersion: string
  batchCode: string
  templateCode: string
  templateName: string
  templateVersion: string
  templateBusinessOrder: number
  outputField: string
  bindingKey: string
  vectorDigest: string
  sampleSize: number
  nonMissing: number
  coverage: number
  mean: number
  p50: number
  p90: number
  publishedAt: string
  ruleCode: string
  ruleName: string
  ruleVersion: string
  metricName: string
  threshold: number
  direction: 'gte' | 'lte'
  hitCount: number
  hitRate: number
}

export type LabelVectorEntry = {
  hitCode: string
  versionCode: string
  businessVersion: string
  batchCode: string
  templateCode: string
  templateName: string
  templateVersion: string
  templateBusinessOrder: number
  outputField: string
  vectorDigest: string
  coverage: number
  sampleSize: number
  nonMissing: number
  publishedAt: string
  vector: BehaviorFeatureVector
  labelHits: LabelHit[]
  bindingKey: string
}

export function emptyFeatureLabelState(): FeatureLabelState {
  return {
    versions: [],
    hits: [],
    conflicts: [],
    migrations: [],
    sequences: { version: 0, hit: 0, conflict: 0, migration: 0, publish: 0 },
  }
}

function pad(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(4, '0')}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const ACTIVE_HIT_STATUSES = ['试算', '已发布', '字段冲突']

function ruleSetMatches(version: FeatureLabelVersion, rules: LabelRuleInput[]): boolean {
  const expected = sortedRules(rules)
  if (expected.length !== version.ruleCodes.length) {
    return false
  }
  return expected.every((rule, index) => {
    const code = version.ruleCodes[index]
    return code === rule.code && version.ruleVersions[code] === rule.version
  })
}

/**
 * 按同一业务版本复核：模板版本、标签规则版本、绑定键、向量摘要与覆盖率必须全部对得上。
 * 任何一项变化都会让复核失败，避免用旧模板的向量去支撑新版本的标签命中。
 */
export function verifyVersion(request: VerifyRequest): VerifyOutcome {
  const { version, hit, template, rules, businessVersion } = request
  const reasons: string[] = []
  if (!businessVersion.trim()) {
    reasons.push('未提供复核所用业务版本')
  }
  if (version.businessVersion !== businessVersion) {
    reasons.push(`版本业务版本 ${version.businessVersion} 与本次复核业务版本 ${businessVersion} 不一致`)
  }
  if (template.businessVersion !== businessVersion) {
    reasons.push(`特征模板业务版本 ${template.businessVersion} 与复核业务版本 ${businessVersion} 不一致`)
  }
  const mismatchedRules = sortedRules(rules).filter((rule) => rule.businessVersion !== businessVersion)
  if (mismatchedRules.length > 0) {
    reasons.push(`标签规则 ${mismatchedRules.map((rule) => rule.code).join('、')} 不属于业务版本 ${businessVersion}`)
  }
  if (template.code !== version.templateCode) {
    reasons.push(`版本绑定模板 ${version.templateCode}，与当前模板 ${template.code} 不一致`)
  }
  if (template.version !== version.templateVersion) {
    reasons.push(`特征模板当前版本 ${template.version} 与命中结果绑定的 ${version.templateVersion} 不一致`)
  }
  const bindingKey = buildBindingKey(template, rules, businessVersion)
  if (bindingKey !== version.bindingKey || bindingKey !== hit.bindingKey) {
    reasons.push('绑定键与模板/规则版本重算结果不一致')
  }
  if (!ruleSetMatches(version, rules)) {
    reasons.push('标签规则集合或规则版本与试算版本不一致')
  }
  const vector = createBehaviorVector(template)
  const digest = computeVectorDigest(template, rules, businessVersion, vector)
  if (digest !== version.vectorDigest || digest !== hit.vector.digest) {
    reasons.push(`向量摘要不一致（当前模板重算 ${digest}，记录为 ${version.vectorDigest}）`)
  }
  if (hit.vector.templateCode !== template.code || hit.vector.templateVersion !== template.version) {
    reasons.push('行为特征向量携带的模板来源与当前模板不一致')
  }
  const coverage = vector.coverage
  if (Math.abs(hit.coverage - coverage) > 1e-9 || Math.abs(hit.vector.coverage - coverage) > 1e-9) {
    reasons.push(`覆盖率不一致（重算 ${(coverage * 100).toFixed(1)}%，记录 ${(hit.coverage * 100).toFixed(1)}%）`)
  }
  const expectedHits = evaluateLabelHits(vector, rules)
  if (expectedHits.length !== hit.labelHits.length) {
    reasons.push(`标签命中条数与规则数不一致（重算 ${expectedHits.length} 条，记录 ${hit.labelHits.length} 条）`)
  } else {
    expectedHits.forEach((expected, index) => {
      const actual = hit.labelHits[index]
      if (
        expected.ruleCode !== actual.ruleCode ||
        expected.ruleVersion !== actual.ruleVersion ||
        expected.hitCount !== actual.hitCount
      ) {
        reasons.push(`标签 ${expected.ruleCode} 的命中数与重算结果不一致`)
      }
    })
  }
  const ok = reasons.length === 0
  const hitCount = hit.labelHits.reduce((sum, item) => sum + item.hitCount, 0)
  const summary = ok
    ? `复核通过：模板 ${template.code}@${template.version} · 业务版本 ${businessVersion} · 覆盖率 ${(coverage * 100).toFixed(1)}%（${vector.nonMissing}/${vector.sampleSize}）· 标签命中 ${hit.labelHits.length} 条（合计 ${hitCount} 次）· 向量摘要 ${digest}`
    : `复核未通过：${reasons.join('；')}`
  return {
    ok,
    reasons,
    summary,
    coverage,
    hitCount,
    templateVersion: template.version,
    vectorDigest: digest,
  }
}

export function reviewVersionInState(
  state: FeatureLabelState,
  request: VerifyRequest & { now: string },
): { state: FeatureLabelState; outcome: ReviewOutcome } {
  const next = clone(state)
  const result = verifyVersion(request)
  const version = next.versions.find((item) => item.code === request.version.code)
  if (!version) {
    return {
      state: next,
      outcome: { ...result, ok: false, summary: `没有找到版本 ${request.version.code}`, version: request.version },
    }
  }
  version.reviewOk = result.ok
  version.reviewedAt = request.now
  version.reviewSummary = result.summary
  return { state: next, outcome: { ...result, version } }
}

function createConflict(
  state: FeatureLabelState,
  input: Omit<ConflictTicket, 'code' | 'createdAt' | 'updatedAt' | 'status'> & { now: string },
): ConflictTicket {
  state.sequences.conflict += 1
  const ticket: ConflictTicket = {
    code: pad('CFLT', state.sequences.conflict),
    type: input.type,
    status: '待处理',
    businessVersion: input.businessVersion,
    outputField: input.outputField,
    templateCode: input.templateCode,
    templateVersion: input.templateVersion,
    hitCode: input.hitCode,
    versionCode: input.versionCode,
    winningTemplateCode: input.winningTemplateCode,
    winningVersionCode: input.winningVersionCode,
    winningHitCode: input.winningHitCode,
    policy: input.policy,
    message: input.message,
    detail: input.detail,
    createdAt: input.now,
    updatedAt: input.now,
  }
  state.conflicts.unshift(ticket)
  return ticket
}

/**
 * 试算请求。同一绑定键只保留首个命中结果，后来的重复回执全部进冲突队列。
 * 试算结果此时还不能被标签侧消费，需先复核再发布。
 */
export function requestTrialInState(
  state: FeatureLabelState,
  request: TrialRequest,
): { state: FeatureLabelState; outcome: TrialOutcome } {
  const next = clone(state)
  const { template, rules, businessVersion, actor, now } = request
  const activeRules = sortedRules(rules)
  if (!template.code || activeRules.length === 0) {
    return {
      state: next,
      outcome: { ok: false, duplicate: false, message: '试算至少需要一个特征模板和一条标签规则' },
    }
  }
  if (!businessVersion.trim()) {
    return {
      state: next,
      outcome: { ok: false, duplicate: false, message: '试算前必须先确定业务版本' },
    }
  }
  if (template.businessVersion !== businessVersion) {
    return {
      state: next,
      outcome: {
        ok: false,
        duplicate: false,
        message: `特征模板业务版本 ${template.businessVersion} 与试算业务版本 ${businessVersion} 不一致`,
      },
    }
  }
  const foreignRule = activeRules.find((rule) => rule.businessVersion !== businessVersion)
  if (foreignRule) {
    return {
      state: next,
      outcome: {
        ok: false,
        duplicate: false,
        message: `标签规则 ${foreignRule.code} 属于业务版本 ${foreignRule.businessVersion}，不能与 ${businessVersion} 一起试算`,
      },
    }
  }
  const bindingKey = buildBindingKey(template, activeRules, businessVersion)
  const existing = next.hits.find(
    (hit) => hit.bindingKey === bindingKey && ACTIVE_HIT_STATUSES.includes(hit.status),
  )
  if (existing) {
    const ticket = createConflict(next, {
      type: '重复回执',
      businessVersion,
      outputField: template.outputField,
      templateCode: template.code,
      templateVersion: template.version,
      hitCode: existing.code,
      versionCode: existing.versionCode,
      winningTemplateCode: existing.templateCode,
      winningVersionCode: existing.versionCode,
      winningHitCode: existing.code,
      policy: '',
      message: '重复提交的试算请求已进入冲突队列',
      detail: `绑定键 ${bindingKey} 已有命中结果 ${existing.code}，本次重复回执不生成新结果，后续处理以首个结果为准。`,
      now,
    })
    return {
      state: next,
      outcome: {
        ok: false,
        duplicate: true,
        conflict: ticket,
        message: `同一绑定键已存在命中结果 ${existing.code}，本次回执进入冲突队列 ${ticket.code}`,
      },
    }
  }
  const batchSignature = activeRules.map((rule) => `${rule.code}:${rule.version}`).join(',')
  const batchCode = `BATCH-${hashText(`${businessVersion}|${batchSignature}`)
    .toString(16)
    .padStart(6, '0')
    .toUpperCase()}`
  next.sequences.version += 1
  next.sequences.hit += 1
  const built = buildTrial({
    versionCode: pad('FLV', next.sequences.version),
    hitCode: pad('HIT', next.sequences.hit),
    businessVersion,
    batchCode,
    template,
    rules: activeRules,
    createdAt: now,
    createdBy: actor,
  })
  next.versions.unshift(built.version)
  next.hits.unshift(built.hit)
  return {
    state: next,
    outcome: { ok: true, duplicate: false, version: built.version, hit: built.hit },
  }
}

type GroupEntry = {
  version: FeatureLabelVersion
  hit: HitResult
}

type ArbitrationEntry = {
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
  isExistingOwner: boolean
}

/**
 * 发布仲裁入口。
 * - 同一业务版本的同一输出字段：一次只允许完整发布一份命中结果。
 * - publish-order（模板发布完成顺序）：先完成发布的模板保留命中结果，其余模板收到字段冲突单并保留草稿。
 * - field-business-order（字段占用业务顺序）：字段归属顺序更靠前的模板获得字段；若替换了已发布结果，
 *   被替换标签进入待迁移清单。
 */
export function publishVersionsInState(
  state: FeatureLabelState,
  request: PublishRequest,
): { state: FeatureLabelState; outcome: PublishOutcome } {
  const next = clone(state)
  const items: PublishItemOutcome[] = []
  const itemByCode = new Map<string, PublishItemOutcome>()
  const createdMigrations: MigrationItem[] = []
  const versionCodes = [...new Set(request.versionCodes)]
  const groups = new Map<string, GroupEntry[]>()

  const reject = (versionCode: string, hitCode: string, templateCode: string, outputField: string, message: string) => {
    const item: PublishItemOutcome = {
      ok: false,
      versionCode,
      hitCode,
      templateCode,
      outputField,
      status: '拒绝',
      conflictCode: '',
      replacedHitCode: '',
      message,
    }
    items.push(item)
    itemByCode.set(versionCode, item)
  }

  for (const versionCode of versionCodes) {
    const version = next.versions.find((item) => item.code === versionCode)
    if (!version) {
      reject(versionCode, '-', '-', '-', `没有找到版本 ${versionCode}`)
      continue
    }
    const hit = next.hits.find((item) => item.code === version.hitCode)
    if (!hit) {
      reject(versionCode, version.hitCode, version.templateCode, version.outputField, `版本 ${versionCode} 没有对应的命中结果`)
      continue
    }
    if (hit.status === '已发布') {
      const ticket = createConflict(next, {
        type: '重复回执',
        businessVersion: version.businessVersion,
        outputField: version.outputField,
        templateCode: version.templateCode,
        templateVersion: version.templateVersion,
        hitCode: hit.code,
        versionCode: version.code,
        winningTemplateCode: version.templateCode,
        winningVersionCode: version.code,
        winningHitCode: hit.code,
        policy: request.policy,
        message: '重复的发布请求已进入冲突队列',
        detail: `命中结果 ${hit.code} 已于 ${hit.publishedAt} 发布，本次重复回执不会再次发布，也不会生成第二份命中结果。`,
        now: request.now,
      })
      const item: PublishItemOutcome = {
        ok: false,
        versionCode,
        hitCode: hit.code,
        templateCode: version.templateCode,
        outputField: version.outputField,
        status: '重复回执',
        conflictCode: ticket.code,
        replacedHitCode: '',
        message: `命中结果 ${hit.code} 已发布，重复回执进入冲突队列 ${ticket.code}`,
      }
      items.push(item)
      itemByCode.set(versionCode, item)
      continue
    }
    if (version.businessVersion !== request.businessVersion) {
      reject(
        versionCode,
        hit.code,
        version.templateCode,
        version.outputField,
        `版本 ${versionCode} 属于业务版本 ${version.businessVersion}，不能在 ${request.businessVersion} 下发布`,
      )
      continue
    }
    if (version.status !== '试算中' && version.status !== '草稿') {
      reject(
        versionCode,
        hit.code,
        version.templateCode,
        version.outputField,
        `版本 ${versionCode} 当前状态「${version.status}」不可发布，需重新试算`,
      )
      continue
    }
    const subject = request.subjects?.[versionCode]
    if (subject) {
      const verified = verifyVersion({
        version,
        hit,
        template: subject.template,
        rules: subject.rules,
        businessVersion: request.businessVersion,
      })
      version.reviewOk = verified.ok
      version.reviewedAt = request.now
      version.reviewSummary = verified.summary
      if (!verified.ok) {
        reject(
          versionCode,
          hit.code,
          version.templateCode,
          version.outputField,
          `按同一业务版本复核未通过：${verified.reasons.join('；')}`,
        )
        continue
      }
    } else if (!version.reviewOk) {
      reject(
        versionCode,
        hit.code,
        version.templateCode,
        version.outputField,
        `版本 ${versionCode} 尚未按同一业务版本复核，暂不能发布`,
      )
      continue
    }
    const groupKey = version.outputField
    const group = groups.get(groupKey) ?? []
    group.push({ version, hit })
    groups.set(groupKey, group)
  }

  for (const group of groups.values()) {
    const first = group[0]
    const requestedCodes = new Set(group.map((entry) => entry.version.code))
    // 输出字段是全局唯一资源：无论业务版本是否相同，同一字段只能有一份已发布命中结果。
    const ownerHit = next.hits.find(
      (hit) =>
        hit.status === '已发布' &&
        hit.outputField === first.version.outputField &&
        !requestedCodes.has(hit.versionCode),
    )
    const ownerVersion = ownerHit
      ? next.versions.find((version) => version.code === ownerHit.versionCode)
      : undefined
    const entries: ArbitrationEntry[] = group.map((entry, index) => ({
      versionCode: entry.version.code,
      hitCode: entry.hit.code,
      templateCode: entry.version.templateCode,
      templateVersion: entry.version.templateVersion,
      templateBusinessOrder: entry.version.templateBusinessOrder,
      outputField: entry.version.outputField,
      businessVersion: entry.version.businessVersion,
      publishOrder: next.sequences.publish + index + 1,
      publishedBefore: false,
      ruleCodes: [...entry.version.ruleCodes],
      ruleNames: { ...entry.version.ruleNames },
      isExistingOwner: false,
    }))
    if (ownerHit && ownerVersion) {
      entries.push({
        versionCode: ownerVersion.code,
        hitCode: ownerHit.code,
        templateCode: ownerVersion.templateCode,
        templateVersion: ownerVersion.templateVersion,
        templateBusinessOrder: ownerVersion.templateBusinessOrder,
        outputField: ownerVersion.outputField,
        businessVersion: ownerVersion.businessVersion,
        publishOrder: ownerHit.publishOrder,
        publishedBefore: true,
        ruleCodes: [...ownerVersion.ruleCodes],
        ruleNames: { ...ownerVersion.ruleNames },
        isExistingOwner: true,
      })
    }
    const plan = arbitratePublish(entries, request.policy)
    const winner = plan.winner as ArbitrationEntry

    // 仲裁前先给本批每个请求建好回执位，赢家/输家稍后原地改写状态。
    for (const entry of group) {
      if (!itemByCode.has(entry.version.code)) {
        const item: PublishItemOutcome = {
          ok: false,
          versionCode: entry.version.code,
          hitCode: entry.hit.code,
          templateCode: entry.version.templateCode,
          outputField: entry.version.outputField,
          status: '拒绝',
          conflictCode: '',
          replacedHitCode: '',
          message: `版本 ${entry.version.code} 未通过本批发布仲裁`,
        }
        items.push(item)
        itemByCode.set(entry.version.code, item)
      }
    }

    if (winner.publishedBefore) {
      // 原占用模板仍然胜出：本批请求全部按字段冲突保留草稿，发布序号不前进。
      for (const loser of plan.losers) {
        const loserVersion = next.versions.find((version) => version.code === loser.versionCode)
        const loserHit = next.hits.find((hit) => hit.code === loser.hitCode)
        if (!loserVersion || !loserHit) {
          continue
        }
        loserVersion.status = '草稿'
        loserVersion.publishedAt = ''
        loserVersion.publishOrder = 0
        loserHit.status = '字段冲突'
        loserHit.publishedAt = ''
        loserHit.publishOrder = 0
        const ticket = createConflict(next, {
          type: '字段冲突',
          businessVersion: loserVersion.businessVersion,
          outputField: loserVersion.outputField,
          templateCode: loserVersion.templateCode,
          templateVersion: loserVersion.templateVersion,
          hitCode: loserHit.code,
          versionCode: loserVersion.code,
          winningTemplateCode: winner.templateCode,
          winningVersionCode: winner.versionCode,
          winningHitCode: winner.hitCode,
          policy: request.policy,
          message: `输出字段「${loserVersion.outputField}」已被占用，模板 ${loserVersion.templateCode} 保留草稿`,
          detail: `输出字段「${loserVersion.outputField}」一次只允许发布一份命中结果。按「${PUBLISH_POLICY_LABELS[request.policy]}」仲裁，已发布模板 ${winner.templateCode}@${winner.templateVersion} 的命中结果 ${winner.hitCode} 继续占用该字段；模板 ${loserVersion.templateCode}@${loserVersion.templateVersion} 的命中结果 ${loserHit.code} 未发布，版本 ${loserVersion.code} 保留草稿并生成此冲突单。`,
          now: request.now,
        })
        const item = itemByCode.get(loserVersion.code)
        if (item) {
          item.status = '字段冲突'
          item.conflictCode = ticket.code
          item.message = ticket.message
        }
      }
      continue
    }

    next.sequences.publish += 1
    const publishOrder = next.sequences.publish

    // 新模板获得字段：先把原占用方替换掉，标签进入待迁移清单。
    if (ownerHit && ownerVersion) {
      ownerVersion.status = '已替换'
      ownerHit.status = '已替换'
      for (const ruleCode of ownerVersion.ruleCodes) {
        const duplicate = next.migrations.find(
          (item) =>
            item.ruleCode === ruleCode &&
            item.fromHitCode === ownerHit.code &&
            item.toHitCode === winner.hitCode,
        )
        if (duplicate) {
          continue
        }
        next.sequences.migration += 1
        const item: MigrationItem = {
          code: pad('MIGR', next.sequences.migration),
          status: '待迁移',
          ruleCode,
          ruleName: ownerVersion.ruleNames[ruleCode] ?? ruleCode,
          fromHitCode: ownerHit.code,
          fromVersionCode: ownerVersion.code,
          fromTemplateCode: ownerVersion.templateCode,
          fromTemplateVersion: ownerVersion.templateVersion,
          toHitCode: winner.hitCode,
          toVersionCode: winner.versionCode,
          toTemplateCode: winner.templateCode,
          toTemplateVersion: winner.templateVersion,
          businessVersion: ownerVersion.businessVersion,
          outputField: ownerVersion.outputField,
          createdAt: request.now,
          migratedAt: '',
        }
        next.migrations.unshift(item)
        createdMigrations.push(item)
      }
    }

    const winnerVersion = next.versions.find((version) => version.code === winner.versionCode)
    const winnerHit = next.hits.find((hit) => hit.code === winner.hitCode)
    if (winnerVersion && winnerHit) {
      winnerVersion.status = '已发布'
      winnerVersion.publishedAt = request.now
      winnerVersion.publishOrder = publishOrder
      winnerHit.status = '已发布'
      winnerHit.publishedAt = request.now
      winnerHit.publishOrder = publishOrder
    }

    for (const loser of plan.losers) {
      if (loser.isExistingOwner) {
        continue
      }
      const loserVersion = next.versions.find((version) => version.code === loser.versionCode)
      const loserHit = next.hits.find((hit) => hit.code === loser.hitCode)
      if (!loserVersion || !loserHit) {
        continue
      }
      loserVersion.status = '草稿'
      loserHit.status = '字段冲突'
      const ticket = createConflict(next, {
        type: '字段冲突',
        businessVersion: loserVersion.businessVersion,
        outputField: loserVersion.outputField,
        templateCode: loserVersion.templateCode,
        templateVersion: loserVersion.templateVersion,
        hitCode: loserHit.code,
        versionCode: loserVersion.code,
        winningTemplateCode: winner.templateCode,
        winningVersionCode: winner.versionCode,
        winningHitCode: winner.hitCode,
        policy: request.policy,
        message: `输出字段「${loserVersion.outputField}」已被占用，模板 ${loserVersion.templateCode} 保留草稿`,
        detail: `输出字段「${loserVersion.outputField}」一次只允许发布一份命中结果。按「${PUBLISH_POLICY_LABELS[request.policy]}」仲裁，模板 ${winner.templateCode}@${winner.templateVersion} 的命中结果 ${winner.hitCode} 获得该字段；模板 ${loserVersion.templateCode}@${loserVersion.templateVersion} 的命中结果 ${loserHit.code} 未发布，版本 ${loserVersion.code} 保留草稿并生成此冲突单。`,
        now: request.now,
      })
      const item = itemByCode.get(loserVersion.code)
      if (item) {
        item.status = '字段冲突'
        item.conflictCode = ticket.code
        item.message = ticket.message
      }
    }

    const winnerItem = itemByCode.get(winner.versionCode)
    if (winnerItem) {
      winnerItem.ok = true
      winnerItem.status = '已发布'
      winnerItem.replacedHitCode = ownerHit?.code ?? ''
      winnerItem.message = ownerHit
        ? `版本 ${winner.versionCode} 已发布，替换命中结果 ${ownerHit.code}，${createdMigrations.filter((item) => item.toHitCode === winner.hitCode).length} 条标签进入待迁移清单`
        : `版本 ${winner.versionCode} 已完整发布，命中结果 ${winner.hitCode} 独占输出字段「${winner.outputField}」`
    }
  }

  return {
    state: next,
    outcome: { items, migrations: createdMigrations, policy: request.policy },
  }
}

/** 标记待迁移标签已迁移。 */
export function migrateLabelsInState(
  state: FeatureLabelState,
  codes: string[],
  now: string,
): { state: FeatureLabelState; migrated: number } {
  const next = clone(state)
  let migrated = 0
  for (const item of next.migrations) {
    if (codes.includes(item.code) && item.status === '待迁移') {
      item.status = '已迁移'
      item.migratedAt = now
      migrated += 1
    }
  }
  return { state: next, migrated }
}

/** 冲突单归档：处理完的冲突留在队列里可追溯。 */
export function archiveConflictInState(
  state: FeatureLabelState,
  code: string,
  now: string,
): { state: FeatureLabelState; ok: boolean } {
  const next = clone(state)
  const ticket = next.conflicts.find((item) => item.code === code)
  if (!ticket) {
    return { state: next, ok: false }
  }
  ticket.status = '已归档'
  ticket.updatedAt = now
  return { state: next, ok: true }
}

export type VersionReviewOutcome = ReviewOutcome

/** 归档一个已发布版本以释放输出字段：字段空出后才允许别的模板发布。 */export function archivePublishedVersionInState(
  state: FeatureLabelState,
  versionCode: string,
  now: string,
): { state: FeatureLabelState; ok: boolean; message: string } {
  const next = clone(state)
  const version = next.versions.find((item) => item.code === versionCode)
  const hit = version ? next.hits.find((item) => item.code === version.hitCode) : undefined
  if (!version || !hit) {
    return { state: next, ok: false, message: `没有找到版本 ${versionCode}` }
  }
  if (version.status !== '已发布' || hit.status !== '已发布') {
    return { state: next, ok: false, message: `版本 ${versionCode} 当前不是已发布状态，无需归档` }
  }
  version.status = '已归档'
  version.archivedAt = now
  hit.status = '已归档'
  for (const conflict of next.conflicts) {
    if (
      conflict.status === '待处理' &&
      conflict.type === '字段冲突' &&
      conflict.winningVersionCode === versionCode
    ) {
      conflict.status = '已归档'
      conflict.updatedAt = now
    }
  }
  return {
    state: next,
    ok: true,
    message: `版本 ${versionCode} 已归档，输出字段「${version.outputField}」已释放，可重新发布其他模板的命中结果`,
  }
}

/** 行动标签侧消费：只取已发布的命中结果，向量与来源版本一并带出。 */
export function labelVectorEntries(state: FeatureLabelState): LabelVectorEntry[] {
  return state.hits
    .filter((hit) => hit.status === '已发布')
    .sort(
      (left, right) =>
        left.templateBusinessOrder - right.templateBusinessOrder ||
        left.outputField.localeCompare(right.outputField) ||
        left.code.localeCompare(right.code),
    )
    .map((hit) => {
      const version = state.versions.find((item) => item.code === hit.versionCode)
      return {
        hitCode: hit.code,
        versionCode: hit.versionCode,
        businessVersion: hit.businessVersion,
        batchCode: hit.batchCode,
        templateCode: hit.templateCode,
        templateName: hit.templateName,
        templateVersion: hit.templateVersion,
        templateBusinessOrder: hit.templateBusinessOrder,
        outputField: hit.outputField,
        vectorDigest: hit.vector.digest,
        coverage: hit.coverage,
        sampleSize: hit.sampleSize,
        nonMissing: hit.nonMissing,
        publishedAt: hit.publishedAt,
        vector: hit.vector,
        labelHits: hit.labelHits,
        bindingKey: version?.bindingKey ?? hit.bindingKey,
      }
    })
}

export function labelPanelRows(state: FeatureLabelState): LabelPanelRow[] {
  const rows: LabelPanelRow[] = []
  for (const entry of labelVectorEntries(state)) {
    for (const hit of entry.labelHits) {
      rows.push({
        hitCode: entry.hitCode,
        versionCode: entry.versionCode,
        businessVersion: entry.businessVersion,
        batchCode: entry.batchCode,
        templateCode: entry.templateCode,
        templateName: entry.templateName,
        templateVersion: entry.templateVersion,
        templateBusinessOrder: entry.templateBusinessOrder,
        outputField: entry.outputField,
        bindingKey: entry.bindingKey,
        vectorDigest: entry.vectorDigest,
        sampleSize: entry.sampleSize,
        nonMissing: entry.nonMissing,
        coverage: entry.coverage,
        mean: entry.vector.mean,
        p50: entry.vector.p50,
        p90: entry.vector.p90,
        publishedAt: entry.publishedAt,
        ruleCode: hit.ruleCode,
        ruleName: hit.ruleName,
        ruleVersion: hit.ruleVersion,
        metricName: hit.metricName,
        threshold: hit.threshold,
        direction: hit.direction,
        hitCount: hit.hitCount,
        hitRate: hit.hitRate,
      })
    }
  }
  return rows
}
