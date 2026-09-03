import { expect } from 'chai'
import { runInNewContext } from 'node:vm'
import globalJsdom from 'global-jsdom'
import React, {
  StrictMode,
  useEffect,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react'
import { createScope } from '../src/index'
import { createScopeHooks, shallowEqual } from '../src/react'
import { flush } from '../src/testing'
import { api, cart, draft, observed, session, upload } from './fixtures'
import { buildModeProbe, rejects } from './helpers'

let cleanupDom: () => void
let RTL: typeof import('@testing-library/react')

let ReactDOMServer: typeof import('react-dom/server')
let ReactDOMClient: typeof import('react-dom/client')

// React 19 exports `Activity`; the pinned React 18 neither exports nor declares it, so one suite runs
// on both majors the peer range admits. The cast holds only behind `hasActivity`, which every test
// that renders it checks first.
const hasActivity = 'Activity' in React
const Activity = (
  React as unknown as {
    Activity: React.ComponentType<{ mode: 'visible' | 'hidden'; children: React.ReactNode }>
  }
).Activity

describe('react', () => {
  before(async () => {
    cleanupDom = globalJsdom()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    RTL = await import('@testing-library/react')
    ReactDOMServer = await import('react-dom/server')
    ReactDOMClient = await import('react-dom/client')
  })

  after(() => {
    cleanupDom?.()
  })

  beforeEach(() => {
    api.reset()
    observed.reset()
  })

  afterEach(() => {
    RTL.cleanup()
  })

  describe('address narrowing', () => {
    it('is a compile error to reach a domain the scope does not host', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function neverCalled(hooks: ReturnType<typeof createScopeHooks<'cart' | 'session'>>) {
        hooks.useDomain('cart')
        hooks.useDomainValue('session', s => s.userId)
        hooks.useEmit()('cart.add', { sku: 'SKU-1', qty: 1 })

        // @ts-expect-error `upload` is a registered domain, but this scope does not host it
        hooks.useDomain('upload')
        // @ts-expect-error same, through the selector hook
        hooks.useDomainValue('upload', s => s)
        // @ts-expect-error and through emit
        hooks.useEmit()('upload.pick', { count: 1 })
        // @ts-expect-error not a registered domain at all
        hooks.useDomain('nope')
      }

      expect(typeof createScopeHooks).to.equal('function')
    })
  })

  describe('shallowEqual', () => {
    it('compares symbol keys, which a selector result may legitimately carry', () => {
      const tag = Symbol('tag')
      expect(shallowEqual({ [tag]: 1 }, { [tag]: 1 })).to.equal(true)
      expect(shallowEqual({ [tag]: 0 }, { [tag]: 1 })).to.equal(false)
      expect(shallowEqual({ [tag]: 1 }, {})).to.equal(false)
      expect(shallowEqual({}, { [tag]: 1 })).to.equal(false)
    })

    it('ignores a non-enumerable key, which a spread would not copy either', () => {
      const a = Object.defineProperty({ v: 1 }, 'hidden', { value: 1, enumerable: false })
      const b = Object.defineProperty({ v: 1 }, 'hidden', { value: 2, enumerable: false })
      expect(shallowEqual(a, b)).to.equal(true)
    })

    it('compares one level and nothing deeper', () => {
      expect(shallowEqual({ a: 1 }, { a: 1 })).to.equal(true)
      expect(shallowEqual({ a: 1 }, { a: 2 })).to.equal(false)
      expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).to.equal(false)
      expect(shallowEqual({ a: { n: 1 } }, { a: { n: 1 } })).to.equal(false)
      expect(shallowEqual(1, 1)).to.equal(true)
      expect(shallowEqual(null, null)).to.equal(true)
      expect(shallowEqual(null, {})).to.equal(false)
    })

    it('tells an array apart from an index-keyed object', () => {
      expect(shallowEqual([1], { 0: 1 })).to.equal(false)
      expect(shallowEqual({ 0: 1 }, [1])).to.equal(false)
      expect(shallowEqual([], {})).to.equal(false)

      expect(shallowEqual([1, 2], [1, 2])).to.equal(true)
      expect(shallowEqual([1, 2], [2, 1])).to.equal(false)
    })

    it('does not call two distinct built-ins equal for having no enumerable keys', () => {
      expect(shallowEqual(new Map([['a', 1]]), new Map([['b', 2]]))).to.equal(false)
      expect(shallowEqual(new Set([1]), new Set([2]))).to.equal(false)
      expect(shallowEqual(/a/g, /b/i)).to.equal(false)
    })

    it('compares a value with no enumerable surface by identity', () => {
      const pattern = /a/g

      expect(shallowEqual(pattern, pattern)).to.equal(true)
      expect(shallowEqual(/a/g, /a/g)).to.equal(false)

      expect(shallowEqual({ at: pattern }, { at: pattern })).to.equal(true)
      expect(shallowEqual({ at: /a/g }, { at: /a/g })).to.equal(false)
    })

    describe('a Date in a selector', () => {
      it('compares two clean Dates by time, one level deep only', () => {
        expect(shallowEqual(new Date(0), new Date(0))).to.equal(true)
        expect(shallowEqual(new Date(0), new Date(86400000))).to.equal(false)
        expect(shallowEqual(new Date(NaN), new Date(NaN))).to.equal(true)
        // Shallow: a Date nested in a selected object is still compared by identity.
        expect(shallowEqual({ at: new Date(0) }, { at: new Date(0) })).to.equal(false)
      })

      // Selector results reach this comparator with no walk before them, so it counts own keys and
      // never reads one; `enumerableKeys` would hide the hidden key and invoke the accessor.
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
          expect(shallowEqual(left[index], left[index]), `case ${index} to itself`).to.equal(true)
          expect(shallowEqual(left[index], right[index]), `case ${index} to its twin`).to.equal(false)
          expect(shallowEqual(left[index], new Date(0)), `case ${index} to a clean Date`).to.equal(false)
        }
        expect(read, 'the accessor was never invoked').to.equal(0)
      })

      it('treats a forged prototype, a foreign realm and a subclass as identity-only', () => {
        const forged = Object.create(Date.prototype) as Date
        expect(shallowEqual(forged, forged)).to.equal(true)
        expect(shallowEqual(forged, Object.create(Date.prototype))).to.equal(false)
        expect(shallowEqual(forged, new Date(0))).to.equal(false)
        const foreign = () => runInNewContext('new Date(0)') as Date
        expect(shallowEqual(foreign(), foreign())).to.equal(false)
        class Timestamp extends Date {}
        expect(shallowEqual(new Timestamp(0), new Timestamp(0))).to.equal(false)
      })

      it('keeps the previous Date when the selector re-runs and the time has not moved', async () => {
        const scope = createScope({ name: 'r-date', domains: [upload] })
        const { useDomainValue } = createScopeHooks(scope)
        const seen: Date[] = []
        let selected = 0
        const asDate = (s: { progress: number }) => {
          selected += 1
          return new Date(s.progress)
        }

        function Tracker() {
          const at = useDomainValue('upload', asDate)
          const previous = useRef<Date | undefined>(undefined)
          if (previous.current !== at) {
            seen.push(at)
            previous.current = at
          }
          return <span>{at.getTime()}</span>
        }

        RTL.render(<Tracker />)
        const selectedAtMount = selected

        // `files` moves, `progress` does not: the domain's reference changes, the selector re-runs,
        // and the fresh Date is equal by time, so the previous reference survives.
        await RTL.act(async () => {
          await scope.emit('upload.pick', { count: 1 })
        })
        expect(selected, 'the selector re-ran').to.be.greaterThan(selectedAtMount)
        expect(seen, 'and the value kept its reference').to.have.length(1)

        await RTL.act(async () => {
          await scope.emit('upload.start')
        })
        expect(seen).to.have.length(2)
        expect(seen[1].getTime()).to.equal(100)
        scope.dispose()
      })
    })

    it('separates arrays whose enumerable keys match but whose lengths do not', () => {
      const sparse = [1]
      sparse.length = 2

      // Holes are not enumerable, so the key walk alone sees `['0']` on both sides; length is what
      // separates them, and the core comparator checks it too.
      expect(shallowEqual([1], sparse), '[1] vs [1, <hole>]').to.equal(false)
      expect(shallowEqual([], new Array(10)), '[] vs new Array(10)').to.equal(false)
      expect(shallowEqual(new Array(3), new Array(3)), 'two equally sparse arrays').to.equal(true)
    })

    it('leaves the plain-object path alone, where there is no length to compare', () => {
      expect(shallowEqual({ a: 1 }, { a: 1 })).to.equal(true)
      expect(shallowEqual({ length: 1 }, { length: 2 }), 'a `length` field is just a field').to.equal(false)
      expect(shallowEqual({ length: 2 }, { length: 2 })).to.equal(true)
    })
  })

  describe('useDomain', () => {
    it('renders state and re-renders when it changes', async () => {
      const scope = createScope({ name: 'r1', domains: [cart, session] })
      const { useDomain } = createScopeHooks(scope)

      function CartView() {
        const state = useDomain('cart')
        return <span data-testid="count">{state.itemCount}</span>
      }

      RTL.render(<CartView />)
      expect(RTL.screen.getByTestId('count').textContent).to.equal('0')

      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 2 })
      })

      expect(RTL.screen.getByTestId('count').textContent).to.equal('1')
    })

    it('exposes views as ordinary state', async () => {
      const scope = createScope({ name: 'r2', domains: [cart, session] })
      const { useDomain } = createScopeHooks(scope)

      function Totals() {
        const state = useDomain('cart')
        return <span data-testid="total">{state.total}</span>
      }

      RTL.render(<Totals />)
      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 2 })
      })

      expect(RTL.screen.getByTestId('total').textContent).to.equal('24')
    })

    it('does not re-render for a change in another domain', async () => {
      const scope = createScope({ name: 'r3', domains: [cart, session] })
      const { useDomain } = createScopeHooks(scope)
      let renders = 0

      function CartOnly() {
        renders += 1
        const state = useDomain('cart')
        return <span>{state.itemCount}</span>
      }

      RTL.render(<CartOnly />)
      const initial = renders

      await RTL.act(async () => {
        await scope.emit('session.signIn', { email: 'a@b.c' })
      })

      expect(renders).to.equal(initial)
    })
  })

  describe('useDomainValue', () => {
    it('re-renders only when the selected value changes', async () => {
      const scope = createScope({ name: 'r4', domains: [cart, session] })
      const { useDomainValue } = createScopeHooks(scope)
      let renders = 0

      function Count() {
        renders += 1
        const count = useDomainValue('cart', s => s.itemCount)
        return <span data-testid="n">{count}</span>
      }

      RTL.render(<Count />)
      const initial = renders

      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 0 }).catch(() => undefined)
      })
      expect(renders).to.equal(initial)

      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      })
      expect(RTL.screen.getByTestId('n').textContent).to.equal('1')
    })

    it('keeps a fresh object selector stable instead of looping forever', async () => {
      const scope = createScope({ name: 'r5', domains: [cart, session] })
      const { useDomainValue } = createScopeHooks(scope)
      let renders = 0

      function Summary() {
        renders += 1

        const summary = useDomainValue('cart', s => ({ n: s.itemCount, t: s.total }))
        return (
          <span data-testid="s">
            {summary.n}/{summary.t}
          </span>
        )
      }

      RTL.render(<Summary />)
      expect(RTL.screen.getByTestId('s').textContent).to.equal('0/0')

      const settled = renders
      await RTL.act(async () => {
        await scope.emit('cart.clear')
      })
      expect(renders).to.equal(settled)

      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      })
      expect(RTL.screen.getByTestId('s').textContent).to.equal('1/12')
      expect(renders).to.be.lessThan(settled + 5)
    })

    it('hands a stable selector a stable reference across renders', async () => {
      const scope = createScope({ name: 'r6', domains: [cart, session] })
      const { useDomainValue } = createScopeHooks(scope)
      const seen: unknown[] = []

      // Stable identity, so the cache is usable across renders. This is the case
      // `useSyncExternalStore` depends on: an equal snapshot must keep its reference or it
      // re-renders forever.
      const summarise = (s: { itemCount: number }) => ({ n: s.itemCount })

      function Tracker() {
        const summary = useDomainValue('cart', summarise)
        const previous = useRef<unknown>(undefined)
        if (previous.current !== summary) {
          seen.push(summary)
          previous.current = summary
        }
        return <span>{summary.n}</span>
      }

      const view = RTL.render(<Tracker />)
      view.rerender(<Tracker />)
      view.rerender(<Tracker />)

      expect(seen).to.have.length(1)
    })

    // Named for what it proves: two *committed* renders, and an inline selector is a new function on
    // each, so the cache written under the previous identity is not usable and the value recomputes.
    // A render React discards is a different question and is not covered here — the cache is a ref
    // written during render, so an abandoned one can write it, and nothing yet demonstrates a stale
    // value surviving that into a committed render.
    it("recomputes for an inline selector rather than reusing another identity's value", async () => {
      const scope = createScope({ name: 'r6b', domains: [cart, session] })
      const { useDomainValue } = createScopeHooks(scope)
      const seen: unknown[] = []

      // An inline selector is a new function every render, so the cache written under the previous
      // one is not usable. It recomputes rather than collapsing against a value another identity
      // produced; `useCallback` is how a consumer buys the stability back.
      function Tracker() {
        const summary = useDomainValue('cart', s => ({ n: s.itemCount }))
        const previous = useRef<unknown>(undefined)
        if (previous.current !== summary) {
          seen.push(summary)
          previous.current = summary
        }
        return <span>{summary.n}</span>
      }

      const view = RTL.render(<Tracker />)
      view.rerender(<Tracker />)

      expect(seen.length, "recomputed rather than reused another identity's value").to.be.greaterThan(1)
      expect(
        seen.every(v => (v as { n: number }).n === 0),
        'and every value is correct',
      ).to.equal(true)
    })

    it('recomputes when the selector changes, even though the state did not move', async () => {
      const scope = createScope({ name: 'r9', domains: [cart, session] })
      const { useDomainValue } = createScopeHooks(scope)

      function Row({ sku }: { sku: string }) {
        const item = useDomainValue('cart', s => s.items.find(i => i.sku === sku) ?? null)
        return <span data-testid="row">{item ? `${item.sku}:${item.qty}` : 'none'}</span>
      }

      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
        await scope.emit('cart.add', { sku: 'SKU-2', qty: 3 })
      })

      const view = RTL.render(<Row sku="SKU-1" />)
      expect(RTL.screen.getByTestId('row').textContent).to.equal('SKU-1:1')

      view.rerender(<Row sku="SKU-2" />)
      expect(RTL.screen.getByTestId('row').textContent).to.equal('SKU-2:3')
    })

    it('recomputes when the comparator changes, even though the state did not move', async () => {
      const scope = createScope({ name: 'r10', domains: [cart, session] })
      const { useDomainValue } = createScopeHooks(scope)

      const selectCount = (s: { itemCount: number }) => ({ n: s.itemCount })
      const pinned = () => true

      function Count({ compare }: { compare: (a: { n: number }, b: { n: number }) => boolean }) {
        const value = useDomainValue('cart', selectCount, compare)
        return <span data-testid="n">{value.n}</span>
      }

      const view = RTL.render(<Count compare={pinned} />)

      await RTL.act(async () => {
        await scope.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      })
      expect(RTL.screen.getByTestId('n').textContent).to.equal('0')

      view.rerender(<Count compare={shallowEqual} />)
      expect(RTL.screen.getByTestId('n').textContent).to.equal('1')
    })
  })

  describe('useEmit and ScopeProvider', () => {
    it('emits from a component', async () => {
      const scope = createScope({ name: 'r7', domains: [cart, session] })
      const { useDomainValue, useEmit } = createScopeHooks(scope)

      function AddButton() {
        const emit = useEmit()
        const count = useDomainValue('cart', s => s.itemCount)
        return (
          <button data-testid="add" onClick={() => void emit('cart.add', { sku: 'SKU-1', qty: 1 })}>
            {count}
          </button>
        )
      }

      RTL.render(<AddButton />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('add').click()
        await flush()
      })

      expect(RTL.screen.getByTestId('add').textContent).to.equal('1')
    })

    it('a provider overrides the factory scope, and the two stay independent', async () => {
      const main = createScope({ name: 'r8-main', domains: [cart, session] })
      const other = createScope({ name: 'r8-other', domains: [cart, session] })
      const { ScopeProvider, useDomainValue } = createScopeHooks(main)

      function Count({ id }: { id: string }) {
        const n = useDomainValue('cart', s => s.itemCount)
        return <span data-testid={id}>{n}</span>
      }

      RTL.render(
        <>
          <Count id="main" />
          <ScopeProvider scope={other}>
            <Count id="other" />
          </ScopeProvider>
        </>,
      )

      await RTL.act(async () => {
        await other.emit('cart.add', { sku: 'SKU-1', qty: 1 })
      })

      expect(RTL.screen.getByTestId('main').textContent).to.equal('0')
      expect(RTL.screen.getByTestId('other').textContent).to.equal('1')
    })
  })

  describe('useDomainInstance', () => {
    // The instance lives in the application's own scope, not a private one. That is the whole point:
    // it reads neighbours, folds in the same transaction as everything else, and outlives a hide
    // that keeps the mount — none of which a separate scope could do.
    it('keeps two mounts apart, and each one folds only its own instance', async () => {
      const scope = createScope({ name: 'inst-apart', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft')
        return (
          <button data-testid={id} onClick={() => void emit('draft.type', 'x')}>
            {state.text.length}
          </button>
        )
      }

      RTL.render(
        <>
          <Uploader id="a" />
          <Uploader id="b" />
        </>,
      )

      await RTL.act(async () => {
        RTL.screen.getByTestId('a').click()
      })

      expect(RTL.screen.getByTestId('a').textContent).to.equal('1')
      expect(RTL.screen.getByTestId('b').textContent, 'the other instance did not move').to.equal('0')
    })

    it('shares one instance when both mounts name the same id', async () => {
      const scope = createScope({ name: 'inst-shared', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader({ testId }: { testId: string }) {
        const [state, emit] = useDomainInstance('draft', 'row-7')
        return (
          <button data-testid={testId} onClick={() => void emit('draft.type', 'x')}>
            {state.text.length}
          </button>
        )
      }

      const view = RTL.render(
        <>
          <Uploader testId="a" />
          <Uploader testId="b" />
        </>,
      )

      await RTL.act(async () => {
        RTL.screen.getByTestId('a').click()
      })

      expect(RTL.screen.getByTestId('b').textContent, 'a supplied id is shared deliberately').to.equal('1')

      await RTL.act(async () => {
        view.rerender(<Uploader testId="b" />)
      })

      expect(RTL.screen.getByTestId('b').textContent, 'one unmount does not reset the survivor').to.equal('1')
      expect(scope.instances('draft')).to.have.own.property('row-7')
    })

    it('releases the old id and keeps the new one when a mount changes identity', async () => {
      const scope = createScope({ name: 'inst-change', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'x')}>
            {state.text.length}
          </button>
        )
      }

      const view = RTL.render(<Uploader id="a" />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })
      expect(RTL.screen.getByTestId('u').textContent).to.equal('1')

      await RTL.act(async () => {
        view.rerender(<Uploader id="b" />)
      })

      expect(Object.keys(scope.instances('draft')), 'only the new identity is live').to.deep.equal(['b'])
      expect(RTL.screen.getByTestId('u').textContent, 'the new identity starts from its seed').to.equal('0')

      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })
      expect(RTL.screen.getByTestId('u').textContent, 'the new lease remains active').to.equal('1')
    })

    // `emit` adopts its handle in the mount effect, so the adoption trails the commit rather than
    // riding the render. The id the mount leaves is held from outside on purpose: released, it would
    // reject a misdirected emit loudly, and the silent case — a write landing on an instance that is
    // still live — is the one worth a guard.
    it('emits into the new instance once an id change has committed', async () => {
      const scope = createScope({ name: 'inst-change-emit', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)
      const left = scope.instance('draft', 'a')

      function Row({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'typed')}>
            {state.text}
          </button>
        )
      }

      const view = RTL.render(<Row id="a" />)
      await RTL.act(async () => {
        view.rerender(<Row id="b" />)
      })

      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })

      expect(RTL.screen.getByTestId('u').textContent, 'the emit followed the id the mount now holds').to.equal('typed')
      expect(left.read().text, 'the id it left took no writes').to.equal('')
      left.dispose()
    })

    // A render React abandons still runs the component body and still writes to the ref objects the
    // committed fiber shares. A transition that swaps the id and then suspends parks one of those
    // renders permanently, with the old row still committed, visible and clickable — so a hook that
    // adopted its handle during render would send that row's clicks to an instance nobody can see.
    it('keeps the committed mount emitting into its own instance while a suspended render names another', async () => {
      const scope = createScope({ name: 'inst-speculative', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      // Held from outside so the abandoned render's id is a live instance a misdirected emit can
      // reach. An id nobody holds would reject the emit instead, and report the defect as an error.
      const unseen = scope.instance('draft', 'b')

      const pending = new Promise<never>(() => {})
      function Suspender({ on }: { on: boolean }) {
        if (on) {
          throw pending
        }
        return null
      }

      function Row({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <div>
            <button data-testid="u" onClick={() => void emit('draft.type', 'typed')}>
              {state.text}
            </button>
            <Suspender on={id === 'b'} />
          </div>
        )
      }

      let swap = () => {}
      function App() {
        const [id, setId] = useState('a')
        const [, startTransition] = useTransition()
        swap = () => startTransition(() => setId('b'))
        return (
          <Suspense fallback={<i data-testid="fallback">loading</i>}>
            <Row id={id} />
          </Suspense>
        )
      }

      RTL.render(<App />)
      await RTL.act(async () => {
        swap()
      })
      expect(RTL.screen.queryByTestId('fallback'), 'a suspended transition keeps the old row on screen').to.equal(null)

      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })

      expect(RTL.screen.getByTestId('u').textContent, 'the row on screen wrote its own instance').to.equal('typed')
      expect(unseen.read().text, 'the render that never committed took no writes').to.equal('')
      unseen.dispose()
    })

    // The other half of that abandoned render. It leaves the hook's single prepared slot holding an
    // id that never committed, so the next render for the committed one finds the mismatch and
    // prepares a second handle object for an identity that never moved. A mount effect keyed on that
    // object would release and retake the lease for it, and with the mount as sole holder the
    // instance would leave the aggregate and come back.
    it('keeps its lease when a render nobody committed makes the next one prepare again', async () => {
      const scope = createScope({ name: 'inst-rebuild', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      const pending = new Promise<never>(() => {})
      function Suspender({ on }: { on: boolean }) {
        if (on) {
          throw pending
        }
        return null
      }

      function Row({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <div>
            <button data-testid="u" onClick={() => void emit('draft.type', 'typed')}>
              {state.text}
            </button>
            <button data-testid="again" onClick={() => void emit('draft.type', 'again')} />
            <Suspender on={id === 'b'} />
          </div>
        )
      }

      let swap = () => {}
      let bump = () => {}
      function App() {
        const [id, setId] = useState('a')
        const [count, setCount] = useState(0)
        const [, startTransition] = useTransition()
        swap = () => startTransition(() => setId('b'))
        bump = () => setCount(count + 1)
        return (
          <Suspense fallback={<i data-testid="fallback">loading</i>}>
            <Row id={id} />
            <span>{count}</span>
          </Suspense>
        )
      }

      RTL.render(<App />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })
      await RTL.act(async () => {
        swap()
      })
      expect(RTL.screen.queryByTestId('fallback'), 'a suspended transition keeps the old row on screen').to.equal(null)

      const trail: string[] = []
      scope.subscribe(() => trail.push(JSON.stringify(scope.instances('draft'))))

      await RTL.act(async () => {
        bump()
      })

      expect(trail, 'an ordinary re-render is not an arrival or a departure').to.deep.equal([])
      expect(
        RTL.screen.getByTestId('u').textContent,
        'the render after the rebuild reads the live state, not a seed',
      ).to.equal('typed')

      await RTL.act(async () => {
        RTL.screen.getByTestId('again').click()
      })
      expect(scope.instances('draft'), 'emit still reaches the handle that holds the lease').to.deep.equal({
        a: { text: 'again', saved: false },
      })
    })

    // The expensive half of the same rebuild. A released and retaken lease reseeds the id, and the
    // generation it bumps is what a command already in flight is checked against: its terminal fold
    // is dropped with a log rather than an error, so the state the fold carried is the assertion.
    it('lands the terminal fold of a command in flight across that re-render', async () => {
      const scope = createScope({ name: 'inst-rebuild-flight', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)
      await scope.emit('session.signIn', { email: 'a@b.c' })

      const pending = new Promise<never>(() => {})
      function Suspender({ on }: { on: boolean }) {
        if (on) {
          throw pending
        }
        return null
      }

      let saving: Promise<string> | undefined
      function Row({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <div>
            <button data-testid="save" onClick={() => (saving = emit('draft.save'))}>
              {String(state.saved)}
            </button>
            <Suspender on={id === 'b'} />
          </div>
        )
      }

      let swap = () => {}
      let bump = () => {}
      function App() {
        const [id, setId] = useState('a')
        const [count, setCount] = useState(0)
        const [, startTransition] = useTransition()
        swap = () => startTransition(() => setId('b'))
        bump = () => setCount(count + 1)
        return (
          <Suspense fallback={<i data-testid="fallback">loading</i>}>
            <Row id={id} />
            <span>{count}</span>
          </Suspense>
        )
      }

      RTL.render(<App />)
      await RTL.act(async () => {
        swap()
      })
      expect(RTL.screen.queryByTestId('fallback'), 'a suspended transition keeps the old row on screen').to.equal(null)

      // Synchronous: the command has to still be in flight when the re-render below prepares again.
      RTL.act(() => {
        RTL.screen.getByTestId('save').click()
      })
      await RTL.act(async () => {
        bump()
      })

      await RTL.act(async () => {
        await saving
        await flush()
      })

      expect(RTL.screen.getByTestId('save').textContent, 'the fold reached the instance that ran it').to.equal('true')
      expect(scope.instances('draft')).to.deep.equal({ a: { text: '', saved: true } })
    })

    // A guard, not a reproducer: narrowing the dependency list is what makes the effect's captured
    // handle and the slot's current one two different objects, and this is the case where the
    // cleanup must release the former.
    it('releases the lease the effect captured when the id changes after a rebuild', async () => {
      const scope = createScope({ name: 'inst-rebuild-change', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      const pending = new Promise<never>(() => {})
      function Suspender({ on }: { on: boolean }) {
        if (on) {
          throw pending
        }
        return null
      }

      function Row({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <div>
            <button data-testid="u" onClick={() => void emit('draft.type', 'typed')}>
              {state.text}
            </button>
            <Suspender on={id === 'b'} />
          </div>
        )
      }

      let swap = () => {}
      let bump = () => {}
      let move = () => {}
      function App() {
        const [id, setId] = useState('a')
        const [count, setCount] = useState(0)
        const [, startTransition] = useTransition()
        swap = () => startTransition(() => setId('b'))
        bump = () => setCount(count + 1)
        move = () => setId('c')
        return (
          <Suspense fallback={<i data-testid="fallback">loading</i>}>
            <Row id={id} />
            <span>{count}</span>
          </Suspense>
        )
      }

      RTL.render(<App />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })
      await RTL.act(async () => {
        swap()
      })
      await RTL.act(async () => {
        bump()
      })

      await RTL.act(async () => {
        move()
      })

      expect(Object.keys(scope.instances('draft')), 'the id the mount left is gone').to.deep.equal(['c'])
      expect(RTL.screen.getByTestId('u').textContent, 'the new identity starts from its seed').to.equal('')

      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })
      expect(scope.instances('draft'), 'the new lease is the one emit reaches').to.deep.equal({
        c: { text: 'typed', saved: false },
      })
    })

    // The same rule as a hide and show, on the window a single mount opens: layout effects run at
    // commit and the mount effect is passive, so a sibling can release the last other lease between
    // the render that read the instance and the effect that takes one. An arriving lease seeds,
    // because the instance whose state the render read no longer exists.
    it('seeds an arriving lease whose instance was disposed between the render and the effect', async () => {
      const scope = createScope({ name: 'inst-disposed-before-mount', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      const outside = scope.instance('draft', 'panel')
      await outside.emit('draft.type', 'from outside')

      function Uploader() {
        const [state] = useDomainInstance('draft', 'panel')
        return <span data-testid="u">{state.text}</span>
      }

      function Closer() {
        useLayoutEffect(() => outside.dispose(), [])
        return null
      }

      await RTL.act(async () => {
        RTL.render(
          <div>
            <Uploader />
            <Closer />
          </div>,
        )
      })

      expect(RTL.screen.getByTestId('u').textContent, 'not the state of the instance that was disposed').to.equal('')
      expect(scope.instances('draft'), 'and the arrival published the seed').to.deep.equal({
        panel: { text: '', saved: false },
      })
    })

    // The same rule again, on the window a *swap* opens. React runs every cleanup in a commit before
    // any setup, so a component replaced by a different one naming the same id has released the last
    // lease by the time the replacement takes its own. This is what the wiki means by last one out,
    // and it is measured here because it reads like a handover and is not one.
    it('seeds when a component is replaced by another naming the same id', async () => {
      const scope = createScope({ name: 'inst-swap-is-last-out', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Before() {
        const [state] = useDomainInstance('draft', 'panel')
        return <span data-testid="s">{state.text}</span>
      }

      // A different component, deliberately: the same one in the same position is a re-render, React
      // keeps the fiber, and nothing unmounts — which is why this does not reproduce with one.
      function After() {
        const [state] = useDomainInstance('draft', 'panel')
        return <b data-testid="s">{state.text}</b>
      }

      let swap = () => {}
      function App() {
        const [swapped, setSwapped] = useState(false)
        swap = () => setSwapped(true)
        return swapped ? <After /> : <Before />
      }

      await RTL.act(async () => {
        RTL.render(<App />)
      })

      const outside = scope.instance('draft', 'panel')
      await RTL.act(async () => {
        await outside.emit('draft.type', 'typed')
      })
      outside.dispose()
      expect(RTL.screen.getByTestId('s').textContent, 'the mount holds the only lease now').to.equal('typed')

      await RTL.act(async () => {
        swap()
      })

      expect(RTL.screen.getByTestId('s').textContent, 'the replacement seeds rather than inheriting').to.equal('')
      expect(scope.instances('draft'), 'and the aggregate agrees').to.deep.equal({
        panel: { text: '', saved: false },
      })
    })

    // The aggregate is an ordinary object, so an id naming a member of `Object.prototype` resolves
    // that member. It is truthy, so a `??` fallback would never reach the seed and the first render —
    // everything before the lease arrives — would show a function.
    it('seeds a first render whose id names a member of Object.prototype', async () => {
      const scope = createScope({ name: 'inst-proto-id', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      const seen: unknown[] = []
      function Uploader({ id }: { id: string }) {
        const [state] = useDomainInstance('draft', id)
        seen.push(state)
        return <span data-testid="u">{String((state as { text: string }).text)}</span>
      }

      await RTL.act(async () => {
        RTL.render(<Uploader id="constructor" />)
      })

      expect(
        seen.map(state => typeof state),
        'no render saw an inherited function',
      ).to.not.include('function')
      expect(RTL.screen.getByTestId('u').textContent, 'the seed, as for any other id').to.equal('')
    })

    it('announces a committed mount to aggregate readers', () => {
      const scope = createScope({ name: 'inst-arrival', domains: [draft, cart, session] })
      const { useScope, useDomainInstance } = createScopeHooks(scope)

      // Through `instances`, not `useDomain`: the aggregate has one accessor, and a hook for it
      // would be a second. What is under test is the announcement, not where it is read.
      function Count() {
        const active = useScope()
        const count = useSyncExternalStore(active.subscribe, () => Object.keys(active.instances('draft')).length)
        return <output data-testid="count">{count}</output>
      }

      function Uploader() {
        const [state] = useDomainInstance('draft', 'visible')
        return <span>{state.text}</span>
      }

      RTL.render(
        <>
          <Count />
          <Uploader />
        </>,
      )

      expect(RTL.screen.getByTestId('count').textContent).to.equal('1')
    })

    it('disposes its instance on unmount, and leaves a sibling alone', async () => {
      const scope = createScope({ name: 'inst-dispose', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader({ id }: { id: string }) {
        const [state] = useDomainInstance('draft', id)
        return <b>{state.text.length}</b>
      }

      const view = RTL.render(
        <>
          <Uploader id="keep" />
          <Uploader id="drop" />
        </>,
      )
      expect(Object.keys(scope.instances('draft'))).to.have.members(['keep', 'drop'])

      await RTL.act(async () => {
        view.rerender(<Uploader id="keep" />)
      })

      expect(Object.keys(scope.instances('draft')), 'only the unmounted one went').to.deep.equal(['keep'])
    })

    it('reads a neighbour from a command handler, which a private scope could not', async () => {
      const scope = createScope({ name: 'inst-neighbour', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'solo')
        return (
          <button data-testid="u" onClick={() => void emit('draft.save')}>
            {String(state.saved)}
          </button>
        )
      }

      RTL.render(<Uploader />)

      // The handler refuses without a signed-in session, which is the neighbour read under test.
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
        await flush()
      })
      expect(RTL.screen.getByTestId('u').textContent, 'refused while signed out').to.equal('false')

      await RTL.act(async () => {
        await scope.emit('session.signIn', { email: 'a@b.c' })
      })
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
        await flush()
      })

      expect(RTL.screen.getByTestId('u').textContent, 'the command folded back into this instance').to.equal('true')
    })

    // What this proves is that an emit issued *after* the replay has settled reaches the instance
    // the replay left behind. Work started inside the discarded first setup is the test below.
    it('keeps its instance across a StrictMode replay, so an emit after it folds', async () => {
      const scope = createScope({ name: 'inst-strict', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'strict')
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'yy')}>
            {state.text.length}
          </button>
        )
      }

      RTL.render(
        <StrictMode>
          <Uploader />
        </StrictMode>,
      )

      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })

      expect(RTL.screen.getByTestId('u').textContent).to.equal('2')
    })

    // The half the test above does not cover, and it is the documented rule rather than a defect: a
    // command begun in the setup StrictMode discards settles against a generation the synthetic
    // cleanup already retired, so its terminal fold is dropped and reported while its promise still
    // carries the handler's real outcome. The replay's own command folds, which is why the state ends
    // correct and the drop is invisible without the log.
    //
    // Two `act` calls, deliberately: React runs passive effects at the end of the first, so the emit
    // does not exist until it returns and anything awaited inside it settles nothing.
    it('drops the fold of a command begun in the setup StrictMode discards, and reports it', async () => {
      const dropped: string[] = []
      const scope = createScope({
        name: 'inst-strict-inflight',
        domains: [draft, cart, session],
        logLevel: 'info',
        logger: {
          debug: () => undefined,
          info: () => undefined,
          error: (_message: string, record?: unknown) => {
            const cause = (record as { cause?: string } | undefined)?.cause
            if (cause !== undefined) {
              dropped.push(cause)
            }
          },
        },
      })
      const { useDomainInstance } = createScopeHooks(scope)

      await scope.emit('session.signIn', { email: 'a@b.c' })

      const outcomes: string[] = []
      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'strict-inflight')
        useEffect(() => {
          void emit('draft.save').then(
            result => outcomes.push(`ok ${String(result)}`),
            (error: Error) => outcomes.push(`err ${error.message}`),
          )
        }, [emit])
        return <span data-testid="u">{String(state.saved)}</span>
      }

      await RTL.act(async () => {
        RTL.render(
          <StrictMode>
            <Uploader />
          </StrictMode>,
        )
      })
      await RTL.act(async () => {
        await flush()
      })

      expect(dropped, 'the discarded setup left a fold that was dropped, and it was reported').to.deep.equal([
        "an instance of domain 'draft' was replaced before this fold, so it was dropped",
      ])
      expect(outcomes, "both callers were told the handler's real outcome, including the dropped one").to.deep.equal([
        'ok saved',
        'ok saved',
      ])
      expect(
        RTL.screen.getByTestId('u').textContent,
        "and the replay's own command folded, which is what hides the drop",
      ).to.equal('true')
    })

    it('survives a hide that keeps the mount, because the lease is the mount', async () => {
      const scope = createScope({ name: 'inst-css-hidden', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'panel')
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'hello')}>
            {state.text}
          </button>
        )
      }

      function Panel({ hidden }: { hidden: boolean }) {
        return (
          <div style={hidden ? { display: 'none' } : undefined}>
            <Uploader />
          </div>
        )
      }

      const view = RTL.render(<Panel hidden={false} />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })

      await RTL.act(async () => {
        view.rerender(<Panel hidden={true} />)
      })
      expect(scope.instances('draft'), 'a CSS hide runs no cleanup').to.have.own.property('panel')

      await RTL.act(async () => {
        view.rerender(<Panel hidden={false} />)
      })
      expect(RTL.screen.getByTestId('u').textContent, 'the state is the one it had').to.equal('hello')
    })

    // `<Activity mode="hidden">` keeps the DOM but unmounts effects, so the mount effect's cleanup
    // releases the lease exactly as a real unmount does. Measured on react 19.2.8: the instance is
    // gone from the aggregate while hidden and shows again at its seed. React 18 has no `Activity`,
    // so this detects the export rather than importing it, and the React 19 leg of CI is what runs
    // the body.
    it('releases the lease when a hide unmounts effects, and comes back seeded', async function () {
      if (!hasActivity) {
        return this.skip()
      }

      const scope = createScope({ name: 'inst-activity', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'panel')
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'hello')}>
            {state.text}
          </button>
        )
      }

      function Panel({ mode }: { mode: 'visible' | 'hidden' }) {
        return (
          <Activity mode={mode}>
            <Uploader />
          </Activity>
        )
      }

      const view = RTL.render(<Panel mode="visible" />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })
      expect(RTL.screen.getByTestId('u').textContent).to.equal('hello')

      await RTL.act(async () => {
        view.rerender(<Panel mode="hidden" />)
      })
      expect(scope.instances('draft'), 'the hidden mount was the last lease').to.not.have.own.property('panel')

      await RTL.act(async () => {
        view.rerender(<Panel mode="visible" />)
      })
      expect(RTL.screen.getByTestId('u').textContent, 'showing it again reseeds the instance').to.equal('')
    })

    it('keeps its state across an unmounting hide when a handle outside React holds a lease', async function () {
      if (!hasActivity) {
        return this.skip()
      }

      const scope = createScope({ name: 'inst-activity-held', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)
      const held = scope.instance('draft', 'panel')

      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'panel')
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'hello')}>
            {state.text}
          </button>
        )
      }

      function Panel({ mode }: { mode: 'visible' | 'hidden' }) {
        return (
          <Activity mode={mode}>
            <Uploader />
          </Activity>
        )
      }

      const view = RTL.render(<Panel mode="visible" />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })

      await RTL.act(async () => {
        view.rerender(<Panel mode="hidden" />)
      })
      expect(held.read().text, 'the surviving lease still addresses the state').to.equal('hello')

      await RTL.act(async () => {
        view.rerender(<Panel mode="visible" />)
      })
      expect(RTL.screen.getByTestId('u').textContent, 'the mount rejoined what it left').to.equal('hello')
      held.dispose()
    })

    // The prepared object is built once for the mount and survives an `<Activity>` hide, so a mount
    // whose first render met an instance somebody else had already advanced would come back to
    // *that render's* snapshot — neither the live state nor the seed — if it held one.
    it('comes back at the seed even when its first render met an instance already in progress', async function () {
      if (!hasActivity) {
        return this.skip()
      }

      const scope = createScope({ name: 'inst-activity-stale', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      const outside = scope.instance('draft', 'panel')
      await outside.emit('draft.type', 'first')

      function Uploader() {
        const [state] = useDomainInstance('draft', 'panel')
        return <span data-testid="u">{state.text}</span>
      }

      function Panel({ mode }: { mode: 'visible' | 'hidden' }) {
        return (
          <Activity mode={mode}>
            <Uploader />
          </Activity>
        )
      }

      const view = RTL.render(<Panel mode="visible" />)
      expect(RTL.screen.getByTestId('u').textContent, 'the mount joined what was already there').to.equal('first')

      await RTL.act(async () => {
        await outside.emit('draft.type', 'latest')
      })
      expect(RTL.screen.getByTestId('u').textContent).to.equal('latest')

      // Leaving the mount as the only lease, so the hide really does take the instance with it.
      outside.dispose()

      await RTL.act(async () => {
        view.rerender(<Panel mode="hidden" />)
      })
      expect(scope.instances('draft'), 'the hidden mount was the last lease').to.not.have.own.property('panel')

      await RTL.act(async () => {
        view.rerender(<Panel mode="visible" />)
      })
      expect(RTL.screen.getByTestId('u').textContent, 'not the snapshot the first render met').to.equal('')
      expect(scope.instances('draft').panel?.text, 'and the published instance agrees').to.equal('')
    })

    it('rejoins the live state, not the seed, when a hide leaves the id in another holder', async function () {
      if (!hasActivity) {
        return this.skip()
      }

      const scope = createScope({ name: 'inst-activity-retained', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      const outside = scope.instance('draft', 'panel')
      await outside.emit('draft.type', 'first')

      function Uploader() {
        const [state] = useDomainInstance('draft', 'panel')
        return <span data-testid="u">{state.text}</span>
      }

      function Panel({ mode }: { mode: 'visible' | 'hidden' }) {
        return (
          <Activity mode={mode}>
            <Uploader />
          </Activity>
        )
      }

      const view = RTL.render(<Panel mode="visible" />)

      await RTL.act(async () => {
        view.rerender(<Panel mode="hidden" />)
      })
      await RTL.act(async () => {
        await outside.emit('draft.type', 'moved on while hidden')
      })

      await RTL.act(async () => {
        view.rerender(<Panel mode="visible" />)
      })
      expect(RTL.screen.getByTestId('u').textContent, 'the id was never free, so nothing was reseeded').to.equal(
        'moved on while hidden',
      )
      outside.dispose()
    })

    it('reads the same snapshot across repeated hide and show cycles', async function () {
      if (!hasActivity) {
        return this.skip()
      }

      const scope = createScope({ name: 'inst-activity-cycles', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      function Uploader() {
        const [state, emit] = useDomainInstance('draft', 'panel')
        return (
          <button data-testid="u" onClick={() => void emit('draft.type', 'hello')}>
            {state.text}
          </button>
        )
      }

      function Panel({ mode }: { mode: 'visible' | 'hidden' }) {
        return (
          <Activity mode={mode}>
            <Uploader />
          </Activity>
        )
      }

      // A release that computed its replacement inside `read` would answer getSnapshot with a new
      // object per call. React catches that itself rather than spinning, so the complaint it logs is
      // the evidence: without it the cycles below pass either way.
      const complaints: string[] = []
      const realError = console.error
      console.error = (...args: unknown[]) => complaints.push(args.map(String).join(' '))

      try {
        const view = RTL.render(<Panel mode="visible" />)

        for (let cycle = 0; cycle < 5; cycle += 1) {
          await RTL.act(async () => {
            RTL.screen.getByTestId('u').click()
          })
          expect(RTL.screen.getByTestId('u').textContent).to.equal('hello')

          await RTL.act(async () => {
            view.rerender(<Panel mode="hidden" />)
          })
          await RTL.act(async () => {
            view.rerender(<Panel mode="visible" />)
          })
          expect(RTL.screen.getByTestId('u').textContent, 'every cycle starts over').to.equal('')
        }
      } finally {
        console.error = realError
      }

      expect(complaints, 'the fallback snapshot kept its reference').to.deep.equal([])
      expect(scope.instances('draft'), 'and the last show left a live lease').to.have.own.property('panel')
    })

    // The rebuild an abandoned render forces reaches this far. React keeps the newest `create`
    // closure even when the dependencies match, so the object the show mounts is the rebuilt one
    // while the cleanup the hide ran belonged to its predecessor: reseeding a released object leaves
    // the successor holding whatever the rebuild happened to read, two writes ago.
    it('comes back at the seed when an abandoned render rebuilt the object the show mounts', async function () {
      if (!hasActivity) {
        return this.skip()
      }

      const scope = createScope({ name: 'inst-activity-rebuilt', domains: [draft, cart, session] })
      const { useDomainInstance } = createScopeHooks(scope)

      // Resolved once the abandoned render has been replaced, so the discarded transition is retired
      // and the rebuild under test is the one the `first` write preceded.
      let release = () => {}
      const pending = new Promise<void>(resolve => {
        release = resolve
      })
      function Suspender({ on }: { on: boolean }) {
        if (on) {
          throw pending
        }
        return null
      }

      function Row({ id }: { id: string }) {
        const [state, emit] = useDomainInstance('draft', id)
        return (
          <div>
            <button data-testid="u" onClick={() => void emit('draft.type', 'first')}>
              {state.text}
            </button>
            <button data-testid="later" onClick={() => void emit('draft.type', 'latest')} />
            <Suspender on={id === 'b'} />
          </div>
        )
      }

      let swap = () => {}
      let cancel = () => {}
      function Panel({ mode }: { mode: 'visible' | 'hidden' }) {
        const [id, setId] = useState('a')
        const [count, setCount] = useState(0)
        const [, startTransition] = useTransition()
        swap = () => startTransition(() => setId('b'))
        cancel = () => {
          setId('a')
          setCount(value => value + 1)
        }
        return (
          <Activity mode={mode}>
            <Suspense fallback={<i data-testid="fallback">loading</i>}>
              <Row id={id} />
              <span>{count}</span>
            </Suspense>
          </Activity>
        )
      }

      const view = RTL.render(<Panel mode="visible" />)
      await RTL.act(async () => {
        RTL.screen.getByTestId('u').click()
      })

      await RTL.act(async () => {
        swap()
      })
      await RTL.act(async () => {
        cancel()
      })
      await RTL.act(async () => {
        release()
        await Promise.resolve()
      })
      expect(RTL.screen.getByTestId('u').textContent, 'the rebuilt object reads the live state').to.equal('first')

      await RTL.act(async () => {
        RTL.screen.getByTestId('later').click()
      })
      expect(RTL.screen.getByTestId('u').textContent).to.equal('latest')

      await RTL.act(async () => {
        view.rerender(<Panel mode="hidden" />)
      })
      expect(scope.instances('draft'), 'the hidden mount was the last lease').to.not.have.own.property('a')

      await RTL.act(async () => {
        view.rerender(<Panel mode="visible" />)
      })
      expect(RTL.screen.getByTestId('u').textContent, 'not the snapshot the rebuild read').to.equal('')
      expect(scope.instances('draft').a?.text, 'and the published instance agrees').to.equal('')
    })
  })

  describe('server rendering and hydration', () => {
    let container: HTMLDivElement

    beforeEach(() => {
      container = document.createElement('div')
      document.body.appendChild(container)
    })

    afterEach(() => {
      container.remove()
    })

    it('adopts what the server rendered, and hydrates its DOM instead of replacing it', async () => {
      const serverScope = createScope({ name: 'ssr-server', domains: [upload] })
      await serverScope.emit('upload.pick', { count: 7 })

      const hooks = createScopeHooks(serverScope)
      function Files() {
        const state = hooks.useDomain('upload')
        return <span data-testid="files">{state.files}</span>
      }

      const html = ReactDOMServer.renderToString(<Files />)
      expect(html).to.contain('>7<')

      const payload = JSON.parse(JSON.stringify(serverScope.getState())) as { upload: { files: number } }
      const clientScope = createScope({
        name: 'ssr-client',
        domains: [upload],
        preloadedState: payload,
      })

      container.innerHTML = html
      const node = container.querySelector('[data-testid="files"]')

      const recoverable: unknown[] = []
      let root: ReturnType<typeof ReactDOMClient.hydrateRoot> | undefined
      await RTL.act(async () => {
        root = ReactDOMClient.hydrateRoot(
          container,
          <hooks.ScopeProvider scope={clientScope}>
            <Files />
          </hooks.ScopeProvider>,
          { onRecoverableError: error => recoverable.push(error) },
        )
      })

      expect(recoverable).to.deep.equal([])
      expect(container.querySelector('[data-testid="files"]')).to.equal(node)
      expect(node?.textContent).to.equal('7')

      await RTL.act(async () => {
        root?.unmount()
      })
    })

    it('reaches the per-request scope only through a provider, on both sides', async () => {
      const moduleScope = createScope({ name: 'module-singleton', domains: [upload] })
      const hooks = createScopeHooks(moduleScope)

      function App() {
        const state = hooks.useDomain('upload')
        return <span data-testid="files">{state.files}</span>
      }

      const requestScope = createScope({ name: 'request-1', domains: [upload] })
      await requestScope.emit('upload.pick', { count: 7 })

      const html = ReactDOMServer.renderToString(
        <hooks.ScopeProvider scope={requestScope}>
          <App />
        </hooks.ScopeProvider>,
      )
      expect(html).to.contain('>7<')

      expect(ReactDOMServer.renderToString(<App />)).to.contain('>0<')

      container.innerHTML = html
      const node = container.querySelector('[data-testid="files"]')
      const clientScope = createScope({
        name: 'client-1',
        domains: [upload],
        preloadedState: { upload: { files: 7 } },
      })

      const recoverable: unknown[] = []
      let root: ReturnType<typeof ReactDOMClient.hydrateRoot> | undefined
      await RTL.act(async () => {
        root = ReactDOMClient.hydrateRoot(
          container,
          <hooks.ScopeProvider scope={clientScope}>
            <App />
          </hooks.ScopeProvider>,
          { onRecoverableError: error => recoverable.push(error) },
        )
      })

      expect(recoverable).to.deep.equal([])
      expect(container.querySelector('[data-testid="files"]')).to.equal(node)

      await RTL.act(async () => {
        root?.unmount()
      })
    })

    it('renders the new value when a scope is rendered again after a dispatch', async () => {
      const scope = createScope({ name: 'ssr-again', domains: [upload] })
      const { useDomain } = createScopeHooks(scope)

      function Files() {
        const state = useDomain('upload')
        return <span data-testid="files">{state.files}</span>
      }

      const first = ReactDOMServer.renderToString(<Files />)
      await scope.emit('upload.pick', { count: 3 })
      const second = ReactDOMServer.renderToString(<Files />)

      expect(first).to.contain('>0<')
      expect(second).to.contain('>3<')
    })
  })
})
