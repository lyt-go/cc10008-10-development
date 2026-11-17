<template>
  <section class="workbench" data-feature-label-workbench>
    <header class="wb-head">
      <div>
        <h3>行为特征标签版本</h3>
        <p class="wb-desc">
          把特征模板与标签规则按同一业务版本绑定成可复算的试算，复核后发布；
          输出字段同一时间只保留一份命中结果，行动标签侧只消费已发布版本。
        </p>
      </div>
      <div class="wb-controls">
        <label class="wb-field">
          <span>业务版本</span>
          <select v-model="businessVersion">
            <option v-for="version in businessVersions" :key="version" :value="version">{{ version }}</option>
          </select>
        </label>
        <label class="wb-field">
          <span>发布仲裁策略</span>
          <select v-model="policy">
            <option value="publish-order">模板发布完成顺序</option>
            <option value="field-business-order">字段占用业务顺序</option>
          </select>
        </label>
        <button class="btn ghost" type="button" @click="reload">刷新</button>
        <button class="btn ghost" type="button" @click="resetAll">重置版本数据</button>
      </div>
    </header>

    <p class="wb-policy-hint">{{ policyHint }}</p>

    <div class="wb-grid">
      <section class="wb-panel">
        <h4>1. 绑定与试算</h4>
        <label class="wb-field full">
          <span>特征模板</span>
          <select v-model="selectedTemplateCode">
            <option v-for="template in templates" :key="template.code" :value="template.code">
              {{ template.code }} · {{ template.name }} · {{ template.outputField }} · {{ template.version }}
            </option>
          </select>
        </label>
        <fieldset class="wb-rules">
          <legend>标签规则（同一批标签同时试算）</legend>
          <label v-for="rule in rules" :key="rule.code" class="wb-rule">
            <input v-model="selectedRuleCodes" type="checkbox" :value="rule.code" />
            <span>{{ rule.code }} · {{ rule.name }} · {{ rule.version }}</span>
          </label>
        </fieldset>
        <div class="wb-actions">
          <button class="btn primary" type="button" @click="runTrialAndReview">试算并复核</button>
          <button class="btn" type="button" @click="runTrial">仅试算并绑定</button>
          <button class="btn" type="button" @click="reviewSelected()">按同一业务版本复核</button>
          <button class="btn" type="button" @click="publishSelected">发布所选版本</button>
        </div>
        <div v-if="selectedTemplate" class="wb-template-card">
          <div><strong>模板 {{ selectedTemplate.code }}@{{ selectedTemplate.version }}</strong> · 业务版本 {{ selectedTemplate.businessVersion }}</div>
          <div>输出字段：<code>{{ selectedTemplate.outputField }}</code> · 字段归属顺序 {{ selectedTemplate.businessOrder }}</div>
          <div>计算逻辑：{{ selectedTemplate.logic }}</div>
          <div>聚合：{{ selectedTemplate.aggregate }} · 窗口 {{ selectedTemplate.windowDays }} 天 · 缺失填充 {{ selectedTemplate.fill }}</div>
        </div>
        <p v-if="message" class="wb-ok">{{ message }}</p>
        <p v-if="error" class="error-text">{{ error }}</p>
      </section>

      <section class="wb-panel">
        <h4>2. 版本与命中结果</h4>
        <table class="data-table wb-table">
          <thead>
            <tr>
              <th>选</th>
              <th>版本</th>
              <th>模板 / 版本</th>
              <th>业务版本</th>
              <th>输出字段</th>
              <th>状态</th>
              <th>复核</th>
              <th>覆盖率</th>
              <th>命中结果</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in state.versions" :key="version.code">
              <td><input v-model="selectedVersionCodes" type="checkbox" :value="version.code" /></td>
              <td>{{ version.code }}</td>
              <td>{{ version.templateCode }}@{{ version.templateVersion }}</td>
              <td>{{ version.businessVersion }}</td>
              <td><code>{{ version.outputField }}</code></td>
              <td>{{ version.status }}</td>
              <td>
                <span :class="version.reviewOk ? 'tag ok' : 'tag warn'">{{ version.reviewOk ? '已通过' : '未通过' }}</span>
              </td>
              <td>{{ coverageText(version.hitCode) }}</td>
              <td>{{ hitStatusText(version.hitCode) }}</td>
              <td class="wb-cell-actions">
                <button class="link" type="button" @click="inspectVersion(version.code)">查看</button>
                <button
                  v-if="version.status === '已发布'"
                  class="link"
                  type="button"
                  @click="archiveVersion(version.code)"
                >
                  归档释放字段
                </button>
              </td>
            </tr>
            <tr v-if="!state.versions.length">
              <td colspan="10" class="empty-state">还没有试算版本，先选择模板和标签规则执行试算</td>
            </tr>
          </tbody>
        </table>

        <div v-if="inspected" class="wb-detail">
          <div class="wb-detail-head">
            <strong>{{ inspected.version.code }} · {{ inspected.version.templateCode }}@{{ inspected.version.templateVersion }}</strong>
            <span>命中结果 {{ inspected.hit.code }} · 绑定键 {{ inspected.version.bindingKey }}</span>
          </div>
          <p class="wb-binding">
            标签命中、覆盖率与特征模板版本严格绑定：向量摘要 {{ inspected.version.vectorDigest }} ·
            覆盖率 {{ (inspected.hit.coverage * 100).toFixed(1) }}%（{{ inspected.hit.nonMissing }}/{{ inspected.hit.sampleSize }}）·
            均值 {{ inspected.hit.vector.mean }} / P50 {{ inspected.hit.vector.p50 }} / P90 {{ inspected.hit.vector.p90 }}
          </p>
          <table class="data-table wb-table">
            <thead>
              <tr><th>标签</th><th>规则版本</th><th>触发事件组</th><th>阈值</th><th>命中数</th><th>命中率</th></tr>
            </thead>
            <tbody>
              <tr v-for="hit in inspected.hit.labelHits" :key="hit.ruleCode">
                <td>{{ hit.ruleCode }} · {{ hit.ruleName }}</td>
                <td>{{ hit.ruleVersion }}</td>
                <td>{{ hit.metricName }}</td>
                <td>{{ hit.direction === 'gte' ? '≥' : '≤' }} {{ hit.threshold }}</td>
                <td>{{ hit.hitCount }}</td>
                <td>{{ (hit.hitRate * 100).toFixed(1) }}%</td>
              </tr>
            </tbody>
          </table>
          <p :class="inspected.version.reviewOk ? 'wb-ok' : 'error-text'">
            {{ inspected.version.reviewSummary || '尚未按同一业务版本复核' }}
          </p>
        </div>
      </section>
    </div>

    <div class="wb-grid">
      <section class="wb-panel">
        <h4>3. 冲突队列与待迁移标签</h4>
        <table class="data-table wb-table">
          <thead>
            <tr><th>冲突单</th><th>类型</th><th>字段</th><th>模板</th><th>占用模板</th><th>策略</th><th>状态</th><th>说明</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="ticket in state.conflicts" :key="ticket.code">
              <td>{{ ticket.code }}</td>
              <td>{{ ticket.type }}</td>
              <td><code>{{ ticket.outputField }}</code></td>
              <td>{{ ticket.templateCode }}@{{ ticket.templateVersion }}</td>
              <td>{{ ticket.winningTemplateCode }}@{{ ticket.winningVersionCode }}</td>
              <td>{{ ticket.policy ? policyLabel(ticket.policy) : '—' }}</td>
              <td>{{ ticket.status }}</td>
              <td class="wb-cell-text">{{ ticket.detail }}</td>
              <td>
                <button v-if="ticket.status === '待处理'" class="link" type="button" @click="archive(ticket.code)">归档</button>
              </td>
            </tr>
            <tr v-if="!state.conflicts.length">
              <td colspan="9" class="empty-state">暂无冲突单</td>
            </tr>
          </tbody>
        </table>

        <table class="data-table wb-table">
          <thead>
            <tr><th>迁移单</th><th>标签</th><th>从</th><th>到</th><th>字段</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="item in state.migrations" :key="item.code">
              <td>{{ item.code }}</td>
              <td>{{ item.ruleCode }} · {{ item.ruleName }}</td>
              <td>{{ item.fromTemplateCode }}@{{ item.fromTemplateVersion }} / {{ item.fromHitCode }}</td>
              <td>{{ item.toTemplateCode }}@{{ item.toTemplateVersion }} / {{ item.toHitCode }}</td>
              <td><code>{{ item.outputField }}</code></td>
              <td>{{ item.status }}</td>
              <td>
                <button v-if="item.status === '待迁移'" class="link" type="button" @click="migrate(item.code)">标记已迁移</button>
              </td>
            </tr>
            <tr v-if="!state.migrations.length">
              <td colspan="7" class="empty-state">暂无待迁移标签</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="wb-panel">
        <h4>4. 行动标签清单（只取已发布命中结果）</h4>
        <p class="wb-desc">
          当前入口：{{ surfaceLabel }}。特征工程与行动标签两个业务面共用同一份「行为特征标签版本」数据流，
          清单只从已发布的行为特征标签命中结果取行为特征向量。
        </p>
        <table class="data-table wb-table">
          <thead>
            <tr>
              <th>命中结果</th>
              <th>标签</th>
              <th>规则版本</th>
              <th>特征模板</th>
              <th>输出版本 / 字段</th>
              <th>覆盖率</th>
              <th>命中数</th>
              <th>向量摘要</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in labelRows" :key="`${row.hitCode}-${row.ruleCode}`">
              <td>{{ row.hitCode }}</td>
              <td>{{ row.ruleName }}</td>
              <td>{{ row.ruleVersion }}</td>
              <td>{{ row.templateCode }}@{{ row.templateVersion }}</td>
              <td>{{ row.businessVersion }} / <code>{{ row.outputField }}</code></td>
              <td>{{ (row.coverage * 100).toFixed(1) }}%</td>
              <td>{{ row.hitCount }}</td>
              <td>{{ row.vectorDigest }}</td>
            </tr>
            <tr v-if="!labelRows.length">
              <td colspan="8" class="empty-state">还没有已发布的命中结果，标签侧暂无可消费数据</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  actionLabelPanelRows,
  archiveFeatureLabelConflict,
  archiveFeatureLabelVersion,
  currentBusinessVersions,
  featureLabelState,
  featureTemplates,
  labelRules,
  migrateFeatureLabelItems,
  publishFeatureLabelVersions,
  resetFeatureLabel,
  reviewFeatureLabelVersion,
  trialFeatureLabel,
  versionHit,
} from '@/api/feature-label-service'
import type { FeatureLabelState, LabelRuleInput, PublishPolicy } from '@/domain/feature-label'

