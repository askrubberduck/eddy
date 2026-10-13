import { expect } from 'chai'
import { cmd, createScope, defineDomain, reduce, view } from '../src/index'
import type { Cmd, DomainType, Reduce } from '../src/index'
import { flush } from '../src/testing'
import { api, cart, observed, session } from './fixtures'
import { buildModeProbe, rejects } from './helpers'

type ProbeState = {
  n: number
  other: number
}
type ProbeViews = {
  doubled: number
  quadrupled: number
}
type ProbeActions = { bump: Reduce; bumpOther: Reduce; work: Cmd<void, number> }

type CycleState = { n: number }
type CycleViews = { a: number; b: number }
type CycleActions = { noop: Reduce }

type CollideState = { n: number }
type CollideViews = { doubled: number }
type CollideActions = { collide: Reduce }

type CondState = { flag: boolean; a: number; b: number }
type CondViews = { picked: number[] }
type CondActions = { setFlag: Reduce<{ flag: boolean }>; setA: Reduce<{ a: number }>; setB: Reduce<{ b: number }> }

type EnumState = { known: number }
type EnumViews = { width: number }
type EnumActions = { bump: Reduce; grow: Reduce }

type ManyState = { n: number; other: number }
type ManyViews = { v1: number; v2: number; v3: number; v4: number }
type ManyActions = { bump: Reduce }

type SplitState = { a: number; b: number }
type SplitViews = { fromA: number[] }
type SplitActions = { run: Cmd<void, number> }

type NestedWriteState = { n: number }
type NestedWriteViews = { upstream: number; sneaky: number }
type NestedWriteActions = { noop: Reduce }

type RelayItem = { id: string; price: number }
type RelayState = { items: RelayItem[]; tag: number }
type RelayViews = { ids: string[]; count: number }
type RelayActions = { markUp: Reduce; addItem: Reduce; bumpTag: Reduce }

declare module '../src/types' {
  interface Domains {
    probe: DomainType<ProbeState, ProbeActions, ProbeViews>
    cycle: DomainType<CycleState, CycleActions, CycleViews>
    collide: DomainType<CollideState, CollideActions, CollideViews>
    conditional: DomainType<CondState, CondActions, CondViews>
    enumerating: DomainType<EnumState, EnumActions, EnumViews>
    split: DomainType<SplitState, SplitActions, SplitViews>
    nestedWrite: DomainType<NestedWriteState, NestedWriteActions, NestedWriteViews>
    relay: DomainType<RelayState, RelayActions, RelayViews>
    manyViews: DomainType<ManyState, ManyActions, ManyViews>
  }
}

let transforms = { doubled: 0, quadrupled: 0 }

let selectors = { doubled: 0, quadrupled: 0 }

const probe = defineDomain('probe', [], {
  state: () => ({ n: 1, other: 0 }),
  actions: {
    bump: reduce(state => ({ n: state.n + 1 })),
    bumpOther: reduce(state => ({ other: state.other + 1 })),
    work: cmd(async () => 42),
  },
  views: {
    doubled: view(
      state => {
        selectors.doubled += 1
        return state.n
      },
      n => {
        transforms.doubled += 1
        return n * 2
      },
    ),
    quadrupled: view(
      state => {
        selectors.quadrupled += 1
        return state.doubled
      },
      doubled => {
        transforms.quadrupled += 1
        return doubled * 2
      },
    ),
  },
})

const cyclic = defineDomain('cycle', [], {
  state: () => ({ n: 0 }),
  actions: { noop: reduce({}) },
  views: {
    a: view(
      state => state.b,
      b => b + 1,
    ),
    b: view(
      state => state.a,
      a => a + 1,
    ),
  },
})

type EnumBasicState = { n: number }
type EnumBasicViews = { doubled: number }
type EnumBasicActions = { noop: Reduce }

let enumBasicKeys: string[] = []
let enumBasicReflectKeys: PropertyKey[] = []
let enumBasicHasDoubled = false
let enumBasicHasMissing = true
let enumBasicForIn: string[] = []

const enumBasic = defineDomain('enumBasic', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    doubled: view(
      state => {
        const s = state as object
        enumBasicKeys = Object.keys(s)
        enumBasicReflectKeys = Reflect.ownKeys(s)
        enumBasicHasDoubled = 'doubled' in s
        enumBasicHasMissing = 'nope' in s
        enumBasicForIn = []
        for (const key in s) enumBasicForIn.push(key)
        return state.n
      },
      n => n * 2,
    ),
  },
})

type EnumCycleState = { n: number }
type EnumCycleViews = { mirror: unknown }
type EnumCycleActions = { noop: Reduce }

