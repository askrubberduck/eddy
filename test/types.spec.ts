import { expect } from 'chai'
import { cmd, createScope, defineDomain, effect, isStale, reduce, view } from '../src/index'
import type {
  Cmd,
  Ctx,
  DomainName,
  DomainType,
  EffectCtx,
  Readable,
  Reduce,
  Scope,
  StateOf,
  StateValue,
  Teardown,
} from '../src/index'
import { createScopeHooks } from '../src/react'
import type { EffectEntries, OnEntries, ViewEntries } from '../src/domain'
import type { InputAt, ResultAt, Stamped, WrittenOf } from '../src/types'
import { cart, draft, session, type CartItem } from './fixtures'

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Assert<T extends true> = T

declare const probeScope: Scope<'cart' | 'session'>

function readsCart() {
  return probeScope.read('cart')
}

type ReadIsReadable = Assert<Equal<ReturnType<typeof readsCart>, Readable<'cart'>>>

type CartReadable = Assert<
  Equal<
    Readable<'cart'>,
    {
      readonly items: CartItem[]
      readonly coupon: string | null
      readonly taxRate: number
      readonly pending: boolean
      readonly error: string | null
      readonly skus: string[]
      readonly subtotal: number
      readonly tax: number
      readonly total: number
      readonly itemCount: number
    }
  >
>

type CartWritten = Assert<
  Equal<
    StateOf<'cart'>,
    { items: CartItem[]; coupon: string | null; taxRate: number; pending: boolean; error: string | null }
  >
>

declare const draftScope: Scope<'draft'>

// `instances`, not `read`: `read` refuses an instanced domain, and `instances` is the one surface
// that speaks the aggregate, keyed by id.
type DraftInstancesAreAggregate = Assert<
  Equal<ReturnType<typeof draftScope.instances<'draft'>>, Readonly<Record<string, Readable<'draft'> | undefined>>>
>
type DraftWrittenIsAggregate = Assert<Equal<WrittenOf<'draft'>, Record<string, Partial<StateOf<'draft'>>>>>

function instancedShapesAreAggregate() {
  const scope = createScope({
    domains: [draft],
    preloadedState: { draft: { row: { text: 'saved' } } },
  })

  // Narrowed, because only the live ids are there: `Record<string, …>` has every string for a key
  // and answers for almost none of them.
  const text: string | undefined = scope.instances('draft').row?.text
  const saved: string | undefined = scope.getWrittenState().draft.row.text

  // @ts-expect-error an instanced domain has no single state for `read` to answer with
  const wrongText: string = scope.read('draft').text
  // @ts-expect-error each top-level preload key is an id and must hold partial instance state
  createScope({ domains: [draft], preloadedState: { draft: { text: 'saved' } } })

  return [text, saved, wrongText]
}

declare const mixedScope: Scope<'cart' | 'draft'>
declare const mixedName: 'cart' | 'draft'
declare const cartCtx: Ctx<'cart'>
declare const draftCtxProbe: Ctx<'draft'>
declare const draftEffectCtx: EffectCtx<'draft'>

// Every single-state surface refuses an instanced domain at the *argument*. Fencing the return with
// `never` instead would refuse only property access, because `never` is assignable to everything:
// `const x: unknown = scope.read('draft')` would pass.
function singleStateSurfacesRefuseAnInstancedDomain() {
  const hooks = createScopeHooks(mixedScope)

  // @ts-expect-error
  mixedScope.read('draft')
  // @ts-expect-error
  hooks.useDomain('draft')
  // @ts-expect-error
  hooks.useDomainValue('draft', state => state.text)
  // @ts-expect-error
  draftCtxProbe.read('draft')
  // @ts-expect-error
  draftEffectCtx.read('draft')

  // A union with one instanced member is refused for the same reason that member is: the call would
  // have to answer with a single state for a name that may not have one.
  // @ts-expect-error
  mixedScope.read(mixedName)
}

