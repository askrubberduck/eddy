import { expect } from 'chai'
import {
  cmd,
  createScope,
  defineDomain,
  effect,
  isStale,
  reduce,
  watch,
  CascadeAborted,
  CommandAborted,
} from '../src/index'
import type { Cmd, DomainType, Reduce } from '../src/index'
import { createTestScope, flush, resetVersion, settled } from '../src/testing'
import type { Scope } from '../src/index'
import { PENDING, platformRejections, rejects, settlement } from './helpers'

type RaceState = { winner: number; started: number[] }
type RaceActions = { go: Cmd<{ id: number }, number>; note: Reduce<{ id: number }> }

type CancelState = { n: number }
type CancelActions = { reason: Cmd<number, number>; own: Cmd<number, number>; plain: Cmd<number, never> }

type ShadowState = { n: number }
type ShadowActions = { run: Cmd<number, number> }

type JoinState = { runs: number; result: number }
type JoinActions = { fetch: Cmd<number, number> }

type HangState = { n: number }
type HangActions = { hang: Cmd<void, number> }

type ChainState = { n: number }
type ChainActions = { outer: Cmd<void, number>; inner: Reduce; bump: Reduce }

type BoomState = { n: number }
type BoomActions = { go: Reduce; ok: Reduce }

type StepState = { n: number }
type StepActions = { a: Reduce; b: Reduce; c: Reduce; d: Reduce }
type MirrorState = { n: number }
type MirrorActions = { noop: Reduce }

type TwoWatchState = { n: number }
type TwoWatchActions = { bump: Reduce; jump: Reduce }

type SpinState = { n: number; doubled: number }
type SpinActions = { tick: Reduce; calm: Reduce }

type OscState = { n: number }
type OscActions = { flip: Reduce }

type StrandedState = { n: number }
type StrandedActions = { trigger: Reduce; queued: Reduce }

type OutcomeState = { n: number }
type OutcomeActions = { go: Cmd<void, number> }

type LateState = { winner: number }
type LateActions = { slow: Cmd<{ id: number }, number>; poke: Reduce }

type CausalState = { last: number }
type CausalActions = { go: Cmd<void, number>; boom: Cmd<void, never> }

type ObservedState = { tag: string }
type ObservedActions = { go: Cmd<string, string> }

declare module '../src/types' {
  interface Domains {
    observedRace: DomainType<ObservedState, ObservedActions>
    race: DomainType<RaceState, RaceActions>
    cancelShapes: DomainType<CancelState, CancelActions>
    joined: DomainType<JoinState, JoinActions>
    shadowReason: DomainType<ShadowState, ShadowActions>
    hang: DomainType<HangState, HangActions>
    chain: DomainType<ChainState, ChainActions>
    boom: DomainType<BoomState, BoomActions>
    step: DomainType<StepState, StepActions>
    mirror: DomainType<MirrorState, MirrorActions, {}, 'step'>
    twoWatch: DomainType<TwoWatchState, TwoWatchActions>
    spin: DomainType<SpinState, SpinActions>
    osc: DomainType<OscState, OscActions>
    stranded: DomainType<StrandedState, StrandedActions>
    outcome: DomainType<OutcomeState, OutcomeActions>
    late: DomainType<LateState, LateActions>
    causal: DomainType<CausalState, CausalActions>
  }
}

let current: Scope<never> | undefined
const emitInto = (address: string) => {
  void (current as unknown as { emit: (a: string, i?: unknown) => Promise<unknown> } | undefined)
    ?.emit(address)
    .catch(() => undefined)
}
const readN = (domain: string): number => (current as unknown as { read: (d: string) => { n: number } }).read(domain).n

let sawA: number[] = []
let sawB: number[] = []
let secondWatcherSaw: number[] = []

let spins = 0

let strandedQueued: Promise<unknown> | undefined

let started: number[] = []

let onAbort: ((id: number) => void) | undefined

