# State and views

Views, the values state may hold, equality, and persistence.

```ts
import { createScope, defineDomain, reduce, view } from '@askrubberduck/eddy'
import type { DomainType, Reduce } from '@askrubberduck/eddy'

type Line = { sku: string; qty: number; unitPrice: number }
type CartState = { lines: Line[]; coupon: number; updatedAt: Date | null }
type CartViews = { subtotal: number; total: number }
type CartActions = { add: Reduce<Line>; setCoupon: Reduce<{ percent: number }> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews>
  }
}

export const cart = defineDomain('cart', [], {
  state: () => ({ lines: [], coupon: 0, updatedAt: null }),
  actions: {
    add: reduce((state, action) => ({ lines: [...state.lines, action.input], updatedAt: new Date() })),
    setCoupon: reduce((_state, action) => ({ coupon: action.input.percent })),
  },
  views: {
    subtotal: view(
      state => state.lines,
      lines => lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0),
    ),
    total: view(
      state => ({ subtotal: state.subtotal, coupon: state.coupon }),
      ({ subtotal, coupon }) => subtotal - Math.round((subtotal * coupon) / 100),
    ),
  },
})

export const scope = createScope({ domains: [cart] })
```

## Views

- Declare a view as `view(input, transform)`. Name its type in the third argument of `DomainType`.
- `input` selects from the domain's fields and its other views. `transform` computes from that selection.
- Read a view as a field: `scope.read('cart').total`.
- The declaration order of views has no effect. A view that depends on itself is refused.
- `input` runs after every stage that changes the domain.
- `transform` runs only when the selection changes by deep equality.
- An equal transform result keeps the previous reference. Selector hooks then stay quiet.
- Make `input` select only what `transform` reads. The memo is on the input.
- A view reads only its own domain. For two domains, use `on` to fold the value into one domain.
- Do not write to the object `input` receives. Do not return it inside a container.
- An instanced domain cannot declare views.
- Keep a value as a field, not a view, when you must persist it.

## What state may hold

`StateValue` is `undefined`, `null`, a boolean, a number, a string, a bigint, a `Date`, an array, or a plain object of these.

| Refused                       | Hold instead                       |
| ----------------------------- | ---------------------------------- |
| `Map`, `Set`                  | an array of entries                |
| `RegExp`                      | its source                         |
| `Error`                       | a message and a code               |
| a class instance, a function  | plain data, or an id               |
| a socket, a cache, an element | an id; the module holds the handle |

Also refused:

- a null-prototype object, a symbol, a typed array;
- an accessor or a non-enumerable property;
- a value from another realm;
- a `Date` subclass, or a `Date` with own properties;
- a `__proto__` field name, in every build.

## Development and production

- A build is development unless `process.env.NODE_ENV` is `'production'`. No `process` means production.
- Development checks every ingress: seed, preload, stage output, view input and value, watcher value.
- Development freezes all published state. A nested write throws.
- Do not call `Date.prototype.setTime` on state. The freeze cannot stop it. Make a new `Date`.
- Production does not check or freeze. A mutating reducer keeps its mutation, even on rejection.
- Production still refuses a stage that returns a non-object or writes a view key.

## Equality

- Equality is deep and structural. `NaN` equals `NaN`. Two `Date`s are equal when their times are equal.
- A key that arrives with `undefined` where no key existed is a change.
- A domain that did not move keeps its state object. `getState()` changes only when a domain moves.

## Persistence

```ts
const saved = scope.getWrittenState()
const restored = createScope({ domains: [cart], preloadedState: saved })
```

- `getWrittenState()` gives cloned written fields. It omits view keys. Save this, not `getState()`.
- A preloaded domain is a partial. The scope merges it over the seed and computes the views.
- A preload with a view key or a non-object is refused. An unknown domain is logged and ignored.
- `JSON.stringify` throws on a `bigint` and turns a `Date` into a string. Revive it on load.
- Prefer a numeric timestamp to a `Date` when state goes through JSON.

## The seed

- `state` is an object or a factory. The scope copies an object seed at the top level for each scope.
- Development freezes the nested values that an object seed shares between scopes.
- A factory must return a new object on each call. Development refuses a reused root.