const props = defineProps<{ surface: 'feature' | 'action' }>()

const state = ref<FeatureLabelState>(featureLabelState())
const templates = ref(featureTemplates())
const rules = ref<LabelRuleInput[]>(labelRules())
const businessVersions = ref(currentBusinessVersions())
const businessVersion = ref(businessVersions.value[0] ?? '')
const policy = ref<PublishPolicy>('publish-order')
const selectedTemplateCode = ref(
  templates.value.find((template) => template.code === 'FEAT-0003')?.code ?? templates.value[0]?.code ?? '',
)
const selectedRuleCodes = ref<string[]>(rules.value.map((rule) => rule.code))
const selectedVersionCodes = ref<string[]>([])
const inspectedCode = ref(state.value.versions[0]?.code ?? '')
const message = ref('')
const error = ref('')

const selectedTemplate = computed(() =>
  templates.value.find((template) => template.code === selectedTemplateCode.value),
)
// 行动标签清单必须从持久化状态实时读取，两个页面共用同一份数据流。
const labelRows = computed(() => actionLabelPanelRows(state.value))
const surfaceLabel = computed(() => (props.surface === 'action' ? '行动标签' : '特征工程'))
const inspected = computed(() => {
  const version = state.value.versions.find((item) => item.code === inspectedCode.value)
  if (!version) {
    return null
  }
  const hit = versionHit(state.value, version.code)
  return hit ? { version, hit } : null
})
const policyHint = computed(() =>
  policy.value === 'publish-order'
    ? '当前策略「模板发布完成顺序」：同一输出字段争用时，先完成发布的模板保留命中结果，其余模板收到字段冲突说明并保留草稿。'
    : '当前策略「字段占用业务顺序」：同一输出字段争用时，字段归属顺序更靠前的模板替换结果，被替换标签进入待迁移清单。',
)