const race = defineDomain('race', [], {
  state: () => ({ winner: 0, started: [] }),
  actions: {
    go: cmd(
      async (input, ctx) => {
        started.push(input.id)
        ctx.signal.addEventListener('abort', () => onAbort?.(input.id))
        await new Promise(resolve => setTimeout(resolve, 5))
        if (ctx.signal.aborted) {
          throw new CommandAborted('race.go')
        }
        return input.id
      },
      { latest: true, done: (_state, action) => ({ winner: action.result }) },
    ),
    note: reduce((state, action) => ({ started: [...state.started, action.input.id] })),
  },
})

const hang = defineDomain('hang', [], {
  state: () => ({ n: 0 }),
  actions: {
    hang: cmd(async () => new Promise<number>(() => undefined), {
      latest: true,
      called: { n: 1 },
      done: (_state, action) => ({ n: action.result }),
    }),
  },
})

const boom = defineDomain('boom', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: reduce(() => {
      throw new Error('reducer exploded')
    }),
    ok: reduce(state => ({ n: state.n + 1 })),
  },
})

const chain = defineDomain('chain', [], {
  state: () => ({ n: 0 }),
  actions: {
    outer: cmd(async () => 1, { done: (state: { n: number }) => ({ n: state.n + 1 }) }),
    inner: reduce(state => ({ n: state.n + 10 })),
    bump: reduce(state => ({ n: state.n + 100 })),
  },
  effects: {
    'chain.outer.done': effect(() => undefined),
  },
})

const step = defineDomain('step', [], {
  state: () => ({ n: 0 }),
  actions: {
    a: reduce(state => ({ n: state.n + 1 })),
    b: reduce(state => ({ n: state.n + 10 })),
    c: reduce(state => ({ n: state.n + 100 })),
    d: reduce(state => ({ n: state.n + 1000 })),
  },
  effects: {
    'step.a': effect(() => emitInto('step.b')),
    'step.b': effect(() => emitInto('step.d')),
  },
})

const mirror = defineDomain('mirror', ['step'], {
  state: () => ({ n: 0 }),
  actions: { noop: reduce({}) },
  effects: {
    'step.a': effect(() => {
      sawA.push(readN('step'))
      emitInto('step.c')
    }),
    'step.b': effect(() => {
      sawB.push(readN('step'))
    }),
  },
})

const twoWatch = defineDomain('twoWatch', [], {
  state: () => ({ n: 0 }),
  actions: {
    bump: reduce(state => ({ n: state.n + 1 })),
    jump: reduce(state => ({ n: state.n + 100 })),
  },
  watch: {
    first: watch(
      state => state.n,
      next => {
        if (next === 1) {
          emitInto('twoWatch.jump')
        }
      },
    ),
    second: watch(
      state => state.n,
      next => {
        secondWatcherSaw.push(next)
      },
    ),
  },
})

const spin = defineDomain('spin', [], {
  // `doubled` is kept at exactly 2n by every reducer, so a fold that committed half of itself would
  // be visible as a broken relationship rather than having to be inferred from a single counter.
  state: () => ({ n: 0, doubled: 0 }),
  actions: {
    tick: reduce(state => ({ n: state.n + 1, doubled: (state.n + 1) * 2 })),
    calm: reduce(() => ({ n: -1, doubled: -2 })),
  },
  effects: {
    'spin.tick': effect(() => {
      if (spins > 0) {
        spins -= 1
        emitInto('spin.tick')
      }
    }),
  },
})

const osc = defineDomain('osc', [], {
  state: () => ({ n: 0 }),
  actions: { flip: reduce(state => ({ n: state.n === 0 ? 1 : 0 })) },
  watch: {
    seen: watch(
      state => state.n,
      () => emitInto('osc.flip'),
    ),
  },
})