// The dual. `instances`, `instance` and `useDomainInstance` are the aggregate-and-identity half, and
// an ordinary domain has no identity to name.
function instanceSurfacesRefuseAnOrdinaryDomain() {
  const hooks = createScopeHooks(mixedScope)

  // @ts-expect-error
  mixedScope.instances('cart')
  // @ts-expect-error
  mixedScope.instance('cart', 'row')
  // @ts-expect-error
  hooks.useDomainInstance('cart')
  // @ts-expect-error
  mixedScope.instances(mixedName)
}

// `scope.emit` is the third fence, and it is written for an *address* rather than a domain name. A
// scope-level emit carries no identity, so an instanced domain's action has no instance to fold into
// and the runtime refuses it — this refuses it at the call instead.
function scopeEmitRefusesAnInstancedAddress() {
  // @ts-expect-error
  void mixedScope.emit('draft.type', 'walked')

  // An ordinary domain's address is untouched.
  void mixedScope.emit('cart.clear')
}

// The surfaces that *do* carry an identity keep the plain `Emit`, which is what makes `ScopeEmit` a
// separate type rather than a brand on the shared one. The owner's decision keeps a handle's emit
// scope-wide, and `useDomainInstance` returns a handle's emit rather than the scope's.
function identityCarryingEmitsStillAcceptAnInstancedAddress() {
  const handle = mixedScope.instance('draft', 'row')
  void handle.emit('draft.type', 'typed')
  void handle.emit('draft.save')

  const hooks = createScopeHooks(mixedScope)
  const [, instanceEmit] = hooks.useDomainInstance('draft', 'row')
  void instanceEmit('draft.type', 'typed')

  // A command's own instanced domain, which the scope forwards its instance id for.
  void draftCtxProbe.emit('draft.type', 'typed')
}

// The fence is on the emit parameter and not in `AddressIn`, so nothing was stripped from the
// observable union: an instanced command's base action and both terminal addresses stay subscribable.
function instancedAddressesStaySubscribable() {
  mixedScope.on('draft.save', () => undefined)
  mixedScope.on('draft.save.done', () => undefined)
  mixedScope.on('draft.save.failed', () => undefined)
  mixedScope.on(['draft.type', 'draft.save.done'], () => undefined)
}

// The positive half, and the reason the guards are written `D & SingleState<D>` rather than as a
// conditional over the whole parameter: a conditional type is not an inference site, so `D` would
// fall back to its constraint and every one of these would answer with `'cart' | 'draft'` united
// instead of the domain named at the call.
type ReadStaysNarrow = Assert<Equal<ReturnType<typeof mixedScope.read<'cart'>>, Readable<'cart'>>>
type CtxReadStaysNarrow = Assert<Equal<ReturnType<typeof cartCtx.read<'cart'>>, Readable<'cart'>>>
type InstancesStaysNarrow = Assert<
  Equal<ReturnType<typeof mixedScope.instances<'draft'>>, Readonly<Record<string, Readable<'draft'> | undefined>>>
>

function inferenceSurvivesTheGuard() {
  const inferred = mixedScope.read('cart')
  type InferredIsNarrow = Assert<Equal<typeof inferred, Readable<'cart'>>>
  const total: number = inferred.total
  return [inferred, total] as [Readable<'cart'>, number, InferredIsNarrow?]
}

type ProbeState = { n: number }
type ProbeViews = { doubled: number }
type ProbeActions = { go: Cmd<{ by: number }, number>; nudge: Reduce<{ by: number }> }

type LinkedState = { hits: number }
type LinkedActions = { ping: Cmd<{ tag: string }, string>; tick: Reduce }

type SecretsState = { token: string | null }
type SecretsActions = { wipe: Reduce }

type CollidingState = { n: number }
type CollidingViews = { total: number }
type CollidingActions = { total: Reduce }