const spreadCycle = defineDomain('enumSpreadCycle', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    mirror: view(
      state => ({ ...(state as object) }),
      value => value,
    ),
  },
})

const entriesCycle = defineDomain('enumEntriesCycle', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    mirror: view(
      state => Object.fromEntries(Object.entries(state as object)),
      value => value,
    ),
  },
})

const jsonCycle = defineDomain('enumJsonCycle', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    mirror: view(
      state => JSON.parse(JSON.stringify(state)),
      value => value,
    ),
  },
})

type EnumThrowState = { n: number }
type EnumThrowViews = { probe: number; boom: number }
type EnumThrowActions = { noop: Reduce }

let enumThrowProbeKeys: string[] = []

const enumThrow = defineDomain('enumThrow', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    probe: view(
      state => {
        enumThrowProbeKeys = Object.keys(state as object)
        return state.n
      },
      n => n,
    ),
    boom: view(
      state => state.n,
      () => {
        throw new Error('boom exploded')
      },
    ),
  },
})

type TwoSpreadState = { n: number }
type TwoSpreadViews = { a: unknown; b: unknown }
type TwoSpreadActions = { noop: Reduce }

const twoSpread = defineDomain('twoSpread', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    a: view(
      state => ({ ...(state as object) }),
      value => value,
    ),
    b: view(
      state => ({ ...(state as object) }),
      value => value,
    ),
  },
})

type CrossSpreadState = { n: number }
type CrossSpreadViews = { probe: unknown; mirror: unknown }
type CrossSpreadActions = { noop: Reduce }

const crossSpread = defineDomain('crossSpread', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    probe: view(
      state => state.mirror,
      mirror => mirror,
    ),
    mirror: view(
      state => ({ ...(state as object) }),
      value => value,
    ),
  },
})

type MultiEnumState = { n: number; other: number }
type MultiEnumViews = { double: number; triple: number; report: unknown }
type MultiEnumActions = { noop: Reduce }

let multiReport: { entries: unknown; spread: unknown; json: unknown } | undefined

const multiEnum = defineDomain('multiEnum', [], {
  state: () => ({ n: 2, other: 3 }),
  actions: { noop: reduce({}) },
  views: {
    double: view(
      state => state.n,
      n => n * 2,
    ),
    triple: view(
      state => state.other,
      other => other * 3,
    ),
    report: view(
      state => {
        const s = state as Record<string, unknown>
        const names = Object.keys(s).filter(key => key !== 'report')
        const picked: Record<string, unknown> = {}
        for (const key of names) picked[key] = s[key]
        multiReport = {
          entries: Object.entries(picked),
          spread: { ...picked },
          json: JSON.parse(JSON.stringify(picked)),
        }
        return 0
      },
      () => 0,
    ),
  },
})

type PoisonSpreadState = { n: number }
type PoisonSpreadViews = { escaped: unknown; spreader: unknown }
type PoisonSpreadActions = { noop: Reduce }

const poisonForward = defineDomain('poisonForward', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    escaped: view(
      state => state,
      () => 0,
    ),
    spreader: view(
      state => ({ ...(state as object) }),
      value => value,
    ),
  },
})

const poisonReverse = defineDomain('poisonReverse', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    spreader: view(
      state => ({ ...(state as object) }),
      value => value,
    ),
    escaped: view(
      state => state,
      () => 0,
    ),
  },
})

type PoisonOrdinaryState = { n: number }
type PoisonOrdinaryViews = { escaped: unknown; other: number }
type PoisonOrdinaryActions = { bump: Reduce }

let poisonOrdinaryKeys: string[] = []
let poisonOrdinaryReflectKeys: PropertyKey[] = []
let poisonOrdinaryHasEscaped = false

const poisonOrdinary = defineDomain('poisonOrdinary', [], {
  state: () => ({ n: 1 }),
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },
  views: {
    escaped: view(
      state => state,
      () => 0,
    ),

    other: view(
      state => {
        poisonOrdinaryKeys = Object.keys(state as object)
        poisonOrdinaryReflectKeys = Reflect.ownKeys(state as object)
        poisonOrdinaryHasEscaped = 'escaped' in (state as object)
        return state.n
      },
      n => n * 10,
    ),
  },
})

type EscapeClassState = {
  n: number
}
type EscapeClassViews = {
  escapeArray: unknown
  escapeNestedArray: unknown
  escapeObjectValue: unknown
  escapeArrayOfObjects: unknown
  escapeDeepNested: unknown
  sibling: number
}
type EscapeClassActions = { noop: Reduce }