const stranded = defineDomain('stranded', [], {
  state: () => ({ n: 0 }),
  actions: {
    trigger: reduce(state => ({ n: state.n + 1 })),
    queued: reduce(state => ({ n: state.n + 10 })),
  },
  effects: {
    'stranded.trigger': effect(() => {
      const scope = current as unknown as { emit: (a: string) => Promise<unknown> }
      strandedQueued = scope.emit('stranded.queued')
      void strandedQueued.catch(() => undefined)
      throw new Error('effect exploded')
    }),
  },
})

const outcome = defineDomain('outcome', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: cmd(async () => 7, {
      done: () => {
        throw new Error('done reducer exploded')
      },
      finally: { n: 99 },
    }),
  },
})

const late = defineDomain('late', [], {
  state: () => ({ winner: 0 }),
  actions: {
    slow: cmd(
      async input => {
        await new Promise(resolve => setTimeout(resolve, input.id === 1 ? 30 : 5))
        return input.id
      },
      { latest: true, done: (_state, action) => ({ winner: action.result }) },
    ),
    poke: reduce(state => state),
  },
})

describe('the dispatch queue', () => {
  beforeEach(() => {
    resetVersion()
    started = []
    onAbort = undefined
    current = undefined
    sawA = []
    sawB = []
    secondWatcherSaw = []
    spins = 0
    strandedQueued = undefined
  })

  describe('superseded during its own called action', () => {
    it('never starts the handler of a call superseded by its own called-stage listener', async () => {
      const scope = createTestScope({ domains: [race] })

      let reentered = false
      scope.on('race.go', action => {
        if (!reentered && (action.input as { id: number }).id === 1) {
          reentered = true
          void scope.emit('race.go', { id: 2 }).catch(() => undefined)
        }
      })

      const first = scope.emit('race.go', { id: 1 })
      const outcome = await settlement(first)
      await flush(6)

      expect(started).to.deep.equal([2])
      expect(outcome).to.not.equal(PENDING)
      expect((outcome as { error: unknown }).error).to.be.instanceOf(CommandAborted)

      expect(scope.actionTypes().filter(type => type === 'race.go.done')).to.have.lengthOf(1)
      expect(scope.actionTypes()).to.not.include('race.go.failed')
      expect(scope.read('race').winner).to.equal(2)
    })
  })

  describe('a superseded running handler that never settles', () => {
    it('rejects the superseded promise itself rather than waiting for the handler', async () => {
      const scope = createScope({ domains: [hang] })

      const first = scope.emit('hang.hang')
      const second = scope.emit('hang.hang')
      void second.catch(() => undefined)

      const outcome = await settlement(first)
      expect(outcome).to.not.equal(PENDING)
      expect((outcome as { error: unknown }).error).to.be.instanceOf(CommandAborted)

      expect(await settlement(second)).to.equal(PENDING)
    })

    it('rejects a running command that disposal cancels, for the same reason', async () => {
      const scope = createScope({ domains: [hang] })

      const running = scope.emit('hang.hang')
      scope.dispose()

      const outcome = await settlement(running)
      expect(outcome).to.not.equal(PENDING)
      expect((outcome as { error: unknown }).error).to.be.instanceOf(Error)
    })
  })

  describe('the replacement is published before the previous one is aborted', () => {
    it('leaves the newest call as latest when the previous one re-emits from its abort listener', async () => {
      const scope = createTestScope({ domains: [race] })

      const promises: Promise<unknown>[] = []
      onAbort = id => {
        if (id === 1) {
          const third = scope.emit('race.go', { id: 3 })
          promises.push(third)
          void third.catch(() => undefined)
        }
      }

      const first = scope.emit('race.go', { id: 1 })
      void first.catch(() => undefined)
      await flush(2)
      const second = scope.emit('race.go', { id: 2 })
      void second.catch(() => undefined)

      await flush(10)

      expect(scope.read('race').winner).to.equal(3)
      expect(await settlement(first)).to.deep.equal({ error: ((await settlement(first)) as { error: unknown }).error })
      expect(((await settlement(first)) as { error: unknown }).error).to.be.instanceOf(CommandAborted)
      expect(((await settlement(second)) as { error: unknown }).error).to.be.instanceOf(CommandAborted)
      expect(await settlement(promises[0])).to.deep.equal({ ok: 3 })
    })
  })

  describe('a version is allocated and enqueued indivisibly', () => {
    it('stamps versions in queue order, including across a synchronous abort', async () => {
      const scope = createTestScope({ domains: [race] })
      current = scope as never

      onAbort = id => {
        if (id === 1) {
          void scope.emit('race.note', { id: 99 }).catch(() => undefined)
        }
      }

      const first = scope.emit('race.go', { id: 1 })
      void first.catch(() => undefined)
      await flush(2)
      const second = scope.emit('race.go', { id: 2 })
      void second.catch(() => undefined)
      await flush(10)

      expect(scope.actionTypes()).to.deep.equal(['race.go', 'race.note', 'race.go', 'race.go.done'])
      expect(scope.actions().map(action => action.__seq as number)).to.deep.equal([1, 2, 3, 4])
    })
  })

  describe('nesting, ordering and cascades', () => {
    it('gives every effect its own action’s post-fold state', async () => {
      const scope = createTestScope({ domains: [step, mirror] })
      current = scope as never

      await scope.emit('step.a')
      await flush(4)

      expect(sawA).to.deep.equal([1])
      expect(sawB).to.deep.equal([11])
    })

    it('delivers a branching cascade breadth-first, in queue order', async () => {
      const scope = createTestScope({ domains: [step, mirror] })
      current = scope as never

      await scope.emit('step.a')
      await flush(4)

      expect(scope.actionTypes()).to.deep.equal(['step.a', 'step.b', 'step.c', 'step.d'])
      expect(scope.read('step').n).to.equal(1111)
    })

    it('evaluates the second watcher against the state before the first one’s emit', async () => {
      const scope = createTestScope({ domains: [twoWatch] })
      current = scope as never

      await scope.emit('twoWatch.bump')
      await flush(4)

      expect(secondWatcherSaw).to.deep.equal([1, 101])
    })

    it('bounds a runaway cascade with a named error rather than a RangeError, and stays usable', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({ domains: [spin], onUnhandledError: error => errors.push(error) })
      current = scope as never
      spins = Number.POSITIVE_INFINITY

      await scope.emit('spin.tick')

      expect(errors).to.have.lengthOf(1)
      expect(errors[0]).to.be.instanceOf(Error)
      expect(errors[0]).to.not.be.instanceOf(RangeError)
      expect(String((errors[0] as Error).message)).to.match(/more than 10000 actions in one cascade/)

      // Classifiable rather than only readable: matching prose was the only way to tell a runaway
      // fold from an application failure, and a reporter cannot branch on a regex it has to invent.
      const aborted = errors[0] as CascadeAborted
      expect(aborted).to.be.instanceOf(CascadeAborted)
      expect(aborted.name).to.equal('CascadeAborted')
      expect(aborted.limit).to.equal(10000)
      expect(aborted.scope).to.equal(scope.name)
      expect(aborted.causes, 'the chain, not a joined string').to.be.an('array')
      expect(aborted.causes.every(cause => typeof cause === 'string')).to.equal(true)
      expect(aborted.causes.join(' -> '), 'and it is what the message was built from').to.satisfy((chain: string) =>
        aborted.message.includes(chain),
      )

      // Not half-applied: every fold that ran committed atomically, so the store holds the coherent
      // result of the folds that completed. What is arbitrary is where the sequence stopped. That
      // distinction is the whole reason there is no rollback, so it is pinned rather than argued.
      const tripped = scope.read('spin')
      expect(tripped.doubled, 'no fold committed half of itself').to.equal(tripped.n * 2)

      spins = 0
      await scope.emit('spin.calm')
      expect(scope.read('spin').n).to.equal(-1)
    })

    it('bounds it exactly: one under the limit completes, one over it fails', async () => {
      const LIMIT = 10_000
      const errors: unknown[] = []
      const report = { onUnhandledError: (error: unknown) => errors.push(error) }

      const under = createTestScope({ domains: [spin], ...report })
      current = under as never
      spins = LIMIT - 2
      await under.emit('spin.tick')
      expect(errors).to.have.lengthOf(0)
      expect(under.read('spin').n).to.equal(LIMIT - 1)

      const over = createTestScope({ domains: [spin], ...report })
      current = over as never
      spins = LIMIT + 1
      await over.emit('spin.tick')
      expect(errors).to.have.lengthOf(1)
    })

    it('names the watcher driving an oscillation', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({ domains: [osc], onUnhandledError: error => errors.push(error) })
      current = scope as never

      await scope.emit('osc.flip')

      const cascade = errors.find(error => /one cascade/.test(String((error as Error).message)))
      expect(cascade, 'a cascade error was reported').to.not.equal(undefined)
      expect(String((cascade as Error).message)).to.match(/osc\.seen/)
    })

    it('settles a queued action rather than stranding it when both an effect and the reporter throw', async () => {
      const scope = createScope({
        domains: [stranded],
        onUnhandledError: () => {
          throw new Error('reporter exploded')
        },
      })
      current = scope as never

      await scope.emit('stranded.trigger').catch(() => undefined)

      expect(await settlement(strandedQueued!)).to.not.equal(PENDING)
      expect(scope.read('stranded').n).to.equal(11)
    })
  })

  describe('commands on the queue', () => {
    it('rejects the emit with a throwing called stage, and never starts the handler', async () => {
      let started = 0
      const guarded = defineDomain('guarded' as never, [], {
        state: { n: 0 },
        actions: {
          go: cmd(
            (async () => {
              started += 1
              return 1
            }) as never,
            {
              called: () => {
                throw new Error('called stage exploded')
              },
            } as never,
          ),
        },
      })
      const scope = createScope({ domains: [guarded] as never }) as never as Scope<never>

      await rejects((scope.emit as (a: string) => Promise<unknown>)('guarded.go'), /called stage exploded/)
      await flush()

      expect(started).to.equal(0)
      expect(scope.inspect().live).to.equal(0)
    })

    it("hands the handler the called action's sequence number as ctx.version", async () => {
      const versioned = defineDomain('versioned' as never, [], {
        state: { n: 0 },
        actions: { go: cmd((async (_input: unknown, ctx: { version: number }) => ctx.version) as never) },
      })
      const scope = createTestScope({ domains: [versioned] as never })

      const version = await (scope.emit as (a: string) => Promise<unknown>)('versioned.go')

      expect(version).to.equal(scope.actions()[0].__seq)
    })

    it('resolves the caller with the handler result when a done stage throws, and reports the stage', async () => {
      const reported: unknown[] = []
      const scope = createTestScope({ domains: [outcome], onUnhandledError: error => reported.push(error) })

      // The handler completed and returned 7. The `done` reducer failing is a second failure, about
      // recording the outcome, and it does not make a finished side effect look unfinished.
      expect(await scope.emit('outcome.go')).to.equal(7)
      await flush(3)

      expect(scope.actionTypes()).to.include('outcome.go.done')
      expect(scope.actionTypes()).to.not.include('outcome.go.failed')

      expect(scope.read('outcome').n).to.equal(0)
      expect((reported[0] as Error)?.message).to.equal('done reducer exploded')
    })

    it('never invokes the handler of a call superseded while its job was still queued', async () => {
      const scope = createTestScope({ domains: [race, step] })
      current = scope as never

      const queued: Promise<unknown>[] = []
      scope.on('step.a', () => {
        queued.push(scope.emit('race.go', { id: 1 }))
        queued.push(scope.emit('race.go', { id: 2 }))
        for (const promise of queued) void promise.catch(() => undefined)
      })

      await scope.emit('step.a')
      await flush(6)

      expect(started).to.deep.equal([2])
      expect(scope.actionTypes().filter(type => type === 'race.go')).to.have.lengthOf(1)
      expect((await settlement(queued[0])).valueOf()).to.not.equal(PENDING)
      expect(((await settlement(queued[0])) as { error: unknown }).error).to.be.instanceOf(CommandAborted)
      expect(await settlement(queued[1])).to.deep.equal({ ok: 2 })
    })

    it('drops the outcome of a handler that ignored its signal and finished late', async () => {
      const scope = createTestScope({ domains: [late] })

      const first = scope.emit('late.slow', { id: 1 })
      void first.catch(() => undefined)
      const second = scope.emit('late.slow', { id: 2 })

      expect(await settlement(second, 200)).to.deep.equal({ ok: 2 })

      await flush(20)

      expect(scope.read('late').winner).to.equal(2)
      expect(scope.actionTypes().filter(type => type === 'late.slow.done')).to.have.lengthOf(1)
      expect(((await settlement(first)) as { error: unknown }).error).to.be.instanceOf(CommandAborted)
    })

    it('keeps the first cancellation reason when disposal follows supersession', async () => {
      const scope = createScope({ domains: [hang] })

      const first = scope.emit('hang.hang')
      const second = scope.emit('hang.hang')
      void second.catch(() => undefined)

      scope.dispose()

      expect(((await settlement(first)) as { error: unknown }).error).to.be.instanceOf(CommandAborted)
      expect(((await settlement(second)) as { error: unknown }).error).to.be.instanceOf(Error)
    })

    it('sends an unawaited pure-action failure to the platform exactly once', () => {
      const seen = platformRejections(`
import { createScope, defineDomain, reduce } from 'SRC'
const boom = (defineDomain as any)('boom', [], {
  state: () => ({ n: 0 }),
  actions: { go: reduce(() => { throw new Error('nobody is listening') }) },
})
const scope = createScope({ domains: [boom] })
scope.emit('boom.go')
`)
      expect(seen).to.deep.equal(['Error: nobody is listening'])
    })
  })

  describe('the drain', () => {
    it('a pure action whose reducer throws rejects instead of throwing out of emit', async () => {
      const scope = createScope({ domains: [boom] })

      let threw = false
      let promise: Promise<unknown> | undefined
      try {
        promise = scope.emit('boom.go')
      } catch {
        threw = true
      }
      expect(threw).to.equal(false)
      await rejects(promise!, /reducer exploded/)

      await scope.emit('boom.ok')
      expect(scope.read('boom').n).to.equal(1)
    })
  })
})

