# Views

A view is a value derived from a domain's own state, declared once, memoised on its input, and read
as if it were a field. It lives in the state the scope publishes, so a component, a neighbour's
command, a watcher and a test all read `cart.total` the same way and never compute it themselves.

## The example on this page

A cart whose total depends on a subtotal that depends on its lines.

```ts
import { createScope, defineDomain, reduce, view } from '@askrubberduck/eddy'
import type { DomainType, Reduce } from '@askrubberduck/eddy'

type Line = { sku: string; qty: number; unitPrice: number }
type CartState = { lines: Line[]; coupon: number }
type CartViews = { subtotal: number; shipping: number; total: number }
type CartActions = {
  add: Reduce<Line>
  setCoupon: Reduce<{ percent: number }>
}

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews>
  }
}

export const cart = defineDomain('cart', [], {
  state: { lines: [], coupon: 0 },
  actions: {
    add: reduce((state, action) => ({ lines: [...state.lines, action.input] })),
    setCoupon: reduce((_state, action) => ({ coupon: action.input.percent })),
  },
  views: {
    subtotal: view(
      state => state.lines,
      lines => lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0),
    ),
    shipping: view(
      state => state.subtotal,
      subtotal => (subtotal === 0 || subtotal >= 5000 ? 0 : 495),
    ),
    total: view(
      state => ({ subtotal: state.subtotal, shipping: state.shipping, coupon: state.coupon }),
      ({ subtotal, shipping, coupon }) => subtotal - Math.round((subtotal * coupon) / 100) + shipping,
    ),
  },
})

export const scope = createScope({ domains: [cart] })
```

## Declaring one

`view(input, transform)` takes a selector over the domain's state and a function of what the
selector returned. The selector sees written fields and sibling views alike, so `shipping` reads
`subtotal` as a field, and `total` reads both. The registry's `Views` type names each view's value,
and a view is read exactly like a field:

```ts
await scope.emit('cart.add', { sku: 'mug', qty: 2, unitPrice: 900 })
scope.read('cart').total // 2295
```

A view is not a field, and nothing may write it. A reducer that returns a view key is refused in
every build, naming the domain, the action and the key; a seed or a preload that carries one is
refused at scope creation. A view never reaches `getWrittenState()`; the [State](State) page covers
what does.

## When it recomputes

The selector runs whenever its domain moves — after every stage of a fold that changed something,
so a later stage reads the view fresh. The transform runs only when the selected input differs from
the last one by deep equality, and when it does run and returns a value equal to the previous one,
the previous reference is kept. A view whose input moved and moved back within one fold is not
republished. The consequence a reader can rely on: `scope.read('cart').total` is the same reference
until the total actually changes, so a selector hook or a memo built on it stays quiet.

A view depends on another by reading it, and the order they are declared in does not matter. A view
that depends on itself, through however many siblings, is refused when the scope is created, not on
first use.

## What the selector may not do

The object a selector receives is an ordinary object with an accessor per view, so `in`,
`Object.keys`, spread and destructuring all agree with a plain read. It is a lens, not the state:
writing to it is refused in a development build, and returning it inside a container is refused
because an accessor is not a state value. Returning it whole is allowed and yields a plain snapshot
of the written fields and every sibling view. Spreading or enumerating it reads every sibling too,
so a sibling that reads this view back is a cycle. The transform's result must itself be a [state value](State), because it is about to
become one.

A view derives from its own domain. A value that needs two domains is derived where both are read:
in a component through two hooks, or in a domain that folds both through `on` and holds the result.

## Ask the duck

- Is the value read by anything other than the component that computes it today — a neighbour, a
  watcher, a test? Then it is a view. Is it read in one place? A selector in that place is shorter.
- Would you persist it? Then it is not derived, and it is a field.
- Does the transform cost enough to notice? The memo is on the input, so pick a selector that names
  exactly what the transform reads and nothing it does not.
