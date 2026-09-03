# Reactions

Four things can react to an action, and they run in one fixed order after its fold has committed. A
neighbour's `on` reducer is not one of them: it folds _in_ the transaction, as part of the action.
Everything on this page runs afterwards, sees the committed state, and cannot change the outcome of
the action it is reacting to.

## The example on this page

A cart, and an audit domain that watches it, reacts to it, and folds from it.

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

## The order

For one action, in one dispatch:

1. `onAction`, the scope's tap, sees the stamped action before anything folds.
2. The fold: every domain that owns the address or wires it through `on` is drafted, then all are
   committed or none is.
3. `subscribe` listeners, when the commit changed state.
4. `watch` handlers whose value changed.
5. `effects` declared on domains, keyed by the address.
6. `on` handlers registered on the scope: those for the exact address, then those for `'*'`.

A reaction that emits does not run its action now. The action is queued and folds after the current
one has finished all six steps, and after any action queued before it, so a cascade is breadth-first
and every reaction reads the state its own action left. When the queue is empty the dispatch is
over and the promises settle. A reaction that throws is [reported](Diagnostics) and the reactions
after it still run.

## `on` in a declaration: fold, in the transaction

The `on` map of a domain keys reducers by a neighbour's address. It receives the whole action —
input, and result or error for an outcome — and folds into this domain in the same transaction as
the action's own stages. The `audit` domain above records an order in the fold that empties the cart,
so no reader can see one without the other.

```ts
await scope.emit('cart.add', { sku: 'mug' })
await scope.emit('cart.checkout')
scope.read('audit').events // ['added mug', 'order ord-…']
```

## `effects`: react, then emit

The `effects` map keys handlers by an address on this domain or a declared neighbour, including its
`.done` and `.failed` outcomes. A handler receives the action and a context with `read` and `emit`
over the domains this one declared. It has no stages, no signal and no invocation, because it is
reacting to somebody else's action. It may return a promise; nothing waits for it, and a rejection is
reported.

## `watch`: a value crossed a line

`watch(source, handler)` names a value and what to do when it changes. The source reads this domain's
state and, through `read`, any declared neighbour; it is evaluated after every commit that moved this
domain or a declared neighbour, and the handler runs only when the value differs from last time by
deep equality. The value is seeded when the scope is created, so a watcher fires on a change and never
on arrival. The handler receives the new value, the previous one, and the same context an effect gets.

A handler may return a teardown. It runs before the handler's next fire and when the scope is
disposed. A watched value is a [state value](State), and a watcher whose handler moves the value it
watches is a loop the [cascade guard](Actions) will stop.

## `scope.on`: listen from outside

`scope.on(address, handler)` registers a handler for one address, a list of addresses, or `'*'`, and
returns one unsubscribe for all of it. The address is validated when it is registered — a domain the
scope does not host, an action it does not declare, or an outcome of a reducer throws there, so a
typo cannot wait silently. A handler fires after every fold of its address that completed, including
one that changed nothing, and never for one that threw, because nothing committed. Under `'*'` the
action is the union of every address, `ActionIn`, so a check on `action.type` narrows it to that
address's exact payload.

```ts
const stop = scope.on(['cart.add', 'cart.checkout.done'], action => {
  if (action.type === 'cart.checkout.done') {
    console.log(action.result)
  }
})

stop()
```

`'*'` is the only subscription that keeps observing when a domain gains an action; there is no
`'cart.*'` and no predicate, because a predicate has no address and nothing could resolve it when the
scope is built.

## `scope.subscribe`: state moved

`subscribe(listener)` is notified after every commit that changed some domain's state, with no
argument, and is what the [React](React) binding uses. A fold that changed nothing does not notify.

## Ask the duck

- Should state change because of this? An `on` reducer, in the transaction. Should the world change?
  An effect. Did a value cross a line, whichever action pushed it? A watcher.
- Is the reaction reading state to decide what to emit? Then it reads the state its action left, and
  that is the state it should decide on.
- Could this be a view instead? A watcher that only computes something for readers is a view that
  fires.
