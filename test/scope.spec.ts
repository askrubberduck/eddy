import { expect } from 'chai'
import { runInNewContext } from 'node:vm'
import { cmd, createScope, defineDomain, reduce, view, watch, effect, CommandAborted } from '../src/index'
import type { Cmd, DispatchedAction, DomainType, Reduce, Scope } from '../src/index'
import type { DomainDef } from '../src/domain'
import { createTestScope, flush, resetVersion, settled } from '../src/testing'
import { buildModeProbe, platformRejections, rejects } from './helpers'
import { api, audit, cart, draft, observed, session, upload, type CartState } from './fixtures'

class Money {
  constructor(public cents: number) {}
}
type WalletState = { balance: Money }
type WalletActions = { noop: Reduce }

type UnclonableState = { onDeposit: () => void }
type UnclonableActions = { noop: Reduce }

type ReacherState = { n: number }
type ReacherActions = { poke: Cmd<void, void>; peek: Cmd<void, number> }
type QuietState = { n: number }
type QuietActions = { touch: Reduce }

// A watcher that emits its own domain's action — the first case to attack, because
// the context is what makes a watcher able to cascade at all.
const selfEmitting = defineDomain('selfEmitting', ['selfEmitting'], {
  state: () => ({ n: 0 }),
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },
  watch: {
    n: watch(
      state => state.n,
      (_next, _previous, ctx) => {
        void ctx.emit('selfEmitting.bump')
      },
    ),
  },
})

declare module '../src/types' {
  interface Domains {
    reactor: DomainType<{ n: number }, { record: Reduce }, {}, 'quiet'>
    reader: DomainType<{ n: number }, { bump: Reduce }, {}, 'session'>
    selfEmitting: DomainType<{ n: number }, { bump: Reduce }, {}, 'selfEmitting'>
    sneakyEffect: DomainType<{ n: number }, { noop: Reduce }>
    reportWatch: DomainType<{ n: number }, { bump: Reduce }>
    credentials: DomainType<{ user: string }, { signIn: Reduce<{ user: string; password: string }> }>
    watchedInstance: DomainType<{ text: string }, { type: Reduce<string> }, {}, DomainName, true>
    usesSnapshot: DomainType<{ n: number }, { touch: Reduce }>
    peeker: DomainType<{ text: string }, { look: Cmd<void, string> }, {}, DomainName, true>
    shapeWriter: DomainType<{ n: number; note?: string }, { addNote: Reduce }>
    rerouter: DomainType<{ n: number }, { noop: Reduce }>
    reacher: DomainType<ReacherState, ReacherActions>
    quiet: DomainType<QuietState, QuietActions>
    wallet: DomainType<WalletState, WalletActions>
    unclonable: DomainType<UnclonableState, UnclonableActions>
    whole: DomainType<WholeState, WholeActions, WholeViews>
    inherited: DomainType<InheritedState, InheritedActions, InheritedViews>
    trigger: DomainType<TriggerState, TriggerActions>
    protoFold: DomainType<ProtoFoldState, ProtoFoldActions>
    protoEffect: DomainType<ProtoEffectState, ProtoEffectActions>
    flaky: DomainType<FlakyState, FlakyActions>
    restore: DomainType<RestoreState, RestoreActions>
    protoNamedView: DomainType<{ n: number }, { bump: Reduce }>
    lensHasDomain: DomainType<LensHasState, LensHasActions, LensHasViews>
    mutualA: DomainType<MutualAState, MutualAActions, {}, 'mutualB'>
    mutualB: DomainType<MutualBState, MutualBActions, {}, 'mutualA'>
  }
}

const wallet = defineDomain('wallet', [], {
  state: { balance: new Money(500) },
  actions: { noop: reduce(state => state) },
})

type WholeState = { n: number }
type WholeViews = { mirror: { n: number } }
type WholeActions = { bump: Reduce }

const whole = defineDomain('whole', [], {
  state: { n: 0 },
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },

  views: {
    mirror: view(
      s => s,
      s => ({ n: s.n }),
    ),
  },
})

type InheritedState = {}
type InheritedViews = { kinds: string[] }
type InheritedActions = { noop: Reduce }

const inherited = defineDomain('inherited', [], {
  state: {},
  actions: { noop: reduce(state => state) },
  views: {
    kinds: view(
      s => [typeof s.constructor, typeof s.toString, typeof s.hasOwnProperty],
      kinds => kinds,
    ),
  },
})

const unclonable = defineDomain('unclonable', [], {
  state: { onDeposit: () => {} },
  actions: { noop: reduce(state => state) },
})

type TriggerState = object
type TriggerActions = { fire: Reduce }

const trigger = defineDomain('trigger', [], {
  state: {},
  actions: { fire: reduce(state => state) },
})

type ProtoFoldState = { folded: boolean }
type ProtoFoldActions = { noop: Reduce }

const protoFold = defineDomain('protoFold', [], {
  state: { folded: false },
  actions: { noop: reduce(state => state) },
})

;(protoFold as unknown as { on: object }).on = Object.create({
  'trigger.fire': reduce<'protoFold', void>(() => ({ folded: true })),
})

type ProtoEffectState = object
type ProtoEffectActions = { noop: Reduce }

const protoEffect = defineDomain('protoEffect', [], {
  state: {},
  actions: { noop: reduce(state => state) },
})

const protoEffectSeen: unknown[] = []
;(protoEffect as unknown as { on: object }).on = Object.create({
  'trigger.fire': effect<'trigger.fire'>(action => {
    protoEffectSeen.push(action)
  }),
})

type FlakyState = { n: number; explode: boolean }
type FlakyActions = { bump: Reduce; arm: Reduce; disarm: Reduce }

const flakyWatched: string[] = []

const flakySources = { count: 0 }
const restoreSources = { count: 0 }

const flaky = defineDomain('flaky', [], {
  state: () => ({ n: 0, explode: false }),
  actions: {
    bump: reduce(state => ({ n: state.n + 1 })),
    arm: reduce({ explode: true }),
    disarm: reduce({ explode: false }),
  },
  watch: {
    boom: watch(
      state => {
        flakySources.count += 1
        if (state.explode) {
          throw new Error('source exploded')
        }
        return state.n
      },
      (next, previous) => {
        flakyWatched.push(`boom:${String(previous)}->${String(next)}`)
      },
    ),
    mirror: watch(
      state => {
        flakySources.count += 1
        return state.explode
      },
      (next, previous) => {
        flakyWatched.push(`mirror:${String(previous)}->${String(next)}`)
      },
    ),
  },
})

type RestoreState = { n: number }
type RestoreActions = { round: Cmd<void, number> }

const restore = defineDomain('restore', [], {
  state: () => ({ n: 0 }),
  actions: {
    round: cmd(async () => 1, {
      done: (_state, action) => ({ n: action.result }),
      finally: { n: 0 },
    }),
  },
  watch: {
    seen: watch(
      state => {
        restoreSources.count += 1
        return state.n
      },
      () => undefined,
    ),
  },
})

const defineProtoView = (viewName: string) =>
  defineDomain(`protoView_${viewName}` as never, [], {
    state: { n: 0 },
    actions: {},

    views: {
      [viewName]: view(
        () => 0,
        (n: number) => n,
      ),
    } as never,
  })

const makeProtoNamedView = (viewName: string) =>
  defineDomain('protoNamedView', [], {
    state: { n: 0 },
    actions: { bump: reduce(state => ({ n: state.n + 1 })) },
    views: {
      [viewName]: view<'protoNamedView', number, number>(
        s => s.n,
        n => n * 10,
      ),
    } as never,
  })

const protoSeedView: DomainDef<'protoSeedView'> = {
  name: 'protoSeedView',
  seed: () => ({ n: 1 }),
  actions: {},
  views: {
    toString: { $: 'view' as const, input: (s: any) => (s as { n: number }).n, transform: (n: any) => n },
    valueOf: { $: 'view' as const, input: (s: any) => (s as { n: number }).n, transform: (n: any) => n },
    constructor: { $: 'view' as const, input: (s: any) => (s as { n: number }).n, transform: (n: any) => n },
    hasOwnProperty: { $: 'view' as const, input: (s: any) => (s as { n: number }).n, transform: (n: any) => n },
  },
  watchers: {},
  on: {},
  uses: [],
  effects: {},
}

const protoSeedRealCollision: DomainDef<'protoSeedRealCollision'> = {
  name: 'protoSeedRealCollision',
  seed: () => ({ n: 1, doubled: 2 }),
  actions: {},
  views: {
    doubled: { $: 'view' as const, input: (s: any) => (s as { n: number }).n, transform: (n: any) => n * 2 },
  },
  watchers: {},
  on: {},
  uses: [],
  effects: {},
}

type LensHasState = { real: number }
type LensHasViews = { probe: boolean[] }
type LensHasActions = { noop: Reduce }

const makeLensHasDomain = () =>
  defineDomain('lensHasDomain', [], {
    state: { real: 1 },
    actions: { noop: reduce(state => state) },
    views: {
      probe: view(
        s => ['real' in s, 'toString' in s, 'constructor' in s, 'hasOwnProperty' in s],
        flags => flags,
      ),
    },
  })

type MutualAState = { seen: number }
type MutualAActions = { go: Reduce }
type MutualBState = { seen: number }
type MutualBActions = { go: Reduce }

const mutualA = defineDomain('mutualA', ['mutualB'], {
  state: () => ({ seen: 0 }),
  actions: { go: reduce(state => ({ seen: state.seen + 1 })) },
  on: { 'mutualB.go': reduce(state => ({ seen: state.seen + 1 })) },
})

const mutualB = defineDomain('mutualB', ['mutualA'], {
  state: () => ({ seen: 0 }),
  actions: { go: reduce(state => ({ seen: state.seen + 1 })) },
  on: { 'mutualA.go': reduce(state => ({ seen: state.seen + 1 })) },
})