let escapeClassSiblingKeys: string[] = []
let escapeClassSiblingReflectKeys: PropertyKey[] = []
let escapeClassSiblingHasEscapeArray = false

const escapeClass = defineDomain('escapeClass', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    escapeArray: view(
      state => [state],
      () => 0,
    ),
    escapeNestedArray: view(
      state => [[state]],
      () => 0,
    ),
    escapeObjectValue: view(
      state => ({ k: state }),
      () => 0,
    ),
    escapeArrayOfObjects: view(
      state => [{ k: state }],
      () => 0,
    ),
    escapeDeepNested: view(
      state => ({ a: { b: { c: state } } }),
      () => 0,
    ),

    sibling: view(
      state => {
        escapeClassSiblingKeys = Object.keys(state as object)
        escapeClassSiblingReflectKeys = Reflect.ownKeys(state as object)
        escapeClassSiblingHasEscapeArray = 'escapeArray' in (state as object)
        return state.n
      },
      n => n * 10,
    ),
  },
})

type EscapeConditionalState = { n: number; escapeAfter: boolean }
type EscapeConditionalViews = { escapee: unknown; sibling: number }
type EscapeConditionalActions = { flip: Reduce }

let escapeConditionalSiblingKeys: string[] = []

const escapeConditional = defineDomain('escapeConditional', [], {
  state: () => ({ n: 1, escapeAfter: false }),
  actions: { flip: reduce(state => ({ escapeAfter: !state.escapeAfter })) },
  views: {
    escapee: view(
      state => (state.escapeAfter ? [state] : state.n),
      value => value,
    ),
    sibling: view(
      state => {
        escapeConditionalSiblingKeys = Object.keys(state as object)
        return state.n
      },
      n => n * 10,
    ),
  },
})

declare module '../src/types' {
  interface Domains {
    enumBasic: DomainType<EnumBasicState, EnumBasicActions, EnumBasicViews>
    enumSpreadCycle: DomainType<EnumCycleState, EnumCycleActions, EnumCycleViews>
    enumEntriesCycle: DomainType<EnumCycleState, EnumCycleActions, EnumCycleViews>
    enumJsonCycle: DomainType<EnumCycleState, EnumCycleActions, EnumCycleViews>
    enumThrow: DomainType<EnumThrowState, EnumThrowActions, EnumThrowViews>
    twoSpread: DomainType<TwoSpreadState, TwoSpreadActions, TwoSpreadViews>
    crossSpread: DomainType<CrossSpreadState, CrossSpreadActions, CrossSpreadViews>
    poisonForward: DomainType<PoisonSpreadState, PoisonSpreadActions, PoisonSpreadViews>
    poisonReverse: DomainType<PoisonSpreadState, PoisonSpreadActions, PoisonSpreadViews>
    poisonOrdinary: DomainType<PoisonOrdinaryState, PoisonOrdinaryActions, PoisonOrdinaryViews>
    escapeClass: DomainType<EscapeClassState, EscapeClassActions, EscapeClassViews>
    escapeConditional: DomainType<EscapeConditionalState, EscapeConditionalActions, EscapeConditionalViews>
    multiEnum: DomainType<MultiEnumState, MultiEnumActions, MultiEnumViews>
  }
}

const collide = defineDomain('collide', [], {
  state: () => ({ n: 0 }),
  actions: { collide: reduce(() => ({ doubled: 99 }) as never) },
  views: {
    doubled: view(
      state => state.n,
      n => n * 2,
    ),
  },
})

let picks = 0

const conditional = defineDomain('conditional', [], {
  state: () => ({ flag: true, a: 1, b: 100 }),
  actions: {
    setFlag: reduce((_state, action) => ({ flag: action.input.flag })),
    setA: reduce((_state, action) => ({ a: action.input.a })),
    setB: reduce((_state, action) => ({ b: action.input.b })),
  },
  views: {
    picked: view(
      state => {
        picks += 1
        return state.flag ? state.a : state.b
      },

      value => [value],
    ),
  },
})

const enumerating = defineDomain('enumerating', [], {
  state: () => ({ known: 0 }),
  actions: {
    bump: reduce(state => ({ known: state.known + 1 })),

    grow: reduce(() => ({ fresh: 1 }) as never),
  },
  views: {
    width: view(
      state => Object.keys(state).filter(key => key !== 'width').length,
      n => n,
    ),
  },
})

let splitTransforms = 0