declare module '../src/types' {
  interface Domains {
    typeProbe: DomainType<ProbeState, ProbeActions, ProbeViews>
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    linked: DomainType<LinkedState, LinkedActions, {}, 'session'>
    secrets: DomainType<SecretsState, SecretsActions>
    colliding: DomainType<CollidingState, CollidingActions, CollidingViews>
  }
}

const seed = () => ({ n: 0 })
const doubled = view<'typeProbe', number, number>(
  state => state.n,
  n => n * 2,
)

const probe = defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    go: cmd(
      async (input, ctx) => {
        type InputIsDeclared = Assert<Equal<typeof input, { by: number }>>
        type StateIsFlattenedAndReadonly = Assert<
          Equal<typeof ctx.state, { readonly n: number; readonly doubled: number }>
        >

        type ReachIsOwnDomainOnly = Assert<Equal<Parameters<typeof ctx.read>[0], 'typeProbe'>>
        type EmittableIsOwnDomainOnly = Assert<
          Equal<Parameters<typeof ctx.emit>[0], 'typeProbe.go' | 'typeProbe.nudge'>
        >

        type VersionIsVisible = Assert<Equal<typeof ctx.version, number>>

        await ctx.emit('typeProbe.nudge', { by: 1 })
        return input.by + ctx.state.n
      },
      {
        done: (state, action) => {
          type StampIsVisible = Assert<Equal<typeof action.__originSeq, number | undefined>>
          return isStale(action, state.n) ? {} : { n: action.result }
        },

        failed: { n: -1 },
      },
    ),
    nudge: reduce((state, action) => ({ n: state.n + action.input.by })),
  },
  views: { doubled },
})

const linked = defineDomain('linked', ['session'], {
  state: () => ({ hits: 0 }),
  actions: {
    ping: cmd(async (input, ctx) => {
      type Reach = Assert<Equal<Parameters<typeof ctx.read>[0], 'linked' | 'session'>>
      type Emittable = Assert<
        Equal<Parameters<typeof ctx.emit>[0], 'linked.ping' | 'linked.tick' | 'session.signIn' | 'session.signOut'>
      >

      const user: string | null = ctx.read('session').userId
      const account = await ctx.emit('session.signIn', { email: 'a@b.c' })
      return `${input.tag}:${user}:${account.id}`
    }),
    tick: reduce(state => ({ hits: state.hits + 1 })),
  },

  on: {
    'session.signOut': reduce(state => ({ hits: state.hits })),
    'linked.ping.done': reduce(state => ({ hits: state.hits + 1 })),
  },

  effects: {
    'linked.ping.done': effect(action => {
      bothFired.push(`effect:${action.input.tag}`)

      isStale(action, 0)
    }),
  },
})

const bothFired: string[] = []

type ReachableAddresses =
  | 'linked.ping'
  | 'linked.tick'
  | 'session.signIn'
  | 'session.signOut'
  | 'linked.ping.done'
  | 'linked.ping.failed'
  | 'session.signIn.done'
  | 'session.signIn.failed'

type OnKeysAreReachableOnly = Assert<Equal<keyof OnEntries<'linked', 'linked' | 'session'>, ReachableAddresses>>
type EffectKeysAreReachableOnly = Assert<Equal<keyof EffectEntries<'linked' | 'session'>, ReachableAddresses>>

// An `on` entry folds the action it names, so a terminal address carries its result and a failed one
// carries its error, not `{ input: any }`.
type OnDoneHandler = NonNullable<OnEntries<'linked', 'session'>['session.signIn.done']>['handler']
type OnDoneAction =
  Extract<OnDoneHandler, (...args: never) => unknown> extends (state: never, action: infer A) => unknown ? A : never
type OnDoneFolds = Assert<Equal<OnDoneAction extends { result: infer R } ? R : never, ResultAt<'session', 'signIn'>>>
type OnDoneCarriesInput = Assert<
  Equal<OnDoneAction extends { input: infer I } ? I : never, InputAt<'session', 'signIn'>>
