import { expect } from 'chai'
import { cmd, createScope, defineDomain, reduce, view } from '../src/index'
import type { Cmd, DomainType, Reduce } from '../src/index'
import { createTestScope } from '../src/testing'

type LeakState = { a: number; b: number }
type LeakViews = { tags: string[]; risky: number }
type LeakActions = { poison: Reduce<{ a: number }>; bumpB: Reduce }

type SnapState = { n: number }
type SnapActions = { go: Cmd<void, number> }

type ChainAState = { count: number }
type ChainAActions = { go: Reduce; stumble: Reduce }

type ChainBState = { ok: boolean }
type ChainBActions = { noop: Reduce }

type ChainCState = { ok: boolean }
type ChainCActions = { noop: Reduce }

type PulseState = { n: number }
type PulseActions = { bump: Reduce }

type StagedState = { first: number; second: number }
type StagedActions = { run: Cmd<void, number> }

type BounceState = { a: number }
type BounceViews = { tag: string[] }
type BounceActions = { round: Cmd<void, number> }

type CarryState = { items: number[]; note?: string }
type CarryActions = { round: Cmd<void, number>; roundConst: Cmd<void, number>; addNote: Reduce }

type BrittleState = { payload: unknown }
type BrittleActions = { poison: Reduce }
type EavesState = { hits: number }
type EavesActions = { noop: Reduce }

declare module '../src/types' {
  interface Domains {
    leak: DomainType<LeakState, LeakActions, LeakViews>
    snap: DomainType<SnapState, SnapActions>
    chainA: DomainType<ChainAState, ChainAActions>
    chainB: DomainType<ChainBState, ChainBActions, {}, 'chainA'>
    chainC: DomainType<ChainCState, ChainCActions, {}, 'chainA'>
    pulse: DomainType<PulseState, PulseActions>
    staged: DomainType<StagedState, StagedActions>
    bounce: DomainType<BounceState, BounceActions, BounceViews>
    carry: DomainType<CarryState, CarryActions>
    brittle: DomainType<BrittleState, BrittleActions>
    eaves: DomainType<EavesState, EavesActions, {}, 'carry'>
  }
}

const leak = defineDomain('leak', [], {
  state: () => ({ a: 0, b: 0 }),
  actions: {
    poison: reduce((_state, action) => ({ a: action.input.a })),
    bumpB: reduce(state => ({ b: state.b + 1 })),
  },
  views: {
    tags: view(
      state => state.a,
      a => [`a${a}`],
    ),
    risky: view(
      state => state.a,
      a => {
        if (a === 99) throw new Error('view exploded')
        return a * 2
      },
    ),
  },
})

const snap = defineDomain('snap', [], {
  state: () => ({ n: 0 }),
  actions: {
    go: cmd(async () => 5, {
      done: () => {
        throw new Error('done exploded')
      },
    }),
  },
})

const chainA = defineDomain('chainA', [], {
  state: () => ({ count: 0 }),
  actions: {
    go: reduce(state => ({ count: state.count + 1 })),

    stumble: reduce(state => ({ count: state.count + 1 })),
  },
})

const chainB = defineDomain('chainB', ['chainA'], {
  state: () => ({ ok: true }),
  actions: { noop: reduce({}) },
  on: {
    'chainA.go': reduce(() => {
      throw new Error('reducer exploded')
    }),
  },
})

const chainC = defineDomain('chainC', ['chainA'], {
  state: () => ({ ok: true }),
  actions: { noop: reduce({}) },
  on: {
    'chainA.stumble': reduce(() => ({ ok: (() => undefined) as never })),
  },
})

const pulse = defineDomain('pulse', [], {
  state: () => ({ n: 0 }),
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },
})

const staged = defineDomain('staged', [], {
  state: () => ({ first: 0, second: 0 }),
  actions: {
    run: cmd(async () => 5, {
      done: (_state, action) => ({ first: action.result }),
      finally: state => ({ second: state.first * 2 }),
    }),
  },
})

let bounceTransforms = 0

