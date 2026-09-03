# React

The binding is a set of hooks made from one scope. `createScopeHooks(scope)` returns a provider and
five hooks bound to that scope by default and to whatever a `ScopeProvider` above the component
supplies instead. It subscribes through `useSyncExternalStore`, so a component renders when the
state it read moves and not otherwise, in React 18 and React 19.

<!-- fence: skip the import alone; the example below imports it -->

```ts
import { createScopeHooks } from '@askrubberduck/eddy/react'
```

## The example on this page

A cart, a per-mount quick-add panel, and a preview scope beside the real one.

```tsx
import { useEffect, useState } from 'react'
import { createScope, defineDomain, reduce, view } from '@askrubberduck/eddy'
import type { DomainType, Reduce } from '@askrubberduck/eddy'
import { createScopeHooks } from '@askrubberduck/eddy/react'

type CartState = { lines: { sku: string; qty: number }[] }
type CartViews = { count: number }
type CartActions = { add: Reduce<{ sku: string; qty: number }> }

type QuickAddState = { sku: string; qty: number }
type QuickAddActions = { choose: Reduce<{ sku: string }>; setQty: Reduce<{ qty: number }> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews>
    quickAdd: DomainType<QuickAddState, QuickAddActions, {}, never, true>
  }
}

const cart = defineDomain('cart', [], {
  state: { lines: [] },
  actions: { add: reduce((state, action) => ({ lines: [...state.lines, action.input] })) },
  views: {
    count: view(
      state => state.lines,
      lines => lines.reduce((sum, line) => sum + line.qty, 0),
    ),
  },
})

const quickAdd = defineDomain('quickAdd', [], {
  instanced: true,
  state: () => ({ sku: '', qty: 1 }),
  actions: {
    choose: reduce((_state, action) => ({ sku: action.input.sku })),
    setQty: reduce((_state, action) => ({ qty: Math.max(1, action.input.qty) })),
  },
})

const appScope = createScope({ name: 'app', domains: [cart, quickAdd] })
const { ScopeProvider, useScope, useDomain, useDomainValue, useEmit, useDomainInstance } = createScopeHooks(appScope)

const report = (error: unknown): void => console.error(error)

function Count() {
  const count = useDomainValue('cart', state => state.count)
  return <span>{count} in the cart</span>
}

function QuickAdd() {
  const [draft, emitLocal] = useDomainInstance('quickAdd')
  const emit = useEmit()

  return (
    <form
      onSubmit={event => {
        event.preventDefault()
        void emit('cart.add', { sku: draft.sku, qty: draft.qty }).catch(report)
      }}
    >
      <input value={draft.sku} onChange={event => void emitLocal('quickAdd.choose', { sku: event.target.value })} />
      <input
        type="number"
        value={draft.qty}
        onChange={event => void emitLocal('quickAdd.setQty', { qty: Number(event.target.value) })}
      />
      <button type="submit">Add {draft.qty}</button>
    </form>
  )
}

export function App() {
  const [preview] = useState(() => createScope({ name: 'preview', domains: [cart, quickAdd] }))
  useEffect(() => () => preview.dispose(), [preview])

  const { name } = useScope()
  const lines = useDomain('cart').lines

  return (
    <>
      <h1>{name}</h1>
      <Count />
      <QuickAdd />
      <ul>
        {lines.map(line => (
          <li key={line.sku}>{line.sku}</li>
        ))}
      </ul>
      <ScopeProvider scope={preview}>
        <Count />
      </ScopeProvider>
    </>
  )
}
```

## `useDomain(domain)`

The whole readable state of one domain, views included. The component renders again when that
domain's state reference changes, which is when a fold moved it and not when a neighbour moved.
Reading `cart` in a component that only shows the count means it renders for every line added; that
is what the next hook is for.

## `useDomainValue(domain, selector, isEqual?)`

One value selected from a domain, compared with `shallowEqual` by default or a comparator you
supply, and the component renders only when the comparison says the value moved. A selector that
returns a fresh object each time is fine: shallow equality on the previous result keeps the
reference stable, so the hook never loops. Identity matters in one direction: the hook caches by
selector, so a selector defined inline recomputes every render and a selector defined once is
recomputed only when the state or the comparator changes.

`shallowEqual` is exported for reuse. It compares one level of own enumerable keys, symbols
included, tells an array from an object with the same keys, and compares a `Date` by its time.

## `useEmit()` and `useScope()`

`useEmit` is the active scope's `emit`, typed to refuse an instanced address, because a scope-level
emit carries no identity. `useScope` is the scope itself, for a component that needs `read`,
`on` or `name`. A handler that emits from an event attaches a rejection handler: `void` alone does
not handle a rejected promise.

## `useDomainInstance(domain, id?)`

One instance of an instanced domain, as `[state, emit]`. With no `id` the mount mints one and the
instance is the mount's alone; with an `id`, every mount naming it shares the instance. The lease is
taken after commit and released on unmount, so a StrictMode replay, a suspended render that named
another id, or a render React abandoned does not strand a command in flight or point a visible
mount at an instance that never arrived. The returned `emit` is the handle's and takes the instanced
addresses `useEmit` refuses.

The instance lives in the provider's scope, so its commands read neighbours and its actions fold in
the same transaction as everything else; the [Instances](Instances) page is the contract.

## `ScopeProvider`

The hooks read the scope passed to `createScopeHooks` unless a `ScopeProvider` above the component
supplies another. That is how a preview, a wizard or a request gets its own state without a second
set of hooks. The component that creates the scope disposes it.

## Server rendering

Nothing on the server is shared: one scope per request, supplied through a `ScopeProvider` on both
sides, its written state serialised with `getWrittenState()` and passed back as `preloadedState` on
the client. The hooks hand `useSyncExternalStore` the live read as its server snapshot, so a store
that moves during the hydration pass is a recoverable mismatch, as it is for any external store.

## Packaging

`@askrubberduck/eddy/react` is a subpath in the package's `exports` map, and a `react.js` at the
package root answers resolvers that predate `exports`, so a React Native application on an older
Metro bundles it. React 18 or 19 is a peer dependency, optional, and the suite runs against both.

## Ask the duck

- Does the component need the whole domain, or one number from it? `useDomain` renders when the
  domain moves; `useDomainValue` renders when the number does.
- Is the state private to this mount? `useDomainInstance` with no id. Shared by two mounts that both
  know the id? Pass the id. Shared by everyone? It is a plain domain.
- Is a selector defined inline, and does its cost show? Define it once, outside the component or in
  a `useCallback`, and the cache does the rest.
