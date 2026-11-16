# Reactions

`on` in a declaration, `effects`, `watch`, `scope.on`, `scope.subscribe`, and their order.

```ts
import { cmd, createScope, defineDomain, effect, reduce, view, watch } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'

type CartState = { lines: string[]; orderId: string | null }
type CartViews = { count: number }
type CartActions = { add: Reduce<{ sku: string }>; checkout: Cmd<void, string> }

type AuditState = { events: string[] }
type AuditActions = { note: Reduce<{ what: string }> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews>
    audit: DomainType<AuditState, AuditActions, {}, 'cart'>
  }
}

export const cart = defineDomain('cart', [], {
  state: { lines: [], orderId: null },
  actions: {
    add: reduce((state, action) => ({ lines: [...state.lines, action.input.sku] })),
    checkout: cmd(async () => `ord-${Date.now()}`, {
      done: (_state, action) => ({ orderId: action.result, lines: [] }),
    }),
  },
  views: {
    count: view(
      state => state.lines,
      lines => lines.length,
    ),
  },
})

export const audit = defineDomain('audit', ['cart'], {
  state: { events: [] },
  actions: {
    note: reduce((state, action) => ({ events: [...state.events, action.input.what] })),
  },
  on: {
    'cart.checkout.done': reduce((state, action) => ({ events: [...state.events, `order ${action.result}`] })),
  },
  effects: {
    'cart.add': effect((action, ctx) => ctx.emit('audit.note', { what: `added ${action.input.sku}` })),
  },
  watch: {
    size: watch(
      (_state, read) => read('cart').count >= 3,
      (large, _previous, ctx) => ctx.emit('audit.note', { what: large ? 'cart is large' : 'cart is small' }),
    ),
  },
})

export const scope = createScope({ domains: [cart, audit] })
```

## Choose one

| Need                                              | Use                     |
| ------------------------------------------------- | ----------------------- |
| This domain's state changes because of the action | `on` in the declaration |
| Something outside state changes, or a new emit    | `effects`               |
| A value changed, whatever action changed it       | `watch`                 |
| Code outside every domain listens                 | `scope.on`              |
| A binding re-reads after any change               | `scope.subscribe`       |
| A value is only computed for readers              | a view, not a watcher   |

## The order

For one action in one dispatch:

1. `onAction`, the scope tap, gets a copy of the action before the fold.
2. The fold. Every domain that owns or wires the address is drafted. All commit or none commit.
3. `subscribe` listeners, if the commit changed state.
4. `watch` handlers whose value changed.
5. `effects`, keyed by the address.
6. `scope.on` handlers: exact address first, then `'*'`.

- An emit from a reaction is queued. It folds after the current action completes all six steps.
- So a cascade is breadth-first. Each reaction reads the state its own action left.
- A reaction that throws goes to the reporter. The reactions after it still run.

## `on` in a declaration

- Key a reducer by a neighbour address, including `.done` and `.failed`.
- It receives the full action: `input`, and `result` or `error` for an outcome.
- It folds in the same transaction as the action's own stages.
- A wire to an address that a hosted domain does not answer makes `createScope` throw.
- A wire into a domain the scope does not host is dropped and logged.

## `effects`

- Key `effect((action, ctx) => …)` by an address on this domain or a declared neighbour.
- `ctx` has `read` and `emit` only. There are no stages and no signal.
- An effect may return a promise. Nothing waits for it. A rejection goes to the reporter.

## `watch(source, handler)`

- `source` is `(state, read) => value`. `read` reaches declared neighbours.
- The scope evaluates `source` after each commit that moved this domain or a neighbour.
- `handler(next, previous, ctx)` runs only when the value changes by deep equality.
- The scope seeds the value at creation. A watcher does not run on creation.
- The handler may return a `Teardown`. It runs before the next run and on dispose.
- The value must be a state value.
- A handler that moves its own watched value loops. The cascade guard stops it.
- An instanced domain cannot declare watchers.

## `scope.on(address, handler)`

```ts
const stop = scope.on(['cart.add', 'cart.checkout.done'], action => {
  if (action.type === 'cart.checkout.done') {
    console.log(action.result)
  }
})

stop()
```

- Give one address, a list, or `'*'`. One unsubscribe function covers all of them.
- An unknown domain, an unknown action, or an outcome of a reducer throws at registration.
- The handler runs after every completed fold, also one that changed nothing. It does not run after a throw.
- Under `'*'` the action is `ActionIn<Names>`. Check `action.type` to narrow it.
- There is no `'cart.*'` and no predicate. Use `'*'` and check `action.type`.

## `scope.subscribe(listener)`

- The listener runs with no argument after each commit that changed state.
- A fold that changed nothing does not notify. The React hooks use this.