const bounce = defineDomain('bounce', [], {
  state: () => ({ a: 0 }),
  actions: {
    round: cmd(async () => 5, {
      done: (_state, action) => ({ a: action.result }),
      finally: { a: 0 },
    }),
  },
  views: {
    tag: view(
      state => state.a,
      a => {
        bounceTransforms += 1
        return [`a${a}`]
      },
    ),
  },
})

// `bounce` round-trips a primitive, which `assemble`'s `Object.is` already preserves. A reference
// field is the case that reaches the commit decision, so both stage forms are declared: a function
// mints a new array each call, a constant reuses one allocated at declaration.
const carry = defineDomain('carry', [], {
  state: () => ({ items: [] }) as CarryState,
  actions: {
    round: cmd(async () => 1, {
      done: () => ({ items: [1] }),
      finally: () => ({ items: [] }),
    }),
    roundConst: cmd(async () => 1, {
      done: { items: [1] },
      finally: { items: [] },
    }),
    addNote: reduce(() => ({ note: undefined })),
  },
})

// Wired to another domain's invocation address and to its terminal address. A per-domain prefilter
// keyed on the parsed domain name alone would silently stop folding both.
const eaves = defineDomain('eaves', ['carry'], {
  state: () => ({ hits: 0 }) as EavesState,
  actions: { noop: reduce(() => undefined) },
  on: {
    'carry.addNote': reduce(state => ({ hits: state.hits + 1 })),
    'carry.round.done': reduce(state => ({ hits: state.hits + 10 })),
  },
})

// A value the development freeze cannot accept. Fresh per call: a freeze that succeeds memoises its
// subject, so a shared one would refuse only the first publication that reached it.
const refusesFreeze = () =>
  new Proxy(
    { value: 1 },
    {
      preventExtensions() {
        throw new Error('freeze boom')
      },
    },
  )

// Instanced domains stay off the typed registry above: it declares single-state shapes, and the
// aggregate surfaces these tests reach for are typed against the domain names it knows.
type Leases = {
  instance: (domain: string, id: string) => { dispose: () => void }
  instances: (domain: string) => Record<string, unknown>
  subscribe: (listener: () => void) => () => void
}

const leaseScope = (domain: string, seed: () => Record<string, unknown>): Leases =>
  createScope({
    domains: [
      defineDomain(domain as never, [], {
        instanced: true,
        state: seed,
        actions: { noop: reduce(() => ({})) },
      } as never),
    ] as never,
    logLevel: 'silent',
    onUnhandledError: () => undefined,
  }) as never as Leases