function reload() {
  state.value = featureLabelState()
  templates.value = featureTemplates()
  rules.value = labelRules()
  businessVersions.value = currentBusinessVersions()
  if (!businessVersions.value.includes(businessVersion.value)) {
    businessVersion.value = businessVersions.value[0] ?? ''
  }
  if (!templates.value.some((template) => template.code === selectedTemplateCode.value)) {
    selectedTemplateCode.value = templates.value[0]?.code ?? ''
  }
  selectedRuleCodes.value = selectedRuleCodes.value.filter((code) =>
    rules.value.some((rule) => rule.code === code),
  )
  if (!state.value.versions.some((version) => version.code === inspectedCode.value)) {
    inspectedCode.value = state.value.versions[0]?.code ?? ''
  }
}

function coverageText(hitCode: string): string {
  const hit = state.value.hits.find((item) => item.code === hitCode)
  return hit ? `${(hit.coverage * 100).toFixed(1)}%` : '—'
}

function hitStatusText(hitCode: string): string {
  const hit = state.value.hits.find((item) => item.code === hitCode)
  return hit ? `${hit.code} · ${hit.status}` : '—'
}

function inspectVersion(code: string) {
  inspectedCode.value = code
}

function runTrial(): string {
  message.value = ''
  error.value = ''
  const result = trialFeatureLabel({
    templateCode: selectedTemplateCode.value,
    ruleCodes: selectedRuleCodes.value,
    businessVersion: businessVersion.value,
  })
  state.value = result.state
  if (result.outcome.ok) {
    inspectedCode.value = result.outcome.version.code
    message.value = `试算完成：版本 ${result.outcome.version.code} · 命中结果 ${result.outcome.hit.code} · 覆盖率 ${(result.outcome.hit.coverage * 100).toFixed(1)}% · 已与模板 ${result.outcome.version.templateCode}@${result.outcome.version.templateVersion} 绑定`
    reload()
    return result.outcome.version.code
  }
  if (result.outcome.duplicate) {
    inspectedCode.value = result.outcome.conflict.winningVersionCode
    error.value = result.outcome.message
    reload()
    return result.outcome.conflict.winningVersionCode
  }
  error.value = result.outcome.message
  reload()
  return ''
}

