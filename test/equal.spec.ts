import { expect } from 'chai'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { changedKeys, isEqual } from '../src/internal/equal'
import { checkState } from '../src/internal/state-value'
import { buildModeProbe } from './helpers'

describe('isEqual', () => {
  describe('the cases dequal already got right', () => {
    it('primitives, including both NaN', () => {
      expect(isEqual(1, 1)).to.equal(true)
      expect(isEqual(1, 2)).to.equal(false)
      expect(isEqual(NaN, NaN)).to.equal(true)
      expect(isEqual(0, -0)).to.equal(true)
      expect(isEqual(null, undefined)).to.equal(false)
      expect(isEqual('a', 'a')).to.equal(true)
      expect(isEqual(1n, 1n)).to.equal(true)
    })

    it('plain objects and arrays, at depth', () => {
      expect(isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).to.equal(true)
      expect(isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).to.equal(false)
      expect(isEqual({ a: 1 }, { a: 1, b: undefined })).to.equal(false)
    })

    it('a value against a missing one, which is what changedKeys asks for constantly', () => {
      expect(isEqual({ a: 1 }, undefined)).to.equal(false)
      expect(isEqual(undefined, { a: 1 })).to.equal(false)
      expect(isEqual([], undefined)).to.equal(false)
    })
  })

  describe('cycles', () => {
    const selfCycle = (payload: unknown) => {
      const node: Record<string, unknown> = { payload }
      node.self = node
      return node
    }

    it('equal self-cycles', () => {
      expect(isEqual(selfCycle(1), selfCycle(1))).to.equal(true)
    })

    it('cycles with differing payloads', () => {
      expect(isEqual(selfCycle(1), selfCycle(2))).to.equal(false)
    })

    it('non-isomorphic cycles: the same values, wired differently', () => {
      const a: Record<string, unknown> = { tag: 'n' }
      const b: Record<string, unknown> = { tag: 'n' }
      a.next = b
      b.next = a

      const c: Record<string, unknown> = { tag: 'n' }
      const d: Record<string, unknown> = { tag: 'n' }
      const e: Record<string, unknown> = { tag: 'n' }
      c.next = d
      d.next = e
      e.next = c

      expect(isEqual(a, c)).to.equal(false)
    })

    it('the same reference against two different counterparts in one comparison', () => {
      const shared = { n: 1 }
      expect(isEqual({ x: shared, y: shared }, { x: { n: 1 }, y: { n: 2 } })).to.equal(false)
      expect(isEqual({ x: shared, y: shared }, { x: { n: 1 }, y: { n: 1 } })).to.equal(true)
    })

    it('cycles through arrays, Sets and Maps', () => {
      const list: unknown[] = [1]
      list.push(list)
      const twin: unknown[] = [1]
      twin.push(twin)
      expect(isEqual(list, twin)).to.equal(true)

      const holder: Record<string, unknown> = {}
      holder.set = new Set([holder])
      const other: Record<string, unknown> = {}
      other.set = new Set([other])
      expect(isEqual(holder, other)).to.equal(false)
    })
  })

  describe('sparse arrays', () => {
    const sparse = () => {
      const array = [1]
      array[2] = 3
      return array
    }

    it('a hole is not an undefined element', () => {
      expect(isEqual(sparse(), [1, undefined, 3])).to.equal(false)
      expect(isEqual([1, undefined, 3], sparse())).to.equal(false)
    })

    it('an identical hole layout is equal', () => {
      expect(isEqual(sparse(), sparse())).to.equal(true)
    })

    it('survives a poisoned Array.prototype, which `in` would not', () => {
      Object.defineProperty(Array.prototype, 1, { value: undefined, configurable: true, writable: true })
      try {
        expect(isEqual(sparse(), [1, undefined, 3])).to.equal(false)
      } finally {
        delete (Array.prototype as unknown as Record<number, unknown>)[1]
      }
    })
  })

  describe('the retired types, which production compares without a walk', () => {
    it('two of a kind are unequal unless they are the same reference', () => {
      for (const build of [() => new Map([['k', 1]]), () => new Set([1]), () => /x/g, () => new Error('nope')]) {
        const one = build()
        expect(isEqual(one, one)).to.equal(true)
        expect(isEqual(one, build())).to.equal(false)
      }
    })

    it('so a fold that replaces one always notifies, which is why ingress refuses them', () => {
      expect(changedKeys({ at: /x/g }, { at: /x/g })).to.deep.equal(['at'])
    })
  })

  describe('a Date, compared', () => {
    it('compares two clean local Dates by their time value', () => {
      expect(isEqual(new Date(0), new Date(0))).to.equal(true)
      expect(isEqual(new Date(0), new Date(1))).to.equal(false)
      expect(isEqual({ at: new Date(5) }, { at: new Date(5) })).to.equal(true)
      expect(isEqual([new Date(5)], [new Date(6)])).to.equal(false)
    })

    it('calls two invalid Dates equal, as it calls two NaNs equal', () => {
      expect(isEqual(new Date(NaN), new Date(NaN))).to.equal(true)
      expect(isEqual(new Date(NaN), new Date(0))).to.equal(false)
    })

    // Production has no walk to refuse a decorated Date before it reaches here, so the comparison
    // counts own keys and never reads one: a decoration of any key class makes the pair
    // identity-only, and an accessor is not invoked to find that out.
    it('makes a Date decorated by any one key class identity-only, without reading the key', () => {
      let read = 0
      const decorated = (): Date[] => [
        Object.assign(new Date(0), { note: 'x' }),
        Object.defineProperty(new Date(0), 'hidden', { value: 1, enumerable: false }),
        Object.defineProperty(new Date(0), Symbol('tag'), { value: 1, enumerable: true }),
        Object.defineProperty(new Date(0), 'boom', {
          get() {
            read += 1
            throw new Error('read')
          },
          enumerable: true,
        }),
      ]
      const left = decorated()
      const right = decorated()
      for (let index = 0; index < left.length; index += 1) {
        expect(isEqual(left[index], left[index]), `case ${index} to itself`).to.equal(true)
        expect(isEqual(left[index], right[index]), `case ${index} to its twin`).to.equal(false)
        expect(isEqual(left[index], new Date(0)), `case ${index} to a clean Date`).to.equal(false)
        expect(isEqual(new Date(0), left[index]), `a clean Date to case ${index}`).to.equal(false)
      }
      expect(read, 'the accessor was never invoked').to.equal(0)
    })

    it('is not fooled by an object wearing Date.prototype without a time value', () => {
      const forged = Object.create(Date.prototype) as Date
      expect(isEqual(forged, forged)).to.equal(true)
      expect(isEqual(forged, Object.create(Date.prototype))).to.equal(false)
      expect(isEqual(forged, new Date(0))).to.equal(false)
      expect(isEqual(new Date(0), forged)).to.equal(false)
    })

    it('treats two foreign-realm Dates, and two instances of one subclass, as identity-only', () => {
      const foreign = () => runInNewContext('new Date(0)') as Date
      class Timestamp extends Date {}
      const one = foreign()
      expect(isEqual(one, one)).to.equal(true)
      expect(isEqual(foreign(), foreign())).to.equal(false)
      expect(isEqual(foreign(), new Date(0))).to.equal(false)
      expect(isEqual(new Timestamp(0), new Timestamp(0))).to.equal(false)
      expect(isEqual(new Timestamp(0), new Date(0))).to.equal(false)
    })

    it('reports a Date field as moved only when its time moved', () => {
      expect(changedKeys({ at: new Date(0) }, { at: new Date(0) })).to.deep.equal([])
      expect(changedKeys({ at: new Date(1) }, { at: new Date(0) })).to.deep.equal(['at'])
    })
  })

  describe('the narrowing', () => {
    it('the same typed array is equal to itself, and two are not', () => {
      const bytes = new Uint8Array([1, 2, 3])
      expect(isEqual(bytes, bytes)).to.equal(true)
      expect(isEqual(bytes, new Uint8Array([1, 2, 3]))).to.equal(false)
    })

    it('an ArrayBuffer and a DataView too — they left as one unit', () => {
      const buffer = new ArrayBuffer(2)
      expect(isEqual(buffer, buffer)).to.equal(true)
      expect(isEqual(buffer, new ArrayBuffer(2))).to.equal(false)

      const view = new DataView(buffer)
      expect(isEqual(view, view)).to.equal(true)
      expect(isEqual(view, new DataView(buffer))).to.equal(false)
    })

    it('a class instance is not field-compared into equality', () => {
      class Money {
        constructor(public cents: number) {}
      }
      expect(isEqual(new Money(5), new Money(5))).to.equal(false)

      expect(isEqual(new Money(5), { cents: 5 })).to.equal(false)
    })

    it('a null-prototype object is not a plain object', () => {
      const bare = Object.assign(Object.create(null), { a: 1 })
      expect(isEqual(bare, bare)).to.equal(true)
      expect(isEqual(bare, Object.assign(Object.create(null), { a: 1 }))).to.equal(false)
      expect(isEqual(bare, { a: 1 })).to.equal(false)
    })

    it('development still refuses all of them at ingress', () => {
      for (const value of [new Uint8Array(1), new ArrayBuffer(1), new DataView(new ArrayBuffer(1))]) {
        expect(() => checkState({ value }, 'a probe')).to.throw(TypeError, /not a supported state value/)
      }
    })
  })

  describe('the value no longer chooses its own comparison', () => {
    it('a forged constructor does not steer the dispatch', () => {
      expect(isEqual({ constructor: Array, a: 1 }, { constructor: Array, a: 2 })).to.equal(false)
      expect(isEqual({ constructor: Date }, { constructor: Date })).to.equal(true)
      expect(isEqual({ constructor: { n: 1 } }, { constructor: { n: 1 } })).to.equal(true)
      expect(isEqual(Object.create(Array.prototype), Object.create(Array.prototype))).to.equal(false)
    })

    it('a forged prototype compares unequal instead of throwing mid-fold', () => {
      expect(isEqual(Object.create(Map.prototype), Object.create(Map.prototype))).to.equal(false)
      expect(changedKeys({ v: Object.create(Date.prototype) }, { v: Object.create(Date.prototype) })).to.deep.equal([
        'v',
      ])
    })
  })

  describe('changedKeys stays one-directional', () => {
    it('an omitted key means unchanged, not deleted', () => {
      expect(changedKeys({}, { a: 1 } as Record<string, unknown>)).to.deep.equal([])
      expect(changedKeys({ a: 1 }, { a: 1, b: 2 } as Record<string, unknown>)).to.deep.equal([])
      expect(changedKeys({ a: 2 }, { a: 1, b: 2 } as Record<string, unknown>)).to.deep.equal(['a'])
    })
  })
})

describe('changedKeys — own keys only', () => {
  it('an inherited value cannot mask a write', () => {
    expect(changedKeys({ ghost: 1 }, Object.create({ ghost: 1 }) as { ghost: number })).to.deep.equal(['ghost'])
    expect(changedKeys({ constructor: 1 } as never, {} as never)).to.deep.equal(['constructor'])
  })
})

describe('a sparse array is compared by the indices it has, not by its length', () => {
  it('answers at the accepted index boundary instead of hanging', () => {
    const atBoundary = () => {
      const list: unknown[] = []
      list[4294967294] = 'x'
      return list
    }

    const started = Date.now()
    expect(isEqual(atBoundary(), atBoundary())).to.equal(true)
    expect(Date.now() - started, 'must not scan by length').to.be.lessThan(1000)
  })

  it('still tells a hole from an explicit undefined', () => {
    expect(isEqual([, 1], [undefined, 1])).to.equal(false)
    expect(isEqual([, 1], [, 1])).to.equal(true)
    expect(isEqual([1], [1, 2])).to.equal(false)
  })
})