describe('scope', () => {
  beforeEach(() => {
    resetVersion()
    api.reset()
    observed.reset()
    flakyWatched.length = 0
    flakySources.count = 0
    restoreSources.count = 0
  })

  describe('pure actions', () => {
    it('folds a constant partial', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(scope.read('cart').items).to.have.length(1)

      await scope.emit('cart.clear')
      expect(scope.read('cart').items).to.have.length(0)
    })

    it('folds a function of state and the action input', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await scope.emit('cart.add', { sku: 'SKU-2', qty: 1 })
      await flush()

      expect(scope.read('cart').items.map(item => item.sku)).to.deep.equal(['SKU-1', 'SKU-2'])

      await scope.emit('cart.reorder', { from: 1, to: 0 })
      expect(scope.read('cart').items.map(item => item.sku)).to.deep.equal(['SKU-2', 'SKU-1'])
    })

    it('does not notify subscribers when a fold changed nothing', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let notifications = 0
      scope.subscribe(() => {
        notifications += 1
      })

      await scope.emit('cart.clear')
      expect(notifications).to.equal(0)

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()
      expect(notifications).to.be.greaterThan(0)
    })

    it('keeps the state object by reference when nothing moved', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const before = scope.read('cart')
      await scope.emit('cart.clear')
      expect(scope.read('cart')).to.equal(before)
    })

    it('resolves a pure action with nothing', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      expect(await scope.emit('cart.clear')).to.equal(undefined)
    })
  })

  describe('commands', () => {
    it('resolves with the handler result', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const item = await scope.emit('cart.add', { sku: 'SKU-1', qty: 2 })

      expect(item.sku).to.equal('SKU-1')
      expect(item.id).to.equal('item-1')
    })

    it('dispatches invocation, then outcome, in order', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(scope.actionTypes()).to.deep.equal(['cart.add', 'cart.add.done'])
    })

    it('folds called, done and finally', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: boolean[] = []
      scope.subscribe(() => seen.push(scope.read('cart').pending))

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(seen[0]).to.equal(true)
      expect(scope.read('cart').pending).to.equal(false)
      expect(scope.read('cart').error).to.equal(null)
    })

    it('rethrows to the caller and folds failed', async () => {
      const scope = createTestScope({ domains: [cart, session] })

      let thrown: unknown
      try {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 0 })
      } catch (error) {
        thrown = error
      }
      await flush()

      expect(thrown).to.be.instanceOf(RangeError)
      expect(scope.read('cart').error).to.contain('qty must be at least 1')
      expect(scope.read('cart').pending).to.equal(false)
      expect(scope.actionTypes()).to.deep.equal(['cart.add', 'cart.add.failed'])
    })

    it('returns a real Promise, not a thenable wearing its name', () => {
      const scope = createTestScope({ domains: [cart, session] })
      const returned = scope.emit('cart.fail')

      expect(returned).to.be.instanceOf(Promise)
      expect(Object.prototype.toString.call(returned)).to.equal('[object Promise]')

      return returned.catch(() => undefined)
    })

    it('no longer routes an unawaited command failure to onUnhandledError', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({
        onUnhandledError: error => errors.push(error),
        domains: [cart, session],
      })
      const ignored = scope.emit('cart.fail')
      await flush(5)

      expect(errors).to.have.length(0)
      await ignored.catch(() => undefined)
    })

    it('latest: a second call supersedes the first, and only the last folds', async () => {
      const scope = createTestScope({ domains: [cart, session] })

      const first = scope.emit('cart.slow', { tag: 'first' }).catch(error => error)
      const second = scope.emit('cart.slow', { tag: 'second' })

      const firstOutcome = await first
      const secondOutcome = await second
      await flush(5)

      expect(firstOutcome).to.be.instanceOf(CommandAborted)
      expect(secondOutcome).to.equal('second')
      expect(scope.read('cart').coupon).to.equal('second')
      expect(scope.actionTypes().filter(type => type === 'cart.slow.done')).to.have.length(1)
    })

    it('ctx.state is a live getter, fresh after an await', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      const reading = scope.emit('cart.countAfterAwait')
      await scope.emit('cart.add', { sku: 'SKU-2', qty: 1 })
      await flush()

      expect(await reading).to.equal(2)
    })

    for (const [label, address] of [
      ['a symbol', Symbol('cart.add')],
      ['a number', 7],
      ['null', null],
      ['undefined', undefined],
      ['an object', {}],
    ] as const) {
      it(`rejects rather than throws when the address is ${label}`, async () => {
        const scope = createTestScope({ domains: [cart, session] })
        let returned: Promise<unknown> | undefined

        expect(() => {
          returned = (scope.emit as (a: unknown) => Promise<unknown>)(address)
        }, 'emit must not throw synchronously').to.not.throw()

        await rejects(returned!, /Unable to emit: an address must be a string/)
      })
    }

    it('names a plain object as one, rather than as a visitor from another realm', async () => {
      const scope = createTestScope({ domains: [cart, session] })

      await rejects(
        (scope.emit as (a: unknown) => Promise<unknown>)({}),
        /^Unable to emit: an address must be a string, but a plain object arrived$/,
      )
      expect(() => (scope.on as (a: unknown, h: () => void) => void)({}, () => undefined)).to.throw(
        'Unable to observe: an address must be a string, but a plain object arrived',
      )
    })

    it('refuses a non-string address to observe, in its own words', () => {
      const scope = createTestScope({ domains: [cart, session] })
      expect(() => (scope.on as (a: unknown, h: () => void) => void)(Symbol('cart.add'), () => undefined)).to.throw(
        'Unable to observe: an address must be a string, but a symbol arrived',
      )
    })

    it('rejects an unknown or non-invocable address', async () => {
      const scope = createTestScope({ domains: [cart, session] })

      await rejects(scope.emit('upload.start' as never), /not hosted here/)
      await rejects(scope.emit('cart.add.done' as never), /not an invocable address/)
    })
  })

  describe('prototype names are not actions or views', () => {
    it('rejects an address naming a prototype property instead of throwing', async () => {
      const scope = createTestScope({ domains: [cart, session] })

      for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
        await rejects(scope.emit(`cart.${name}` as never), /declares no such action/)
      }
    })

    // Refused at construction rather than ignored at runtime: a declaration that survives validation
    // is one the runtime can reach, and an inherited one never is.
    it('an inherited entry on `on` is refused at construction rather than ignored at runtime', () => {
      expect(() => createScope({ domains: [trigger, protoFold] })).to.throw(
        /the 'on' object's prototype carries enumerable properties/,
      )
    })

    it('an inherited entry on `effects` is refused the same way', () => {
      expect(() => createScope({ domains: [trigger, protoEffect] })).to.throw(/prototype carries enumerable properties/)
    })

    it('a selector that returns the whole state does not detonate the lens on a later fold', async () => {
      const scope = createScope({ name: 'lens', domains: [whole] }) as unknown as Scope<'whole'>

      await scope.emit('whole.bump')
      await scope.emit('whole.bump')

      expect(scope.read('whole').n).to.equal(2)
      expect(scope.read('whole').mirror).to.deep.equal({ n: 2 })
    })

    it('a view input selector reading an inherited name gets the property, not a view', () => {
      const scope = createScope({ name: 'inherited', domains: [inherited] }) as unknown as Scope<'inherited'>

      expect(scope.read('inherited').kinds).to.deep.equal(['function', 'function', 'function'])
    })

    it('defines a domain declaring a view named after a prototype property, with no colliding action', () => {
      for (const viewName of ['toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
        expect(() => defineProtoView(viewName), viewName).not.to.throw()
      }
    })

    it("refuses a view named '__proto__', whose resolved value a bracket assignment would silently lose", () => {
      expect(() => defineProtoView('__proto__')).to.throw(/must not be named '__proto__'/)
    })

    it('still refuses a genuine action/view name collision', () => {
      expect(() =>
        defineDomain('genuineCollision' as never, [], {
          state: { n: 0 },
          actions: { doubled: reduce(state => state) },
          views: {
            doubled: view(
              () => 0,
              (n: number) => n * 2,
            ),
          },
        } as never),
      ).to.throw(/'doubled' is declared as both an action and a view/)
    })

    it('creates a scope for a seed that shares no key with a prototype-named view', () => {
      expect(() => createScope({ domains: [protoSeedView] })).not.to.throw()
    })

    it('still refuses when a seed genuinely sets a view key', () => {
      expect(() => createScope({ domains: [protoSeedRealCollision] })).to.throw(
        /the seed for domain 'protoSeedRealCollision' sets 'doubled', which is a view/,
      )
    })

    it('a view named after a prototype property resolves and reads correctly end to end', async () => {
      for (const viewName of ['toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
        const scope = createScope({
          name: `protoNamedView-${viewName}`,
          domains: [makeProtoNamedView(viewName)],
        }) as unknown as Scope<'protoNamedView'>

        await scope.emit('protoNamedView.bump')
        expect((scope.read('protoNamedView') as Record<string, unknown>)[viewName], viewName).to.equal(10)
        await scope.emit('protoNamedView.bump')
        expect((scope.read('protoNamedView') as Record<string, unknown>)[viewName], viewName).to.equal(20)
      }

      expect(() => makeProtoNamedView('__proto__')).to.throw(/must not be named '__proto__'/)
    })

    it('the lens is an ordinary object, so `in` answers for inherited names the way reading them does', () => {
      const scope = createScope({
        name: 'lensHas',
        domains: [makeLensHasDomain()],
      }) as unknown as Scope<'lensHasDomain'>

      expect(scope.read('lensHasDomain').probe).to.deep.equal([true, true, true, true])
    })
  })

  // `reacher` reaches `quiet` without declaring it, which TypeScript refuses and a cast does not.
  const reacher = defineDomain('reacher', [], {
    state: () => ({ n: 0 }),
    actions: {
      poke: cmd(async (_input, ctx) => {
        await (ctx.emit as unknown as (address: string) => Promise<unknown>)('quiet.touch')
      }),
      peek: cmd(async (_input, ctx) => (ctx.read as unknown as (d: string) => QuietState)('quiet').n),
    },
  })

  const quiet = defineDomain('quiet', [], {
    state: () => ({ n: 0 }),
    actions: { touch: reduce(state => ({ n: state.n + 1 })) },
  })

  describe('an effect reacting to a neighbour', () => {
    it('reads state and emits through its own declaration, which is what a reaction needs', async () => {
      const seen: number[] = []

      const reactor = defineDomain('reactor', ['quiet'], {
        state: () => ({ n: 0 }),
        actions: { record: reduce(state => ({ n: state.n + 1 })) },
        effects: {
          'quiet.touch': effect(async (_action, ctx) => {
            seen.push(ctx.read('quiet').n)
            await ctx.emit('reactor.record')
          }),
        },
      })

      const scope = createScope({ name: 'reactor', domains: [quiet, reactor] })
      await scope.emit('quiet.touch')
      await flush()

      expect(seen, 'the effect saw the state the fold committed').to.deep.equal([1])
      expect(scope.read('reactor').n, 'and its own emit landed').to.equal(1)
    })

    it('is refused when it emits into a domain its own declaration never named', async () => {
      const reported: unknown[] = []
      const sneaky = defineDomain('sneakyEffect', [], {
        state: () => ({ n: 0 }),
        actions: { noop: reduce({}) },
        effects: {
          'quiet.touch': effect(async (_action, ctx) => {
            await (ctx.emit as unknown as (address: string) => Promise<unknown>)('quiet.touch')
          }),
        } as never,
      })

      const scope = createScope({
        onUnhandledError: error => reported.push(error),
        name: 'sneaky-effect',
        domains: [quiet, sneaky],
      })
      await scope.emit('quiet.touch')
      await flush()

      expect(scope.read('quiet').n, 'the undeclared emit never folded').to.equal(1)
      expect((reported[0] as Error)?.message).to.match(/does not declare 'quiet' in its 'uses'/)
    })
  })

  describe('a failure reported from a state observer', () => {
    it('carries the action that triggered it, for a subscriber and for a watcher', async () => {
      const seen: (string | undefined)[] = []
      const watched = defineDomain('reportWatch', [], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          seen: watch(
            state => state.n,
            () => {
              throw new Error('watcher broke')
            },
          ),
        },
      })

      const scope = createScope({
        onUnhandledError: (_error, action) => seen.push(action?.type),
        name: 'report-watch',
        domains: [watched],
      })
      scope.subscribe(() => {
        throw new Error('subscriber broke')
      })

      await scope.emit('reportWatch.bump')

      // Both carry the action, so a report can be tied to its commit.
      expect(seen).to.deep.equal(['reportWatch.bump', 'reportWatch.bump'])
    })

    it('identifies the dispatch without carrying its payload, which is the one channel that leaves the process', async () => {
      const seen: unknown[] = []

      const credentials = defineDomain('credentials', [], {
        state: () => ({ user: '' }),
        actions: { signIn: reduce((_state, action) => ({ user: action.input.user })) },
      })

      const scope = createScope({
        onUnhandledError: (_error, action) => seen.push(action),
        name: 'reporter-ceiling',
        domains: [credentials],
      })
      scope.subscribe(() => {
        throw new Error('subscriber broke')
      })

      await scope.emit('credentials.signIn', { user: 'ada', password: 'hunter2' })

      const [reported] = seen as [Record<string, unknown>]
      expect(reported.type, 'the report can still be tied to its commit').to.equal('credentials.signIn')
      expect(typeof reported.__seq, 'and to its place in the order').to.equal('number')

      // Asserted over the whole key set rather than field by field: a later field added to the
      // dispatched action must not reach the reporter by default, and naming `input` alone would
      // not catch that. An instance id is application data, so `__instance` is not in the set.
      expect(Object.keys(reported).sort()).to.deep.equal(['__originSeq', '__seq', 'type'])
      expect(JSON.stringify(reported), 'no payload survives anywhere in it').to.not.include('hunter2')
    })

    it('does not carry the instance id, which the React page invites an application to set to a token', async () => {
      const seen: unknown[] = []
      const scope = createScope({
        onUnhandledError: (_error, action) => seen.push(action),
        name: 'reporter-instance',
        domains: [session, draft],
      })
      scope.subscribe(() => {
        throw new Error('subscriber broke')
      })

      const handle = scope.instance('draft', 'access-token-SECRET')
      await handle.emit('draft.type', 'hello')

      // Seeding the instance publishes once with no action of its own, so that report comes first
      // and carries `undefined`. The fold's report is the one under test.
      const reported = (seen as (Record<string, unknown> | undefined)[]).find(Boolean)!
      expect(reported.type, 'the report still names the dispatch').to.equal('draft.type')
      expect(Object.keys(reported).sort()).to.deep.equal(['__originSeq', '__seq', 'type'])
      expect(JSON.stringify(reported)).to.not.include('SECRET')
    })

    // A logger is host code and may be hostile; `contain` exists so it cannot take the caller's
    // action down with it. The command path is the one to attack: the `.then` probe on the logger's
    // return value, and a command enqueues outside its own promise, so an escaping throw would leave
    // the invocation live.
    it('survives a logger whose return value throws from a then getter, on the command path', async () => {
      const hostile = {
        get then() {
          throw new Error('then-getter')
        },
      }
      const scope = createTestScope({
        domains: [cart, session],
        logLevel: 'debug',
        logger: { debug: () => hostile as never, info: () => hostile as never, error: () => hostile as never },
        onUnhandledError: () => undefined,
      })

      let threw: unknown
      let returned: Promise<unknown> | undefined
      try {
        returned = scope.emit('cart.add', { sku: 'MUG-1', qty: 1 })
      } catch (error) {
        threw = error
      }

      expect(threw, 'emit rejects, never throws — including for commands').to.equal(undefined)
      await returned?.catch(() => undefined)
      expect(scope.inspect().live, 'and no invocation is stranded').to.equal(0)
    })

    // The preload is shallow-copied at the top level only, so a nested array the caller
    // still holds is the same array the store folds over. Development freezes and catches a later
    // write; production does not, and "production trusts what it was given" is not the same promise
    // as "a caller may keep mutating it afterwards". Probed in a production build, the only place
    // the freeze is absent.
    it('does not leave a preloaded nested value aliased to the caller in a production build', () => {
      const PROBE = `
const shelf = eddy.defineDomain('shelf', [], {
  state: () => ({ items: [] }),
  actions: { noop: eddy.reduce({}) },
})

const mine = ['first']
const scope = eddy.createScope({ name: 'aliased', domains: [shelf], preloadedState: { shelf: { items: mine } } })

mine.push('smuggled')
console.log(String(scope.read('shelf').items.length))
`

      expect(buildModeProbe(PROBE, { env: { NODE_ENV: 'production' } })).to.deep.equal(['1'])
    })

    // The same hole one door over: a value seed is shallow-copied like a preload, so a caller who
    // keeps the array they seeded with could push to it afterwards, and every scope built from the
    // definition would share it.
    it("does not leave a value seed's nested value aliased to the caller in a production build", () => {
      const PROBE = `
const mine = ['first']
const shelf = eddy.defineDomain('shelf', [], {
  state: { items: mine },
  actions: { noop: eddy.reduce({}) },
})

const scope = eddy.createScope({ name: 'seed-aliased', domains: [shelf] })
mine.push('smuggled')
console.log(String(scope.read('shelf').items.length))
`

      expect(buildModeProbe(PROBE, { env: { NODE_ENV: 'production' } })).to.deep.equal(['1'])
    })

    it('refuses to read state for an instanced command reached without a handle', async () => {
      // Instanced, but emitted straight at the scope: there is no instance for `ctx.state` to be
      // about, and its type promises one. Handing back the aggregate is the lie the type cannot
      // catch, so the read refuses instead.
      const peeker = defineDomain('peeker', [], {
        instanced: true,
        state: () => ({ text: 'seed' }),
        actions: { look: cmd(async (_input, ctx) => JSON.stringify(ctx.state)) },
      } as never)

      const scope = createScope({ name: 'no-handle', domains: [peeker], logLevel: 'silent' })
      scope.instance('peeker', 'one')

      const outcome = await scope.emit('peeker.look' as never).then(
        (resolved: unknown) => `resolved with ${String(resolved)}`,
        (error: unknown) => (error as Error).message,
      )

      expect(outcome).to.match(/it is instanced, so the command must be emitted through the handle/)
    })

    it("snapshots a domain's uses, so pushing to the caller's array cannot widen a live scope", async () => {
      const uses: string[] = []
      const snapshot = defineDomain('usesSnapshot', uses as never, {
        state: () => ({ n: 0 }),
        actions: { touch: reduce(state => ({ n: state.n + 1 })) },
      })

      const scope = createScope({ name: 'snapshot-uses', domains: [snapshot, session], logLevel: 'silent' })
      uses.push('session')

      const reported: string[] = []
      scope.subscribe(() => undefined)
      const before = JSON.stringify(scope.read('session'))
      await scope.emit('usesSnapshot.touch' as never)

      expect(JSON.stringify(scope.read('session')), 'the neighbour is untouched').to.equal(before)
      expect(reported).to.deep.equal([])
    })

    it('does not name the instance in the diagnostic record either, where the changed keys are ids', async () => {
      const lines: string[] = []
      const scope = createScope({
        name: 'record-instance',
        domains: [session, draft],
        logLevel: 'debug',
        logger: {
          debug: (...args: unknown[]) => lines.push(JSON.stringify(args)),
          info: (...args: unknown[]) => lines.push(JSON.stringify(args)),
          error: (...args: unknown[]) => lines.push(JSON.stringify(args)),
        },
      })

      await scope.instance('draft', 'access-token-SECRET').emit('draft.type', 'hello')

      const all = lines.join('\n')
      expect(all, 'the fold is still traced').to.include('draft.type')
      expect(all, 'and the id is not in it').to.not.include('SECRET')
    })

    it('does not name an orphaned instance in the diagnostic cause', async () => {
      const lines: string[] = []
      const scope = createScope({
        name: 'orphan-instance',
        domains: [session, draft],
        logger: {
          debug: () => undefined,
          info: () => undefined,
          error: (...args: unknown[]) => lines.push(JSON.stringify(args)),
        },
      })

      // The orphan path proper: a command in flight when its instance goes. A released handle is
      // refused before it reaches the fold, so the report has to be provoked by an outcome that
      // arrives after the instance it belongs to is gone.
      await scope.emit('session.signIn', { email: 'a@b.c' })
      const handle = scope.instance('draft', 'access-token-SECRET')
      const inFlight = handle.emit('draft.save')
      handle.dispose()
      await inFlight.catch(() => undefined)
      await flush()

      const all = lines.join('\n')
      expect(all, 'the dropped fold is still reported').to.include('fold was dropped')
      expect(all, 'and application data stays out of the record').to.not.include('SECRET')
    })
  })

  describe('instanced domain state', () => {
    describe('a fold dropped because its instance went', () => {
      type Strandable = {
        instance: (d: string, id: string) => { emit: (a: string) => Promise<unknown>; dispose: () => void }
      }

      const strandable = (causes: string[]) => {
        const releases: (() => void)[] = []
        const def = defineDomain('strand' as never, [], {
          instanced: true,
          state: () => ({ saved: 0, settled: 0 }),
          actions: {
            save: cmd(() => new Promise<void>(resolve => releases.push(resolve)), {
              done: (state: { saved: number }) => ({ saved: state.saved + 1 }),
              finally: (state: { settled: number }) => ({ settled: state.settled + 1 }),
            } as never),
          },
        } as never)
        const scope = createScope({
          domains: [def] as never,
          logger: {
            debug: () => undefined,
            info: () => undefined,
            error: (_event: unknown, record: unknown) => causes.push(String((record as { cause?: string })?.cause)),
          },
        }) as never as Strandable
        return { scope, release: () => releases.shift()!() }
      }

      it('is reported once for a fold with two stages', async () => {
        const causes: string[] = []
        const { scope, release } = strandable(causes)

        const handle = scope.instance('strand', 'a')
        const saving = handle.emit('strand.save')
        handle.dispose()
        release()
        await saving

        expect(causes).to.deep.equal(["an instance of domain 'strand' is gone, so the fold was dropped"])
      })

      it('is reported again for a later instance seeded under the same id', async () => {
        const causes: string[] = []
        const { scope, release } = strandable(causes)

        for (const _round of [1, 2]) {
          const handle = scope.instance('strand', 'a')
          const saving = handle.emit('strand.save')
          handle.dispose()
          release()
          await saving
        }

        expect(causes).to.have.length(2)
      })
    })

    it('lets an effect emit back into the instance whose action it heard', async () => {
      const reports: unknown[] = []
      const def = defineDomain('echoing' as never, [], {
        instanced: true,
        state: () => ({ title: '', echoed: 0 }),
        actions: {
          type: reduce((_s: never, a: { input: string }) => ({ title: a.input })),
          echo: reduce((s: { echoed: number }) => ({ echoed: s.echoed + 1 })),
        },
        effects: {
          'echoing.type': effect((async (_action: unknown, ctx: { emit: (a: string) => Promise<unknown> }) => {
            await ctx.emit('echoing.echo')
          }) as never),
        },
      } as never)
      const scope = createScope({
        domains: [def] as never,
        onUnhandledError: error => reports.push(error),
      }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown> }
        instances: (d: string) => Record<string, { echoed: number }>
      }

      await scope.instance('echoing', 'a').emit('echoing.type', 'hello')
      scope.instance('echoing', 'b')
      await flush()

      expect(reports).to.deep.equal([])
      expect(scope.instances('echoing')['a'].echoed).to.equal(1)
      expect(scope.instances('echoing')['b'].echoed, 'and only into that instance').to.equal(0)
    })

    it('keeps no book for an instance that has gone', function () {
      this.timeout(30000)
      // A minted id per mount is the React binding's default, so a long-lived scope sees an unbounded
      // number of distinct ids. Measured in a child process, where the heap can be collected.
      const [line] = buildModeProbe(
        `
const row = eddy.defineDomain('row', [], { instanced: true, state: () => ({ v: 0 }), actions: {} })
const scope = eddy.createScope({ domains: [row] })
const heap = () => {
  for (let i = 0; i < 4; i += 1) global.gc()
  return process.memoryUsage().heapUsed
}
scope.instance('row', 'warm').dispose()
const before = heap()
for (let i = 0; i < 200000; i += 1) scope.instance('row', 'row-' + i).dispose()
const grown = heap() - before
// Read after measuring, or the collector may take the whole scope with its books.
console.log('GROWTH_MB:' + (grown / 1e6).toFixed(1) + ' LIVE:' + Object.keys(scope.instances('row')).length)
`,
        { execArgv: ['--expose-gc'] },
      )

      expect(line).to.match(/ LIVE:0$/)
      expect(parseFloat(line.slice('GROWTH_MB:'.length)), line).to.be.below(5)
    })

    it('drops a terminal fold whose instance was replaced while the command was in flight', async () => {
      let release!: (v: number) => void
      const gate = new Promise<number>(r => {
        release = r
      })
      const def = defineDomain('leaseFlight' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed' }),
        actions: {
          slow: cmd(async () => gate, { done: (_s: never, a: { result: number }) => ({ value: `DONE-${a.result}` }) }),
          set: reduce((_s: never, a: { input: string }) => ({ value: a.input })),
        },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { value: string }>
      }

      // The check must happen when the stage folds, not when the command was dispatched.
      const first = scope.instance('leaseFlight', 'row')
      void first.emit('leaseFlight.slow').catch(() => undefined)
      first.dispose()
      const second = scope.instance('leaseFlight', 'row')
      void second.emit('leaseFlight.set', 'SECOND-OWN').catch(() => undefined)
      await flush()

      release(7)
      await flush()
      await flush()

      expect(scope.instances('leaseFlight')['row'].value, "the replaced instance's terminal must not land").to.equal(
        'SECOND-OWN',
      )
      second.dispose()
    })

    it('lets a command emit its own domain from ctx, which carries the generation with the id', async () => {
      const def = defineDomain('leaseReach' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed', echoed: '' }),
        actions: {
          go: cmd(async (_i: unknown, ctx: unknown) => {
            await (ctx as { emit: (a: string, i?: unknown) => Promise<unknown> }).emit('leaseReach.echo', 'FROM-CTX')
            return 1
          }),
          echo: reduce((_s: never, a: { input: string }) => ({ echoed: a.input })),
        },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { echoed: string }>
      }

      // The id alone does not reach the fold: whatever forwards the id forwards the generation.
      const handle = scope.instance('leaseReach', 'row')
      await handle.emit('leaseReach.go')
      await flush()

      expect(scope.instances('leaseReach')['row'].echoed, "a command's own emit is not an orphan").to.equal('FROM-CTX')
      handle.dispose()
    })

    it('still folds a neighbour wire when the emitting domain recycled the same id', async () => {
      const src = defineDomain('leaseSrc' as never, [], {
        instanced: true,
        state: () => ({ n: 0 }),
        actions: { ping: reduce(() => ({})) },
      } as never)
      const mirror = defineDomain(
        'leaseMirror' as never,
        ['leaseSrc'] as never,
        {
          instanced: true,
          state: () => ({ seen: 0 }),
          actions: {},
          on: { 'leaseSrc.ping': reduce((state: { seen: number }) => ({ seen: state.seen + 1 })) },
        } as never,
      )
      const scope = createScope({ domains: [src, mirror] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { seen: number }>
      }

      // A generation is minted by one domain's book. Comparing it against another's asks whether an
      // unrelated domain recycled the same string, and answers by dropping a live instance's fold.
      const held = scope.instance('leaseMirror', 'row')
      const first = scope.instance('leaseSrc', 'row')
      await first.emit('leaseSrc.ping')
      await flush()
      first.dispose()

      const second = scope.instance('leaseSrc', 'row')
      await second.emit('leaseSrc.ping')
      await flush()

      expect(scope.instances('leaseMirror')['row'].seen, 'the wire is about the id, not a foreign book').to.equal(2)
      second.dispose()
      held.dispose()
    })

    it('does not let an in-flight command read the state of the instance that replaced its own', async () => {
      let release!: (v: number) => void
      const gate = new Promise<number>(r => {
        release = r
      })
      const def = defineDomain('leaseCtxState' as never, [], {
        instanced: true,
        state: () => ({ text: 'seed' }),
        actions: {
          set: reduce((_s: never, a: { input: string }) => ({ text: a.input })),
          look: cmd(async (_i: unknown, ctx: unknown) => {
            await gate
            return (ctx as { state: { text: string } }).state.text
          }),
        },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
      }

      const first = scope.instance('leaseCtxState', 'row')
      await first.emit('leaseCtxState.set', 'GEN1-TEXT')
      const looking = first.emit('leaseCtxState.look')
      first.dispose()

      const second = scope.instance('leaseCtxState', 'row')
      await second.emit('leaseCtxState.set', 'GEN2-SECRET')
      release(1)

      // The fold already refuses to write into the successor. A handler that can still *read* it
      // returns it to the caller and out of the process, which is the same leak by another door.
      expect(await looking, "a command reads its own instance's state, not its replacement's").to.equal('GEN1-TEXT')
      second.dispose()
    })

    it('supersedes latest per instance, not across every instance sharing the address', async () => {
      const gates: Record<string, (v: string) => void> = {}
      const def = defineDomain('slotLatest' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed' }),
        actions: {
          go: cmd(
            async (input: unknown) =>
              new Promise<string>(resolve => {
                gates[input as string] = resolve
              }),
            { latest: true, done: (_s: never, a: { result: string }) => ({ value: a.result }) },
          ),
        },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { value: string }>
      }

      // One slot for one address means instance B's call aborts instance A's, and A's write is lost
      // on a fully typed path. Two instances are two subjects; `latest` is about one of them.
      const a = scope.instance('slotLatest', 'a')
      const b = scope.instance('slotLatest', 'b')
      const first = a.emit('slotLatest.go', 'A')
      const second = b.emit('slotLatest.go', 'B')

      await flush()
      gates['A']?.('A-DONE')
      gates['B']?.('B-DONE')

      await first
      await second
      await flush()

      expect(scope.instances('slotLatest')['a'].value, "instance A's own command is not superseded").to.equal('A-DONE')
      expect(scope.instances('slotLatest')['b'].value).to.equal('B-DONE')
      a.dispose()
      b.dispose()
    })

    it('does not let a replacement instance join a call belonging to the instance it replaced', async () => {
      let settle!: (v: string) => void
      const def = defineDomain('slotGen' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed' }),
        actions: {
          go: cmd(
            async () =>
              new Promise<string>(resolve => {
                settle = resolve
              }),
            { join: true, done: (_s: never, a: { result: string }) => ({ value: a.result }) },
          ),
        },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
      }

      // The generation is in the slot as well as the id. Without it a successor joins its
      // predecessor's call, and that call's fold is dropped — so the successor's caller is told it
      // succeeded while nothing was written anywhere.
      const first = scope.instance('slotGen', 'row')
      const running = first.emit('slotGen.go')
      first.dispose()

      const second = scope.instance('slotGen', 'row')
      const rejoined = second.emit('slotGen.go')

      expect(rejoined, 'a replacement takes its own invocation').to.not.equal(running)
      settle('DONE')
      second.dispose()
    })

    it('joins per instance, so one instance never resolves with another instance result', async () => {
      const gates: Record<string, (v: string) => void> = {}
      const def = defineDomain('slotJoin' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed' }),
        actions: {
          go: cmd(
            async (input: unknown) =>
              new Promise<string>(resolve => {
                gates[input as string] = resolve
              }),
            { join: true, done: (_s: never, a: { result: string }) => ({ value: a.result }) },
          ),
        },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { value: string }>
      }

      // Joining across instances hands B's caller A's result and folds nothing into B — success
      // reported while going nowhere, which is the shape this whole contract exists to refuse.
      const a = scope.instance('slotJoin', 'a')
      const b = scope.instance('slotJoin', 'b')
      const first = a.emit('slotJoin.go', 'A')
      const second = b.emit('slotJoin.go', 'B')

      await flush()
      gates['A']?.('A-DONE')
      gates['B']?.('B-DONE')

      expect(await first).to.equal('A-DONE')
      expect(await second, "instance B gets its own command's result").to.equal('B-DONE')
      await flush()
      expect(scope.instances('slotJoin')['b'].value, "and B's own done stage folds").to.equal('B-DONE')
      a.dispose()
      b.dispose()
    })

    it('refuses a released handle even while another holder keeps the instance alive', async () => {
      const def = defineDomain('leaseHeld' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed' }),
        actions: { set: reduce((_s: never, a: { input: string }) => ({ value: a.input })) },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (
          d: string,
          id: string,
        ) => { read: () => { value: string }; emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { value: string }>
      }

      // Two holders share one generation, so the generation cannot tell a released handle from a
      // live one. The lease has to answer for itself.
      const a = scope.instance('leaseHeld', 'row')
      const b = scope.instance('leaseHeld', 'row')
      await b.emit('leaseHeld.set', 'FROM-B')
      await flush()

      a.dispose()

      expect(() => a.read(), 'a released handle reads nothing').to.throw(/released/)
      await rejects(a.emit('leaseHeld.set', 'FROM-RELEASED'), /released/)
      await flush()
      expect(scope.instances('leaseHeld')['row'].value, 'and writes nothing').to.equal('FROM-B')

      b.dispose()
    })

    it('does not let a stale handle reach an instance whose id merely looks synthetic', async () => {
      const def = defineDomain('leaseCollide' as never, [], {
        instanced: true,
        state: () => ({ value: 'seed' }),
        actions: { set: reduce((_s: never, a: { input: string }) => ({ value: a.input })) },
      } as never)
      const scope = createScope({ domains: [def] as never, onUnhandledError: () => undefined }) as never as {
        instance: (d: string, id: string) => { emit: (a: string, i?: unknown) => Promise<unknown>; dispose: () => void }
        instances: (d: string) => Record<string, { value: string }>
      }

      const stale = scope.instance('leaseCollide', 'row')
      stale.dispose()
      const fresh = scope.instance('leaseCollide', 'row')
      // An id a dropped write could be redirected into. Nothing may construct it.
      const decoy = scope.instance('leaseCollide', 'row\u00001')
      await decoy.emit('leaseCollide.set', 'DECOY-OWN')
      await flush()

      void stale.emit('leaseCollide.set', 'HIJACK').catch(() => undefined)
      await flush()

      expect(scope.instances('leaseCollide')['row\u00001'].value, 'a dropped write lands nowhere').to.equal('DECOY-OWN')
      fresh.dispose()
      decoy.dispose()
    })

    it('reads and round-trips the aggregate keyed by id', () => {
      const scope = createScope({
        name: 'instance-aggregate',
        domains: [session, draft],
        preloadedState: { draft: { row: { text: 'saved' } } },
      })

      expect(scope.instances('draft')).to.deep.equal({ row: { text: 'saved', saved: false } })
      expect(scope.getWrittenState().draft).to.deep.equal({ row: { text: 'saved', saved: false } })
    })

    it('refuses one instance state where the aggregate belongs', () => {
      expect(() =>
        createScope({
          name: 'instance-preload-shape',
          domains: [session, draft],
          preloadedState: { draft: { text: 'saved' } } as never,
        }),
      ).to.throw(/the preloaded instance in domain 'draft' must be a plain object of written fields/)
    })

    it('keeps a shared instance until its last handle releases it', async () => {
      const scope = createScope({ name: 'instance-owners', domains: [session, draft] })
      let notifications = 0
      scope.subscribe(() => (notifications += 1))

      const first = scope.instance('draft', 'shared')
      const second = scope.instance('draft', 'shared')
      await first.emit('draft.type', 'x')
      first.dispose()

      expect(second.read().text, 'the surviving owner keeps the state').to.equal('x')
      expect(scope.instances('draft')).to.have.own.property('shared')

      second.dispose()
      expect(scope.instances('draft')).to.deep.equal({})
      expect(notifications, 'arrival, fold, and final departure each publish once').to.equal(3)
    })

    // A watcher source is typed `Readable<D>` — one instance — and an instanced domain would hand
    // it the aggregate, so `state.text` reads `undefined` and the watcher silently watches nothing.
    // A watcher has no handle, so it cannot be about one instance; the surface that cannot name an
    // instance refuses instead.
    it('refuses a watcher on an instanced domain, which has no instance for its source to be about', () => {
      const watched = defineDomain('watchedInstance', [], {
        instanced: true,
        state: () => ({ text: '' }),
        actions: { type: reduce((_state, action) => ({ text: action.input })) },
        watch: {
          seen: watch(((state: unknown) => (state as { text: string }).text) as never, (() => undefined) as never),
        },
      } as never)

      expect(() => createScope({ name: 'watched-instance', domains: [watched] })).to.throw(/instanced/)
    })

    it('refuses a view on an instanced domain', () => {
      const viewed = defineDomain('viewedInstance' as never, [], {
        instanced: true,
        state: () => ({ text: '' }),
        actions: { type: reduce({ text: 'x' }) },
        views: {
          length: view(((state: { text: string }) => state.text) as never, ((text: string) => text.length) as never),
        },
      } as never)

      expect(() => createScope({ name: 'viewed-instance', domains: [viewed] as never })).to.throw(
        /is instanced and declares views/,
      )
    })

    it("fails a neighbour's plain action that an instanced domain wires through on", async () => {
      const source = defineDomain('plainSource' as never, [], {
        state: { n: 0 },
        actions: { ping: reduce((state: { n: number }) => ({ n: state.n + 1 })) },
      } as never)
      const listener = defineDomain(
        'instancedListener' as never,
        ['plainSource'] as never,
        {
          instanced: true,
          state: () => ({ heard: 0 }),
          actions: { noop: reduce({}) },
          on: { 'plainSource.ping': reduce((state: { heard: number }) => ({ heard: state.heard + 1 })) },
        } as never,
      )
      const scope = createScope({ domains: [source, listener] as never }) as never as {
        emit: (a: string) => Promise<unknown>
        read: (d: string) => { n: number }
      }

      await rejects(scope.emit('plainSource.ping'), /it is instanced, so the action must name an instance/)
      expect(scope.read('plainSource').n, 'one transaction, so the neighbour did not fold either').to.equal(0)
    })

    // `instances` is the named aggregate accessor, but it accepts an ordinary domain
    // and hands back that domain's single state while its type promises an aggregate keyed by id.
    // That recreates the same silent shape lie in reverse, so the surface must refuse the domain.
    it('refuses the instance aggregate accessor for an ordinary domain', () => {
      const scope = createScope({ name: 'ordinary-instances', domains: [session] })

      // Cast past the argument guard on purpose: the refusal under test is the runtime one, which
      // is what an untyped consumer meets.
      expect(() => scope.instances('session' as never)).to.throw(/not instanced/)
    })

    it('does not let a released handle write into a later instance with the same id', async () => {
      const scope = createScope({ name: 'instance-replacement', domains: [session, draft] })
      const released = scope.instance('draft', 'same')
      released.dispose()

      const replacement = scope.instance('draft', 'same')

      // Refused rather than dropped-and-resolved: the caller holds a dead object, and a write that
      // reports success while going nowhere is the silent half of this defect.
      await rejects(released.emit('draft.type', 'stale'), /released/)

      expect(replacement.read().text).to.equal('')
    })
  })

  describe('the write path', () => {
    it('publishes a new own key that holds undefined, which is not the same as absent', async () => {
      let notified = 0

      const shape = defineDomain('shapeWriter', [], {
        state: () => ({ n: 0 }) as { n: number; note?: string },
        actions: {
          addNote: reduce(() => ({ note: undefined })),
        },
      })

      const scope = createScope({ name: 'shape-writer', domains: [shape] })
      scope.subscribe(() => (notified += 1))

      await scope.emit('shapeWriter.addNote')

      expect(Object.hasOwn(scope.read('shapeWriter'), 'note'), 'the key exists').to.equal(true)
      expect(notified, 'and subscribers heard about it').to.equal(1)
    })

    it('refuses a factory that hands every scope the same root', () => {
      const shared = { n: 0 }
      const def = defineDomain('sharedRoot' as never, [], {
        state: () => shared,
        actions: { bump: reduce({ n: 1 }) },
      } as never)

      createScope({ name: 'shared-1', domains: [def] as never })

      expect(() => createScope({ name: 'shared-2', domains: [def] as never })).to.throw(
        /the factory returned the same object it returned last time/,
      )
    })
  })

  describe('the action object every participant shares', () => {
    it('is frozen in development, so no participant can reroute a later fold', async () => {
      let frozen: boolean | undefined
      let rerouted = false

      const watcher = defineDomain('rerouter', ['quiet'], {
        state: () => ({ n: 0 }),
        actions: { noop: reduce({}) },
        effects: {
          'quiet.touch': effect(action => {
            frozen = Object.isFrozen(action)
            try {
              ;(action as { type: string }).type = 'quiet.other'
            } catch {
              // Strict mode throws where sloppy mode ignores; the assertion is the type, not the mode.
            }
            rerouted = action.type !== 'quiet.touch'
          }),
        },
      })

      const scope = createScope({ name: 'frozen-action', domains: [quiet, watcher] })
      await scope.emit('quiet.touch')

      expect(frozen, 'the action is frozen in development').to.equal(true)
      expect(rerouted, 'and the write did not move it').to.equal(false)
      expect(scope.read('quiet').n).to.equal(1)
    })
  })

  describe('the declaration graph as a runtime contract', () => {
    const lines: { level: string; args: unknown[] }[] = []

    const recording = () => {
      lines.length = 0
      return {
        logLevel: 'info' as const,
        logger: {
          debug: (...args: unknown[]) => lines.push({ level: 'debug', args }),
          info: (...args: unknown[]) => lines.push({ level: 'info', args }),
          error: (...args: unknown[]) => lines.push({ level: 'error', args }),
        },
      }
    }

    const causes = () => lines.map(line => (line.args[1] as { cause?: string })?.cause).filter(Boolean)

    it('refuses an emit into a hosted domain the caller never declared, and says why', async () => {
      const scope = createScope({
        logLevel: 'info',
        logger: {
          debug: (...args: unknown[]) => lines.push({ level: 'debug', args }),
          info: (...args: unknown[]) => lines.push({ level: 'info', args }),
          error: (...args: unknown[]) => lines.push({ level: 'error', args }),
        },
        name: 'undeclared-emit',
        domains: [reacher, quiet],
      })

      await rejects(
        scope.emit('reacher.poke'),
        /Unable to emit 'quiet\.touch' from domain 'reacher': it does not declare 'quiet' in its 'uses'/,
      )

      expect(causes().some(cause => cause?.includes("emits into 'quiet'"))).to.equal(true)
    })

    it('answers an undeclared read, because a typed read has no refusal that is not a lie, and logs it', async () => {
      const scope = createScope({ name: 'undeclared-read', domains: [reacher, quiet], ...recording() })

      expect(await scope.emit('reacher.peek')).to.equal(0)
      expect(causes().some(cause => cause?.includes("reads 'quiet'"))).to.equal(true)
    })

    it('drops a wire whose address this scope cannot resolve, builds anyway, and names it', () => {
      const settings = recording()
      const def = defineDomain('wired' as never, [], {
        state: { n: 0 },
        actions: { bump: reduce({ n: 1 }) },
      })
      Object.defineProperty(def, 'effects', {
        value: { 'nowhere.atall': effect(() => undefined) },
      })

      const scope = createScope({ name: 'dropped-wire', domains: [def] as never, ...settings })

      expect(scope.read('wired' as never)).to.not.equal(undefined)
      expect(causes().some(cause => cause?.includes('an address this scope cannot resolve'))).to.equal(true)
    })

    const errorsOnly = () => {
      const seen: string[] = []
      return {
        seen,
        settings: {
          logger: {
            debug: () => undefined,
            info: () => undefined,
            error: (...args: unknown[]) => seen.push(String((args[1] as { cause?: string })?.cause ?? args[0])),
          },
        },
      }
    }

    it('reports an undeclared read on the ungated channel, once per neighbour per scope', async () => {
      const first = errorsOnly()
      const scope = createScope({ name: 'ungated-read', domains: [reacher, quiet], ...first.settings })

      await scope.emit('reacher.peek')
      await scope.emit('reacher.peek')

      expect(first.seen.filter(cause => cause.includes("reads 'quiet'"))).to.have.length(1)

      const second = errorsOnly()
      const other = createScope({ name: 'ungated-read-2', domains: [reacher, quiet], ...second.settings })
      await other.emit('reacher.peek')

      expect(
        second.seen.filter(cause => cause.includes("reads 'quiet'")),
        'a second scope reports its own',
      ).to.have.length(1)
    })

    it('does not mark a neighbour reported when the guard or a failing logger dropped the line', async () => {
      // Two neighbours, so the report made *during* the first logger call is a different pair from
      // the one that triggered it and cannot be confused with the dedupe.
      const other = defineDomain('otherQuiet' as never, [], {
        state: { n: 0 },
        actions: { touch: reduce({ n: 1 }) },
      } as never)

      let reach: ((domain: string) => unknown) | undefined
      const prober = defineDomain('prober' as never, [], {
        state: { n: 0 },
        actions: {
          go: cmd(async (_input: unknown, ctx: unknown) => {
            const read = (ctx as { read: (d: string) => unknown }).read
            reach = read
            read('quiet')
            return 0
          }),
        },
      } as never)

      const seen: string[] = []
      let reentered = false
      let failNext = false

      const scope = createScope({
        name: 'reentrant-logger',
        domains: [prober, quiet, other] as never,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          error: (...args: unknown[]) => {
            if (failNext) {
              failNext = false
              throw new Error('logger is having a moment')
            }
            seen.push(String((args[1] as { cause?: string })?.cause ?? args[0]))
            if (!reentered) {
              // Synchronously, inside the logger: this second report meets the re-entrancy guard.
              reentered = true
              reach?.('otherQuiet')
            }
          },
        },
      } as never)

      const reportsForOther = () => seen.filter(cause => cause.includes("reads 'otherQuiet'")).length

      await (scope.emit as (a: string) => Promise<unknown>)('prober.go')
      expect(reportsForOther(), 'the re-entrant report was dropped by the guard').to.equal(0)

      // Dropped again, this time because the logger threw rather than because of the guard.
      failNext = true
      reach?.('otherQuiet')
      expect(reportsForOther(), 'a throwing logger delivers nothing either').to.equal(0)

      reach?.('otherQuiet')
      expect(reportsForOther(), 'and it is reported once the channel works, not silenced forever').to.equal(1)

      reach?.('otherQuiet')
      expect(reportsForOther(), 'then deduplicated, because the first report carried it').to.equal(1)
    })

    it('keeps reporting to a sink whose failure it cannot see', async () => {
      const asyncOther = defineDomain('asyncQuiet' as never, [], {
        state: { n: 0 },
        actions: { touch: reduce({ n: 1 }) },
      } as never)

      let reach: ((domain: string) => unknown) | undefined
      const prober = defineDomain('asyncProber' as never, [], {
        state: { n: 0 },
        actions: {
          go: cmd(async (_input: unknown, ctx: unknown) => {
            reach = (ctx as { read: (d: string) => unknown }).read
            return 0
          }),
        },
      } as never)

      let calls = 0
      const scope = createScope({
        name: 'async-logger',
        domains: [prober, asyncOther] as never,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          // A sink that reports asynchronously: eddy cannot know whether this settled.
          error: () => {
            calls += 1
            return Promise.reject(new Error('sink failed later'))
          },
        },
      } as never)

      await (scope.emit as (a: string) => Promise<unknown>)('asyncProber.go')

      reach?.('asyncQuiet')
      reach?.('asyncQuiet')

      expect(calls, 'not deduplicated into permanent silence').to.equal(2)
    })

    it('throws for a wire naming an action its declared neighbour does not have', () => {
      const target = defineDomain('wireTarget' as never, [], { state: { n: 0 }, actions: { real: reduce({ n: 1 }) } })
      const typo = defineDomain(
        'wireTypo' as never,
        ['wireTarget'] as never,
        {
          state: { n: 0 },
          actions: { noop: reduce({}) },
          on: { 'wireTarget.rael': reduce({ n: 1 }) },
        } as never,
      )

      expect(() => createScope({ name: 'wire-typo', domains: [target, typo] as never })).to.throw(/wireTarget\.rael/)
    })

    for (const [label, wires, hosted] of [
      ["the domain's own missing action", { on: { 'selfWire.og': reduce({ n: 1 }) } }, false],
      [
        "an outcome of the domain's own pure action",
        { effects: { 'selfWire.go.done': effect(() => undefined) } },
        false,
      ],
      ['a hosted neighbour it does not declare', { on: { 'wireTarget.rael': reduce({ n: 1 }) } }, true],
    ] as const) {
      it(`throws for a wire naming ${label}, since that domain is hosted`, () => {
        const target = defineDomain('wireTarget' as never, [], { state: { n: 0 }, actions: { real: reduce({ n: 1 }) } })
        const own = defineDomain('selfWire' as never, [], {
          state: { n: 0 },
          actions: { go: reduce({ n: 2 }) },
          ...wires,
        } as never)

        expect(() => createScope({ name: 'self-wire', domains: (hosted ? [target, own] : [own]) as never })).to.throw(
          /Unable to create scope 'self-wire': domain 'selfWire' declares '(on|effects)' for '/,
        )
      })
    }

    it('still hosts a blueprint whose wire names a domain this scope does not have', () => {
      const { seen, settings } = errorsOnly()
      const blueprint = defineDomain('blueprint' as never, [], {
        state: { n: 0 },
        actions: { noop: reduce({}) },
        on: { 'absent.thing': reduce({ n: 1 }) },
      } as never)

      const scope = createScope({ name: 'blueprint-scope', domains: [blueprint] as never, ...settings })

      expect(scope.read('blueprint' as never)).to.not.equal(undefined)
      expect(seen.some(cause => cause.includes('cannot resolve'))).to.equal(true)
    })

    it('reports a registration made after disposal on the ungated channel', () => {
      const { seen, settings } = errorsOnly()
      const scope = createScope({ name: 'ungated-dispose', domains: [quiet], ...settings })
      scope.dispose()

      const off = scope.subscribe(() => undefined)

      expect(typeof off).to.equal('function')
      expect(seen.some(cause => cause.includes('after disposal'))).to.equal(true)
    })

    it('names a preloaded key that no hosted domain answers to, and still ignores it', () => {
      const scope = createScope({
        name: 'preload-named',
        domains: [upload],
        preloadedState: { hydrtaed: { files: 99 } } as never,
        ...recording(),
      })

      expect(scope.read('upload').files).to.equal(0)
      expect(causes().some(cause => cause?.includes("names 'hydrtaed'"))).to.equal(true)
    })
  })

  describe('onAction', () => {
    const probe = () => {
      const seen: DispatchedAction[] = []
      const scope = createScope({ domains: [cart, session] as const, onAction: a => seen.push(a) })
      return { seen, scope: scope as unknown as Scope<'cart' | 'session'> }
    }

    it('sees every action, in order, stamped', async () => {
      const { seen, scope } = probe()
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(seen.map(a => a.type)).to.deep.equal(['cart.add', 'cart.add.done'])
      expect(seen.every(a => typeof a.__seq === 'number' && a.__seq > 0)).to.equal(true)

      expect(seen[1].result).to.have.property('sku', 'SKU-1')
    })

    it('fires before the fold, not after', async () => {
      const at: boolean[] = []
      const scope = createScope({
        domains: [cart, session] as const,
        onAction: () => at.push((scope as never as Scope<'cart'>).read('cart').pending),
      })

      await (scope as never as Scope<'cart'>).emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(at[0]).to.equal(false)
    })

    it('does not fire for a disposed scope', async () => {
      const { seen, scope } = probe()
      scope.dispose()
      await scope.emit('cart.clear').catch(() => undefined)
      expect(seen).to.have.length(0)
    })

    it('cannot be attached after construction', async () => {
      const options: {
        domains: readonly [typeof cart, typeof session]
        onAction?: (a: DispatchedAction) => void
      } = {
        domains: [cart, session] as const,
      }
      const scope = createScope(options) as unknown as Scope<'cart'>

      const late: string[] = []
      options.onAction = a => late.push(a.type)

      await scope.emit('cart.clear')
      expect(late).to.have.length(0)
    })

    it('a throwing observer does not stop the fold, and is reported', async () => {
      const errors: unknown[] = []
      const scope = createScope({
        onUnhandledError: error => errors.push(error),
        domains: [cart, session] as const,
        onAction: () => {
          throw new Error('observer exploded')
        },
      }) as unknown as Scope<'cart'>

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(scope.read('cart').items).to.have.length(1)
      expect((errors[0] as Error).message).to.equal('observer exploded')
    })

    it('an asynchronously rejecting observer is reported too', async () => {
      const errors: unknown[] = []
      const scope = createScope({
        onUnhandledError: error => errors.push(error),
        domains: [cart, session] as const,
        onAction: (() => Promise.reject(new Error('observer rejected'))) as () => void,
      }) as unknown as Scope<'cart'>

      await scope.emit('cart.clear')
      await flush(5)

      expect(scope.read('cart').items).to.have.length(0)
      expect((errors[0] as Error).message).to.equal('observer rejected')
    })

    it('an observer cannot rewrite the action that folds', async () => {
      const scope = createScope({
        domains: [cart, session] as const,
        onAction: action => {
          Object.assign(action, { type: 'cart.clear', input: { sku: 'HACKED', qty: 99 } })
        },
      }) as unknown as Scope<'cart'>

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(scope.read('cart').items.map(i => i.sku)).to.deep.equal(['SKU-1'])
    })

    it('the error handler cannot rewrite the action either, nor veto the fold by throwing', async () => {
      const scope = createScope({
        onUnhandledError: (_error, action) => {
          Object.assign(action ?? {}, { type: 'cart.clear' })
          throw new Error('the reporter exploded too')
        },
        domains: [cart, session] as const,
        onAction: () => {
          throw new Error('observer exploded')
        },
      }) as unknown as Scope<'cart'>

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(scope.read('cart').items.map(i => i.sku)).to.deep.equal(['SKU-1'])
    })
  })

  describe('createTestScope composes onAction', () => {
    it('records first, so a caller observer already sees the action', async () => {
      const at: number[] = []
      const scope = createTestScope({
        domains: [cart, session],
        onAction: () => at.push(scope.actions().length),
      })

      await scope.emit('cart.clear')

      expect(at).to.deep.equal([1])
    })

    it('forwards a rejecting caller observer to the error handler', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({
        onUnhandledError: error => errors.push(error),
        domains: [cart, session],
        onAction: (() => Promise.reject(new Error('caller observer rejected'))) as () => void,
      })

      await scope.emit('cart.clear')
      await flush(5)

      expect((errors[0] as Error).message).to.equal('caller observer rejected')
    })

    it('names an unnamed scope, and forgets what it recorded on clearActions', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.clear')

      expect(scope.name).to.match(/^test-\d+$/)
      expect(scope.actionTypes()).to.deep.equal(['cart.clear'])

      scope.clearActions()
      expect(scope.actions()).to.deep.equal([])

      await scope.emit('cart.clear')
      expect(scope.actionTypes()).to.deep.equal(['cart.clear'])
    })

    for (const times of [3, 5]) {
      it(`flush(${times === 3 ? '' : times}) yields to the host ${times} times`, async () => {
        let turns = 0
        let ticking = true
        const tick = () => {
          if (ticking) {
            turns += 1
            setTimeout(tick, 0)
          }
        }
        setTimeout(tick, 0)

        await (times === 3 ? flush() : flush(times))
        ticking = false

        expect(turns).to.equal(times)
      })
    }

    it('takes the options createScope takes, preloaded state included', () => {
      const scope = createTestScope({ domains: [cart, session], preloadedState: { session: { userId: 'u-1' } } })

      expect(scope.read('session').userId).to.equal('u-1')
    })
  })

  describe('addressing', () => {
    const define = (name: string) =>
      defineDomain(name as never, [], {
        state: { n: 0 },
        actions: { bump: reduce({ n: 1 }) },
      })

    it('refuses a domain name that is not a plain identifier, and names it', () => {
      expect(() => define('we.ird')).to.throw(/Unable to define domain 'we\.ird'/)
      expect(() => define('we.ird')).to.throw(/must be a plain identifier/)
    })

    it('refuses the empty string as a domain name', () => {
      expect(() => define('')).to.throw(/Unable to define domain ''/)
    })

    it("refuses '__proto__' as a domain name, which the definition is the last place to blame", () => {
      expect(() => define('__proto__')).to.throw(/Unable to define domain '__proto__'/)
      expect(() => define('__proto__')).to.throw(/replaces the prototype/)
    })

    for (const [label, actions, arrived] of [
      ['missing', undefined, 'nothing'],
      ['null', null, 'null'],
      ['a string', 'bump', 'a string'],
      ['a number', 0, 'a number'],
      ['false', false, 'a boolean'],
      ['an array', [], 'an array'],

      ['a function', () => undefined, 'a function'],
    ] as const) {
      it(`refuses an actions map that is ${label}, naming the domain and what arrived`, () => {
        expect(() => defineDomain('maplessDefine' as never, [], { state: { n: 0 }, actions } as never)).to.throw(
          `Unable to define domain 'maplessDefine': 'actions' must be an object of action declarations, but ${arrived} arrived`,
        )
      })
    }

    for (const [label, state, arrived] of [
      ['a number', 42, 'a number'],
      ['a string', 'abc', 'a string'],
      ['null', null, 'null'],
      ['an array', [1, 2], 'an array'],
      ['a factory returning a number', () => 42, 'a number'],

      ['a Date', new Date(0), 'a Date'],
      ['a Map', new Map(), 'an instance of Map'],
      ['a Set', new Set(), 'an instance of Set'],
      ['a RegExp', /x/, 'an instance of RegExp'],
    ] as const) {
      it(`refuses a seed that is ${label}, rather than spreading it into fields`, () => {
        const def = defineDomain('primitiveSeed' as never, [], { state, actions: {} } as never)
        expect(() => createScope({ name: `primitive-${label}`, domains: [def] as never })).to.throw(
          `Unable to seed domain 'primitiveSeed': state must be a plain object of fields, but ${arrived} arrived`,
        )
      })
    }

    it('still accepts the unusual objects that work — empty, and null-prototype', () => {
      expect(() => defineDomain('emptyActions' as never, [], { state: { n: 0 }, actions: {} } as never)).not.to.throw()
      expect(() =>
        defineDomain('bareActions' as never, [], {
          state: { n: 0 },
          actions: Object.assign(Object.create(null), { bump: reduce({ n: 1 }) }),
        } as never),
      ).not.to.throw()
    })

    it('refuses a declaration that lands on the actions object’s prototype, where no lookup reads', () => {
      expect(() =>
        defineDomain('literalProto' as never, [], {
          state: { n: 0 },
          actions: { __proto__: reduce({ n: 1 }) } as never,
        }),
      ).to.throw(/the 'actions' object's prototype carries enumerable properties/)

      expect(() =>
        defineDomain('inheritedAction' as never, [], {
          state: { n: 0 },
          actions: Object.assign(Object.create({ bump: reduce({ n: 1 }) }), { other: reduce({ n: 2 }) }) as never,
        }),
      ).to.throw(/the 'actions' object's prototype carries enumerable properties/)
    })

    it('refuses the same shape on `on`, where the dispatch-time guards would otherwise be the only defence', () => {
      expect(() =>
        defineDomain('onLiteralProto' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
          on: { __proto__: reduce({ n: 2 }) } as never,
        }),
      ).to.throw(/the 'on' object's prototype carries enumerable properties/)

      expect(() =>
        defineDomain('onInheritedEntry' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
          on: Object.assign(Object.create({ 'other.thing': reduce({ n: 2 }) }), {}) as never,
        }),
      ).to.throw(/the 'on' object's prototype carries enumerable properties/)
    })

    it('refuses the same shape on `views`, which shares the gap with `on`', () => {
      expect(() =>
        defineDomain('viewsLiteralProto' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
          views: {
            __proto__: view(
              () => 0,
              (n: number) => n,
            ),
          } as never,
        }),
      ).to.throw(/the 'views' object's prototype carries enumerable properties/)
    })

    it('refuses the same shape on `watch`, which shares the gap too', () => {
      expect(() =>
        defineDomain('watchLiteralProto' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
          watch: {
            __proto__: watch(
              () => 0,
              () => {},
            ),
          } as never,
        }),
      ).to.throw(/the 'watch' object's prototype carries enumerable properties/)
    })

    it('reads the immediate prototype only, so nothing else in the process can veto a definition', async () => {
      Object.defineProperty(Object.prototype, 'polluted', {
        value: 1,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      try {
        const plain = defineDomain('plainLiteral' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
        })
        const scope = createScope({ name: 'polluted', domains: [plain] }) as unknown as {
          emit: (type: string) => Promise<unknown>
          read: (name: string) => { n: number }
        }
        await scope.emit('plainLiteral.bump')
        expect(scope.read('plainLiteral').n).to.equal(1)
      } finally {
        delete (Object.prototype as Record<string, unknown>).polluted
      }
    })

    it('accepts an actions object that is merely shaped unusually, having nothing unreachable in it', async () => {
      const quiet = defineDomain('quietProto' as never, [], {
        state: { n: 0 },
        actions: Object.assign(Object.create(Object.defineProperty({}, 'helper', { value: 1 })), {
          bump: reduce({ n: 1 }),
        }) as never,
      })

      const foreign = runInNewContext('({})') as Record<string, unknown>
      foreign.bump = reduce({ n: 1 })
      const crossRealm = defineDomain('crossRealm' as never, [], {
        state: { n: 0 },
        actions: foreign as never,
      })

      const scope = createScope({ name: 'shapes', domains: [quiet, crossRealm] }) as unknown as {
        emit: (type: string) => Promise<unknown>
        read: (name: string) => { n: number }
      }
      await scope.emit('quietProto.bump')
      await scope.emit('crossRealm.bump')
      expect(scope.read('quietProto').n).to.equal(1)
      expect(scope.read('crossRealm').n).to.equal(1)
    })

    it("keeps the near misses working: 'constructor' as a name, and a computed '__proto__' as an action", async () => {
      const near = defineDomain('constructor' as never, [], {
        state: { n: 0 },

        actions: { constructor: reduce({ n: 1 }), ['__proto__']: reduce({ n: 2 }) },
      })
      const scope = createScope({ name: 'near', domains: [near] }) as unknown as {
        emit: (type: string) => Promise<unknown>
        read: (name: string) => { n: number }
      }

      await scope.emit('constructor.constructor')
      expect(scope.read('constructor').n).to.equal(1)
      await scope.emit('constructor.__proto__')
      expect(scope.read('constructor').n).to.equal(2)
    })

    it('observes a hosted outcome address', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []
      scope.on('cart.add.done', action => seen.push(action.result.id))

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(seen).to.deep.equal(['item-1'])
    })

    it('refuses an address for a domain the scope does not host', () => {
      const scope = createTestScope({ domains: [cart, session] })
      expect(() => scope.on('upload.pick' as never, () => undefined)).to.throw(/is not hosted here/)
    })

    it('refuses an unknown action on a hosted domain', () => {
      const scope = createTestScope({ domains: [cart, session] })
      expect(() => scope.on('cart.nope' as never, () => undefined)).to.throw(/declares no such action/)
    })

    it('refuses an outcome of a pure action, which is never dispatched', () => {
      const scope = createTestScope({ domains: [cart, session] })
      expect(() => scope.on('cart.clear.done' as never, () => undefined)).to.throw(/is a pure action/)
    })

    it('refuses an address naming a prototype property rather than registering a listener', () => {
      const scope = createTestScope({ domains: [cart, session] })
      for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
        expect(() => scope.on(`cart.${name}` as never, () => undefined), name).to.throw(/declares no such action/)
      }
    })
  })

  describe('cross-domain', () => {
    it('folds a neighbour action into its own slice', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()
      expect(scope.read('cart').items).to.have.length(1)

      await scope.emit('session.signOut')

      expect(scope.read('cart').items).to.have.length(0)
      expect(scope.read('session').userId).to.equal(null)
    })

    it('runs an effect declared against a neighbour outcome', async () => {
      const scope = createTestScope({ domains: [cart, session, audit] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 3 })
      await flush()

      expect(observed.added).to.deep.equal(['SKU-1:item-1'])
    })

    it('an effect sees a typed failure', async () => {
      const scope = createTestScope({ domains: [cart, session, audit] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 0 }).catch(() => undefined)
      await flush()

      expect(observed.failures[0]).to.contain('qty must be at least 1')
    })

    it('ctx.read reaches a neighbour', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('session.signIn', { email: 'a@b.c' })
      await flush()
      expect(await scope.emit('cart.checkout')).to.match(/^order-/)
    })

    it('cannot be given an unhosted neighbour to read in the first place', () => {
      expect(() => createTestScope({ domains: [cart] })).to.throw(
        /domain 'cart' declares neighbour 'session', which this scope does not host/,
      )

      const scope = createTestScope({ domains: [cart, session] })
      expect(() => scope.read('upload' as never)).to.throw(/the domain is not hosted here/)
    })
  })

  describe('watchers', () => {
    // The source reads declared neighbours, and a neighbour moving re-reads it. Without the
    // second half a foreign-only source would never run — 4 of 23 real watchers have that shape.
    it('re-reads its source when a declared neighbour moves, not only its own domain', async () => {
      const seen: string[] = []
      const foreign = defineDomain('reader', ['session'], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          signedIn: watch(
            (_own, read) => read('session').userId !== null,
            next => {
              seen.push(String(next))
            },
          ),
        },
      })
      const scope = createTestScope({ domains: [foreign, session] })

      await scope.emit('session.signIn', { email: 'a@b.c' })
      await flush()
      expect(seen, 'a neighbour moving is now a trigger').to.deep.equal(['true'])

      await scope.emit('session.signOut')
      await flush()
      expect(seen).to.deep.equal(['true', 'false'])
    })

    it('re-reads on a neighbour move and stays silent when the derived value did not change', async () => {
      let reads = 0
      let handlerRuns = 0
      const quiet = defineDomain('reader', ['session'], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          signedIn: watch(
            (_own, read) => {
              reads += 1
              return read('session').userId !== null
            },
            () => {
              handlerRuns += 1
            },
          ),
        },
      })
      const scope = createTestScope({ domains: [quiet, session] })

      await scope.emit('session.signIn', { email: 'a@b.c' })
      await flush()
      const afterFirst = reads

      // The neighbour genuinely moves again — a different user — and the derived boolean does not.
      await scope.emit('session.signIn', { email: 'b@c.d' })
      await flush()

      expect(reads, 'the source is re-read on the neighbour move').to.be.greaterThan(afterFirst)
      expect(handlerRuns, 'and the handler is not run twice for one value').to.equal(1)
    })

    it('does not run for a domain it neither hosts nor declares', async () => {
      const runs: string[] = []
      const unrelated = defineDomain('reader', [], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          own: watch(
            state => state.n,
            next => {
              runs.push(String(next))
            },
          ),
        },
      })
      const scope = createTestScope({ domains: [unrelated, session] })

      await scope.emit('session.signIn', { email: 'a@b.c' })
      await flush()

      expect(runs, 'an undeclared domain moving is not a trigger').to.deep.equal([])
    })

    // The handler's third argument is `effect`'s context, not a second surface.
    it('reads a neighbour through the context, at the moment its own domain changes', async () => {
      const seen: Array<string | null> = []
      const reader = defineDomain('reader', ['session'], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          n: watch(
            state => state.n,
            (_next, _previous, ctx) => {
              seen.push(ctx.read('session').userId)
            },
          ),
        },
      })
      const scope = createTestScope({ domains: [reader, session] })

      await scope.emit('session.signIn', { email: 'a@b.c' })
      await scope.emit('reader.bump')
      await flush()

      expect(seen, 'the neighbour is read as it stands when this domain moved').to.deep.equal(['user-a@b.c'])
    })

    it('does not fire when only the neighbour moved — the context consults, it does not trigger', async () => {
      const runs: number[] = []
      const consulting = defineDomain('reader', ['session'], {
        state: () => ({ n: 0 }),
        actions: { bump: reduce(state => ({ n: state.n + 1 })) },
        watch: {
          n: watch(
            state => state.n,
            next => {
              runs.push(next)
            },
          ),
        },
      })
      const scope = createTestScope({ domains: [consulting, session] })

      await scope.emit('session.signIn', { email: 'd@e.f' })
      await scope.emit('session.signOut')
      await flush()

      expect(runs, 'a neighbour moving is not a trigger').to.deep.equal([])
    })

    // This is the first case to attack, and dedup does not bound it: the
    // emitted action moves the very value being watched, so `isEqual` never sees an unchanged one
    // and the watcher fires on every fold. `CASCADE_LIMIT` is the only bound, and it is reached.
    // Pinned as it behaves rather than as it was assumed, because the difference is the hazard.
    it('can run away when it emits an action that moves its own watched value', async () => {
      const reported: unknown[] = []
      const scope = createTestScope({
        domains: [selfEmitting],
        onUnhandledError: error => reported.push(error),
      })

      await scope.emit('selfEmitting.bump').catch(() => undefined)
      await flush()

      expect(scope.inspect().cascades.count, 'only the cascade guard stops it').to.equal(1)
      expect(String((reported[0] as Error).message)).to.match(/more than 10000 actions in one cascade/)
    })

    it('fires on a change, not on arrival', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      expect(observed.emptied).to.deep.equal([])

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()
      expect(observed.emptied).to.deep.equal([false])

      await scope.emit('cart.clear')
      await flush()
      expect(observed.emptied).to.deep.equal([false, true])
    })

    it('a throwing source is reported, does not strand the watchers behind it, and records nothing', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({
        onUnhandledError: error => errors.push(error),
        domains: [flaky],
      })

      await scope.emit('flaky.arm')
      await scope.emit('flaky.bump')
      await flush()

      expect(errors.map(String)).to.deep.equal([
        "Error: Unable to run watcher 'flaky.boom': reading the value it watches failed — source exploded",
        "Error: Unable to run watcher 'flaky.boom': reading the value it watches failed — source exploded",
      ])
      expect((errors[0] as { cause?: Error }).cause?.message).to.equal('source exploded')
      expect(flakyWatched).to.deep.equal(['mirror:false->true'])

      await scope.emit('flaky.disarm')
      await flush()
      expect(flakyWatched).to.deep.equal(['mirror:false->true', 'boom:0->1', 'mirror:true->false'])
    })

    it('does not evaluate a watcher whose own domain did not move', async () => {
      const scope = createTestScope({ domains: [flaky, audit, cart, session] })

      const seeded = flakySources.count

      await scope.emit('audit.note', { what: 'x' })
      await flush()

      expect(scope.read('audit').seen).to.deep.equal(['x'])
      expect(flakySources.count).to.equal(seeded)
      expect(flakyWatched).to.deep.equal([])
    })

    it('a field a later stage restored notifies nobody and evaluates no watcher', async () => {
      const scope = createTestScope({ domains: [restore] })
      const seeded = restoreSources.count

      let notified = 0
      scope.subscribe(() => {
        notified += 1
      })

      await scope.emit('restore.round')
      await flush()

      expect(scope.read('restore').n).to.equal(0)
      expect(notified).to.equal(0)
      expect(restoreSources.count).to.equal(seeded)
    })

    it('a throwing subscriber does not stop the watchers or the effects behind it', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({
        onUnhandledError: error => errors.push(error),
        domains: [flaky],
      })

      const seen: string[] = []
      scope.on('flaky.bump', () => {
        seen.push('listener')
      })
      scope.subscribe(() => {
        throw new Error('subscriber exploded')
      })

      await scope.emit('flaky.bump')
      await flush()

      expect(errors.map(String)).to.deep.equal(['Error: subscriber exploded'])
      expect(flakyWatched).to.deep.equal(['boom:0->1'])
      expect(seen).to.deep.equal(['listener'])
    })
  })

  describe('addressing — length and action keys', () => {
    const define = (name: string, action = 'bump') =>
      defineDomain(name as never, [], {
        state: { n: 0 },
        actions: { [action]: reduce({ n: 1 }) } as never,
      })

    it('refuses an action key that is not a plain identifier', () => {
      expect(() => define('cart', 'we.ird')).to.throw(/action 'we.ird' must be a plain identifier/)
    })
  })

  describe('a scope fixes its declaration properties at construction', () => {
    const define = (name: string) =>
      defineDomain(name as never, [], {
        state: { n: 0 },
        actions: { bump: reduce({ n: 1 }) },
      })

    it('does not see the actions property replaced after the scope was built', async () => {
      const def = define('swapActions')
      const scope = createScope({ name: 'swap-1', domains: [def] as never })

      Object.defineProperty(def, 'actions', { value: { ...def.actions, extra: reduce({ n: 99 }) }, writable: true })

      await rejects(
        (scope.emit as (a: string) => Promise<unknown>)('swapActions.extra'),
        /domain 'swapActions' declares no such action/,
      )
      expect(() => scope.on('swapActions.extra' as never, () => undefined)).to.throw(/declares no such action/)
    })

    it('does not let a throwing accessor installed after construction reach a dispatch', async () => {
      const def = define('poisonActions')
      const scope = createScope({ name: 'swap-2', domains: [def] as never })

      Object.defineProperty(def, 'actions', {
        get() {
          throw new Error('the definition was poisoned after the scope was built')
        },
      })

      await (scope.emit as (a: string) => Promise<unknown>)('poisonActions.bump')
      expect((scope.read('poisonActions' as never) as { n: number }).n).to.equal(1)
    })

    it('copies the map, so mutating the definition afterwards is not seen either', async () => {
      const def = define('mutateActions')
      const scope = createScope({ name: 'swap-3', domains: [def] as never })

      ;(def.actions as Record<string, unknown>).extra = reduce({ n: 99 })

      await rejects(
        (scope.emit as (a: string) => Promise<unknown>)('mutateActions.extra'),
        /domain 'mutateActions' declares no such action/,
      )
    })

    it('refuses `latest` beside a `finally` stage, whose cleanup a supersession would strand', () => {
      expect(() =>
        defineDomain('strandedCleanup' as never, [], {
          state: { n: 0 },
          actions: {
            go: cmd(async () => undefined, { latest: true, finally: { n: 1 } }),
          } as never,
        }),
      ).to.throw(/declares both 'latest' and a 'finally' stage/)
    })

    it('accepts either of them alone', () => {
      expect(() =>
        defineDomain('latestOnly' as never, [], {
          state: { n: 0 },
          actions: { go: cmd(async () => undefined, { latest: true }) } as never,
        }),
      ).to.not.throw()

      expect(() =>
        defineDomain('finallyOnly' as never, [], {
          state: { n: 0 },
          actions: { go: cmd(async () => undefined, { finally: { n: 1 } }) } as never,
        }),
      ).to.not.throw()
    })

    it('refuses a symbol-keyed declaration, which no address could ever name', () => {
      const actions: Record<PropertyKey, unknown> = { bump: reduce({ n: 1 }) }
      actions[Symbol('hidden')] = reduce({ n: 2 })

      expect(() =>
        defineDomain('symbolAction' as never, [], {
          state: { n: 0 },
          actions: actions as never,
        }),
      ).to.throw(/declares a symbol key/)
    })

    it('refuses a non-enumerable watcher, which was stored and then never seeded or run', () => {
      const watchers = {}
      Object.defineProperty(watchers, 'seen', {
        value: watch(
          () => 1,
          () => undefined,
        ),
      })

      expect(() =>
        defineDomain('hiddenWatcher' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
          watch: watchers as never,
        }),
      ).to.throw(/the 'watch' object declares 'seen' as a non-enumerable property/)
    })

    it('refuses a non-enumerable own action, which direct lookup reached and enumeration missed', () => {
      const actions = {}
      Object.defineProperty(actions, 'bump', { value: reduce({ n: 1 }) })

      expect(() =>
        defineDomain('hiddenAction' as never, [], {
          state: { n: 0 },
          actions: actions as never,
        }),
      ).to.throw(/declares 'bump' as a non-enumerable property/)
    })

    it('reads views once, so a later getter answer cannot bypass the seed collision check', () => {
      const def = define('oneShotViews')
      Object.defineProperty(def, 'seed', { value: () => ({ n: 1, doubled: 99 }) })
      let reads = 0
      Object.defineProperty(def, 'views', {
        get() {
          reads += 1
          return reads === 1
            ? {}
            : {
                doubled: view<'whole', number, number>(
                  state => state.n,
                  n => n * 2,
                ),
              }
        },
      })

      const scope = createScope({ name: 'one-shot-views', domains: [def] as never })

      expect(reads).to.equal(1)
      expect((scope.read('oneShotViews' as never) as { doubled: number }).doubled).to.equal(99)
    })

    it('a watchers getter installed after construction cannot make a committed action reject', async () => {
      const def = define('lateWatcherGetter')
      const scope = createScope({ name: 'guard-1', domains: [def] as never })
      let notified = 0
      scope.subscribe(() => {
        notified += 1
      })

      Object.defineProperty(def.watchers, 'boom', {
        enumerable: true,
        get() {
          throw new Error('watcher map getter')
        },
      })

      await (scope.emit as (a: string) => Promise<unknown>)('lateWatcherGetter.bump')
      expect((scope.read('lateWatcherGetter' as never) as { n: number }).n).to.equal(1)
      expect(notified).to.equal(1)
    })

    it('an effects getter installed after construction cannot strand a command invocation', async () => {
      const def = defineDomain('lateEffectGetter' as never, [], {
        state: { n: 0 },
        actions: { go: cmd(async () => 7, { done: { n: 1 } }) } as never,
      })
      const scope = createScope({ name: 'guard-2', domains: [def] as never })

      Object.defineProperty(def.effects, 'lateEffectGetter.go.done', {
        enumerable: true,
        get() {
          throw new Error('effects map getter')
        },
      })

      const settled = await Promise.race([
        (scope.emit as (a: string) => Promise<unknown>)('lateEffectGetter.go').then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise(resolve => setTimeout(() => resolve('pending'), 100)),
      ])

      expect(settled).to.equal('resolved')
      expect((scope.read('lateEffectGetter' as never) as { n: number }).n).to.equal(1)
    })

    it("keeps emit's rejected-promise contract after an action's '$' is poisoned", async () => {
      const go = cmd(async () => {
        throw new Error('handler failed')
      })
      const def = defineDomain('poisonedActionKind' as never, [], {
        state: { n: 0 },
        actions: { go } as never,
      })
      const scope = createScope({ name: 'entry-1', domains: [def] as never })

      Object.defineProperty(go, '$', {
        get() {
          throw new Error("accessor on '$' fired")
        },
      })

      let emitted: Promise<unknown> | undefined
      expect(() => {
        emitted = (scope.emit as (a: string) => Promise<unknown>)('poisonedActionKind.go')
      }).not.to.throw()
      await rejects(emitted!, /handler failed/)
    })

    it("keeps emit's rejected-promise contract after an action's stage record is poisoned", async () => {
      const go = cmd(async () => {
        throw new Error('handler failed')
      })
      const def = defineDomain('poisonedActionStages' as never, [], {
        state: { n: 0 },
        actions: { go } as never,
      })
      const scope = createScope({ name: 'entry-2', domains: [def] as never })

      Object.defineProperty(go.stages, 'latest', {
        get() {
          throw new Error('accessor on stages.latest fired')
        },
      })

      let emitted: Promise<unknown> | undefined
      expect(() => {
        emitted = (scope.emit as (a: string) => Promise<unknown>)('poisonedActionStages.go')
      }).not.to.throw()
      await rejects(emitted!, /handler failed/)
    })

    it('fails construction when an entry field cannot be read', () => {
      const bump = reduce({ n: 1 } as never)
      Object.defineProperty(bump, 'handler', {
        get() {
          throw new Error('entry handler accessor fired')
        },
      })
      const def = defineDomain('poisonedEntryAtBuild' as never, [], {
        state: { n: 0 },
        actions: { bump } as never,
      })

      expect(() => createScope({ name: 'entry-3', domains: [def] as never })).to.throw(/entry handler accessor fired/)
    })

    it('reads a watcher source once at construction and never through the author entry again', async () => {
      const errors: unknown[] = []
      const seen: number[] = []
      let sourceReads = 0
      const watched = watch<any, number>(
        (state: any) => state.n as number,
        (next: number) => {
          seen.push(next)
        },
      )
      Object.defineProperty(watched, 'source', {
        get() {
          sourceReads += 1
          if (sourceReads > 1) {
            throw new Error('watcher source accessor fired again')
          }
          return (state: { n: number }) => state.n
        },
      })
      const def = defineDomain('oneReadWatcherEntry' as never, [], {
        state: { n: 0 },
        actions: { bump: reduce((state: { n: number }) => ({ n: state.n + 1 })) } as never,
        watch: { watched } as never,
      })
      const scope = createScope({
        onUnhandledError: error => errors.push(error),
        name: 'entry-4',
        domains: [def] as never,
      })

      await (scope.emit as (a: string) => Promise<unknown>)('oneReadWatcherEntry.bump')

      expect(sourceReads).to.equal(1)
      expect(seen).to.deep.equal([1])
      expect(errors).to.deep.equal([])
    })

    it('reads a declaration getter once, at construction, where a throw is still loud', () => {
      const def = define('poisonedAtBuild')
      Object.defineProperty(def.watchers, 'boom', {
        enumerable: true,
        get() {
          throw new Error('poisoned before the scope existed')
        },
      })

      expect(() => createScope({ name: 'swap-4', domains: [def] as never })).to.throw(
        /poisoned before the scope existed/,
      )
    })

    for (const [label, plant] of [
      ['a plain key', (actions: Record<string, unknown>) => (actions.junk = 'not a declaration')],
      [
        'a non-enumerable key',
        (actions: Record<string, unknown>) =>
          Object.defineProperty(actions, 'hidden', { value: 'not a declaration', enumerable: false }),
      ],
      [
        'a symbol key',
        (actions: Record<string, unknown>) =>
          Object.defineProperty(actions, Symbol('sneaky'), { value: 'not a declaration', enumerable: true }),
      ],
    ] as const) {
      it(`refuses a declaration slot holding something no wrapper built — ${label}`, () => {
        const def = define('junkDeclaration')
        plant(def.actions as unknown as Record<string, unknown>)

        // Three different mistakes, three different refusals: a key the runtime could never reach
        // is refused by shape, and a reachable key holding a non-declaration by its missing '$'.
        expect(() => createScope({ name: `junk-${label}`, domains: [def] as never })).to.throw(
          /non-enumerable property|declares a symbol key|its '\$' is missing/,
        )
      })
    }

    it('accepts a hand-built command declaration that carries no stages', async () => {
      const def = define('brandedNoStages')
      ;(def.actions as unknown as Record<string, unknown>).bare = { $: 'cmd', handler: async () => 'ok' }

      const scope = createScope({ name: 'branded', domains: [def] as never })
      expect(await (scope.emit as (a: string) => Promise<unknown>)('brandedNoStages.bare')).to.equal('ok')
    })

    for (const [label, entry, slot] of [
      ['a pure action with no handler', { $: 'reduce' }, 'actions'],
      ['a command with no handler', { $: 'cmd' }, 'actions'],
      ['a command whose handler is not callable', { $: 'cmd', handler: 42 }, 'actions'],
      ['a pure action whose handler is null', { $: 'reduce', handler: null }, 'actions'],
    ] as const) {
      it(`refuses ${label}`, () => {
        const def = define('shapeless')
        ;(def.actions as unknown as Record<string, unknown>).bad = entry

        expect(() => createScope({ name: `shape-${label}`, domains: [def] as never })).to.throw(
          new RegExp(`declares 'bad' in '${slot}'`),
        )
      })
    }

    it('refuses a declaration that answers only its brand, however it answers', () => {
      const def = define('proxied')
      ;(def.actions as unknown as Record<string, unknown>).ghost = new Proxy(
        {},
        { get: (_t, property) => (property === '$' ? 'cmd' : undefined) },
      )

      expect(() => createScope({ name: 'proxied', domains: [def] as never })).to.throw(/declares 'ghost'/)
    })

    for (const [slot, options] of [
      ['views', { views: { bad: { $: 'view', input: (s: unknown) => s } } }],
      ['watch', { watch: { bad: { $: 'watch', source: (s: unknown) => s } } }],
      ['effects', { effects: { bad: { $: 'effect' } } }],
      ['on', { on: { 'cart.add': { $: 'reduce' } } }],
    ] as const) {
      it(`refuses a declaration in '${slot}' that does not carry what its kind needs`, () => {
        const def = defineDomain('slotProbe' as never, [], {
          state: { n: 0 },
          actions: { bump: reduce({ n: 1 }) },
          ...options,
        } as never)

        expect(() => createScope({ name: `slot-${slot}`, domains: [def] as never })).to.throw(
          new RegExp(`declares '.*' in '${slot}', but its '.*' is missing`),
        )
      })
    }

    for (const [label, slotValue] of [
      ['null', null],
      ['undefined', undefined],
      ['an array', []],
      ['a function', () => undefined],
      ['a primitive', 7],
    ] as const) {
      it(`refuses a declaration map that is ${label}, naming the scope, the domain and the slot`, () => {
        const def = define('mapless')
        Object.defineProperty(def, 'actions', { value: slotValue, writable: true })

        expect(() => createScope({ name: `mapless-${label}`, domains: [def] as never })).to.throw(
          /Unable to create scope 'mapless-.*': domain 'mapless' declares 'actions' as .*, but it must be an object of declarations/,
        )
      })
    }

    it('names the definition property, not the authoring key, for the slot whose names differ', () => {
      const def = define('watchless')
      Object.defineProperty(def, 'watchers', { value: null, writable: true })

      expect(() => createScope({ name: 'watchless', domains: [def] as never })).to.throw(
        "Unable to create scope 'watchless': domain 'watchless' declares 'watchers' as null, but it must be an object of declarations",
      )
    })

    for (const [label, handler, arrived] of [
      ['an array', [], 'an array'],
      ['a primitive', 42, 'a number'],
      ['a string, which would spread into numbered fields', 'ab', 'a string'],
    ] as const) {
      it(`refuses a pure action whose constant handler is ${label}`, async () => {
        const def = define('oddConstant')
        ;(def.actions as unknown as Record<string, unknown>).odd = { $: 'reduce', handler }

        const scope = createScope({ name: `odd-${label}`, domains: [def] as never })
        const error = await (scope.emit as (a: string) => Promise<unknown>)('oddConstant.odd').then(
          () => undefined,
          (caught: Error) => caught,
        )

        expect(error?.message).to.match(/a stage returns a partial object of fields, or nothing at all/)
        expect(error?.message).to.include(`${arrived} arrived`)
      })
    }

    it('lets the state contract refuse a retired built-in as a constant, naming what to carry instead', async () => {
      const def = define('dateConstant')
      ;(def.actions as unknown as Record<string, unknown>).odd = { $: 'reduce', handler: new Date(0) }

      const scope = createScope({ name: 'date-constant', domains: [def] as never })
      const error = await (scope.emit as (a: string) => Promise<unknown>)('dateConstant.odd').then(
        () => undefined,
        (caught: Error) => caught,
      )

      // The shape check answers first: a Date is not a partial object of fields either.
      expect(error?.message).to.match(/a stage returns a partial object of fields/)
      expect(error?.message).to.include('a Date arrived')
    })

    it('lets the state contract refuse a null-prototype constant, naming the fold', async () => {
      const def = define('nullProtoConstant')
      ;(def.actions as unknown as Record<string, unknown>).odd = { $: 'reduce', handler: Object.create(null) }

      const scope = createScope({ name: 'null-proto', domains: [def] as never })
      const error = await (scope.emit as (a: string) => Promise<unknown>)('nullProtoConstant.odd').then(
        () => undefined,
        (caught: Error) => caught,
      )

      expect(error?.message).to.match(/a stage returns a partial object of fields/)
      expect(error?.message).to.include('an object with a null prototype arrived')

      expect(error?.message).not.to.match(/reading the state it produced failed/)
      expect((error as Error & { cause?: unknown }).cause).to.equal(undefined)
    })

    it('names the action and the domain when reading the state a stage produced fails', async () => {
      const { proxy, revoke } = Proxy.revocable({ n: 1 }, {})
      const def = define('revokedConstant')
      ;(def.actions as unknown as Record<string, unknown>).odd = { $: 'reduce', handler: proxy }
      revoke()

      const scope = createScope({ name: 'revoked', domains: [def] as never })
      const error = await (scope.emit as (a: string) => Promise<unknown>)('revokedConstant.odd').then(
        () => undefined,
        (thrown: Error) => thrown,
      )

      expect(error?.message).to.match(
        /Unable to fold 'revokedConstant\.odd' into domain 'revokedConstant': reading the state it produced failed — .*revoked/,
      )
      expect((error as Error & { cause?: Error }).cause).to.be.an.instanceOf(TypeError)
    })

    it('contains a read that fails only at the merge, after every earlier read succeeded', async () => {
      const def = define('lateTrap')
      ;(def.actions as unknown as Record<string, unknown>).odd = {
        $: 'reduce',
        handler: new Proxy(
          { n: 1 },
          {
            get(target, property, receiver) {
              if (property === 'n') {
                throw new TypeError('the trap fired at the merge')
              }
              return Reflect.get(target, property, receiver)
            },
          },
        ),
      }

      const scope = createScope({ name: 'late-trap', domains: [def] as never })
      await rejects(
        (scope.emit as (a: string) => Promise<unknown>)('lateTrap.odd'),
        /Unable to fold 'lateTrap\.odd' into domain 'lateTrap': reading the state it produced failed — the trap fired at the merge/,
      )
    })

    it('contains a read that throws something no one can stringify', async () => {
      const thrown = Object.create(null) as object
      const def = define('unspeakable')
      ;(def.actions as unknown as Record<string, unknown>).odd = {
        $: 'reduce',
        handler: new Proxy(
          { n: 1 },
          {
            ownKeys() {
              throw thrown
            },
          },
        ),
      }

      const scope = createScope({ name: 'unspeakable', domains: [def] as never })
      const error = await (scope.emit as (a: string) => Promise<unknown>)('unspeakable.odd').then(
        () => undefined,
        (caught: Error) => caught,
      )

      expect(error?.message).to.match(
        /Unable to fold 'unspeakable\.odd' into domain 'unspeakable': reading the state it produced failed — a value that cannot be described/,
      )
      expect((error as Error & { cause?: unknown }).cause).to.equal(thrown)
    })

    it('contains the same read in a production build, where the development checks are not there', () => {
      expect(
        buildModeProbe(
          `const def = eddy.defineDomain('revokedProd', [], {
             state: () => ({ n: 0 }),
             actions: { bump: eddy.reduce({ n: 1 }) },
           })
           const { proxy, revoke } = Proxy.revocable({ n: 1 }, {})
           def.actions.odd = { $: 'reduce', handler: proxy }
           revoke()
           const scope = eddy.createScope({ domains: [def] })
           scope.emit('revokedProd.odd').then(
             () => console.log('resolved'),
             e => console.log(e.message),
           )`,
          { env: { NODE_ENV: 'production' } },
        ).join(' '),
      ).to.match(
        /Unable to fold 'revokedProd\.odd' into domain 'revokedProd': reading the state it produced failed — .*revoked/,
      )
    })

    for (const [label, message] of [
      ['a number', { value: 42 }],
      ['absent', { value: undefined }],
      [
        'a getter that throws',
        {
          get() {
            throw new Error('the message getter exploded')
          },
        },
      ],
    ] as const) {
      it(`contains a read that throws an Error whose message is ${label}`, async () => {
        const thrown = Object.create(Error.prototype, { message: message as PropertyDescriptor }) as Error
        const def = define('badMessage')
        ;(def.actions as unknown as Record<string, unknown>).odd = {
          $: 'reduce',
          handler: new Proxy(
            { n: 1 },
            {
              ownKeys() {
                throw thrown
              },
            },
          ),
        }

        const scope = createScope({ name: `bad-message-${label}`, domains: [def] as never })
        const error = await (scope.emit as (a: string) => Promise<unknown>)(`badMessage.odd`).then(
          () => undefined,
          (caught: Error) => caught,
        )

        expect(error?.message).to.match(
          /Unable to fold 'badMessage\.odd' into domain 'badMessage': reading the state it produced failed/,
        )
        expect((error as Error & { cause?: unknown }).cause).to.equal(thrown)
      })
    }

    it('reads a definition name once, so an unstable one cannot key the scope under two names', () => {
      let reads = 0
      const unstable = define('placeholderOne')
      Object.defineProperty(unstable, 'name', {
        get() {
          reads += 1
          return reads === 1 ? 'settledName' : 'somethingElse'
        },
      })

      const scope = createScope({ name: 'unstable-name', domains: [unstable] as never })

      expect(reads, 'the name is read exactly once').to.equal(1)
      expect(Object.keys(scope.getState())).to.deep.equal(['settledName'])
      expect(() => (scope.read as (d: string) => unknown)('settledName')).to.not.throw()
    })

    it('refuses a definition whose name is not an identifier, before it is hosted', () => {
      const dotted = define('placeholderTwo')
      Object.defineProperty(dotted, 'name', { value: 'we.ird', writable: true })
      expect(() => createScope({ name: 'dotted', domains: [dotted] as never })).to.throw(
        "Unable to create scope 'dotted': domain name 'we.ird' must be a plain identifier",
      )
    })

    it('refuses a view declared non-enumerably or keyed by a symbol', () => {
      const hidden = define('hiddenView')
      Object.defineProperty(hidden.views, 'hidden', {
        value: { $: 'view', input: (s: { n: number }) => s.n, transform: (n: number) => n * 2 },
        enumerable: false,
      })
      expect(() => createScope({ name: 'hidden-view', domains: [hidden] as never })).to.throw(
        /the 'views' object declares 'hidden' as a non-enumerable property/,
      )

      const symbolled = define('symbolView')
      Object.defineProperty(symbolled.views, Symbol('sv'), {
        value: { $: 'view', input: (s: { n: number }) => s.n, transform: (n: number) => n * 2 },
        enumerable: true,
      })
      expect(() => createScope({ name: 'symbol-view', domains: [symbolled] as never })).to.throw(
        /the 'views' object declares a symbol key/,
      )
    })

    it('refuses a view named __proto__ that arrived as data', () => {
      const def = define('protoView')
      Object.defineProperty(def, 'views', {
        value: { ['__proto__']: { $: 'view', input: (s: { n: number }) => s.n, transform: (n: number) => n * 2 } },
        writable: true,
      })

      expect(() => createScope({ name: 'proto-view', domains: [def] as never })).to.throw(
        /a view must not be named '__proto__'/,
      )
    })

    it('refuses a domain named __proto__ that arrived as data, naming the name', () => {
      const def = define('placeholderThree')
      Object.defineProperty(def, 'name', { value: '__proto__', writable: true })

      expect(() => createScope({ name: 'proto-domain', domains: [def] as never })).to.throw(
        /a domain must not be named '__proto__'/,
      )
    })

    it('never lets host code observe read() and getState() disagreeing, mid-commit', async () => {
      const observed: { live: number; root: number }[] = []
      type Probe = {
        read: (d: string) => { n: number }
        getState: () => Record<string, { n: number }>
        emit: (a: string) => Promise<unknown>
      }
      let scope: Probe | undefined

      const probe = new Proxy(
        { v: 2 },
        {
          ownKeys(target) {
            if (scope) {
              observed.push({ live: scope.read('tornFirst').n, root: scope.getState().tornFirst.n })
            }
            return Reflect.ownKeys(target)
          },
        },
      )

      const first = defineDomain('tornFirst' as never, [], {
        state: () => ({ n: 0 }),
        actions: { go: reduce({ n: 1 }) },
      } as never)
      const second = defineDomain('tornSecond' as never, [], {
        state: () => ({ bag: { v: 1 } }),
        actions: {},
        on: { 'tornFirst.go': reduce(() => ({ bag: probe })) },
      } as never)

      scope = createScope({ name: 'torn', domains: [first, second] as never }) as unknown as Probe
      await scope.emit('tornFirst.go')

      expect(observed.length, 'the probe must actually have been reached').to.be.greaterThan(0)
      expect(observed.filter(seen => seen.live !== seen.root)).to.deep.equal([])
    })

    it('names the action and the domain when reading the state a view derives from fails', async () => {
      let armed = false
      const def = defineDomain('lateArm' as never, [], {
        state: { n: 0 },
        actions: {
          plant: reduce({
            bag: new Proxy(
              { v: 1 },
              {
                get(target, property, receiver) {
                  if (armed && property === 'v') {
                    throw new TypeError('the trap was armed after the value was accepted')
                  }
                  return Reflect.get(target, property, receiver)
                },
              },
            ),
          } as never),
          bump: reduce((s: { n: number }) => ({ n: s.n + 1 })),
        },
        views: {
          derived: view(
            (s: { bag?: { v?: number } }) => s.bag?.v ?? 0,
            (v: number) => v * 2,
          ),
        },
      } as never)

      const scope = createScope({ name: 'late-arm', domains: [def] as never })
      await (scope.emit as (a: string) => Promise<unknown>)('lateArm.plant')
      armed = true

      await rejects(
        (scope.emit as (a: string) => Promise<unknown>)('lateArm.bump'),
        /Unable to fold 'lateArm\.bump' into domain 'lateArm': reading the state it derives failed — the trap was armed after the value was accepted/,
      )

      expect((scope.read as (d: string) => { n: number })('lateArm').n).to.equal(0)
    })

    it("leaves a reducer's own error alone, which is the author's to answer for", async () => {
      const def = define('authorThrows')
      ;(def.actions as unknown as Record<string, unknown>).odd = {
        $: 'reduce',
        handler: () => {
          throw new Error('the reducer said no')
        },
      }

      const scope = createScope({ name: 'author-throws', domains: [def] as never })
      const error = await (scope.emit as (a: string) => Promise<unknown>)('authorThrows.odd').then(
        () => undefined,
        (caught: Error) => caught,
      )

      expect(error?.message).to.equal('the reducer said no')
      expect((error as Error & { cause?: unknown }).cause).to.equal(undefined)
    })

    it('accepts a pure action whose handler is a constant partial, and folds it', async () => {
      const def = define('constantFold')
      ;(def.actions as unknown as Record<string, unknown>).wipe = reduce({ n: 99 } as never)

      const scope = createScope({ name: 'constant', domains: [def] as never })
      await (scope.emit as (a: string) => Promise<unknown>)('constantFold.wipe')
      expect((scope.read as (d: string) => { n: number })('constantFold').n).to.equal(99)
    })
  })

  describe('action listeners', () => {
    it('drops the internal entry once the last handler for an address unsubscribes', () => {
      const scope = createTestScope({ domains: [cart, session] })
      const handlerA = () => undefined
      const handlerB = () => undefined

      const added: Set<unknown>[] = []
      const originalAdd = Set.prototype.add
      Set.prototype.add = function (this: Set<unknown>, value: unknown) {
        added.push(this)
        return originalAdd.call(this, value)
      } as typeof Set.prototype.add

      try {
        const unsubscribe = scope.on('cart.add', handlerA)
        unsubscribe()
        scope.on('cart.add', handlerB)
      } finally {
        Set.prototype.add = originalAdd
      }

      const [setForA, setForB] = added
      expect(added).to.have.length(2)
      expect(setForA).to.exist
      expect(setForB).to.exist
      expect(setForB).to.not.equal(setForA)
    })

    it('two owners sharing one handler reference keep separate subscriptions', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0
      const shared = () => {
        hits += 1
      }

      const offA = scope.on('cart.add', shared)
      scope.on('cart.add', shared)
      offA()

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()
      expect(hits).to.equal(1)

      let broadcasts = 0
      const sharedSubscriber = () => {
        broadcasts += 1
      }
      const offSubA = scope.subscribe(sharedSubscriber)
      scope.subscribe(sharedSubscriber)
      offSubA()

      await scope.emit('cart.add', { sku: 'SKU-2', qty: 1 })
      await flush()
      expect(broadcasts).to.be.greaterThan(0)
    })

    it('a spent unsubscribe called twice does not unsubscribe a live listener', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0

      const stale = scope.on('cart.add', () => undefined)
      stale()
      scope.on('cart.add', () => {
        hits += 1
      })
      stale()

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      expect(hits).to.equal(1)
    })

    it('a listener registered mid-dispatch does not fire for the action that added it', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const late: string[] = []

      scope.on('cart.clear', () => {
        scope.on('cart.clear', action => late.push(action.type))
      })

      await scope.emit('cart.clear')
      await flush()
      expect(late, 'the listener added during delivery must not see that same action').to.deep.equal([])

      await scope.emit('cart.clear')
      await flush()
      expect(late).to.deep.equal(['cart.clear'])
    })

    it('a listener that unsubscribes an unvisited neighbour does not skip it', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const order: string[] = []
      let offB = () => undefined as void

      scope.on('cart.clear', () => {
        order.push('A')
        offB()
      })
      offB = scope.on('cart.clear', () => {
        order.push('B')
      })

      await scope.emit('cart.clear')
      await flush()
      expect(order, 'B was registered when delivery began, so this action is still B‘s').to.deep.equal(['A', 'B'])
    })

    it('a subscriber that unsubscribes an unvisited neighbour does not skip it', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      const order: string[] = []
      let offB = () => undefined as void

      scope.subscribe(() => {
        order.push('A')
        offB()
      })
      offB = scope.subscribe(() => {
        order.push('B')
      })

      await scope.emit('cart.clear')

      expect(order).to.deep.equal(['A', 'B'])
    })
  })

  describe("observing every action with '*'", () => {
    it('does not deliver to a listener that registered during its own delivery', async () => {
      // Reading the '*' set at delivery time rather than at the pre-fold snapshot passes every
      // other test here, because they all use an exact address.
      const scope = createTestScope({ domains: [cart, session] })
      const late: string[] = []

      scope.on('*', () => {
        scope.on('*', action => late.push(action.type))
      })

      await scope.emit('cart.clear')
      await flush()
      expect(late, 'the listener added during delivery must not see that same action').to.deep.equal([])

      await scope.emit('cart.clear')
      await flush()
      expect(late).to.deep.equal(['cart.clear'])
    })

    it('sees a pure action, and a command at both its call and its outcome', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      scope.on('*', action => seen.push(action.type))

      await scope.emit('cart.clear')
      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(seen).to.deep.equal(['cart.clear', 'cart.add', 'cart.add.done'])
    })

    it('sees a failed command outcome', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      scope.on('*', action => seen.push(action.type))

      await rejects(scope.emit('cart.fail'), /./)
      await flush()

      expect(seen).to.deep.equal(['cart.fail', 'cart.fail.failed'])
    })

    it('does not see an action whose own fold threw, because nothing committed', async () => {
      const errors: unknown[] = []
      const def = defineDomain('foldThrower' as never, [], {
        state: { n: 0 },
        actions: {
          bump: reduce(() => {
            throw new Error('the reducer refused')
          }),
        },
      })
      const scope = createScope({
        domains: [def] as const,
        onUnhandledError: error => errors.push(error),
      }) as unknown as Scope<'cart'>
      const seen: string[] = []

      scope.on('*' as never, (action: DispatchedAction) => seen.push(action.type))

      await rejects((scope.emit as (a: string) => Promise<unknown>)('foldThrower.bump'), /the reducer refused/)
      await flush()

      expect(seen, 'a fold that throws reaches no listener, on any descriptor').to.deep.equal([])

      // Where the failure surfaces is the stage's business, and for a pure action it is the emit
      // promise, not `onUnhandledError`.
      expect(errors, 'a pure action reports through its own rejection').to.deep.equal([])
    })

    it('reads state after the fold, not before it', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const at: number[] = []

      scope.on('*', () => at.push(scope.read('cart').items.length))

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      // `onAction` is the pre-fold seam and would report 0 here; '*' is the post-fold one.
      expect(at[0], 'the call stage already committed its own reducer').to.equal(0)
      expect(at.at(-1), 'the outcome stage sees the item').to.equal(1)
    })

    it('fires even when the fold changed no state', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      await scope.emit('cart.clear')
      await flush()

      scope.on('*', action => seen.push(action.type))
      await scope.emit('cart.clear')
      await flush()

      expect(seen, 'a no-op fold silences subscribe, never on').to.deep.equal(['cart.clear'])
    })

    it('delivers to the exact address before the wildcard', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const order: string[] = []

      scope.on('*', () => order.push('star'))
      scope.on('cart.clear', () => order.push('exact'))

      await scope.emit('cart.clear')
      await flush()

      expect(order, 'specific before general, whatever the registration order was').to.deep.equal(['exact', 'star'])
    })

    it('delivers twice to one handler registered at both', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0
      const both = () => {
        hits += 1
      }

      scope.on('*', both)
      scope.on('cart.clear', both)

      await scope.emit('cart.clear')
      await flush()

      expect(hits, 'two registrations are two subscriptions, as they already are for one address').to.equal(2)
    })

    it('stops on unsubscribe, and a spent unsubscribe is inert', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      const stop = scope.on('*', action => seen.push(action.type))
      await scope.emit('cart.clear')
      await flush()

      stop()
      stop()
      await scope.emit('cart.clear')
      await flush()

      expect(seen).to.deep.equal(['cart.clear'])
    })

    it('looks up a fixed number of listener sets per action, however many are registered', async () => {
      const scope = createTestScope({ domains: [cart, session] })

      const lookups = () => {
        const keys: unknown[] = []
        const original = Map.prototype.get
        Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
          keys.push(key)
          return original.call(this, key)
        } as typeof Map.prototype.get
        try {
          void scope.emit('cart.clear')
        } finally {
          Map.prototype.get = original
        }
        return keys
      }

      scope.on('*', () => undefined)
      const withOne = lookups()

      for (let i = 0; i < 200; i += 1) {
        scope.on('*', () => undefined)
        scope.on('cart.clear', () => undefined)
      }
      const withMany = lookups()

      await flush()

      // The keys, not the count: an implementation that selected listeners by iterating the map
      // would call `get` zero times and pass a count assertion while being O(n). Naming the two keys
      // pins that selection is keyed — the action's own address, then the wildcard — and the
      // equality pins that neither the work nor the order grows with the number of listeners.
      expect(withOne).to.include.members(['cart.clear', '*'])
      expect(withMany, 'selection must stay keyed, and identical, at 401 listeners').to.deep.equal(withOne)
    })

    it('keeps a handler registered at both an address and the wildcard independent', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0
      const both = () => {
        hits += 1
      }

      const offStar = scope.on('*', both)
      scope.on('cart.clear', both)
      offStar()

      await scope.emit('cart.clear')
      await flush()
      expect(hits, 'unsubscribing one registration must not take the other with it').to.equal(1)
    })

    it('does not skip a wildcard neighbour that an earlier wildcard listener unsubscribed', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const order: string[] = []
      let offB = () => undefined as void

      scope.on('*', () => {
        order.push('A')
        offB()
      })
      offB = scope.on('*', () => {
        order.push('B')
      })

      await scope.emit('cart.clear')
      await flush()
      expect(order, 'B was registered when delivery began, so this action is still B‘s').to.deep.equal(['A', 'B'])
    })

    it('does not let a spent wildcard unsubscribe reach a newer wildcard registration', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0

      const stale = scope.on('*', () => undefined)
      stale()
      scope.on('*', () => {
        hits += 1
      })
      stale()

      await scope.emit('cart.clear')
      await flush()
      expect(hits).to.equal(1)
    })

    it('routes a throwing wildcard listener to onUnhandledError without skipping its neighbour', async () => {
      const errors: unknown[] = []
      const scope = createTestScope({ domains: [cart, session], onUnhandledError: error => errors.push(error) })
      const seen: string[] = []

      scope.on('*', () => {
        throw new Error('wildcard listener failed')
      })
      scope.on('*', action => seen.push(action.type))

      await scope.emit('cart.clear')
      await flush()

      expect(seen, 'the neighbour still ran').to.deep.equal(['cart.clear'])
      expect(errors).to.have.lengthOf(1)
      expect(String((errors[0] as Error).message)).to.equal('wildcard listener failed')
    })

    it('refuses registration after disposal the same way an address does', async () => {
      const lines: unknown[][] = []
      const scope = createTestScope({
        domains: [cart, session],
        logger: { debug: () => undefined, info: () => undefined, error: (...args) => lines.push(args) },
      })

      scope.dispose()
      const stop = scope.on('*', () => expect.fail('a disposed scope must not deliver'))

      expect(stop, 'the no-op unsubscriber still comes back').to.be.a('function')
      stop()
      expect(
        lines.some(line => String(line[1] && (line[1] as { cause?: string }).cause).includes("observe '*'")),
        'the refusal is logged rather than silent',
      ).to.equal(true)
    })

    it('is accepted by a scope that hosts nothing, where it simply never fires', async () => {
      const scope = createScope({ name: 'empty', domains: [] })

      const stop = (scope as unknown as { on: (a: string, h: () => void) => () => void }).on('*', () =>
        expect.fail('an empty scope dispatches nothing'),
      )
      expect(stop).to.be.a('function')
      stop()
    })

    it('is stopped by the cascade guard when its listener emits unconditionally', async () => {
      // At one address, a listener has to emit its own action to loop. At '*' it only has to emit
      // anything at all — the same mistake, one line easier to make.
      const errors: unknown[] = []
      const scope = createTestScope({ domains: [cart, session], onUnhandledError: error => errors.push(error) })

      scope.on('*', () => {
        void scope.emit('cart.clear').catch(() => undefined)
      })

      await scope.emit('cart.clear').catch(() => undefined)
      await flush()

      const cascade = errors.find(error => /one cascade/.test(String((error as Error).message)))
      expect(cascade, 'the existing guard catches it; no new mechanism was needed').to.not.equal(undefined)
      expect(scope.inspect().cascades.count, 'and it is counted where a report can find it').to.equal(1)
    })
  })

  describe('observing a list of addresses', () => {
    it('registers every member and removes them all with one unsubscribe', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      const stop = scope.on(['cart.clear', 'session.signOut'], action => seen.push(action.type))

      await scope.emit('cart.clear')
      await scope.emit('session.signOut')
      await flush()
      expect(seen).to.deep.equal(['cart.clear', 'session.signOut'])

      stop()
      await scope.emit('cart.clear')
      await scope.emit('session.signOut')
      await flush()
      expect(seen, 'one unsubscribe covers the whole list').to.deep.equal(['cart.clear', 'session.signOut'])
    })

    it('registers nothing at all when one member is unresolvable', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []
      const handler = (action: DispatchedAction) => seen.push(action.type)

      expect(() => scope.on(['cart.clear', 'cart.nope'] as never, handler)).to.throw(/declares no such action/)

      await scope.emit('cart.clear')
      await flush()
      expect(seen, 'the valid sibling must not be left half-subscribed').to.deep.equal([])
    })

    it('refuses an empty list rather than returning a subscription to nothing', () => {
      const scope = createTestScope({ domains: [cart, session] })

      expect(() => scope.on([], () => undefined)).to.throw(/at least one/)
    })

    it('refuses a hole, so a sparse list cannot subscribe to half of what it named', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      // `Array.prototype.map` skips holes and `for...of` does not, so a validate-then-register pair
      // built from both silently registers the named members and returns an unsubscriber that
      // throws. A hole is not an address.
      const observe = scope.on as (d: unknown, h: (action: DispatchedAction) => void) => () => void
      expect(() => observe(Array(1), () => undefined)).to.throw(/an address must be a string/)
      expect(() => observe([, 'cart.clear'], action => seen.push(action.type))).to.throw(/an address must be a string/)

      await scope.emit('cart.clear')
      await flush()
      expect(seen, 'the named sibling must not be left subscribed either').to.deep.equal([])
    })

    it('registers every indexed member even when the list hands out a shorter iterator', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      // `Array.from` walks `Symbol.iterator`, which the caller's own array can override to yield
      // fewer members than it holds — the same class as the hole above, through a different door.
      const list = ['cart.clear', 'session.signOut']
      Object.defineProperty(list, Symbol.iterator, {
        value: function* () {
          yield this[0]
        },
      })

      scope.on(list as never, (action: DispatchedAction) => seen.push(action.type))

      await scope.emit('cart.clear')
      await scope.emit('session.signOut')
      await flush()
      expect(seen, 'length and indices are the contract, not the iterator').to.deep.equal([
        'cart.clear',
        'session.signOut',
      ])
    })

    it('reads the list length once, so a second answer cannot smuggle a member past the check', () => {
      const scope = createTestScope({ domains: [cart, session] })
      let reads = 0

      // `length` is not a fact when the caller owns the object: a Proxy answers each read
      // separately, and 1-then-0 passes the empty check and then validates nothing at all.
      const list = new Proxy(['cart.nope'], {
        get(target, key, receiver) {
          if (key === 'length') {
            reads += 1
            return reads === 1 ? 1 : 0
          }
          return Reflect.get(target, key, receiver)
        },
      })

      expect(() => scope.on(list as never, () => undefined)).to.throw(/declares no such action/)
      expect(reads, 'one read, so there is one answer to disagree with').to.equal(1)
    })

    it('registers nothing when reading one member shortens the list', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      // Reading `length` per iteration would end the loop after index 0 and register 'cart.clear'
      // while never seeing the invalid member at all.
      const list = ['cart.clear', 'cart.nope']
      Object.defineProperty(list, '0', {
        get() {
          list.length = 1
          return 'cart.clear'
        },
        configurable: true,
      })

      expect(() => scope.on(list as never, (action: DispatchedAction) => seen.push(action.type))).to.throw(
        /an address must be a string/,
      )

      await scope.emit('cart.clear')
      await flush()
      expect(seen, 'the member read before the truncation must not be left subscribed').to.deep.equal([])
    })

    it('leaves no wildcard behind when a later member of the list is unresolvable', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      const seen: string[] = []

      expect(() =>
        scope.on(['*', 'cart.nope'] as never, (action: DispatchedAction) => seen.push(action.type)),
      ).to.throw(/declares no such action/)

      await scope.emit('cart.clear')
      await flush()
      expect(seen, "'*' must not be registered ahead of the member that fails").to.deep.equal([])
    })

    it('does not deduplicate its members', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0

      scope.on(['cart.clear', 'cart.clear'], () => {
        hits += 1
      })

      await scope.emit('cart.clear')
      await flush()
      expect(hits, 'two entries are two registrations, exactly as two calls would be').to.equal(2)
    })

    it('does not let its spent unsubscribe reach a newer registration', async () => {
      const scope = createTestScope({ domains: [cart, session] })
      let hits = 0

      const stale = scope.on(['cart.clear'], () => undefined)
      stale()
      scope.on('cart.clear', () => {
        hits += 1
      })
      stale()

      await scope.emit('cart.clear')
      await flush()
      expect(hits).to.equal(1)
    })

    it('still refuses a non-string, non-list address', () => {
      const scope = createTestScope({ domains: [cart, session] })

      expect(() => (scope.on as (a: unknown, h: () => void) => void)(Symbol('cart.add'), () => undefined)).to.throw(
        /an address must be a string/,
      )
    })
  })

  describe('independence and disposal', () => {
    it('keeps two scopes over the same domain independent', async () => {
      const a = createScope({ name: 'doc-a', domains: [cart, session] })
      const b = createScope({ name: 'doc-b', domains: [cart, session] })

      await a.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      expect(a.read('cart').items).to.have.length(1)
      expect(b.read('cart').items).to.have.length(0)
    })

    it('disposing stops dispatch', async () => {
      const scope = createScope({ name: 'temporary', domains: [cart, session] })
      scope.dispose()

      await rejects(scope.emit('cart.clear'), /disposed/)
    })

    it('lets two scopes share a name, since a name is only a label', () => {
      expect(() => {
        createScope({ name: 'shared-label', domains: [cart, session] })
        createScope({ name: 'shared-label', domains: [cart, session] })
      }).to.not.throw()
    })
  })

  describe('declared neighbours must be hosted', () => {
    it('throws, naming the domain, the neighbour and the scope', () => {
      expect(() => createScope({ name: 'checkout', domains: [cart] })).to.throw(
        /Unable to create scope 'checkout': domain 'cart' declares neighbour 'session', which this scope does not host/,
      )
    })

    it('does not throw when the neighbour is hosted', () => {
      expect(() => createScope({ name: 'both', domains: [cart, session] })).to.not.throw()
    })

    it('is order-independent, because a forward reference is legal', () => {
      expect(() => createScope({ name: 'forward', domains: [cart, session] })).to.not.throw()
      expect(() => createScope({ name: 'backward', domains: [session, cart] })).to.not.throw()
    })

    it('accepts a domain that declares no neighbours, alone', () => {
      expect(() => createScope({ name: 'solo', domains: [session] })).to.not.throw()
      expect(() => createScope({ name: 'empty', domains: [] })).to.not.throw()
    })

    it('accepts mutual neighbours, because this is not a topological sort', () => {
      expect(() => createScope({ name: 'mutual', domains: [mutualA, mutualB] })).to.not.throw()
      expect(() => createScope({ name: 'mutual-reversed', domains: [mutualB, mutualA] })).to.not.throw()
    })

    it('still throws when only one half of a mutual pair is hosted', () => {
      expect(() => createScope({ name: 'half', domains: [mutualA] })).to.throw(
        /domain 'mutualA' declares neighbour 'mutualB', which this scope does not host/,
      )
    })

    it("does not cross-check an effects: wire against the domain's own uses", () => {
      const alpha = (defineDomain as any)('wireAlpha', [], {
        state: () => ({}),
        actions: { noop: reduce({}) },
        effects: { 'nowhere.go': effect(() => undefined) },
      })

      expect(() => createScope({ domains: [alpha] as const })).to.not.throw()
    })

    it("does not cross-check an on: wire against the domain's own uses", () => {
      const beta = (defineDomain as any)('wireBeta', [], {
        state: () => ({}),
        actions: { noop: reduce({}) },
        on: { 'nowhere.go': reduce({}) },
      })

      expect(() => createScope({ domains: [beta] as const })).to.not.throw()
    })

    it('fires an undeclared wire to a hosted domain, which is the half that is not silent', async () => {
      const source = (defineDomain as any)('wireSource', [], {
        state: () => ({}),
        actions: { go: reduce({}) },
      })

      const seen: string[] = []
      const listener = (defineDomain as any)('wireListener', [], {
        state: () => ({ folded: 0 }),
        actions: { noop: reduce({}) },

        on: { 'wireSource.go': reduce((s: { folded: number }) => ({ folded: s.folded + 1 })) },
        effects: { 'wireSource.go': effect(() => void seen.push('effect')) },
      })

      const scope = createScope({ name: 'undeclared-wire', domains: [source, listener] as const })
      await (scope.emit as (a: string) => Promise<unknown>)('wireSource.go')

      expect((scope.read as (d: string) => { folded: number })('wireListener').folded).to.equal(1)
      expect(seen).to.deep.equal(['effect'])
    })
  })

  describe('state seeding', () => {
    it('gives each scope its own copy of a factory seed', async () => {
      const a = createScope({ name: 'seed-a', domains: [cart, session] })
      const b = createScope({ name: 'seed-b', domains: [cart, session] })
      expect(a.read('cart').items).to.not.equal(b.read('cart').items)
    })

    it('gives each scope its own copy of a value seed', async () => {
      const a = createScope({ name: 'seed-value-a', domains: [audit, cart, session] })
      const b = createScope({ name: 'seed-value-b', domains: [audit, cart, session] })

      await a.emit('audit.note', { what: 'only-a' })

      expect(a.read('audit').seen).to.deep.equal(['only-a'])
      expect(b.read('audit').seen).to.deep.equal([])
    })

    it('names the domain and offers a factory when a value seed cannot be cloned', () => {
      expect(() => createScope({ name: 'unclonable-seed', domains: [unclonable] })).to.throw(
        TypeError,
        /Unable to accept the seed for domain 'unclonable'\.onDeposit: a function is not a supported state value/,
      )
    })

    it('rejects a nested class instance in a value seed in development', () => {
      expect(() => createScope({ name: 'wallet-clone', domains: [wallet] })).to.throw(
        TypeError,
        /Unable to accept the seed for domain 'wallet'\.balance: an instance of Money is not a supported state value/,
      )
      expect(new Money(500)).to.be.instanceOf(Money)
    })

    it('exposes written and derived fields through one read', () => {
      const scope = createScope({ name: 'shape', domains: [cart, session] })
      const state: Readonly<Record<keyof CartState, unknown>> = scope.read('cart') as never
      expect(Object.keys(state).sort()).to.deep.equal(
        ['coupon', 'error', 'itemCount', 'items', 'pending', 'skus', 'subtotal', 'tax', 'taxRate', 'total'].sort(),
      )
    })
  })

  describe('preloaded state', () => {
    const item = () => ({ id: 'i1', sku: 'SKU-1', qty: 2, price: 10 })

    it('starts a domain from the preloaded fields, with views recomputed from them', () => {
      const scope = createScope({
        name: 'preload-cart',
        domains: [cart, session],
        preloadedState: { cart: { items: [item()] } },
      })

      expect(scope.read('cart').items).to.have.length(1)

      expect(scope.read('cart').itemCount).to.equal(1)
      expect(scope.read('cart').subtotal).to.equal(20)

      expect(scope.read('cart').taxRate).to.equal(0.2)
      expect(scope.read('session').userId).to.equal(null)
    })

    it('does not read a domain payload through Object.prototype', () => {
      const near = defineDomain('constructor' as never, [], {
        state: { n: 0 },
        actions: { bump: reduce({ n: 1 }) },
      })

      const bare = createScope({ name: 'proto-preload-none', domains: [near] }) as unknown as {
        read: (name: string) => { n: number }
      }
      expect(bare.read('constructor').n).to.equal(0)

      const empty = createScope({ name: 'proto-preload-empty', domains: [near], preloadedState: {} }) as unknown as {
        read: (name: string) => { n: number }
      }
      expect(empty.read('constructor').n).to.equal(0)

      const supplied = createScope({
        name: 'proto-preload-supplied',
        domains: [near],
        preloadedState: { constructor: { n: 9 } } as never,
      }) as unknown as { read: (name: string) => { n: number } }
      expect(supplied.read('constructor').n).to.equal(9)
    })

    // The payload becomes the store's at the top level only. A deep clone would need
    // `structuredClone`, which React Native lacks, and was never what the contract needed; the
    // caller is told not to retain what it hands over.
    it('copies the payload at the top level, and shares what is nested beneath it', async () => {
      const payload = { cart: { items: [item()] } }
      const a = createScope({ name: 'preload-share-a', domains: [cart, session], preloadedState: payload })
      const b = createScope({ name: 'preload-share-b', domains: [cart, session], preloadedState: payload })

      // Top level: one scope writing a key does not reach the other.
      await a.emit('cart.clear')
      expect(a.read('cart').items, 'the writing scope moved').to.deep.equal([])
      expect(b.read('cart').items, 'the other scope did not').to.have.lengthOf(1)

      // Nested: the two scopes hold the same array the caller supplied, by reference.
      const c = createScope({ name: 'preload-share-c', domains: [cart, session], preloadedState: payload })
      const d = createScope({ name: 'preload-share-d', domains: [cart, session], preloadedState: payload })
      expect(c.read('cart').items, 'nested values are shared, as a factory seed shares them').to.equal(
        d.read('cart').items,
      )
    })

    it('refuses a view key, and says the payload set it rather than the seed', () => {
      expect(() =>
        createScope({
          name: 'preload-view',
          domains: [cart, session],
          preloadedState: { cart: { itemCount: 3 } as never },
        }),
      ).to.throw(/the preloaded state for domain 'cart' sets 'itemCount', which is a view/)
    })

    it('names the scope when reading the preload payload is what fails', () => {
      expect(() =>
        createScope({
          name: 'preload-getter',
          domains: [cart, session],
          preloadedState: {
            get cart(): never {
              throw new Error('hydration payload not ready')
            },
          } as never,
        }),
      ).to.throw(
        "Unable to create scope 'preload-getter': reading the preloaded state for domain 'cart' failed — hydration payload not ready",
      )

      const revocable = Proxy.revocable({ cart: { coupon: null } }, {})
      revocable.revoke()

      expect(() =>
        createScope({ name: 'preload-revoked', domains: [cart, session], preloadedState: revocable.proxy as never }),
      ).to.throw(/Unable to create scope 'preload-revoked': reading 'preloadedState' failed — Cannot perform/)
    })

    it('reads the preloadedState option exactly once', () => {
      let reads = 0
      const scope = createScope({
        name: 'preload-once',
        domains: [cart, session],
        get preloadedState(): never {
          reads += 1
          return { cart: { coupon: 'SAVE' } } as never
        },
      })

      expect(reads).to.equal(1)
      expect(scope.read('cart').coupon).to.equal('SAVE')
    })

    it('validates the payload as its own ingress, before the clone', () => {
      expect(() =>
        createScope({
          name: 'preload-bad',
          domains: [cart, session],
          preloadedState: { cart: { coupon: (() => undefined) as never } },
        }),
      ).to.throw(
        TypeError,
        /Unable to accept the preloaded state for domain 'cart'\.coupon: a function is not a supported state value/,
      )

      expect(() =>
        createScope({
          name: 'preload-lossy',
          domains: [cart, session],
          preloadedState: { cart: { error: Object.assign(new Error('nope'), { code: 'ERR_TAG' }) as never } },
        }),
      ).to.throw(/an Error is not a supported state value/)
    })

    it('refuses a payload that is not a plain object, naming the domain and what arrived', () => {
      for (const [payload, arrived] of [
        [null, 'null'],
        [7, 'a number'],
        ['abc', 'a string'],
        [[1, 2], 'an array'],
        [Object.create(null) as object, 'an object with a null prototype'],
        [new Date(), 'a Date'],
      ] as const) {
        expect(() =>
          createScope({ name: 'preload-shape', domains: [upload], preloadedState: { upload: payload as never } }),
        ).to.throw(
          TypeError,
          `Unable to create scope 'preload-shape': the preloaded state for domain 'upload' must be a plain object of written fields, but ${arrived} arrived.`,
        )
      }

      for (const [map, arrived] of [
        [7, 'a number'],
        ['abc', 'a string'],
        [[{ files: 1 }], 'an array'],
        [() => ({}), 'a function'],
      ] as const) {
        expect(() => createScope({ name: 'preload-map', domains: [upload], preloadedState: map as never })).to.throw(
          TypeError,
          `Unable to create scope 'preload-map': 'preloadedState' must be a plain object keyed by domain name, but ${arrived} arrived.`,
        )
      }

      expect(
        createScope({ name: 'preload-null', domains: [upload], preloadedState: null as never }).read('upload').files,
      ).to.equal(0)
    })

    it('refuses a bad payload in production too, because preload is the one ingress from outside', () => {
      expect(
        buildModeProbe(
          `const upload = eddy.defineDomain('upload', [], {
             state: () => ({ files: 0, progress: 0 }),
             actions: { pick: eddy.reduce(s => ({ files: s.files + 1 })) },
           })
           try {
             eddy.createScope({ domains: [upload], preloadedState: { upload: 'abc' } })
             console.log('SPREAD')
           } catch (error) {
             console.log('REFUSED:' + (error.message.includes('a plain object of written fields') ? 'shape' : 'other'))
           }`,
          { env: { NODE_ENV: 'production' } },
        ),
      ).to.deep.equal(['REFUSED:shape'])
    })

    it('hands back a copy, so persisting state cannot edit it', async () => {
      const scope = createScope({
        name: 'written-copy',
        domains: [cart, session, upload],
        preloadedState: { cart: { items: [{ id: 'i1', sku: 'MUG-1', price: 5, qty: 2 }] } },
      })

      const saved = scope.getWrittenState()
      ;(saved.cart.items as { qty: number }[])[0].qty = 99
      ;(saved.upload as { files: number }).files = 40

      expect(scope.read('cart').items[0].qty, 'the fold owns that object, not the caller').to.equal(2)
      expect(scope.read('cart').subtotal).to.equal(10)

      await scope.emit('upload.pick', { count: 1 })
      expect(scope.read('upload').files, 'and a later action does not publish the edit').to.equal(1)
    })

    // The clone is written over supported state rather than delegated to `structuredClone`, which
    // refuses a proxy through internal slots no library code can see. A transparent proxy over a
    // plain object is inside the supported space by every check made of it, so it is carried out as
    // the plain data it holds — and the caller still cannot reach committed state through what it
    // was handed.
    it('carries a proxy over a plain object out as plain data, aliasing nothing', async () => {
      const proxied = defineDomain('proxied' as never, [], {
        state: { holder: {} as Record<string, unknown> },
        actions: { put: reduce(() => ({ holder: new Proxy({ n: 1 }, {}) })) },
      } as never)

      const scope = createScope({ name: 'proxied-state', domains: [proxied] as never })
      await (scope.emit as (a: string) => Promise<unknown>)('proxied.put')

      const written = (
        scope as unknown as { getWrittenState: () => Record<string, { holder: unknown }> }
      ).getWrittenState()

      expect(written.proxied.holder).to.deep.equal({ n: 1 })
      expect(Object.getPrototypeOf(written.proxied.holder as object)).to.equal(Object.prototype)
      expect(written.proxied.holder, 'the handed-out copy is not the object state holds').to.not.equal(
        (scope as unknown as { read: (d: string) => { holder: unknown } }).read('proxied').holder,
      )
    })

    it('round-trips getWrittenState through preloadedState, which getState cannot', async () => {
      // `cart` has views, which is what makes the round trip a real question.
      const first = createScope({
        name: 'round-trip',
        domains: [cart, session, upload],
        preloadedState: { upload: { files: 2 }, cart: { items: [{ id: 'i1', sku: 'MUG-1', price: 5, qty: 2 }] } },
      })
      await first.emit('upload.pick', { count: 3 })

      const saved = first.getWrittenState()
      expect(Object.hasOwn(saved.cart, 'subtotal'), 'no view key survives the read').to.equal(false)

      const second = createScope({
        name: 'round-trip-2',
        domains: [cart, session, upload],
        preloadedState: saved,
      })
      expect(second.read('upload').files).to.equal(5)
      expect(second.read('cart').items).to.have.length(1)
      expect(second.read('cart').subtotal, 'the view recomputes from what was written').to.equal(10)

      // The cast is the point: `getState()` does not type-check into `preloadedState` either, and a
      // consumer who casts past that meets the runtime refusal the view keys earn.
      expect(
        () =>
          createScope({
            name: 'round-trip-3',
            domains: [cart, session, upload],
            preloadedState: first.getState() as never,
          }),
        'getState still carries views, which preload still refuses',
      ).to.throw(/which is a view/)
    })

    it('ignores a preloadedState key that names no hosted domain, instead of rejecting it', () => {
      const scope = createScope({
        name: 'preload-typo',
        domains: [upload],
        preloadedState: { hydrtaed: { files: 99 } } as never,
      })
      expect(scope.read('upload').files).to.equal(0)
    })
  })

  describe('a reducer or a caller reaching the live state object directly, in production', () => {
    it('a reducer that mutates draft.state and then throws keeps the mutation, though the action rejects', () => {
      expect(
        buildModeProbe(
          `const counter = eddy.defineDomain('counter', [], {
             state: () => ({ items: [] }),
             actions: {
               push: eddy.reduce(state => {
                 state.items.push('leaked')
                 throw new Error('fold failed')
               }),
             },
           })
           const scope = eddy.createScope({ domains: [counter] })
           scope.emit('counter.push').then(
             () => console.log('resolved'),
             e => console.log('rejected: ' + e.message),
           )
           console.log(JSON.stringify(scope.read('counter')))`,
          { env: { NODE_ENV: 'production' } },
        ),
      ).to.deep.equal(['{"items":["leaked"]}', 'rejected: fold failed'])
    })

    it('a caller-attached getter can fire during the next commit, depending on key order and where assemble short-circuits; a setter never fires', () => {
      const probe = (seed: string) =>
        buildModeProbe(
          `const counter = eddy.defineDomain('counter', [], {
             state: () => (${seed}),
             actions: {
               go: eddy.cmd(async () => 'ok', { done: { a: 1 }, finally: { b: 1 } }),
             },
           })
           const scope = eddy.createScope({ domains: [counter] })
           const live = scope.read('counter')
           let gets = 0
           let sets = 0
           Object.defineProperty(live, 'other', {
             configurable: true,
             enumerable: true,
             get() { gets++; return 0 },
             set() { sets++ },
           })
           scope.emit('counter.go').then(() => console.log(JSON.stringify({ gets, sets })))`,
          { env: { NODE_ENV: 'production' } },
        )

      expect(probe('{ other: 0, a: 0, b: 0 }')).to.deep.equal(['{"gets":2,"sets":0}'])

      expect(probe('{ a: 0, b: 0, other: 0 }')).to.deep.equal(['{"gets":0,"sets":0}'])

      const restoring = buildModeProbe(
        `const counter = eddy.defineDomain('counter', [], {
           state: () => ({ a: 0, other: 0 }),
           actions: {
             go: eddy.cmd(async () => 'ok', { done: { a: 1 }, finally: { a: 0 } }),
           },
         })
         const scope = eddy.createScope({ domains: [counter] })
         const live = scope.read('counter')
         let gets = 0
         Object.defineProperty(live, 'other', {
           configurable: true,
           enumerable: true,
           get() { gets++; return 0 },
           set() {},
         })
         scope.emit('counter.go').then(() => console.log(JSON.stringify({ gets })))`,
        { env: { NODE_ENV: 'production' } },
      )
      expect(restoring).to.deep.equal(['{"gets":1}'])
    })
  })

  describe('what the platform sees', () => {
    it('a caller-less command failure reaches the platform', () => {
      const seen = platformRejections(`
import { createScope, defineDomain, cmd } from 'SRC'
const boom = (defineDomain as any)('boom', [], {
  state: () => ({}),
  actions: { go: cmd(async () => { throw new Error('always fails') }) },
})
const scope = createScope({ domains: [boom] as const })
void (scope as any).emit('boom.go')
`)
      expect(seen).to.deep.equal(['Error: always fails'])
    })

    it('a superseded latest call does not, while an awaited one still rejects', () => {
      const seen = platformRejections(`
import { createScope, defineDomain, cmd, CommandAborted } from 'SRC'
const race = (defineDomain as any)('race', [], {
  state: () => ({}),
  actions: {
    go: cmd(async (_input: void, ctx: any) => {
      await new Promise(r => setTimeout(r, 20))
      if (ctx.signal.aborted) throw new Error('should not surface')
      return 'ok'
    }, { latest: true }),
  },
})
const scope = createScope({ domains: [race] as const })
const first = (scope as any).emit('race.go')
void (scope as any).emit('race.go')
first.then(
  () => console.log('AWAITED:resolved'),
  (e: unknown) => console.log('AWAITED:' + (e instanceof CommandAborted ? 'CommandAborted' : 'other')),
)
`)
      expect(seen).to.deep.equal([])
    })

    it('a command awaiting a superseded sibling fails properly rather than posing as cancelled', async () => {
      const compose = (defineDomain as any)('compose', [], {
        state: () => ({ failed: null as string | null }),
        actions: {
          search: cmd(
            async (q: unknown) => {
              await new Promise(r => setTimeout(r, 20))
              return q as string
            },
            { latest: true },
          ),
          page: cmd(async (q: unknown, ctx: any) => `page(${await ctx.emit('compose.search', q)})`, {
            failed: (_s: unknown, a: any) => ({ failed: String(a.error) }),
          }),
        },
      })
      const scope = createScope({ name: 'compose', domains: [compose] as const }) as any

      const page = scope.emit('compose.page', 'shoes')
      void scope.emit('compose.search', 'sho')

      const error = await page.then(
        () => undefined,
        (e: unknown) => e as Error,
      )

      expect(error).to.be.instanceOf(CommandAborted)
      expect(error?.message).to.contain('compose.search')
      expect(error?.message).to.not.contain('compose.page')
      expect(scope.read('compose').failed).to.contain('compose.search')
    })

    it('disposal does not report a non-latest command it aborts', () => {
      const seen = platformRejections(`
import { createScope, defineDomain, cmd } from 'SRC'
const slow = (defineDomain as any)('slow', [], {
  state: () => ({}),
  actions: { go: cmd(async () => { await new Promise(r => setTimeout(r, 100)); return 'ok' }) },
})
const scope = createScope({ domains: [slow] as const })
void (scope as any).emit('slow.go')
setTimeout(() => scope.dispose(), 10)
`)
      expect(seen).to.deep.equal([])
    })

    it('a .failed effect that re-emits the same latest address does not eat the failure', () => {
      const seen = platformRejections(`
import { createScope, defineDomain, cmd, effect } from 'SRC'
let again = false
const trap = (defineDomain as any)('trap', [], {
  state: () => ({}),
  actions: { go: cmd(async () => { throw new Error('ordinary failure') }, { latest: true }) },
  effects: {
    'trap.go.failed': effect(() => {
      if (again) return
      again = true
      void (scope as any).emit('trap.go')
    }),
  },
})
const scope = createScope({ domains: [trap] as const })
void (scope as any).emit('trap.go')
`)
      expect(seen).to.deep.equal(['Error: ordinary failure', 'Error: ordinary failure'])
    })
  })

  describe('construction refuses what authoring refuses', () => {
    // A definition that never went through `defineDomain` is the population the recheck exists for,
    // so each of these is built by hand rather than declared.
    const handBuilt = (over: object) => ({
      name: 'hand',
      uses: [],
      seed: () => ({ n: 0 }),
      actions: {},
      views: {},
      watchers: {},
      on: {},
      effects: {},
      ...over,
    })

    it('sees every wire the fold can fire, so a non-enumerable one cannot hide from the sweep', async () => {
      const quiet = defineDomain('quiet', [], {
        state: () => ({ n: 0 }),
        actions: { touch: reduce(state => ({ n: state.n + 1 })) },
      })

      const sneaky = defineDomain(
        'hidden' as never,
        ['quiet'] as never,
        {
          state: () => ({ n: 0 }),
          actions: { poke: reduce({}) },
        } as never,
      )
      Object.defineProperty(sneaky.on, 'quiet.touch', {
        value: reduce({ n: 1 }),
        enumerable: false,
        configurable: true,
      })

      expect(() => createScope({ name: 'hidden-wire', domains: [quiet, sneaky] as never })).to.throw(/non-enumerable/)
    })

    it('refuses latest beside a finally stage, which defineDomain already refuses', () => {
      const def = handBuilt({
        actions: { go: { $: 'cmd', handler: async () => 1, stages: { latest: true, finally: { n: 1 } } } },
      })

      expect(() => createScope({ name: 'latest-finally', domains: [def] as never })).to.throw(/latest/)
    })

    it('refuses an action name that is not a plain identifier', () => {
      const def = handBuilt({ actions: { 'not an identifier': { $: 'reduce', handler: () => ({}) } } })

      expect(() => createScope({ name: 'bad-action-name', domains: [def] as never })).to.throw(/identifier/)
    })

    it('validates the copy it stored, so a getter cannot answer differently the second time', () => {
      let reads = 0
      const actions = {}
      Object.defineProperty(actions, 'go', {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1
          return reads === 1 ? { $: 'reduce', handler: () => ({}) } : { $: 'reduce', handler: 'not a function' }
        },
      })

      const scope = createScope({ name: 'bait', domains: [handBuilt({ actions })] as never })

      // One read, stored. Whatever the getter answers afterwards reaches nothing.
      expect(reads).to.equal(1)
      expect(scope.read('hand' as never)).to.not.equal(undefined)
    })

    it('names the scope when a watcher source throws while seeding, and does not double-prefix it', () => {
      const fragile = defineDomain('fragile' as never, [], {
        state: () => ({ n: 0 }),
        actions: { go: reduce({}) },
        watch: {
          seen: watch(
            () => {
              throw new Error('fragile selector')
            },
            () => undefined,
          ),
        },
      })

      let message = ''
      try {
        createScope({ name: 'seeding', domains: [fragile] as never })
      } catch (error) {
        message = String((error as Error).message)
      }

      expect(message, 'the scope is named').to.match(/Unable to create scope 'seeding'/)
      expect(message, 'and the watcher is named').to.contain('fragile.seen')
      expect(message.match(/Unable to create scope/g) ?? [], 'named once, not twice').to.have.length(1)
    })

    it('does not prefix a watcher failure that is the refusal of a scope of its own', () => {
      // A source that builds its own scope throws that scope's refusal, which already names it.
      // Naming the outer one over the top of it says nothing and reads twice.
      const orphan = defineDomain('orphan' as never, ['nowhere'] as never, {
        state: () => ({ n: 0 }),
        actions: { go: reduce({}) },
      })
      const nested = defineDomain('nested' as never, [], {
        state: () => ({ n: 0 }),
        actions: { go: reduce({}) },
        watch: {
          seen: watch(
            () => createScope({ name: 'inner', domains: [orphan] as never }),
            () => undefined,
          ),
        },
      })

      let message = ''
      try {
        createScope({ name: 'outer', domains: [nested] as never })
      } catch (error) {
        message = String((error as Error).message)
      }

      expect(message.match(/Unable to create scope/g) ?? [], 'prefixed once, not twice').to.have.length(1)
      expect(message, 'and it is the inner one that survives').to.match(
        /^Unable to create scope 'inner': domain 'orphan'/,
      )
    })

    it('does prefix a host error whose message merely imitates a refusal', () => {
      // The library tells its own refusals apart by identity, not by message text, so a source
      // throwing prose that starts like one is still a host failure and is named as such.
      const mimic = defineDomain('mimic' as never, [], {
        state: () => ({ n: 0 }),
        actions: { go: reduce({}) },
        watch: {
          seen: watch(
            () => {
              throw new Error("Unable to create scope 'inner': something went wrong in there")
            },
            () => undefined,
          ),
        },
      })

      let message = ''
      try {
        createScope({ name: 'outer', domains: [mimic] as never })
      } catch (error) {
        message = String((error as Error).message)
      }

      expect(message).to.match(
        /^Unable to create scope 'outer': seeding watcher 'mimic\.seen' failed — Unable to create scope 'inner'/,
      )
    })
  })

  describe('a scope answers for itself', () => {
    it('reports nothing in flight when nothing is', () => {
      const scope = createScope({ name: 'idle', domains: [cart, session] })

      expect(scope.inspect()).to.deep.equal({
        queueDepth: 0,
        inFlight: [],
        live: 0,
        cascades: { count: 0, lastCause: undefined },
      })
      scope.dispose()
    })

    it('names a command with no `latest`, which the supersession registry never held', async () => {
      // `inFlight` names every live invocation, not the supersession map, which is written only for
      // `latest` commands: `cart.slow` is declared `latest` and `cart.countAfterAwait` is not.
      const scope = createScope({ name: 'plain-command', domains: [cart, session] })
      const running = scope.emit('cart.countAfterAwait')
      await flush(1)

      expect(scope.inspect().inFlight, 'a plain command is in flight too').to.deep.equal(['cart.countAfterAwait'])

      await running
      expect(scope.inspect().inFlight, 'and is gone once it settles').to.deep.equal([])
      scope.dispose()
    })

    it('names the address of a command whose handler has not settled', async () => {
      const scope = createScope({ name: 'stuck', domains: [cart, session] })
      const running = scope.emit('cart.slow', { tag: 'a' })
      await flush(1)

      const report = scope.inspect()
      expect(report.inFlight, 'the stuck address is nameable').to.deep.equal(['cart.slow'])
      expect(report.live).to.be.greaterThan(0)

      scope.dispose()
      await rejects(running, /disposed/)
    })

    it('carries addresses and never a payload', async () => {
      const scope = createScope({ name: 'no-payload', domains: [cart, session] })
      const running = scope.emit('cart.slow', { tag: 'SECRET-VALUE' })
      await flush(1)

      expect(JSON.stringify(scope.inspect()), 'the snapshot is address-only').to.not.contain('SECRET')

      scope.dispose()
      await rejects(running, /disposed/)
    })

    it('hands back a materialised array, not a live view of the map', async () => {
      const scope = createScope({ name: 'materialised', domains: [cart, session] })
      const running = scope.emit('cart.slow', { tag: 'a' })
      await flush(1)

      const { inFlight } = scope.inspect()
      expect(Array.isArray(inFlight)).to.equal(true)

      scope.dispose()
      await rejects(running, /disposed/)

      // Consumed after the scope died. A leaked iterator would have read the torn-down map here.
      expect(inFlight).to.deep.equal(['cart.slow'])
    })

    it('answers after disposal, because that is when the question gets asked', async () => {
      const scope = createScope({ name: 'gone', domains: [cart, session], onUnhandledError: () => undefined })
      const running = scope.emit('cart.slow', { tag: 'a' })
      await flush(1)
      scope.dispose()
      await rejects(running, /disposed/)

      const report = scope.inspect()
      expect(report.queueDepth).to.equal(0)
      expect(report.inFlight, 'the cancelled handler ignores its signal and is still running').to.deep.equal([
        'cart.slow',
      ])
      expect(report.live).to.equal(0)

      await settled(scope)
      expect(scope.inspect().inFlight).to.deep.equal([])
    })

    it('counts the drains its own guard aborted, and keeps the cause', async () => {
      const spinner = defineDomain('spinner' as never, [], {
        state: () => ({ n: 0 }),
        actions: { tick: reduce(((state: { n: number }) => ({ n: state.n + 1 })) as never) },
      })

      const scope = createScope({
        name: 'runaway',
        domains: [spinner] as never,
        onUnhandledError: () => undefined,
      })
      scope.on('spinner.tick' as never, () => {
        void (scope.emit as (a: string) => Promise<unknown>)('spinner.tick').catch(() => undefined)
      })

      expect(scope.inspect().cascades.count, 'nothing has tripped yet').to.equal(0)

      // The originating action commits and resolves: it succeeded, and the cascade its reaction
      // spawned is not its caller's to be told about.
      await (scope.emit as (a: string) => Promise<unknown>)('spinner.tick')

      const after = scope.inspect().cascades
      expect(after.count, 'the aborted drain is on the record').to.equal(1)
      expect(after.lastCause, 'and names what was cascading').to.contain('spinner.tick')

      scope.dispose()
    })
  })
})
