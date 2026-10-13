import { expect } from 'chai'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { createScope, defineDomain, reduce, view, watch } from '../src/index'
import type { DomainType, Reduce } from '../src/index'
import { checkState, cloneState, freezeState, inDevelopment } from '../src/internal/state-value'
import { isEqual } from '../src/internal/equal'
import { flush } from '../src/testing'
import { cart, session } from './fixtures'
import { buildModeProbe } from './helpers'

type CarriedState = { value: unknown }
type CarriedActions = { set: Reduce<{ value: unknown }> }

type LensState = { n: number }
type LensViews = { peek: number }
type LensActions = { bump: Reduce }

type WatchedState = { n: number }
type WatchedActions = { bump: Reduce }

type RollbackState = { ok: boolean; blob: unknown }
type RollbackActions = { bad: Reduce; good: Reduce }

type PollutingState = { n: number }
type PollutingActions = { set: Reduce }

type DatedState = { at: Date; n: number }
type DatedActions = { stamp: Reduce<Date>; bump: Reduce }
type DatedViews = { later: Date; epochStart: Date }

declare module '../src/types' {
  interface Domains {
    carried: DomainType<CarriedState, CarriedActions>
    dated: DomainType<DatedState, DatedActions, DatedViews>
    datedValue: DomainType<DatedState, DatedActions>
    carriedFactory: DomainType<CarriedState, CarriedActions>
    lens: DomainType<LensState, LensActions, LensViews>
    watched: DomainType<WatchedState, WatchedActions>
    rollback: DomainType<RollbackState, RollbackActions>
    polluting: DomainType<PollutingState, PollutingActions>
  }
}

let lensMode: 'ok' | 'badInput' | 'badValue' | 'writes' | 'deletes' | 'defines' = 'ok'
let watchMode: 'ok' | 'bad' = 'ok'

const carried = defineDomain('carried', [], {
  state: { value: null },
  actions: { set: reduce((_state, action) => ({ value: action.input.value })) },
})

const lens = defineDomain('lens', [], {
  state: () => ({ n: 1 }),
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },
  views: {
    peek: view(
      state => {
        if (lensMode === 'writes') {
          ;(state as { n: number }).n = 99
        }

        if (lensMode === 'deletes') {
          delete (state as { n?: number }).n
        }
        if (lensMode === 'defines') {
          Object.defineProperty(state, 'injected', { value: 7, enumerable: true, configurable: true })
        }
        return lensMode === 'badInput' ? ({ nope: () => undefined } as never) : state.n
      },
      () => (lensMode === 'badValue' ? (new Uint8Array(1) as never) : 1),
    ),
  },
})

const watched = defineDomain('watched', [], {
  state: () => ({ n: 0 }),
  actions: { bump: reduce(state => ({ n: state.n + 1 })) },
  watch: {
    seen: watch(
      state => (watchMode === 'bad' ? { nope: () => undefined } : state.n),
      () => undefined,
    ),
  },
})

const datedRuns = { laterInputs: 0, laterTransforms: 0, epochTransforms: 0, sources: 0, handlers: 0 }

const dated = defineDomain('dated', [], {
  state: () => ({ at: new Date(0), n: 0 }),
  actions: {
    stamp: reduce((_state, action) => ({ at: action.input })),
    bump: reduce(state => ({ n: state.n + 1 })),
  },
  views: {
    later: view(
      state => {
        datedRuns.laterInputs += 1
        return state.at
      },
      at => {
        datedRuns.laterTransforms += 1
        return new Date(at.getTime() + 1)
      },
    ),
    // Input is `n`, so a bump re-runs the transform; the output is a fresh Date equal to the last.
    epochStart: view(
      state => state.n,
      () => {
        datedRuns.epochTransforms += 1
        return new Date(0)
      },
    ),
  },
  watch: {
    at: watch(
      state => {
        datedRuns.sources += 1
        return new Date(state.at.getTime())
      },
      () => {
        datedRuns.handlers += 1
      },
    ),
  },
})

const datedValue = defineDomain('datedValue', [], {
  state: { at: new Date(0), n: 0 },
  actions: {
    stamp: reduce((_state, action) => ({ at: action.input })),
    bump: reduce(state => ({ n: state.n + 1 })),
  },
})

const rejects = (value: unknown, matching: RegExp) => {
  expect(() => checkState(value, 'a probe')).to.throw(TypeError, matching)
}

