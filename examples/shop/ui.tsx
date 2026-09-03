import { useEffect, useState } from 'react'
import { createScope, defineDomain, reduce } from '../../src/index'
import type { DomainType, Reduce } from '../../src/index'
import { createScopeHooks } from '../../src/react'
import { analytics } from './domains/analytics'
import { cart } from './domains/cart'
import { catalog } from './domains/catalog'
import { session } from './domains/session'

export type QuickAddState = { sku: string; qty: number }
export type QuickAddActions = {
  choose: Reduce<{ sku: string }>
  setQty: Reduce<{ qty: number }>
}

declare module '../../src/types' {
  interface Domains {
    quickAdd: DomainType<QuickAddState, QuickAddActions, {}, never, true>
  }
}

// Instanced: the panel's draft is private to the mount, and it lives in the shop's own scope, so
// the commit below is an ordinary emit into a neighbour rather than a hop between two stores.
const quickAdd = defineDomain('quickAdd', [], {
  instanced: true,
  state: () => ({ sku: '', qty: 1 }),
  actions: {
    choose: reduce((_state, action) => ({ sku: action.input.sku })),
    setQty: reduce((_state, action) => ({ qty: Math.max(1, action.input.qty) })),
  },
})

const appScope = createScope({
  name: 'shop-ui',
  domains: [catalog, session, cart, analytics, quickAdd] as const,
})

const { ScopeProvider, useScope, useDomain, useDomainValue, useEmit, useDomainInstance } = createScopeHooks(appScope)

const report = (error: unknown): void => console.error(error)

function CartSummary() {
  const state = useDomain('cart')

  return (
    <aside aria-busy={state.pending}>
      <p>
        {state.itemCount} item(s), total £{(state.total / 100).toFixed(2)}
      </p>
      {state.coupon ? <p>Coupon {state.coupon.code} applied</p> : null}
      {state.lastError ? <p role="alert">{state.lastError}</p> : null}
    </aside>
  )
}

function ProductList() {
  const skus = useDomainValue('catalog', state => state.visible.map(product => product.sku))
  const cheapest = useDomainValue('catalog', state => state.cheapestVisible?.sku ?? null)
  const emit = useEmit()

  return (
    <ul>
      {skus.map(sku => (
        <li key={sku}>
          <button onClick={() => void emit('catalog.select', { sku }).catch(report)}>{sku}</button>
          {sku === cheapest ? <span> (cheapest)</span> : null}
          <button onClick={() => void emit('cart.add', { sku, qty: 1 }).catch(report)}>Add</button>
        </li>
      ))}
    </ul>
  )
}

function CartLineRow({ sku }: { sku: string }) {
  const state = useDomain('cart')
  const line = state.lines.find(candidate => candidate.sku === sku)

  if (!line) {
    return null
  }

  return (
    <tr>
      <td>{line.title}</td>
      <td>{line.qty}</td>
      <td>£{((line.unitPrice * line.qty) / 100).toFixed(2)}</td>
    </tr>
  )
}

function QuickAddPanel({ skus }: { skus: string[] }) {
  const [draft, emitLocal] = useDomainInstance('quickAdd')
  const emitShared = useEmit()

  return (
    <form
      onSubmit={event => {
        event.preventDefault()
        if (draft.sku !== '') {
          void emitShared('cart.add', { sku: draft.sku, qty: draft.qty }).catch(report)
        }
      }}
    >
      <label>
        Product
        <select
          value={draft.sku}
          onChange={event => void emitLocal('quickAdd.choose', { sku: event.target.value }).catch(report)}
        >
          <option value="">Choose…</option>
          {skus.map(sku => (
            <option key={sku} value={sku}>
              {sku}
            </option>
          ))}
        </select>
      </label>
      <label>
        Quantity
        <input
          type="number"
          min={1}
          value={draft.qty}
          onChange={event => void emitLocal('quickAdd.setQty', { qty: Number(event.target.value) }).catch(report)}
        />
      </label>
      <button type="submit">Add {draft.qty}</button>
    </form>
  )
}

function SignOutButton() {
  const scope = useScope()
  const signedIn = useDomainValue('session', state => state.userId !== null)

  if (!signedIn) {
    return null
  }

  return <button onClick={() => void scope.emit('session.signOut').catch(report)}>Sign out of {scope.name}</button>
}

export function Shop() {
  const [previewScope] = useState(() =>
    createScope({ domains: [catalog, session, cart, analytics, quickAdd] as const }),
  )

  useEffect(() => () => previewScope.dispose(), [previewScope])

  return (
    <>
      <main>
        <ProductList />
        <QuickAddPanel skus={['mug-white', 'mug-black', 'rug-jute']} />
        <table>
          <caption>Cart</caption>
          <tbody>
            <CartLineRow sku="mug-white" />
          </tbody>
        </table>
        <CartSummary />
        <SignOutButton />
      </main>

      <ScopeProvider scope={previewScope}>
        <section aria-label="preview">
          <CartSummary />
        </section>
      </ScopeProvider>
    </>
  )
}
