import type { FeatureLabelState } from '@/domain/feature-label'
import { emptyFeatureLabelState } from '@/domain/feature-label-flow'

// 行为特征标签版本单独存一份：与 18 个业务模块的登记数据分开，
// 但入口同时被「特征工程」和「行动标签」两个页面复用。
const STORAGE_KEY = 'behavior-event-trace-hub:feature-label'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: FeatureLabelState | null = null

function normalize(parsed: Partial<FeatureLabelState>): FeatureLabelState {
  const base = emptyFeatureLabelState()
  return {
    versions: parsed.versions ?? base.versions,
    hits: parsed.hits ?? base.hits,
    conflicts: parsed.conflicts ?? base.conflicts,
    migrations: parsed.migrations ?? base.migrations,
    sequences: { ...base.sequences, ...(parsed.sequences ?? {}) },
  }
}

export function loadFeatureLabelState(): FeatureLabelState {
  if (cache) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = emptyFeatureLabelState()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = emptyFeatureLabelState()
    return cache
  }
  try {
    cache = normalize(JSON.parse(raw) as Partial<FeatureLabelState>)
  } catch {
    cache = emptyFeatureLabelState()
  }
  return cache
}

export function saveFeatureLabelState(state: FeatureLabelState): FeatureLabelState {
  cache = clone(state)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
  return cache
}

export function resetFeatureLabelState(): FeatureLabelState {
  cache = emptyFeatureLabelState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
  return cache
}