describe('causality — a terminal action carries the version of the action that caused it', () => {
  const causal = defineDomain('causal', [], {
    state: () => ({ last: 0 }),
    actions: {
      go: cmd(async () => 7, { done: (_state, action) => ({ last: action.result }) }),
      boom: cmd(async () => {
        throw new Error('nope')
      }),
    },
  })

  const stamps = (scope: ReturnType<typeof createTestScope<[typeof causal]>>, type: string) => {
    const action = scope.actions().find(a => a.type === type)
    expect(action, `no ${type} action was dispatched`).to.not.equal(undefined)
    return {
      seq: (action as { __seq?: number }).__seq,
      originSeq: (action as { __originSeq?: number }).__originSeq,
    }
  }

  it('stamps .done with the invoking action’s __seq, and takes a later one of its own', async () => {
    resetVersion()
    const scope = createTestScope({ domains: [causal] })

    await scope.emit('causal.go')

    const called = stamps(scope, 'causal.go')
    const done = stamps(scope, 'causal.go.done')

    expect(done.originSeq, '.done carries the invocation it came from').to.equal(called.seq)
    expect(done.seq).to.be.greaterThan(done.originSeq!)
  })

  it('stamps .failed the same way — an outcome is an outcome', async () => {
    resetVersion()
    const scope = createTestScope({ domains: [causal] })

    await rejects(scope.emit('causal.boom'), /nope/)

    const called = stamps(scope, 'causal.boom')
    const failed = stamps(scope, 'causal.boom.failed')

    expect(failed.originSeq, '.failed carries the invocation it came from').to.equal(called.seq)
  })

  it('lets isStale answer for a terminal action, which is the only reason the stamp exists', async () => {
    resetVersion()
    const scope = createTestScope({ domains: [causal] })

    await scope.emit('causal.go')

    const done = scope.actions().find(a => a.type === 'causal.go.done')!
    const origin = stamps(scope, 'causal.go').seq!

    expect(isStale(done, origin + 1), 'an outcome older than the last request must read as stale').to.equal(true)
    expect(isStale(done, origin), 'the outcome of the request we are waiting for is not stale').to.equal(false)
  })

  describe('an observer that supersedes the action it is observing', () => {
    const observedRace = defineDomain('observedRace', [], {
      state: { tag: '' },
      actions: {
        go: cmd(async (input: string) => input, {
          latest: true,
          called: (_state, action) => {
            folded.push(action.input)
            return { tag: action.input }
          },
        }),
      },
      effects: {
        'observedRace.go': effect(action => {
          reacted.push(action.input as string)
        }),
      },
    })

    let folded: string[] = []
    let reacted: string[] = []

    beforeEach(() => {
      folded = []
      reacted = []
    })

    it('folds nothing and fires nothing for the invocation it cancelled', async () => {
      let scope: Scope<'observedRace'>
      scope = createScope({
        name: 'observed',
        domains: [observedRace],
        onAction: action => {
          if (action.type === 'observedRace.go' && action.input === 'first') {
            void scope.emit('observedRace.go', 'second').catch(() => undefined)
          }
        },
      })

      const first = scope.emit('observedRace.go', 'first').catch(() => 'aborted')
      await flush()

      expect(await first).to.equal('aborted')
      expect(folded).to.deep.equal(['second'])
      expect(reacted).to.deep.equal(['second'])
      expect(scope.read('observedRace').tag).to.equal('second')
    })
  })
})