// `done` moves `a`, which `fromA` reads; `finally` moves only `b`. Two effective stages, one input
// movement, so the transform belongs to the first stage alone.
const split = defineDomain('split', [], {
  state: () => ({ a: 0, b: 0 }),
  actions: {
    run: cmd(async () => 5, {
      done: (_state, action) => ({ a: action.result }),
      finally: state => ({ b: state.a + 1 }),
    }),
  },
  views: {
    fromA: view(
      state => state.a,
      a => {
        splitTransforms += 1
        return [a]
      },
    ),
  },
})

const nestedWrite = defineDomain('nestedWrite', [], {
  state: () => ({ n: 1 }),
  actions: { noop: reduce({}) },
  views: {
    sneaky: view(state => {
      const seen = state.upstream
      ;(state as unknown as Record<string, unknown>).written = 'through the lens'
      return seen
    }, Number),
    upstream: view(
      state => state.n,
      n => n,
    ),
  },
})

let relaySelectors = { ids: 0, count: 0 }

const relay = defineDomain('relay', [], {
  state: () => ({ items: [{ id: 'a', price: 1 }], tag: 0 }),
  actions: {
    markUp: reduce(state => ({ items: state.items.map(item => ({ ...item, price: item.price + 1 })) })),
    addItem: reduce(state => ({ items: [...state.items, { id: `x${state.items.length}`, price: 1 }] })),
    bumpTag: reduce(state => ({ tag: state.tag + 1 })),
  },
  views: {
    ids: view(
      state => {
        relaySelectors.ids += 1
        return state.items
      },
      items => items.map(item => item.id),
    ),
    count: view(
      state => {
        relaySelectors.count += 1
        return state.ids
      },
      ids => ids.length,
    ),
  },
})