>

type ViewKeysAreExhaustive = Assert<Equal<keyof ViewEntries<'typeProbe'>, 'doubled'>>

type RegistryIsPopulated = Assert<
  Equal<Extract<DomainName, 'cart' | 'session' | 'typeProbe'>, 'cart' | 'session' | 'typeProbe'>
>

// @ts-expect-error `DomainName` is not `never` once the registry is augmented
type RegistryIsNotEmpty = Assert<Equal<DomainName, never>>

function noTypeArgumentsAndNoCurrying() {
  // @ts-expect-error `defineDomain` takes no type arguments and returns a definition, not a factory
  return defineDomain<ProbeState, ProbeActions>()('typeProbe', { state: seed, actions: {}, views: { doubled } })
}

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    // @ts-expect-error `go` declares a result, so it needs a command — a bare fold is not enough
    go: reduce({ n: 1 }),
    nudge: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    go: cmd(async () => 1),
    // @ts-expect-error `nudge` is a pure action — it has no command
    nudge: cmd(async () => undefined),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  // @ts-expect-error `nudge` is declared but not implemented
  actions: { go: cmd(async () => 1) },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    go: cmd(async () => 1),
    nudge: reduce({ n: 1 }),
    // @ts-expect-error `nope` is not declared in ProbeActions
    nope: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    // @ts-expect-error the handler must resolve to number
    go: cmd(async () => 'not-a-number'),
    nudge: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    // @ts-expect-error `doubled` is a view — no fold may write it
    go: cmd(async () => 1, { done: { doubled: 5 } }),
    nudge: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    go: cmd(async (input, ctx) => {
      // @ts-expect-error readable state is readonly — a command reads it, it does not assign to it
      ctx.state.n = 5
      return input.by
    }),
    nudge: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    // @ts-expect-error `__nope` is not a field the kernel stamps
    go: cmd(async () => 1, { done: (_state, action) => ({ n: action.__nope }) }),
    nudge: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: {
    go: cmd(async (input, ctx) => {
      // @ts-expect-error `typeProbe` declared no neighbours, so `session` is unreachable
      ctx.read('session')
      // @ts-expect-error and so is every address of it
      await ctx.emit('session.signOut')
      return input.by
    }),
    nudge: reduce({ n: 1 }),
  },
  views: { doubled },
})

defineDomain('linked', ['session'], {
  state: () => ({ hits: 0 }),
  actions: {
    ping: cmd(async (input, ctx) => {
      // @ts-expect-error `secrets` is registered but is not a declared neighbour of `linked`
      ctx.read('secrets')
      // @ts-expect-error nor is any address of it emittable
      await ctx.emit('secrets.wipe')
      return input.tag
    }),
    tick: reduce(state => ({ hits: state.hits })),
  },
})

defineDomain('linked', ['session'], {
  state: () => ({ hits: 0 }),
  actions: { ping: cmd(async input => input.tag), tick: reduce(state => ({ hits: state.hits })) },
  on: {
    // @ts-expect-error `secrets` is not a declared neighbour, so nothing of its can be folded
    'secrets.wipe': reduce(state => ({ hits: state.hits })),
  },
})

defineDomain('linked', ['session'], {
  state: () => ({ hits: 0 }),
  actions: { ping: cmd(async input => input.tag), tick: reduce(state => ({ hits: state.hits })) },
  on: {
    // @ts-expect-error `tick` is a pure action, so it has no `.done`
    'linked.tick.done': reduce(state => ({ hits: state.hits })),
  },
})

defineDomain('linked', ['session'], {
  state: () => ({ hits: 0 }),
  actions: { ping: cmd(async input => input.tag), tick: reduce(state => ({ hits: state.hits })) },
  effects: {
    // @ts-expect-error `secrets` is not a declared neighbour, so nothing of its can be reacted to
    'secrets.wipe': effect(() => undefined),
  },
})