function reviewSelected(keepNotice = false) {
  const notice = keepNotice ? message.value : ''
  const noticeError = keepNotice ? error.value : ''
  message.value = ''
  error.value = ''
  if (!selectedVersionCodes.value.length) {
    error.value = '请先在版本列表中勾选需要复核的版本'
    return false
  }
  const summaries: string[] = []
  for (const code of selectedVersionCodes.value) {
    const result = reviewFeatureLabelVersion(code, businessVersion.value)
    state.value = result.state
    summaries.push(`${code}：${result.outcome.summary}`)
    if (!result.outcome.ok) {
      error.value = [noticeError, ...summaries].filter(Boolean).join('\n')
      reload()
      return false
    }
  }
  message.value = [notice, ...summaries].filter(Boolean).join('\n')
  error.value = noticeError
  reload()
  return true
}

function runTrialAndReview() {
  const versionCode = runTrial()
  if (!versionCode || error.value) {
    return
  }
  selectedVersionCodes.value = [versionCode]
  reviewSelected(true)
}

function publishSelected() {
  message.value = ''
  error.value = ''
  if (!selectedVersionCodes.value.length) {
    error.value = '请先勾选需要发布的版本（同一输出字段的争用模板可一起勾选，由策略仲裁）'
    return
  }
  const result = publishFeatureLabelVersions(
    selectedVersionCodes.value,
    policy.value,
    businessVersion.value,
  )
  state.value = result.state
  const lines = result.items.map(
    (item) => `[${item.status}] ${item.versionCode}${item.conflictCode ? `（${item.conflictCode}）` : ''}：${item.message}`,
  )
  if (result.items.some((item) => item.ok)) {
    message.value = lines.join('\n')
  } else {
    error.value = lines.join('\n')
  }
  if (result.migrations > 0) {
    message.value += `\n生成了 ${result.migrations} 条待迁移标签。`
  }
  reload()
}

