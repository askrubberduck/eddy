# React

The hooks from `@askrubberduck/eddy/react`. React 18 or 19 is an optional peer dependency.

```tsx
import { useEffect, useState } from 'react'
import { createScope, defineDomain, reduce, view } from '@askrubberduck/eddy'
import type { DomainType, Reduce, Scope } from '@askrubberduck/eddy'
import { createScopeHooks } from '@askrubberduck/eddy/react'

type CartState = { lines: { sku: string; qty: number }[] }
type CartViews = { count: number }
type CartActions = { add: Reduce<{ sku: string; qty: number }> }

type QuickAddState = { sku: string }
type QuickAddActions = { choose: Reduce<{ sku: string }> }

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
  state: () => ({ sku: '' }),
  actions: { choose: reduce((_state, action) => ({ sku: action.input.sku })) },
})

const appScope = createScope({ name: 'app', domains: [cart, quickAdd] })
const { ScopeProvider, useDomainValue, useEmit, useDomainInstance } = createScopeHooks(appScope)

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
        emit('cart.add', { sku: draft.sku, qty: 1 }).catch(report)
      }}
    >
      <input
        value={draft.sku}
        onChange={event => emitLocal('quickAdd.choose', { sku: event.target.value }).catch(report)}
      />
    </form>
  )
}

export function App() {
  const [preview, setPreview] = useState<Scope<'cart' | 'quickAdd'>>()
  useEffect(() => {
    const created = createScope({ name: 'preview', domains: [cart, quickAdd] })
    setPreview(created)
    return () => created.dispose()
  }, [])

  return (
    <>
      <Count />
      <QuickAdd />
      {preview && (
        <ScopeProvider scope={preview}>
          <Count />
        </ScopeProvider>
      )}
    </>
  )
}
```

## `createScopeHooks(scope)`

It returns `ScopeProvider`, `useScope`, `useDomain`, `useDomainValue`, `useEmit` and `useDomainInstance`.
The hooks use `scope`, or the scope of the nearest `ScopeProvider`.

| Hook                                         | Returns                         | Renders again when                                 |
| -------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| `useDomain(domain)`                          | the domain's state and views    | the domain's state reference changes               |
| `useDomainValue(domain, selector, isEqual?)` | the selected value              | `isEqual` (default `shallowEqual`) says it changed |
| `useEmit()`                                  | the active scope's `emit`       | —                                                  |
| `useScope()`                                 | the active scope                | —                                                  |
| `useDomainInstance(domain, id?)`             | `[state, emit]` of one instance | that instance changes                              |

- Use `useDomainValue` when the component shows one value. `useDomain` renders on every change to the domain.
- A selector may return a new object. `shallowEqual` keeps the reference stable.
- Define the selector outside the component when its cost matters. An inline selector runs on every render.
- `@askrubberduck/eddy/react` exports `shallowEqual`. It compares one level of own keys and compares `Date`s by time.
- Attach `.catch` to an emit in an event handler. `void` alone does not handle a rejection.

## `useDomainInstance(domain, id?)`

- Without `id`, the mount gets its own instance. With `id`, all mounts with that id share it.
- The hook takes the handle after commit and releases it on unmount. StrictMode replays are safe.
- The returned `emit` carries the instance id. It accepts instanced addresses. `useEmit` does not.

## `ScopeProvider`

- Use it to give a subtree its own scope: a preview, a wizard, a request.
- Create the scope in the effect that disposes it. Do not create it during render.
- StrictMode runs each effect twice. A scope made during render stays disposed.

## Server rendering

- Create one scope for each request. Never share a scope between requests.
- Supply it through `ScopeProvider` on the server and on the client.
- Send `getWrittenState()` to the client. Pass it as `preloadedState` there.

## Preact

- There is no Preact entry point. `@askrubberduck/eddy/react` runs on Preact through an alias.
- In the bundler, alias `react` and `react-dom` to `preact/compat`.
- Alias `react/jsx-runtime` to `preact/jsx-runtime`. `@preact/preset-vite` sets all three.

## Signals

- There is no signals entry point. Build a signal from `scope.read(domain)` and `scope.subscribe(listener)`.
- In `subscribe`, write `scope.read(domain)` into a writable signal. Expose a read-only derivation of it.
- Call the unsubscribe function from `subscribe` when the signal is no longer used.