// Handlers that pass `ctx.signal` to their work, which is what the wiki instructs, rejecting three
// different ways once the library aborts them.
const waitFor = (ms: number, signal: AbortSignal, rejectWith: () => unknown) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(rejectWith())
    })
  })

const cancelShapes = defineDomain('cancelShapes', [], {
  state: () => ({ n: 0 }),
  actions: {
    reason: cmd(
      async (ms: number, ctx) => {
        await waitFor(ms, ctx.signal, () => ctx.signal.reason)
        return ms
      },
      { latest: true },
    ),
    own: cmd(
      async (ms: number, ctx) => {
        await waitFor(ms, ctx.signal, () => new Error('handler blew up'))
        return ms
      },
      { latest: true },
    ),
    plain: cmd(
      async (ms: number) => {
        await new Promise(resolve => setTimeout(resolve, ms))
        throw new Error('late failure')
      },
      { latest: true },
    ),
  },
})

describe('a cancelled invocation and the failure that is really the handler‌’s', () => {
  const supersede = async (address: 'cancelShapes.reason' | 'cancelShapes.own' | 'cancelShapes.plain') => {
    const reported: string[] = []
    const scope = createScope({
      name: 'cancel-shapes',
      domains: [cancelShapes],
      onUnhandledError: error => reported.push(String((error as Error)?.message)),
    })

    const first = scope.emit(address, 60).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 5))
    await scope.emit(address, 10).catch(() => undefined)
    await first
    await settled(scope)
    await new Promise(resolve => setTimeout(resolve, 90))

    scope.dispose()
    return reported
  }

  it('does not report the abort reason the library itself installed', async () => {
    expect(await supersede('cancelShapes.reason')).to.deep.equal([])
  })

  it('still reports a handler that fails on its own account after being aborted', async () => {
    expect(await supersede('cancelShapes.own')).to.deep.equal(['handler blew up'])
  })

  it('still reports a handler failure when the signal reason has been shadowed', async () => {
    const reported: string[] = []
    const shadow = defineDomain('shadowReason', [], {
      state: () => ({ n: 0 }),
      actions: {
        run: cmd(
          async (ms: number, ctx) => {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, ms)
              ctx.signal.addEventListener('abort', () => {
                clearTimeout(timer)
                // A handler holds the signal, so it can shadow the public property the library
                // would otherwise compare against, and then fail for its own reasons.
                const failure = new Error('genuine handler failure')
                Object.defineProperty(ctx.signal, 'reason', { value: failure, configurable: true })
                reject(failure)
              })
            })
            return ms
          },
          { latest: true },
        ),
      },
    })

    const scope = createScope({
      name: 'shadow-reason',
      domains: [shadow],
      onUnhandledError: error => reported.push(String((error as Error)?.message)),
    })

    const first = scope.emit('shadowReason.run', 60).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 5))
    await scope.emit('shadowReason.run', 10)
    await first
    await new Promise(resolve => setTimeout(resolve, 90))

    expect(reported).to.deep.equal(['genuine handler failure'])
    scope.dispose()
  })

  it('still reports a late failure from a handler that ignored the signal', async () => {
    expect(await supersede('cancelShapes.plain')).to.deep.equal(['late failure'])
  })
})