function archive(code: string) {
  const result = archiveFeatureLabelConflict(code)
  state.value = result.state
  message.value = result.ok ? `冲突单 ${code} 已归档` : `没有找到冲突单 ${code}`
  reload()
}

function archiveVersion(code: string) {
  const result = archiveFeatureLabelVersion(code)
  state.value = result.state
  if (result.ok) {
    message.value = result.message
    error.value = ''
  } else {
    error.value = result.message
  }
  reload()
}

function migrate(code: string) {
  const result = migrateFeatureLabelItems([code])
  state.value = result.state
  message.value = result.migrated ? `迁移单 ${code} 已标记为已迁移` : `迁移单 ${code} 当前不可迁移`
  reload()
}

function policyLabel(value: PublishPolicy): string {
  return value === 'publish-order' ? '模板发布完成顺序' : '字段占用业务顺序'
}

function resetAll() {
  state.value = resetFeatureLabel()
  reload()
}

onMounted(() => {
  reload()
  // 另一个浏览器标签页改过版本数据时同步刷新，避免两个业务面看到不同的已发布清单。
  window.addEventListener('storage', reload)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', reload)
})

defineExpose({ reload, resetAll, inspectVersion: (code: string) => inspectVersion(code) })
</script>

<style scoped>
.workbench { margin-top: 20px; border-top: 2px solid var(--border); padding-top: 12px; }
.wb-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.wb-head h3 { margin: 0; font-size: 15px; }
.wb-desc { color: var(--muted); font-size: 12px; margin: 4px 0 0; max-width: 720px; }
.wb-controls { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.wb-field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
.wb-field select { border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; background: #fff; font-size: 13px; }
.wb-field.full { width: 100%; }
.wb-field.full select { width: 100%; }
.wb-policy-hint { font-size: 12px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 6px 10px; }
.wb-grid { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(420px, 1.4fr); gap: 14px; margin-bottom: 14px; align-items: start; }
.wb-panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.wb-panel h4 { margin: 0 0 8px; font-size: 13px; }
.wb-rules { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; margin: 8px 0; display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow: auto; }
.wb-rules legend { font-size: 12px; color: var(--muted); padding: 0 4px; }
.wb-rule { font-size: 12px; display: flex; gap: 6px; align-items: center; }
.wb-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wb-template-card { margin-top: 8px; font-size: 12px; color: #334155; background: #f8fafc; border: 1px dashed var(--border); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 3px; }
.wb-ok { color: #166534; font-size: 12px; white-space: pre-line; }
.wb-table { width: 100%; }
.wb-table th, .wb-table td { padding: 5px 7px; font-size: 12px; }
.wb-detail { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 8px; }
.wb-detail-head { display: flex; flex-direction: column; gap: 2px; font-size: 12px; margin-bottom: 6px; }
.wb-binding { font-size: 12px; color: #334155; background: #f8fafc; border-radius: 6px; padding: 6px 8px; }
.tag { font-size: 11px; border-radius: 999px; padding: 1px 8px; }
.tag.ok { background: #dcfce7; color: #166534; }
.tag.warn { background: #fef3c7; color: #92400e; }
.wb-cell-text { max-width: 320px; color: #475569; }
.wb-cell-actions { display: flex; gap: 6px; white-space: nowrap; }
.wb-desc code, .wb-table code { background: #eef2f7; border-radius: 4px; padding: 1px 4px; }
</style>