describe('regression: the dispatch specification', () => {
  it('a throwing view leaves state untouched, and does not poison later folds', async () => {
    const scope = createScope({ domains: [leak] })
    const before = scope.read('leak')

    let poisoned: unknown
    try {
      await scope.emit('leak.poison', { a: 99 })
    } catch (error) {
      poisoned = error
    }
    expect(poisoned).to.be.instanceOf(Error)

    expect(scope.read('leak')).to.deep.equal(before)

    await scope.emit('leak.bumpB')
    expect(scope.read('leak').b).to.equal(1)
    expect(scope.read('leak').a).to.equal(before.a)
  })

  it('a throwing done stage publishes nothing and dispatches no second terminal action', async () => {
    const reported: unknown[] = []
    const scope = createTestScope({ domains: [snap], onUnhandledError: error => reported.push(error) })
    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    await scope.emit('snap.go')

    expect(scope.read('snap').n).to.equal(0)
    expect(notified).to.equal(0)
    expect(scope.actionTypes()).to.deep.equal(['snap.go', 'snap.go.done'])
    expect((reported[0] as Error)?.message).to.equal('done exploded')
  })

  it('a throwing reducer leaves read() and getState() agreeing', async () => {
    const scope = createScope({ domains: [chainA, chainB] })

    let thrown: unknown
    try {
      await scope.emit('chainA.go')
    } catch (error) {
      thrown = error
    }
    expect(thrown).to.be.instanceOf(Error)

    expect(scope.read('chainA').count).to.equal(0)
    expect(scope.getState().chainA).to.deep.equal(scope.read('chainA'))
  })

  it('a throwing subscriber does not prevent later subscribers from being notified', async () => {
    const scope = createScope({ domains: [pulse] })

    let secondCalled = false
    scope.subscribe(() => {
      throw new Error('listener exploded')
    })
    scope.subscribe(() => {
      secondCalled = true
    })

    try {
      await scope.emit('pulse.bump')
    } catch {}

    expect(secondCalled).to.equal(true)
  })

  it("a later stage sees the earlier stage's state, and both writes survive", async () => {
    const scope = createScope({ domains: [staged] })

    await scope.emit('staged.run')

    expect(scope.read('staged').first).to.equal(5)
    expect(scope.read('staged').second).to.equal(10)
  })

  it('keeps the view cache out of a failed fold, so a later fold still serves the memo', async () => {
    const scope = createScope({ domains: [leak] })
    const before = scope.read('leak')

    try {
      await scope.emit('leak.poison', { a: 99 })
    } catch {}

    await scope.emit('leak.bumpB')
    expect(scope.read('leak').tags).to.equal(before.tags)
    expect(scope.read('leak').tags).to.deep.equal(['a0'])
  })

  it('rolls back a refused state value exactly as it rolls back a throwing reducer', async () => {
    const scope = createScope({ domains: [chainA, chainC] })

    let thrown: unknown
    try {
      await scope.emit('chainA.stumble')
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(TypeError)
    expect(scope.read('chainA').count).to.equal(0)
    expect(scope.getState().chainA).to.deep.equal(scope.read('chainA'))
  })

  it('a failed fold notifies nobody, runs no effects, and leaks nothing into the next one', async () => {
    const scope = createScope({ domains: [chainA, chainB] })

    const published: number[] = []
    scope.subscribe(() => {
      published.push((scope.getState().chainA as { count: number }).count)
    })
    const seen: string[] = []
    scope.on('chainA.go', () => {
      seen.push('listener')
    })

    try {
      await scope.emit('chainA.go')
    } catch {}

    expect(published).to.deep.equal([])
    expect(seen).to.deep.equal([])

    await scope.emit('chainA.stumble')

    expect(published).to.deep.equal([1])
    expect(scope.read('chainA').count).to.equal(1)
    expect(seen).to.deep.equal([])
  })

  it('a view whose input bounced back inside one fold does not move, and nothing is republished', async () => {
    const scope = createScope({ domains: [bounce] })
    const before = scope.read('bounce')

    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    await scope.emit('bounce.round')

    expect(scope.read('bounce').a).to.equal(0)
    expect(scope.read('bounce').tag).to.deep.equal(['a0'])

    expect(scope.read('bounce').tag).to.equal(before.tag)
    expect(scope.read('bounce')).to.equal(before)
    expect(notified).to.equal(0)
  })

  it('runs the transform once when the input leaves the published value and comes back', async () => {
    const scope = createScope({ domains: [bounce] })
    bounceTransforms = 0

    await scope.emit('bounce.round')

    // The draft cache carries the fold forward, so the second stage no longer meets the published
    // entry in `previous`. Without the published-input check it would recompute and discard.
    expect(bounceTransforms, 'the stage that returns the input recomputes nothing').to.equal(1)
    expect(scope.read('bounce').tag).to.deep.equal(['a0'])
  })

  for (const address of ['carry.round', 'carry.roundConst'] as const) {
    it(`a reference field that bounces back across the stages of ${address} does not commit`, async () => {
      const scope = createScope({ domains: [carry] })
      const before = scope.read('carry')

      let notified = 0
      scope.subscribe(() => {
        notified += 1
      })

      await scope.emit(address)

      expect(scope.read('carry').items).to.deep.equal([])
      expect(scope.read('carry').items, 'the field keeps its reference').to.equal(before.items)
      expect(scope.read('carry'), 'the domain keeps its reference').to.equal(before)
      expect(notified).to.equal(0)
    })
  }

  it("folds an `on` reducer wired to another domain's invocation and terminal addresses", async () => {
    const scope = createScope({ domains: [carry, eaves] })

    await scope.emit('carry.addNote')
    expect(scope.read('eaves').hits, 'the invocation address').to.equal(1)

    await scope.emit('carry.round')
    expect(scope.read('eaves').hits, 'and the terminal address').to.equal(11)
  })

  it('a key that arrives holding undefined still commits, because presence is the change', async () => {
    const scope = createScope({ domains: [carry] })
    const before = scope.read('carry')

    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    await scope.emit('carry.addNote')

    expect(Object.hasOwn(scope.read('carry'), 'note'), 'the key exists').to.equal(true)
    expect(scope.read('carry'), 'a new object was published').to.not.equal(before)
    expect(notified).to.equal(1)
  })

  // The development freeze is fallible: `Object.freeze` throws on an exotic object whose
  // `preventExtensions` refuses. Run after the root is assigned, the throw would reject the dispatch
  // on a state already published and no subscriber told — a rejection lying about whether the fold
  // committed.
  it('does not publish a fold whose freeze throws', async () => {
    const brittle = defineDomain('brittle', [], {
      state: { payload: null as unknown },
      actions: { poison: reduce(() => ({ payload: refusesFreeze() })) },
    })

    const scope = createScope({ domains: [brittle], logLevel: 'silent', onUnhandledError: () => undefined })
    const before = scope.read('brittle').payload

    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    let rejected: Error | undefined
    await scope.emit('brittle.poison').catch((error: Error) => {
      rejected = error
    })

    expect(rejected?.message, 'the dispatch rejected').to.equal('freeze boom')
    expect(scope.read('brittle').payload, 'and nothing was published').to.equal(before)
    expect(notified, 'so no subscriber was told about a fold that did not happen').to.equal(0)
  })

  // An instance arrives through the same publication sequence, so the root is frozen before the
  // instance is part of it.
  it('does not publish an instance whose freeze throws', () => {
    const scope = leaseScope('brittleLease', () => ({ payload: refusesFreeze() }))

    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    expect(() => scope.instance('brittleLease', 'row'), 'the take refused').to.throw('freeze boom')
    expect(Object.hasOwn(scope.instances('brittleLease'), 'row'), 'and no instance arrived').to.equal(false)
    expect(notified, 'so no reader was told about a lease nobody holds').to.equal(0)
  })

  // The claim is what makes a take reversible: it counts an owner for an instance that was never
  // published, so the next take of the same id finds a phantom co-owner and the last handle out is
  // never the last.
  it('does not claim an owner for an instance whose freeze throws', () => {
    let brittle = true
    const scope = leaseScope('leakLease', () => ({ payload: brittle ? refusesFreeze() : 1 }))

    expect(() => scope.instance('leakLease', 'row')).to.throw('freeze boom')

    brittle = false
    scope.instance('leakLease', 'row').dispose()

    expect(
      Object.hasOwn(scope.instances('leakLease'), 'row'),
      'the take that failed holds nothing, so the one that succeeded was the last owner out',
    ).to.equal(false)
  })

  // Release publishes the removal, so it inherits the same fallible freeze. Reaching it needs state
  // the store should never have held: a take whose freeze threw is the only thing that puts an
  // unfreezable value where a later publication has to walk it again.
  it('does not remove an instance whose release cannot publish', () => {
    let brittle = false
    const scope = leaseScope('dropLease', () => ({ payload: brittle ? refusesFreeze() : 1 }))

    const kept = scope.instance('dropLease', 'kept')

    brittle = true
    expect(() => scope.instance('dropLease', 'poison')).to.throw('freeze boom')
    brittle = false

    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    kept.dispose()

    expect(Object.hasOwn(scope.instances('dropLease'), 'kept'), 'the release published').to.equal(false)
    expect(notified, 'and told its readers once').to.equal(1)
  })

  // The claim is what the arrival notification is allowed to be re-entered against: the take that
  // caused it counts as an owner before any subscriber runs, so a subscriber taking and releasing
  // the same id is never the last one out.
  it('survives a subscriber that takes and releases the arriving id from the notification', () => {
    const scope = leaseScope('echoLease', () => ({ n: 1 }))

    let reentered = false
    scope.subscribe(() => {
      if (reentered) {
        return
      }
      reentered = true
      scope.instance('echoLease', 'row').dispose()
    })

    const outer = scope.instance('echoLease', 'row') as { read: () => unknown; dispose: () => void }

    expect(reentered, 'the subscriber ran inside the arrival').to.equal(true)
    expect(outer.read(), 'and left the instance under the handle its arrival notified').to.deep.equal({ n: 1 })
  })
})