defineDomain('typeProbe', [], {
  state: seed,
  actions: { go: cmd(async () => 1), nudge: reduce({ n: 1 }) },
  // @ts-expect-error `doubled` is declared in ProbeViews but not implemented
  views: {},
})

const seedsAView = defineDomain('typeProbe', [], {
  state: () => ({ n: 0, doubled: 0 }),
  actions: { go: cmd(async () => 1), nudge: reduce({ n: 1 }) },
  views: { doubled },
})

const defineColliding = () =>
  defineDomain('colliding', [], {
    state: () => ({ n: 0 }),
    actions: { total: reduce({ n: 1 }) },
    views: {
      total: view<'colliding', number, number>(
        state => state.n,
        n => n,
      ),
    },
  })

type PureActionResultIsVoid = Assert<Equal<ResultAt<'cart', 'clear'>, void>>

async function addressesAreTyped(scope: ReturnType<typeof makeScope>) {
  // @ts-expect-error `typeProbe` is not hosted in this scope
  await scope.emit('typeProbe.nudge', { by: 1 })
  // @ts-expect-error no such action on a hosted domain
  await scope.emit('cart.nope')
  // @ts-expect-error an outcome address is not invocable
  await scope.emit('cart.add.done', { sku: 'SKU-1', qty: 1 })
  // @ts-expect-error `clear` is a pure action, so it has no outcome to subscribe to
  scope.on('cart.clear.done', () => undefined)
  // @ts-expect-error `orders` is not a registered domain at all
  scope.read('orders')

  scope.on('cart.add.done', action => {
    const sku: string = action.input.sku
    const id: string = action.result.id

    type ReactionStampIsVisible = Assert<Equal<typeof action.__originSeq, number | undefined>>
    void isStale(action, 0)
    // @ts-expect-error the stamped intersection did not degenerate to `any`
    action.__nope
    return [sku, id]
  })

  scope.on('*', action => {
    if (action.type === 'cart.add.done') {
      const id: string = action.result.id
      void id
    }
    if (action.type === 'session.signOut') {
      // @ts-expect-error a pure action carries no result, even inside the all-actions union
      action.result
    }
    // @ts-expect-error `cart.nope` is not an address this scope can dispatch
    void (action.type === 'cart.nope')

    // Reachable without narrowing, because every member carries them — which is what an analytics
    // sink reads, and the shape the wiki's `'*'` example uses.
    const type: string = action.type
    void [type, action.input]

    // The stamped intersection has to survive the union, or `isStale` stops working exactly where
    // an all-actions listener would most want it.
    type WildcardStampIsVisible = Assert<Equal<typeof action.__seq, number | undefined>>
    void isStale(action, 0)
  })

  scope.on(['cart.add.done', 'session.signOut'], action => {
    type ListNarrowsToItsMembers = Assert<Equal<typeof action.type, 'cart.add.done' | 'session.signOut'>>

    if (action.type === 'cart.add.done') {
      const id: string = action.result.id
      void id
    }
  })

  // @ts-expect-error an address outside the list is not a member of its union
  scope.on(['cart.add.done', 'session.signOut'], action => action.type === 'cart.clear')
  // @ts-expect-error a list is checked member by member, exactly as a single address is
  scope.on(['cart.clear', 'cart.nope'], () => undefined)

  const item = await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
  const price: number = item.price
  // @ts-expect-error a command result is CartItem, not string
  const wrongPrice: string = item.price

  void scope.emit('cart.clear')
  await scope.emit('cart.clear')
  // @ts-expect-error a pure action has no result, so it cannot be read as one
  const nothing: number = await scope.emit('cart.clear')

  return price
}

const makeScope = () => createScope({ name: 'types-probe', domains: [cart, session] })