describe('supported state values', () => {
  beforeEach(() => {
    lensMode = 'ok'
    watchMode = 'ok'
  })

  afterEach(() => {})

  it('runs at all, which every other case here assumes', () => {
    expect(inDevelopment).to.equal(true)
  })

  describe('what the contract refuses', () => {
    it('a symbol, as a value or as a key', () => {
      rejects({ tag: Symbol('nope') }, /\.tag: a symbol is not a supported/)
      rejects({ [Symbol('nope')]: 1 }, /a symbol key \(Symbol\(nope\)\) is not a supported/)
    })

    it('a function', () => {
      rejects({ run: () => undefined }, /\.run: a function is not a supported/)
    })

    it('a property one past the last array index, which is not an index at all', () => {
      const past: unknown[] = [1]
      past['4294967295' as unknown as number] = 'ignored'
      rejects({ list: past }, /a custom property '4294967295' on an array/)

      const last: unknown[] = [1]
      last['4294967294' as unknown as number] = 'kept'
      expect(() => checkState({ list: last }, 'a probe')).not.to.throw()
    })

    it('an accessor or a non-enumerable property in an array element position', () => {
      const accessor: unknown[] = [1]
      Object.defineProperty(accessor, '0', { get: () => 1, enumerable: true, configurable: true })
      rejects({ list: accessor }, /\[0\]: an accessor property/)

      const hidden: unknown[] = [1]
      Object.defineProperty(hidden, '0', { value: 1, enumerable: false, configurable: true })
      rejects({ list: hidden }, /\[0\]: a non-enumerable property/)
    })

    it('an object with a null prototype', () => {
      rejects({ bare: Object.assign(Object.create(null), { a: 1 }) }, /\.bare: an object with a null prototype/)
    })

    it('a class instance', () => {
      class Money {
        constructor(public cents: number) {}
      }
      rejects({ balance: new Money(1) }, /\.balance: an instance of Money/)
    })

    it('an object whose prototype chain is shaped like a plain object, but is not one', () => {
      class NullBased {}
      Object.setPrototypeOf(NullBased.prototype, null)
      rejects({ odd: new NullBased() }, /\.odd: an instance of NullBased/)

      const named = Object.create(null) as { constructor: { name: string } }
      named.constructor = { name: 'Widget' }
      rejects({ odd: Object.create(named) as object }, /\.odd: an instance of Widget/)

      rejects({ odd: Object.create(Object.create(null)) as object }, /\.odd: an object of no recognised kind/)
    })

    it('a typed array, an ArrayBuffer and a DataView', () => {
      rejects({ bytes: new Uint8Array(2) }, /\.bytes: an instance of Uint8Array/)
      rejects({ buffer: new ArrayBuffer(2) }, /\.buffer: an instance of ArrayBuffer/)
      rejects({ view: new DataView(new ArrayBuffer(2)) }, /\.view: an instance of DataView/)
    })

    it('an accessor, and a non-enumerable data property', () => {
      rejects(Object.defineProperty({}, 'lazy', { get: () => 1, enumerable: true }), /\.lazy: an accessor property/)
      rejects(Object.defineProperty({}, 'hidden', { value: 1 }), /\.hidden: a non-enumerable property/)
    })

    it('an unsupported value nested inside a supported container', () => {
      rejects({ a: { b: [{ c: new Uint8Array(1) }] } }, /\.a\.b\[0\]\.c: an instance of Uint8Array/)
      rejects({ a: [{ b: () => undefined }] }, /\.a\[0\]\.b: a function/)
      rejects({ a: { b: [Symbol('nope')] } }, /\.a\.b\[0\]: a symbol/)
    })

    it('an unsupported value the consumer froze first, which is not the same as validated', () => {
      class Money {
        constructor(public cents: number) {}
      }
      rejects({ balance: Object.freeze(new Money(1)) }, /\.balance: an instance of Money/)
      rejects({ bare: Object.freeze(Object.create(null)) }, /\.bare: an object with a null prototype/)
      rejects({ weak: Object.freeze(new WeakMap()) }, /\.weak: an instance of WeakMap/)
      rejects({ at: Object.freeze(new (class Timestamp extends Date {})()) }, /\.at: an instance of Timestamp/)
      rejects(Object.freeze({ label: Object.freeze(new Map()) }), /a Map is not a supported state value/)

      rejects(Object.freeze({ onDeposit: () => undefined }), /\.onDeposit: a function/)
      rejects(Object.freeze({ tag: Symbol('nope') }), /\.tag: a symbol/)
    })
  })

  describe('the four types the state model retired', () => {
    it('refuses each by name, and says what to carry instead', () => {
      for (const [value, named] of [
        [new Map([['k', 1]]), 'a Map'],
        [new Set([1]), 'a Set'],
        [/x/g, 'a RegExp'],
        [new Error('nope'), 'an Error'],
      ] as const) {
        rejects({ held: value }, new RegExp(`\\.held: ${named} is not a supported state value`))
        rejects({ held: value }, /carry it as plain data/)
      }
    })

    it('refuses them nested, wherever they are', () => {
      rejects({ a: [{ b: /x/g }] }, /\.a\[0\]\.b: a RegExp is not a supported state value/)
      rejects({ a: { b: { c: new Map() } } }, /\.a\.b\.c: a Map is not a supported state value/)
    })

    it('refuses a subclass of one under the name of the type it is', () => {
      rejects({ label: new (class Tag extends Map {})() }, /a Map is not a supported state value/)
    })
  })

  describe('a Date at ingress', () => {
    it('is accepted, nested anywhere, invalid included', () => {
      expect(() => checkState({ at: new Date(0), rows: [{ when: new Date(NaN) }] }, 'a probe')).to.not.throw()
    })

    it('reaches every ingress: both seeds, a fold, a view input, a view value, a watcher, a preload', async () => {
      const scope = createScope({
        name: 'dated-ingress',
        domains: [dated, datedValue],
        preloadedState: { datedValue: { at: new Date(5) } },
      })
      expect(scope.read('dated').at.getTime()).to.equal(0)
      expect(scope.read('dated').later.getTime()).to.equal(1)
      expect(scope.read('datedValue').at.getTime()).to.equal(5)

      await scope.emit('dated.stamp', new Date(10))
      expect(scope.read('dated').at.getTime()).to.equal(10)
      expect(scope.read('dated').later.getTime()).to.equal(11)
      scope.dispose()
    })

    it('refuses one decorated by any single key class, by path, naming the key', () => {
      rejects(
        { at: Object.assign(new Date(0), { note: 'x' }) },
        /\.at: a Date carrying a custom property 'note' is not/,
      )
      rejects(
        { at: Object.defineProperty(new Date(0), 'hidden', { value: 1, enumerable: false }) },
        /\.at: a Date carrying a custom property 'hidden' is not/,
      )
      rejects(
        { at: Object.defineProperty(new Date(0), Symbol('tag'), { value: 1 }) },
        /\.at: a Date carrying a symbol key \(Symbol\(tag\)\) is not/,
      )
      let read = 0
      const accessor = Object.defineProperty(new Date(0), 'boom', {
        get() {
          read += 1
          throw new Error('read')
        },
        enumerable: true,
      })
      rejects({ at: accessor }, /\.at: a Date carrying a custom property 'boom' is not/)
      expect(read, 'the accessor was never invoked').to.equal(0)
    })

    it('refuses a Date from another realm, an object wearing its prototype, and a subclass, each by name', () => {
      rejects({ at: runInNewContext('new Date(0)') as object }, /\.at: a Date from another realm is not/)
      rejects(
        { at: Object.create(Date.prototype) as object },
        /\.at: an object with Date's prototype and no time value is not/,
      )
      rejects({ at: new (class Timestamp extends Date {})(0) }, /\.at: an instance of Timestamp is not/)
    })

    // `Object.freeze` seals properties; a Date's time value is an internal slot. The freeze runs
    // and achieves nothing, which the State page says: treat a Date as a value and build a new one.
    it('cannot stop a Date being mutated in place, which is the documented limit of the freeze', () => {
      const scope = createScope({ name: 'dated-freeze', domains: [dated] })
      const at = scope.read('dated').at
      expect(Object.isFrozen(at)).to.equal(true)
      at.setTime(99)
      expect(scope.read('dated').at.getTime(), 'the committed value moved with no fold').to.equal(99)
      scope.dispose()
    })
  })

  describe('a Date through the scope', () => {
    beforeEach(() => {
      for (const key of Object.keys(datedRuns) as (keyof typeof datedRuns)[]) {
        datedRuns[key] = 0
      }
    })

    it('folds an equal Date as a no-op: same root, no notification', async () => {
      const scope = createScope({ name: 'dated-noop', domains: [dated] })
      let notified = 0
      scope.subscribe(() => {
        notified += 1
      })
      const before = scope.read('dated')
      await scope.emit('dated.stamp', new Date(0))
      expect(scope.read('dated')).to.equal(before)
      expect(notified).to.equal(0)
      scope.dispose()
    })

    it('re-runs a view selector when another field moves, and skips the transform for an equal Date input', async () => {
      const scope = createScope({ name: 'dated-view', domains: [dated] })
      const later = scope.read('dated').later
      const inputs = datedRuns.laterInputs
      const transforms = datedRuns.laterTransforms
      await scope.emit('dated.bump')
      expect(datedRuns.laterInputs, 'the selector re-ran').to.be.greaterThan(inputs)
      expect(datedRuns.laterTransforms, 'the transform did not').to.equal(transforms)
      expect(scope.read('dated').later).to.equal(later)
      await scope.emit('dated.stamp', new Date(10))
      expect(datedRuns.laterTransforms).to.equal(transforms + 1)
      expect(scope.read('dated').later.getTime()).to.equal(11)
      scope.dispose()
    })

    it('keeps the published Date when a transform that did run returns an equal one', async () => {
      const scope = createScope({ name: 'dated-transform', domains: [dated] })
      const start = scope.read('dated').epochStart
      const transforms = datedRuns.epochTransforms
      await scope.emit('dated.bump')
      expect(datedRuns.epochTransforms, 'the transform ran on a moved input').to.equal(transforms + 1)
      expect(scope.read('dated').epochStart, 'and its equal result kept the reference').to.equal(start)
      scope.dispose()
    })

    it('re-runs a watcher source that returns a fresh equal Date, and keeps the handler quiet', async () => {
      const scope = createScope({ name: 'dated-watch', domains: [dated] })
      const sources = datedRuns.sources
      await scope.emit('dated.bump')
      expect(datedRuns.sources, 'the source re-ran').to.be.greaterThan(sources)
      expect(datedRuns.handlers).to.equal(0)
      await scope.emit('dated.stamp', new Date(7))
      expect(datedRuns.handlers).to.equal(1)
      scope.dispose()
    })

    it('round-trips a Date through getWrittenState and preloadedState without JSON', async () => {
      const first = createScope({ name: 'dated-first', domains: [dated, datedValue] })
      await first.emit('dated.stamp', new Date(1_700_000_000_000))
      const saved = first.getWrittenState()
      expect(saved.dated.at).to.be.instanceOf(Date)
      expect(saved.dated.at).to.not.equal(first.read('dated').at)
      const second = createScope({ name: 'dated-second', domains: [dated, datedValue], preloadedState: saved })
      expect(second.read('dated').at.getTime()).to.equal(1_700_000_000_000)
      expect(second.read('dated').later.getTime()).to.equal(1_700_000_000_001)
      first.dispose()
      second.dispose()
    })

    it('accepts a Date value seed and preload in a production build, and hands a Date back', function () {
      this.timeout(20000)
      expect(
        buildModeProbe(
          `const stamped = eddy.defineDomain('stamped', [], {
             state: { at: new Date(0) },
             actions: { set: eddy.reduce((s, a) => ({ at: a.input })) },
           })
           const scope = eddy.createScope({ domains: [stamped], preloadedState: { stamped: { at: new Date(5) } } })
           const out = scope.getWrittenState().stamped.at
           console.log('KIND:' + Object.prototype.toString.call(out) + ':' + out.getTime() + ':' + (out !== scope.read('stamped').at))`,
          { env: { NODE_ENV: 'production' } },
        ),
      ).to.deep.equal(['KIND:[object Date]:5:true'])
    })
  })

  describe('an array from another realm', () => {
    const foreign = runInNewContext('[1, 2, 3]') as number[]

    it('is refused at ingress, where a local array is accepted', () => {
      expect(Array.isArray(foreign)).to.equal(true)
      rejects({ items: foreign }, /\.items: an array from another realm is not a supported state value/)
      expect(() => checkState({ items: [1, 2, 3] }, 'a probe')).to.not.throw()
    })

    it('is refused because equality could never match it against a local twin', () => {
      expect(isEqual(foreign, [1, 2, 3])).to.equal(false)
    })
  })

  describe('what the contract accepts', () => {
    const accepts = (value: unknown) => expect(() => checkState(value, 'a probe')).to.not.throw()

    it('primitives, NaN and bigint included', () => {
      accepts({ a: undefined, b: null, c: false, d: NaN, e: 'x', f: 1n })
    })

    it('a sparse array, holes and all', () => {
      const sparse = [1]
      sparse[3] = 4
      accepts(sparse)
      expect(Object.hasOwn(sparse, 1)).to.equal(false)
    })

    it('a cyclic plain object, rather than recursing forever', () => {
      const cyclic: Record<string, unknown> = { name: 'root' }
      cyclic.self = cyclic
      cyclic.list = [cyclic]
      accepts(cyclic)
    })
  })

  describe('where the check runs', () => {
    it('the seed of a value-form domain', () => {
      const bad = defineDomain('carried', [], {
        state: { value: new Uint8Array(1) },
        actions: { set: reduce(state => state) },
      })
      expect(() => createScope({ name: 'i1', domains: [bad] })).to.throw(
        /the seed for domain 'carried'\.value: an instance of Uint8Array/,
      )
    })

    it('the seed of a factory-form domain, which never reaches structuredClone', () => {
      const bad = defineDomain('carriedFactory', [], {
        state: () => ({ value: new Uint8Array(1) }),
        actions: { set: reduce(state => state) },
      })
      expect(() => createScope({ name: 'i2', domains: [bad] })).to.throw(
        /the seed for domain 'carriedFactory'\.value: an instance of Uint8Array/,
      )
    })

    it('the partial a reducer folds', async () => {
      const scope = createScope({ name: 'i3', domains: [carried] })
      const outcome = await scope.emit('carried.set', { value: () => undefined }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(outcome).to.be.instanceOf(TypeError)
      expect(String((outcome as Error).message)).to.match(
        /the state 'carried\.set' folds into domain 'carried'\.value: a function/,
      )
    })

    it("a view's input", () => {
      lensMode = 'badInput'
      expect(() => createScope({ name: 'i4', domains: [lens] })).to.throw(
        /the input of view 'lens\.peek'\.nope: a function/,
      )
    })

    it("a view's computed value", () => {
      lensMode = 'badValue'
      expect(() => createScope({ name: 'i5', domains: [lens] })).to.throw(
        /the value of view 'lens\.peek': an instance of Uint8Array/,
      )
    })

    it("a watcher's seeded value, which never came from a reducer", () => {
      watchMode = 'bad'
      expect(() => createScope({ name: 'i6', domains: [watched] })).to.throw(
        /the value watched by 'watched\.seen'\.nope: a function/,
      )
    })

    it("a watcher's value on a later comparison", async () => {
      const errors: unknown[] = []
      const scope = createScope({
        name: 'i7',
        domains: [watched],
        onUnhandledError: error => errors.push(error),
      })
      watchMode = 'bad'

      await scope.emit('watched.bump')

      expect(errors).to.have.lengthOf(1)
      expect(errors[0]).to.be.instanceOf(TypeError)
      expect(String((errors[0] as Error).message)).to.match(/the value watched by 'watched\.seen'\.nope: a function/)

      expect(scope.read('watched').n).to.equal(1)
    })
  })

  describe('the development freeze', () => {
    it('reaches nested state, which is the dangerous case: a nested write defeats change detection', () => {
      const scope = createScope({ name: 'f1', domains: [cart, session] })

      expect(() => scope.read('cart').items.push({ id: 'x', sku: 'x', qty: 1, price: 1 })).to.throw(TypeError)

      expect(() => Object.assign(scope.read('cart'), { taxRate: 0 })).to.throw(TypeError)
    })

    it('reaches the root object getState hands out', () => {
      const scope = createScope({ name: 'f2', domains: [cart, session] })

      expect(() => Object.assign(scope.getState(), { cart: {} })).to.throw(TypeError)
    })

    it('reaches through a container the consumer froze first', () => {
      const seen = ['a']
      const value = { audit: Object.freeze({ seen }) }
      checkState(value, 'a probe')
      freezeState(value)

      expect(Object.isFrozen(seen)).to.equal(true)
      expect(() => seen.push('leaked')).to.throw(TypeError)
    })

    it('survives reassembly, so state stays frozen after a fold', async () => {
      const scope = createScope({ name: 'f3', domains: [cart, session] })

      await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      await flush()

      const items = scope.read('cart').items
      expect(items).to.have.length(1)
      expect(() => Object.assign(items[0], { qty: 99 })).to.throw(TypeError)
    })

    it('does not clone, so the reference-stability contract still holds', async () => {
      const scope = createScope({ name: 'f4', domains: [cart, session] })
      const before = scope.read('cart')

      await scope.emit('cart.clear')

      expect(scope.read('cart')).to.equal(before)
    })

    it('refuses a write through a view input selector', () => {
      lensMode = 'writes'
      expect(() => createScope({ name: 'f5', domains: [lens] })).to.throw(
        TypeError,
        /Unable to write 'n' while resolving the views of domain 'lens'/,
      )
    })

    it('refuses the other two ways a selector can write', () => {
      lensMode = 'deletes'
      expect(() => createScope({ name: 'f5b', domains: [lens] })).to.throw(
        TypeError,
        /Unable to write 'n' while resolving the views of domain 'lens'/,
      )

      lensMode = 'defines'
      expect(() => createScope({ name: 'f5c', domains: [lens] })).to.throw(
        TypeError,
        /Unable to write 'injected' while resolving the views of domain 'lens'/,
      )
    })
  })

  describe('build mode', () => {
    const PROBE = `
const attempt = fn => {
  try {
    fn()
    return 'allowed'
  } catch (error) {
    return error.constructor.name
  }
}

const domain = eddy.defineDomain('probe', [], {
  state: { items: [{ qty: 1 }] },
  actions: { noop: eddy.reduce({}) },
})
const scope = eddy.createScope({ domains: [domain] })

console.log('FROZEN:' + Object.isFrozen(scope.read('probe')))
console.log('PUSH:' + attempt(() => scope.read('probe').items.push({ qty: 2 })))
console.log('NESTED:' + attempt(() => Object.assign(scope.read('probe').items[0], { qty: 7 })))
console.log('ROOT:' + attempt(() => Object.assign(scope.getState(), { probe: 'clobbered' })))

const unsupported = eddy.defineDomain('unsupported', [], {
  state: () => ({ bytes: new Uint8Array(2) }),
  actions: { noop: eddy.reduce({}) },
})
console.log('VALIDATED:' + attempt(() => eddy.createScope({ domains: [unsupported] })))

const writer = eddy.defineDomain('writer', [], {
  state: { n: 1 },
  actions: { noop: eddy.reduce({}) },
  views: {
    peek: eddy.view(
      s => {
        s.n = 99
        return s.n
      },
      v => v,
    ),
  },
})
console.log('LENSWRITE:' + attempt(() => eddy.createScope({ domains: [writer] })))
`

    it('NODE_ENV=production neither validates nor freezes', function () {
      this.timeout(60000)
      expect(buildModeProbe(PROBE, { env: { NODE_ENV: 'production' } })).to.deep.equal([
        'FROZEN:false',
        'PUSH:allowed',
        'NESTED:allowed',
        'ROOT:allowed',
        'VALIDATED:allowed',
        'LENSWRITE:allowed',
      ])
    })

    it('an absent process is production too, so a direct browser load pays nothing', function () {
      this.timeout(60000)
      expect(buildModeProbe(PROBE, { withoutProcess: true, env: { NODE_ENV: 'development' } })).to.deep.equal([
        'FROZEN:false',
        'PUSH:allowed',
        'NESTED:allowed',
        'ROOT:allowed',
        'VALIDATED:allowed',
        'LENSWRITE:allowed',
      ])
    })

    it('a process without env loads, and is production like an absent one', function () {
      this.timeout(60000)
      expect(buildModeProbe(PROBE, { withPartialProcess: true, env: { NODE_ENV: 'development' } })).to.deep.equal([
        'FROZEN:false',
        'PUSH:allowed',
        'NESTED:allowed',
        'ROOT:allowed',
        'VALIDATED:allowed',
        'LENSWRITE:allowed',
      ])
    })

    it('NODE_ENV unset is development', function () {
      this.timeout(60000)
      expect(buildModeProbe(PROBE, { env: { NODE_ENV: '' } })).to.deep.equal([
        'FROZEN:true',
        'PUSH:TypeError',
        'NESTED:TypeError',
        'ROOT:TypeError',
        'VALIDATED:TypeError',
        'LENSWRITE:TypeError',
      ])
    })

    // In a production build nothing inspects a value seed: `checkState` returns immediately when
    // `!inDevelopment`, and there is no deep clone to trip over it (React Native has no
    // `structuredClone`). These pin that narrowing so it stays visible rather than silent.
    it('accepts in production a value seed that development refuses, having no ingress check left', function () {
      this.timeout(60000)
      const lines = buildModeProbe(
        `
const domain = eddy.defineDomain('unclonable', [], {
  state: { onDeposit: () => {} },
  actions: { noop: eddy.reduce({}) },
})
try {
  eddy.createScope({ domains: [domain] })
  console.log('SEEDED')
} catch (error) {
  console.log('THREW:' + error.message)
}
`,
        { env: { NODE_ENV: 'production' } },
      )
      expect(lines[0], 'production no longer inspects a value seed at all').to.equal('SEEDED')
    })

    it('carries its own keys into production', function () {
      this.timeout(60000)
      const lines = buildModeProbe(
        `
const lossy = eddy.defineDomain('lossy', [], {
  state: { value: Object.assign(new Error('nope'), { code: 'ERR_TAG', status: 500 }) },
  actions: { noop: eddy.reduce({}) },
})
const seeded = eddy.createScope({ domains: [lossy] }).read('lossy').value
console.log('DROPPED:' + seeded.message + ':' + seeded.code)
`,
        { env: { NODE_ENV: 'production' } },
      )
      // Nothing copies an Error's custom own keys away, so what the author wrote is what production
      // holds.
      expect(lines[0]).to.equal('DROPPED:nope:ERR_TAG')
    })

    it('reads a production seed only where structuredClone does, so a hidden hostile node is not its business', function () {
      this.timeout(60000)

      const lines = buildModeProbe(
        `
const seed = { ok: 1 }
Object.defineProperty(seed, 'hidden', {
  value: new Proxy({}, { ownKeys() { throw new Error('ownKeys blew up') } }),
  enumerable: false,
})
const domain = eddy.defineDomain('hidden', [], { state: seed, actions: { noop: eddy.reduce({}) } })
try {
  console.log('SEEDED:' + eddy.createScope({ domains: [domain] }).read('hidden').ok)
} catch (error) {
  console.log('THREW:' + error.message)
}
`,
        { env: { NODE_ENV: 'production' } },
      )
      expect(lines[0]).to.equal('SEEDED:1')
    })

    it('reads a production seed once, and a throwing getter is no longer named as a clone failure', function () {
      this.timeout(60000)

      const lines = buildModeProbe(
        `
const hostile = eddy.defineDomain('hostile', [], {
  state: { get boom() { throw new Error('getter blew up') } },
  actions: { noop: eddy.reduce({}) },
})
try {
  eddy.createScope({ domains: [hostile] })
  console.log('SEEDED')
} catch (error) {
  console.log('THREW:' + error.message)
}

let calls = 0
const counted = eddy.defineDomain('counted', [], {
  state: { get n() { calls++; return 1 } },
  actions: { noop: eddy.reduce({}) },
})
eddy.createScope({ domains: [counted] })
console.log('CALLS:' + calls)
`,
        { env: { NODE_ENV: 'production' } },
      )
      // The getter's throw reaches the caller as its own. Reading exactly once is the part that
      // matters.
      expect(lines[0]).to.equal('THREW:getter blew up')
      expect(lines[1]).to.equal('CALLS:1')
    })
  })

  describe('the freeze and the transaction that produced it', () => {
    const rollbackDomain = (payload: object) =>
      defineDomain('rollback', [], {
        state: () => ({ ok: false, blob: null as unknown }),
        actions: {
          // The function is what the state contract refuses; `blob` is walked and reached first.
          bad: reduce(() => ({ blob: payload, boom: () => undefined }) as Partial<RollbackState>),
          good: reduce(() => ({ blob: payload })),
        },
      })

    it('leaves the caller its own object when the fold is refused', async () => {
      const owned = { tags: ['a'] }
      const scope = createScope({ name: 'rollback-refused', domains: [rollbackDomain(owned)] })

      await rejects(scope.emit('rollback.bad'), /not a supported state value/)

      expect(scope.read('rollback').blob, 'nothing was published').to.equal(null)
      expect(Object.isFrozen(owned), 'and nothing was frozen on the way out').to.equal(false)
      expect(() => owned.tags.push('b')).to.not.throw()
    })

    it('freezes what the fold actually committed', async () => {
      const owned = { tags: ['a'] }
      const scope = createScope({ name: 'rollback-committed', domains: [rollbackDomain(owned)] })

      await scope.emit('rollback.good')

      expect(scope.read('rollback').blob).to.equal(owned)
      expect(Object.isFrozen(owned)).to.equal(true)
      expect(() => owned.tags.push('b')).to.throw(TypeError)
    })

    it('reaches a deeply nested object, so the freeze is not a top-level gesture', async () => {
      const deep = { a: { b: { c: { leaf: ['x'] } } } }
      const scope = createScope({ name: 'rollback-deep', domains: [rollbackDomain(deep)] })

      await scope.emit('rollback.good')

      expect(Object.isFrozen(deep.a.b.c.leaf), 'the leaf is frozen, not just the root').to.equal(true)
      expect(() => deep.a.b.c.leaf.push('y')).to.throw(TypeError)
    })

    it('descends into a container the caller froze first, whose children it did not freeze', async () => {
      const child = { qty: 1 }
      const container = Object.freeze({ child })
      const scope = createScope({ name: 'rollback-prefrozen', domains: [rollbackDomain(container)] })

      await scope.emit('rollback.good')

      expect(Object.isFrozen(child), 'a frozen parent does not imply a frozen subtree').to.equal(true)
    })
  })

  // The clone is eddy's own, over supported state, because React Native has no `structuredClone`.
  // These pin the value space it must carry and the edge it must refuse.
  describe('carrying state out', () => {
    // Production trusts ingress, so a hostile `__proto__` can be in state by the time it is carried
    // out. The clone must not be what turns it into a hijack: `copy[key] = value` invokes the
    // prototype setter for that one key. An array can carry an enumerable own `__proto__` too, and
    // the same assignment runs the same setter.
    it('does the same for an array, which can carry an enumerable own __proto__ too', () => {
      const hostile: unknown[] = [1, 2]
      Object.defineProperty(hostile, '__proto__', {
        value: { isAdmin: true },
        enumerable: true,
        configurable: true,
        writable: true,
      })

      const copied = cloneState({ rows: hostile }, detail => `nope: ${detail}`) as { rows: unknown[] }

      expect(Object.getPrototypeOf(copied.rows), 'still an ordinary array').to.equal(Array.prototype)
      expect((copied.rows as { isAdmin?: unknown }).isAdmin, 'nothing inherited').to.equal(undefined)
      expect(copied.rows[0], 'and the real elements survive').to.equal(1)
    })

    it("carries an own __proto__ out as an own property instead of replacing the copy's prototype", () => {
      const hostile = JSON.parse('{"__proto__":{"isAdmin":true}}') as Record<string, unknown>
      const copied = cloneState({ user: hostile }, detail => `nope: ${detail}`) as { user: Record<string, unknown> }

      expect(Object.getPrototypeOf(copied.user), 'the copy keeps a plain prototype').to.equal(Object.prototype)
      expect((copied.user as { isAdmin?: unknown }).isAdmin, 'nothing is inherited from the payload').to.equal(
        undefined,
      )
      expect(Object.prototype.hasOwnProperty.call(copied.user, '__proto__'), 'the key survives as its own').to.equal(
        true,
      )
    })

    const carried = <T>(value: T): T => cloneState(value, detail => `nope — ${detail}`)

    it('keeps the five things a JSON round-trip destroys', () => {
      const sparse: unknown[] = [1]
      sparse[3] = 4
      const source: Record<string, unknown> = { u: undefined, n: NaN, b: 10n, sparse }
      source.self = source

      const copy = carried(source)

      expect('u' in copy && copy.u === undefined, 'an undefined value keeps its key').to.equal(true)
      expect(Number.isNaN(copy.n as number), 'NaN survives').to.equal(true)
      expect(copy.b, 'a bigint survives').to.equal(10n)
      expect(Object.hasOwn(copy.sparse as object, 1), 'a hole stays a hole').to.equal(false)
      expect((copy.sparse as unknown[]).length).to.equal(4)
      expect(copy.self, 'a cycle is rebuilt against the copy, not the source').to.equal(copy)
      expect(copy.self).to.not.equal(source)
    })

    it('copies rather than aliases, all the way down', () => {
      const source = { deep: { list: [{ n: 1 }] } }
      const copy = carried(source)

      expect(copy).to.deep.equal(source)
      expect(copy.deep).to.not.equal(source.deep)
      expect(copy.deep.list).to.not.equal(source.deep.list)
      expect(copy.deep.list[0]).to.not.equal(source.deep.list[0])
    })

    describe('a Date, carried out', () => {
      it('comes back as a distinct Date with the same time', () => {
        const at = new Date(1_700_000_000_000)
        const copy = carried({ at })
        expect(copy.at).to.not.equal(at)
        expect(copy.at).to.be.instanceOf(Date)
        expect(copy.at.getTime()).to.equal(at.getTime())
      })

      it('keeps an alias aliased, and an invalid Date invalid', () => {
        const at = new Date(0)
        const copy = carried({ a: at, b: at, bad: new Date(NaN) })
        expect(copy.a).to.equal(copy.b)
        expect(copy.a).to.not.equal(at)
        expect(Number.isNaN(copy.bad.getTime())).to.equal(true)
      })

      // Production seeds and preloads reach the clone with no walk before them, so the clone
      // carries only what the walk would have accepted and refuses the rest by name.
      it('refuses what only a walk would have refused, and keeps it by reference for a production seed', () => {
        const cases: [string, object, RegExp][] = [
          ['enumerable', Object.assign(new Date(0), { note: 'x' }), /a Date carrying a custom property 'note'/],
          [
            'hidden',
            Object.defineProperty(new Date(0), 'hidden', { value: 1, enumerable: false }),
            /a Date carrying a custom property 'hidden'/,
          ],
          [
            'symbol',
            Object.defineProperty(new Date(0), Symbol('tag'), { value: 1 }),
            /a Date carrying a symbol key \(Symbol\(tag\)\)/,
          ],
          ['foreign', runInNewContext('new Date(0)') as object, /a Date from another realm/],
          ['subclass', new (class Timestamp extends Date {})(0), /an instance of Timestamp/],
          ['forged', Object.create(Date.prototype) as object, /an object with Date's prototype and no time value/],
        ]
        for (const [label, at, message] of cases) {
          expect(() => carried({ at }), label).to.throw(message)
          expect(cloneState({ at }, detail => detail, true).at, `${label} preserved`).to.equal(at)
        }
      })
    })

    it('refuses what state may not hold, and the failure names the subject', () => {
      expect(() => carried({ run: () => undefined })).to.throw(/nope — a function/)
      expect(() => carried({ tag: Symbol('nope') })).to.throw(/nope — a symbol/)
      expect(() => carried({ at: /x/g })).to.throw(/nope — an instance of RegExp/)
      expect(() => carried({ bare: Object.create(null) as object })).to.throw(/nope — an object with a null prototype/)
    })
  })

  describe('a state key that reaches the prototype', () => {
    it('refuses __proto__ as a written field, in every build', async () => {
      const polluting = defineDomain('polluting', [], {
        state: () => ({ n: 0 }),
        actions: { set: reduce(() => JSON.parse('{"__proto__": {"polluted": true}}') as Partial<PollutingState>) },
      })
      const scope = createScope({ name: 'polluting', domains: [polluting] })

      const refusal = await scope.emit('polluting.set').then(
        () => undefined,
        (error: unknown) => String((error as Error).message),
      )

      expect(refusal, 'the fold is refused').to.be.a('string')
      expect(refusal).to.match(/__proto__/)
      expect(Object.prototype.hasOwnProperty.call(scope.read('polluting'), '__proto__')).to.equal(false)
    })

    it('refuses it from the seed and the preload too, which reach state without a fold', () => {
      const seeded = defineDomain('polluting', [], {
        state: () => JSON.parse('{"n": 0, "__proto__": {"polluted": true}}') as PollutingState,
        actions: { set: reduce({}) },
      })
      expect(() => createScope({ name: 'seeded', domains: [seeded] })).to.throw(/__proto__/)

      const clean = defineDomain('polluting', [], {
        state: () => ({ n: 0 }),
        actions: { set: reduce({}) },
      })
      expect(() =>
        createScope({
          name: 'preloaded',
          domains: [clean],
          preloadedState: JSON.parse('{"polluting": {"__proto__": {"polluted": true}}}') as never,
        }),
      ).to.throw(/__proto__/)
    })

    // The three cases above all put the key at depth one, which is the depth the top-level ingress
    // guards test. Nested, it would reach state intact, and a reader copying that object out with
    // `Object.assign` would have its target's prototype replaced.
    it('refuses __proto__ nested inside a state value, not only at the top level', async () => {
      const nesting = defineDomain('polluting', [], {
        state: () => ({ n: 0 }),
        actions: {
          set: reduce(
            () => JSON.parse('{"n": 1, "inner": {"__proto__": {"polluted": true}}}') as Partial<PollutingState>,
          ),
        },
      })
      const scope = createScope({ name: 'nesting', domains: [nesting] })

      const refusal = await scope.emit('polluting.set').then(
        () => undefined,
        (error: unknown) => String((error as Error).message),
      )

      expect(refusal, 'the fold is refused').to.be.a('string')
      expect(refusal).to.match(/__proto__/)
      // Named by path, so the reader is told where it is rather than that it is somewhere.
      expect(refusal).to.match(/\.inner\.__proto__/)
      expect(scope.read('polluting').n, 'the fold rolled back whole').to.equal(0)
    })

    it('refuses a nested __proto__ arriving through the preload', () => {
      const clean = defineDomain('polluting', [], {
        state: () => ({ n: 0 }),
        actions: { set: reduce({}) },
      })

      expect(() =>
        createScope({
          name: 'nested-preload',
          domains: [clean],
          preloadedState: JSON.parse('{"polluting": {"inner": {"__proto__": {"polluted": true}}}}') as never,
        }),
      ).to.throw(/\.inner\.__proto__/)
    })

    it('leaves an ordinary nested object alone', async () => {
      const ordinary = defineDomain('polluting', [], {
        state: () => ({ n: 0 }),
        actions: { set: reduce(() => ({ n: 1, inner: { ok: true } }) as Partial<PollutingState>) },
      })
      const scope = createScope({ name: 'ordinary', domains: [ordinary] })

      await scope.emit('polluting.set')

      expect(scope.read('polluting').n).to.equal(1)
    })
  })
  // A development build refuses all of this at `checkState`, so every case here runs against a
  // production build, where the preload is the one ingress carrying data the application did not
  // write itself: `getWrittenState` output, persisted, read back with `JSON.parse`, handed back.
  describe('a preloaded __proto__ in a production build', () => {
    const ORDINARY = `
const users = eddy.defineDomain('users', [], {
  state: { current: { name: 'a' } },
  actions: { noop: eddy.reduce({}) },
})
const build = current =>
  eddy.createScope({ name: 'app', domains: [users], preloadedState: { users: { current } } })
`

    it('refuses the reported case, names the path, and leaves an Object.assign copy clean', function () {
      this.timeout(60000)
      const lines = buildModeProbe(
        `${ORDINARY}
try {
  build(JSON.parse('{"name":"b","__proto__":{"isAdmin":true}}'))
  console.log('CONSTRUCTED')
} catch (error) {
  console.log('REFUSED:' + error.message)
}
const clean = build(JSON.parse('{"name":"b"}'))
console.log('ASSIGN:' + Object.assign({}, clean.read('users').current).isAdmin)
`,
        { env: { NODE_ENV: 'production' } },
      )

      expect(lines[0], 'refused at construction, by path').to.match(/^REFUSED:.*'\.current\.__proto__'/)
      // The copy a reader makes of what the scope hands out. A preload with no `__proto__` still
      // constructs, so the guard has not become a refusal of ordinary state.
      expect(lines[1]).to.equal('ASSIGN:undefined')
    })

    it('descends into an array element, which the clone warns can carry the key too', function () {
      this.timeout(60000)
      const lines = buildModeProbe(
        `
const rows = eddy.defineDomain('rows', [], { state: { list: [] }, actions: { noop: eddy.reduce({}) } })
try {
  eddy.createScope({
    name: 'app',
    domains: [rows],
    preloadedState: { rows: JSON.parse('{"list":[{"ok":1},{"__proto__":{"isAdmin":true}}]}') },
  })
  console.log('CONSTRUCTED')
} catch (error) {
  console.log('REFUSED:' + error.message)
}
`,
        { env: { NODE_ENV: 'production' } },
      )

      expect(lines[0]).to.match(/^REFUSED:.*'\.list\[1\]\.__proto__'/)
    })

    it('refuses it in an instanced preload, both as an instance id and inside one instance', function () {
      this.timeout(60000)
      const lines = buildModeProbe(
        `
const drafts = eddy.defineDomain('drafts', [], {
  instanced: true,
  state: () => ({ text: '' }),
  actions: { noop: eddy.reduce({}) },
})
const build = preloaded => {
  try {
    eddy.createScope({ name: 'app', domains: [drafts], preloadedState: { drafts: preloaded } })
    console.log('CONSTRUCTED')
  } catch (error) {
    console.log('REFUSED:' + error.message)
  }
}
build(JSON.parse('{"__proto__":{"isAdmin":true}}'))
build(JSON.parse('{"one":{"text":"hi","inner":{"__proto__":{"isAdmin":true}}}}'))
build(JSON.parse('{"one":{"text":"hi"}}'))
`,
        { env: { NODE_ENV: 'production' } },
      )

      expect(lines[0], 'the aggregate keyed by instance id').to.match(/^REFUSED:.*'\.__proto__'/)
      expect(lines[1], 'and inside one instance').to.match(/^REFUSED:.*'\.one\.inner\.__proto__'/)
      expect(lines[2]).to.equal('CONSTRUCTED')
    })

    it('terminates on a cycle, and never invokes an accessor the clone already read', function () {
      this.timeout(60000)
      const lines = buildModeProbe(
        `
const held = eddy.defineDomain('held', [], { state: { blob: null }, actions: { noop: eddy.reduce({}) } })
const build = blob => eddy.createScope({ name: 'app', domains: [held], preloadedState: { held: { blob } } })

const cyclic = { n: 1 }
cyclic.self = cyclic
console.log('CYCLE:' + build(cyclic).read('held').blob.n)

let reads = 0
console.log('GETTER:' + build({ get computed() { reads++; return 1 } }).read('held').blob.computed)
console.log('READS:' + reads)
`,
        { env: { NODE_ENV: 'production' } },
      )

      expect(lines[0], 'the walk terminates rather than recurring forever').to.equal('CYCLE:1')
      // The clone materialises the accessor; the scan reads that copy's data properties, so the
      // payload's own code runs once and the scan cannot see a different value than the clone did.
      expect(lines[1]).to.equal('GETTER:1')
      expect(lines[2]).to.equal('READS:1')
    })
  })
})