describe('views', () => {
  beforeEach(() => {
    api.reset()
    observed.reset()
    transforms = { doubled: 0, quadrupled: 0 }
    selectors = { doubled: 0, quadrupled: 0 }
    relaySelectors = { ids: 0, count: 0 }
    picks = 0
  })

  it('materialises into state, readable beside written fields', () => {
    const scope = createScope({ name: 'v1', domains: [cart, session] })
    const state = scope.read('cart')

    expect(state.items).to.deep.equal([])
    expect(state.subtotal).to.equal(0)
    expect(state.total).to.equal(0)
    expect(state.itemCount).to.equal(0)
  })

  it('resolves a view that depends on another view', async () => {
    const scope = createScope({ name: 'v2', domains: [cart, session] })
    await scope.emit('cart.add', { sku: 'SKU-1', qty: 2 })
    await flush()

    const state = scope.read('cart')
    expect(state.subtotal).to.equal(20)
    expect(state.tax).to.equal(4)
    expect(state.total).to.equal(24)
    expect(state.itemCount).to.equal(1)
  })

  it('recomputes only when the declared input changed', async () => {
    const scope = createScope({ name: 'v3', domains: [probe] })

    expect(transforms).to.deep.equal({ doubled: 1, quadrupled: 1 })

    await scope.emit('probe.bumpOther')
    expect(scope.read('probe').other).to.equal(1)

    expect(transforms).to.deep.equal({ doubled: 1, quadrupled: 1 })

    await scope.emit('probe.bump')
    expect(scope.read('probe').doubled).to.equal(4)
    expect(transforms).to.deep.equal({ doubled: 2, quadrupled: 2 })
  })

  it('keeps the previous value by reference when a recomputation lands on an equal value', async () => {
    const scope = createScope({ name: 'v4', domains: [cart, session] })
    await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
    await flush()

    const before = scope.read('cart')

    await scope.emit('cart.reorder', { from: 0, to: 0 })

    const after = scope.read('cart')

    expect(after.skus).to.equal(before.skus)
    expect(after.skus).to.deep.equal(['SKU-1'])
  })

  it('keeps the previous value by reference when the input moved but the value did not', async () => {
    const scope = createScope({ name: 'v5', domains: [cart, session] })
    await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
    await flush()

    const before = scope.read('cart')
    await scope.emit('cart.markUp')

    const after = scope.read('cart')

    expect(after.subtotal).to.not.equal(before.subtotal)
    expect(after.skus).to.equal(before.skus)
  })

  it('a command result flows through a view in the same pass', async () => {
    const scope = createScope({ name: 'v5', domains: [cart, session] })
    const item = await scope.emit('cart.add', { sku: 'SKU-1', qty: 3 })

    expect(item.price).to.equal(10)
    expect(scope.read('cart').subtotal).to.equal(30)
    expect(scope.read('cart').total).to.equal(36)
  })

  it('refuses a reducer that writes a view key, naming the domain, the action and the key', async () => {
    const scope = createScope({ name: 'v8', domains: [collide] })
    await rejects(
      scope.emit('collide.collide'),
      /Unable to fold 'collide\.collide' into domain 'collide': it writes 'doubled', which is a view/,
    )
  })

  it('refuses that same reducer in production too, because the check is one hasOwn per key', () => {
    const lines = buildModeProbe(
      `
const domain = eddy.defineDomain('collideProd', [], {
  state: () => ({ n: 0 }),
  actions: { collide: eddy.reduce(() => ({ doubled: 99 })) },
  views: { doubled: eddy.view(s => s.n, n => n * 2) },
})
const scope = eddy.createScope({ domains: [domain] })
let notified = 0
scope.subscribe(() => { notified += 1 })
const before = scope.read('collideProd')
scope.emit('collideProd.collide').catch(error => console.log('REFUSED:' + /which is a view/.test(error.message)))
const after = scope.read('collideProd')
console.log('SAME_REF:' + (before === after))
console.log('NOTIFIED:' + notified)
console.log('VIEW:' + after.doubled)
`,
      { env: { NODE_ENV: 'production' } },
    )

    expect(lines).to.deep.equal(['SAME_REF:true', 'NOTIFIED:0', 'VIEW:0', 'REFUSED:true'])
  })

  it('does not let a real field alongside it smuggle a view key into production state', () => {
    const lines = buildModeProbe(
      `
const domain = eddy.defineDomain('collideMixedProd', [], {
  state: () => ({ n: 0, tick: 0 }),
  actions: { collide: eddy.reduce(s => ({ tick: s.tick + 1, doubled: 99 })) },
  views: { doubled: eddy.view(s => s.n, n => n * 2) },
})
const folded = []
const scope = eddy.createScope({
  domains: [domain],
  logLevel: 'debug',
  logger: { debug: (msg, record) => { if (msg === 'eddy: folded') folded.push(record.fields.collideMixedProd) }, info: () => {}, error: () => {} },
})
scope.emit('collideMixedProd.collide').catch(() => {})
scope.emit('collideMixedProd.collide').catch(() => {})
console.log('FOLDED:' + JSON.stringify(folded))
console.log('TICK:' + scope.read('collideMixedProd').tick)
console.log('VIEW:' + scope.read('collideMixedProd').doubled)
`,
      { env: { NODE_ENV: 'production' } },
    )

    // Nothing folds at all: the fold is refused whole, so the legitimate field does not land either.
    expect(lines).to.deep.equal(['FOLDED:[]', 'TICK:0', 'VIEW:0'])
  })

  it('a conditional selector follows the branch it actually took, in both directions', async () => {
    const scope = createScope({ name: 'v9', domains: [conditional] })

    const first = scope.read('conditional').picked
    expect(first).to.deep.equal([1])

    await scope.emit('conditional.setB', { b: 200 })
    expect(scope.read('conditional').picked).to.equal(first)

    await scope.emit('conditional.setFlag', { flag: false })
    expect(scope.read('conditional').picked).to.deep.equal([200])

    await scope.emit('conditional.setB', { b: 300 })
    expect(scope.read('conditional').picked).to.deep.equal([300])

    const settled = scope.read('conditional').picked
    await scope.emit('conditional.setA', { a: 42 })
    expect(scope.read('conditional').picked).to.equal(settled)
  })

  it('a selector that enumerates re-evaluates for a field the seed never carried', async () => {
    const scope = createScope({ name: 'v10', domains: [enumerating] })
    expect(scope.read('enumerating').width).to.equal(1)

    await scope.emit('enumerating.grow')
    expect(scope.read('enumerating').width).to.equal(2)

    await scope.emit('enumerating.bump')
    expect(scope.read('enumerating').width).to.equal(2)
  })

  it('keeps a view by reference when nothing it reads moved, and propagates when it does', async () => {
    const scope = createScope({ name: 'v11', domains: [probe] })
    const before = scope.read('probe').quadrupled

    await scope.emit('probe.bumpOther')
    expect(scope.read('probe').other).to.equal(1)
    expect(scope.read('probe').quadrupled).to.equal(before)

    await scope.emit('probe.bump')
    expect(scope.read('probe').quadrupled).to.equal(8)
  })

  it('holds a downstream view still when its upstream recomputed to an equal value', async () => {
    const scope = createScope({ name: 'v12', domains: [relay] })

    const before = scope.read('relay')

    await scope.emit('relay.markUp')
    expect(scope.read('relay').ids).to.equal(before.ids)
    expect(scope.read('relay').count).to.equal(1)

    await scope.emit('relay.bumpTag')
    expect(scope.read('relay').ids).to.equal(before.ids)

    await scope.emit('relay.addItem')
    expect(scope.read('relay').count).to.equal(2)
    expect(scope.read('relay').ids).to.not.equal(before.ids)
  })

  it('resolves a view against every field the whole fold moved, not just the last stage', async () => {
    const scope = createScope({ name: 'v13', domains: [split] })

    await scope.emit('split.run')

    expect(scope.read('split').a).to.equal(5)
    expect(scope.read('split').b).to.equal(6)
    expect(scope.read('split').fromA).to.deep.equal([5])
  })

  it('builds one lens per resolution pass, not one per view', async () => {
    // Four views over two written fields. One lens costs four accessors in production and eight in
    // development, where written keys are redefined too. Per view it costs that many times four.
    const many = defineDomain('manyViews', [], {
      state: () => ({ n: 1, other: 0 }),
      actions: { bump: reduce(state => ({ n: state.n + 1 })) },
      views: {
        v1: view(
          state => state.n,
          n => n + 1,
        ),
        v2: view(
          state => state.n,
          n => n + 2,
        ),
        v3: view(
          state => state.n,
          n => n + 3,
        ),
        v4: view(
          state => state.n,
          n => n + 4,
        ),
      },
    })

    const scope = createScope({ name: 'many-views', domains: [many] })

    const real = Object.defineProperty
    let defines = 0
    Object.defineProperty = ((...args: Parameters<typeof real>) => {
      defines += 1
      return real(...args)
    }) as typeof real

    try {
      await scope.emit('manyViews.bump')
    } finally {
      Object.defineProperty = real
    }

    // The suite runs in development, where a lens defines an accessor per view key and redefines
    // each written key too: four plus two. Once per view it would be four times that.
    expect(defines, 'one lens, not one per view').to.equal(6)
  })

  it('recomputes a view once for a fold whose later stage does not touch its input', async () => {
    const scope = createScope({ name: 'v13b', domains: [split] })
    splitTransforms = 0

    await scope.emit('split.run')

    expect(scope.read('split').fromA).to.deep.equal([5])
    expect(splitTransforms, 'the finally stage moves `b`, which `fromA` does not read').to.equal(1)
  })

  const TAMPER_MARK = Symbol('tamper')

  for (const [label, attack] of [
    [
      'a redefinition that leaves the key list unchanged',
      (state: object) => Object.defineProperty(state, 'n', { get: () => 99, configurable: true }),
    ],
    ['a prototype swap', (state: object) => Object.setPrototypeOf(state, { n: 7 })],
    [
      'a symbol-keyed property, which no key list names',
      (state: object) => {
        ;(state as Record<symbol, unknown>)[TAMPER_MARK] = 42
      },
    ],
    [
      'freezing it, which no descriptor value records',
      (state: object) => {
        Object.freeze(state)
      },
    ],
    [
      'making it non-extensible',
      (state: object) => {
        Object.preventExtensions(state)
      },
    ],
    [
      'a prototype swap hidden behind a replaced Object.getPrototypeOf',
      (state: object) => {
        const real = Object.getPrototypeOf
        const original = real(state)
        Object.setPrototypeOf(state, { forged: 77 })
        Object.getPrototypeOf = ((value: object) =>
          value === state ? original : real(value)) as typeof Object.getPrototypeOf
      },
    ],
    [
      'reordering the keys while every descriptor stays identical',
      (state: object) => {
        const own = Object.getOwnPropertyDescriptor(state, 'n')
        delete (state as Record<string, unknown>).n
        Object.defineProperty(state, 'n', own as PropertyDescriptor)
      },
    ],
    [
      'flipping an attribute flag while keeping the getter',
      (state: object) => {
        const own = Object.getOwnPropertyDescriptor(state, 'sibling')
        Object.defineProperty(state, 'sibling', { get: own?.get, enumerable: false, configurable: true })
      },
    ],
  ] as const) {
    it(`refuses ${label}, which one lens per pass would otherwise carry to a sibling`, () => {
      const tamper = defineDomain(('tamper' + label.length) as never, [], {
        state: () => ({ n: 1 }),
        actions: {},
        views: {
          bad: {
            $: 'view',
            input: (state: object) => {
              attack(state)
              return 0
            },
            transform: (v: unknown) => v,
          },
          sibling: { $: 'view', input: (state: { n: number }) => state.n, transform: (n: number) => n },
        },
      } as never)

      const realGetPrototypeOf = Object.getPrototypeOf
      after(() => {
        Object.getPrototypeOf = realGetPrototypeOf
      })

      expect(() => createScope({ name: 'tamper-' + label.length, domains: [tamper] as never })).to.throw(
        TypeError,
        /Unable to write '(n|bad|sibling|Symbol\(tamper\)|\[\[Prototype\]\]|\[\[Extensible\]\])' while resolving the views of domain/,
      )
    })
  }

  it('still refuses a write made after the selector resolved another view', () => {
    expect(() => createScope({ name: 'v14', domains: [nestedWrite] })).to.throw(
      TypeError,
      /Unable to write 'written' while resolving the views of domain 'nestedWrite'/,
    )
  })

  it('detects a cycle at scope creation, not at first use', () => {
    expect(() => createScope({ name: 'v6', domains: [cyclic] })).to.throw(/depends on itself/)
  })

  it('names written and view keys the same way across Object.keys, Reflect.ownKeys, "in" and for...in — without resolving anything', () => {
    createScope({ name: 'enumBasic1', domains: [enumBasic] })

    expect(enumBasicKeys.sort()).to.deep.equal(['doubled', 'n'])
    expect(enumBasicReflectKeys.sort()).to.deep.equal(['doubled', 'n'])
    expect(enumBasicHasDoubled).to.equal(true)
    expect(enumBasicHasMissing).to.equal(false)
    expect(enumBasicForIn.sort()).to.deep.equal(['doubled', 'n'])
  })

  it('a view whose selector fully enumerates the lens — spread, Object.entries, or JSON.stringify — depends on itself, the same as a direct self-read would', () => {
    const dependsOnSelf = (domain: string) =>
      new RegExp(`Unable to resolve view '${domain}\\.mirror': it depends on itself, through \\[mirror\\]`)

    expect(() => createScope({ name: 'sc1', domains: [spreadCycle] })).to.throw(dependsOnSelf('enumSpreadCycle'))
    expect(() => createScope({ name: 'sc2', domains: [entriesCycle] })).to.throw(dependsOnSelf('enumEntriesCycle'))
    expect(() => createScope({ name: 'sc3', domains: [jsonCycle] })).to.throw(dependsOnSelf('enumJsonCycle'))
  })

  it('names a throwing view without resolving it — enumeration is safe even when a real read is not', () => {
    expect(() => createScope({ name: 'enumThrow1', domains: [enumThrow] })).to.throw(/boom exploded/)

    expect(enumThrowProbeKeys.sort()).to.deep.equal(['boom', 'n', 'probe'])
  })

  it('two views that both spread the lens do not deadlock on each other — the first one touched hits itself', () => {
    expect(() => createScope({ name: 'twoSpread1', domains: [twoSpread] })).to.throw(
      /Unable to resolve view 'twoSpread\.a': it depends on itself, through \[a\]/,
    )
  })

  it('a real dependency on a view that spreads the lens back becomes a cycle, because the spread now genuinely reads it', () => {
    expect(() => createScope({ name: 'crossSpread1', domains: [crossSpread] })).to.throw(
      /Unable to resolve view 'crossSpread\.probe': it depends on itself, through \[probe -> mirror\]/,
    )
  })

  it('Object.entries, spread and JSON.stringify all succeed with real resolved values on a domain that actually has views', () => {
    createScope({ name: 'multiEnum1', domains: [multiEnum] })
    expect(multiReport?.entries).to.deep.equal([
      ['n', 2],
      ['other', 3],
      ['double', 4],
      ['triple', 9],
    ])
    expect(multiReport?.spread).to.deep.equal({ n: 2, other: 3, double: 4, triple: 9 })
    expect(multiReport?.json).to.deep.equal({ n: 2, other: 3, double: 4, triple: 9 })
  })

  it('reports a cycle in either declaration order when a view spreads the lens', () => {
    // Spreading the lens reads every view accessor, including the spreader's own, so the spread is
    // a self-dependency. An identity selector now keeps its siblings rather than degrading to a
    // written-only snapshot, so it takes part in the cycle instead of hiding it in one order.
    for (const [name, domain] of [
      ['poisonForward1', poisonForward],
      ['poisonReverse1', poisonReverse],
    ] as const) {
      expect(() => createScope({ name, domains: [domain] })).to.throw(/it depends on itself, through \[/)
      expect(() => createScope({ name, domains: [domain] })).to.throw(/spreader/)
    }
  })

  it('an ordinary view resolved after an escaped-lens view still agrees across Object.keys, Reflect.ownKeys and "in" — the escape does not poison later enumeration in the same pass, including across a fold', async () => {
    const scope = createScope({ name: 'poisonOrdinary1', domains: [poisonOrdinary] })

    expect(poisonOrdinaryKeys.sort()).to.deep.equal(['escaped', 'n', 'other'])
    expect(poisonOrdinaryReflectKeys.sort()).to.deep.equal(['escaped', 'n', 'other'])
    expect(poisonOrdinaryHasEscaped).to.equal(true)
    expect(scope.read('poisonOrdinary').other).to.equal(10)

    await scope.emit('poisonOrdinary.bump')
    expect(scope.read('poisonOrdinary').other).to.equal(20)
    expect(poisonOrdinaryKeys.sort()).to.deep.equal(['escaped', 'n', 'other'])
  })

  it('refuses a lens returned inside a container, naming the path and what to return instead', () => {
    expect(() => createScope({ name: 'escapeClass1', domains: [escapeClass] })).to.throw(
      TypeError,
      /Unable to accept the input of view 'escapeClass\.escape\w+'.*: an accessor property is not a supported state value/,
    )

    expect(() => createScope({ name: 'escapeClass2', domains: [escapeClass] })).to.throw(
      /return a plain copy of what it needs instead/,
    )
  })

  it('refuses it on the fold that first escapes, not only at construction', async () => {
    const scope = createScope({ name: 'escapeConditional1', domains: [escapeConditional] })
    expect(scope.read('escapeConditional').sibling).to.equal(10)

    await rejects(scope.emit('escapeConditional.flip'), /an accessor property is not a supported state value/)
  })

  for (const count of [2, 3]) {
    it(`${count} whole-state selectors construct, and none of them reaches another`, () => {
      const seen: Record<string, unknown>[] = []
      const views: Record<string, unknown> = {}

      for (let i = 0; i < count; i += 1) {
        views['w' + i] = {
          $: 'view',
          input: (state: unknown) => state,
          transform: (value: unknown) => {
            seen.push(value as Record<string, unknown>)
            return i
          },
        }
      }

      const domain = defineDomain(('whole' + count) as never, [], {
        state: () => ({ n: 7 }),
        actions: {},
        views,
      } as never)

      createScope({ name: 'whole-' + count, domains: [domain] as never })

      expect(seen).to.have.length(count)
      // Symmetric by construction: a whole-state selector sees written state plus siblings that are
      // not themselves whole-state selectors. Here every sibling is one, so every input is the same.
      for (const input of seen) {
        expect(input).to.deep.equal({ n: 7 })
      }
    })
  }

  it('an identity selector keeps its sibling views', () => {
    let seen: Record<string, unknown> | undefined

    const mirror = defineDomain('mirrorViews' as never, [], {
      state: () => ({ n: 3 }),
      actions: {},
      views: {
        doubled: { $: 'view', input: (s: { n: number }) => s.n, transform: (n: number) => n * 2 },
        whole: {
          $: 'view',
          input: (s: unknown) => s,
          transform: (v: unknown) => {
            seen = v as Record<string, unknown>
            return 0
          },
        },
      },
    } as never)

    createScope({ name: 'mirror-views', domains: [mirror] as never })

    expect(seen).to.deep.equal({ n: 3, doubled: 6 })
  })

  it('describes a view key with a descriptor that has a getter, so descriptor-copying code keeps it', () => {
    let descriptor: PropertyDescriptor | undefined
    let copied: Record<string, unknown> | undefined

    const described = defineDomain('describedViews' as never, [], {
      state: () => ({ n: 4 }),
      actions: {},
      views: {
        doubled: { $: 'view', input: (s: { n: number }) => s.n, transform: (n: number) => n * 2 },
        probe: {
          $: 'view',
          input: (s: unknown) => {
            descriptor = Object.getOwnPropertyDescriptor(s as object, 'doubled')
            copied = Object.defineProperties({}, Object.getOwnPropertyDescriptors(s as object)) as Record<
              string,
              unknown
            >
            return 0
          },
          transform: (v: unknown) => v,
        },
      },
    } as never)

    createScope({ name: 'described-views', domains: [described] as never })

    expect(descriptor?.get, 'the descriptor carries the accessor').to.be.a('function')
    expect(descriptor?.enumerable).to.equal(true)
    expect(copied?.doubled, 'a descriptor copy resolves to the same value').to.equal(8)
  })

  it('a neighbour reads views as ordinary state', async () => {
    const scope = createScope({ name: 'v7', domains: [cart, session] })
    await scope.emit('cart.add', { sku: 'SKU-1', qty: 2 })
    await flush()

    const asNeighbourSees = scope.read('cart')
    expect(asNeighbourSees.total).to.equal(24)
    expect(asNeighbourSees.items).to.have.length(1)
  })
})