let joinRuns = 0

const joined = defineDomain('joined', [], {
  state: () => ({ runs: 0, result: 0 }),
  actions: {
    fetch: cmd(
      async (ms: number) => {
        joinRuns += 1
        await new Promise(resolve => setTimeout(resolve, ms))
        return ms
      },
      {
        called: state => ({ runs: state.runs + 1 }),
        done: (_state, action) => ({ result: action.result }),
        join: true,
      },
    ),
  },
})

describe('join — a second caller of a live address adopts the first invocation', () => {
  it('runs one handler, folds one called and one terminal, and settles every caller', async () => {
    const dispatched: string[] = []
    const scope = createScope({
      name: 'joining',
      domains: [joined],
      onAction: action => dispatched.push(action.type),
    })
    joinRuns = 0

    const a = scope.emit('joined.fetch', 20)
    const b = scope.emit('joined.fetch', 999)
    const c = scope.emit('joined.fetch', 999)

    expect(scope.inspect().live, 'one live invocation').to.equal(1)

    expect(await a).to.equal(20)
    expect(await b, 'the joiner gets the first outcome').to.equal(20)
    expect(await c).to.equal(20)

    expect(joinRuns, 'one handler run').to.equal(1)
    expect(scope.read('joined').runs, 'one called fold').to.equal(1)
    expect(scope.read('joined').result).to.equal(20)
    expect(dispatched, 'one invocation action and one terminal action').to.deep.equal([
      'joined.fetch',
      'joined.fetch.done',
    ])

    scope.dispose()
  })

  it('starts a fresh invocation once the first has settled', async () => {
    const scope = createScope({ name: 'joining-again', domains: [joined] })
    joinRuns = 0

    expect(await scope.emit('joined.fetch', 5)).to.equal(5)
    expect(await scope.emit('joined.fetch', 7)).to.equal(7)

    expect(joinRuns).to.equal(2)
    scope.dispose()
  })

  it('refuses to sit beside latest', () => {
    expect(() =>
      defineDomain('joinLatest' as never, [], {
        state: () => ({ n: 0 }),
        actions: { go: cmd(async () => 1, { latest: true, join: true } as never) },
      } as never),
    ).to.throw(/'join'/)
  })
})