export type Checked = [
  ReadIsReadable,
  CartReadable,
  CartWritten,
  OnKeysAreReachableOnly,
  EffectKeysAreReachableOnly,
  ViewKeysAreExhaustive,
  RegistryIsPopulated,
  RegistryIsNotEmpty,
  PureActionResultIsVoid,
  DraftInstancesAreAggregate,
  DraftWrittenIsAggregate,
]
export type AddressesChecked = typeof addressesAreTyped
export type InstancedShapesChecked = typeof instancedShapesAreAggregate
export type DraftInstancesChecked = DraftInstancesAreAggregate

describe('types', () => {
  it('compiles the declarations above, and rejects the negative controls', () => {
    expect(probe.name).to.equal('typeProbe')
    expect(linked.uses).to.deep.equal(['session'])
  })

  it('rejects direct property access on an instanced domain', () => {
    const readWithoutHandle = (scope: Scope<'draft'>) => {
      // @ts-expect-error an instanced domain is readable only through a handle
      return scope.read('draft').text
    }

    expect(readWithoutHandle).to.be.a('function')
  })

  it('throws when a seed sets a view key, which the type system cannot catch', () => {
    expect(() => createScope({ name: 'seeds-a-view', domains: [seedsAView] })).to.throw(/which is a view/)
  })

  it('throws when an action and a view share a key, which the split made invisible to the types', () => {
    expect(defineColliding).to.throw(/'total' is declared as both an action and a view/)
  })

  it('folds and reacts to one address from both maps', async () => {
    bothFired.length = 0
    const scope = createScope({ name: 'both-maps', domains: [linked, session] })
    await scope.emit('linked.ping', { tag: 'x' })

    expect(scope.read('linked').hits).to.equal(1)
    expect(bothFired).to.deep.equal(['effect:x'])
    scope.dispose()
  })
})

type ScopeSurfaceHasNoDisposed = Assert<Equal<'disposed' extends keyof Scope<'typeProbe'> ? true : false, false>>

describe('the scope surface', () => {
  it('does not expose `disposed`', () => {
    const scope = createScope({ name: 'no-disposed', domains: [probe] })

    expect(Object.hasOwn(scope, 'disposed')).to.equal(false)
    expect('disposed' in scope).to.equal(false)
    scope.dispose()
  })
})

// The exported union must not permit what the runtime throws for. These four are in the runtime's
// RETIRED table, so a consumer typing state against `StateValue` is told the truth at compile time
// rather than at the first fold — and it must permit the one built-in the runtime admits.
type Permits<T> = [T] extends [StateValue] ? true : false

type DateIsState = Assert<Equal<Permits<Date>, true>>
type RegExpIsNotState = Assert<Equal<Permits<RegExp>, false>>
type ErrorIsNotState = Assert<Equal<Permits<Error>, false>>
type MapIsNotState = Assert<Equal<Permits<ReadonlyMap<string, number>>, false>>
type SetIsNotState = Assert<Equal<Permits<ReadonlySet<string>>, false>>

// ...and must still permit everything it does accept.
type PrimitivesAreState = Assert<Equal<Permits<string | number | boolean | bigint | null | undefined>, true>>
type NestedIsState = Assert<Equal<Permits<{ readonly a: readonly { readonly b: number }[] }>, true>>

// Reachable from the package root, because they appear in signatures a consumer meets: `Scope.on`
// hands back `Stamped`, a watcher handler returns `Teardown`, and an effect receives `EffectCtx`.
declare const stamped: Stamped
declare const teardown: Teardown
declare const effectCtx: EffectCtx<'cart'>
declare const draftCtx: Ctx<'draft'>

type StampedCarriesVersions = Assert<Equal<typeof stamped.__seq, number | undefined>>
type TeardownTakesNothing = Assert<Equal<ReturnType<typeof teardown>, void>>
type EffectCtxReads = Assert<Equal<ReturnType<typeof effectCtx.read<'cart'>>, Readable<'cart'>>>
type CommandReadIsOwnState = Assert<Equal<ReturnType<typeof draftCtx.read<'draft'>>, Readable<'draft'>>>
