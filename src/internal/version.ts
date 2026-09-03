import { inDevelopment } from './state-value'
import type { Stamped } from '../types'

// The global registry prevents duplicate module instances from issuing colliding sequence numbers.
const counterKey = Symbol.for('@askrubberduck/eddy/sequence-counter@1')

type VersionCounterState = { counter: number }

// Written the long way, not `??=`: that survives an ES2022 emit untouched and metro 0.72's
// minifier cannot parse it. `check:bundler` pins this.
const registry = globalThis as unknown as Record<symbol, VersionCounterState | undefined>
const state: VersionCounterState = registry[counterKey] ?? { counter: 0 }
registry[counterKey] = state

export const nextVersion = (): number => ++state.counter

// Development only. A rewind reissues numbers already in flight, and `isStale` then calls a stale
// response fresh — the failure direction that accepts an old answer over a new one.
export const resetVersion = (): void => {
  if (!inDevelopment) {
    return
  }
  state.counter = 0
}

export const isStale = (action: Stamped, seen: number | undefined): boolean =>
  action.__originSeq !== undefined && seen !== undefined && action.__originSeq !== seen
