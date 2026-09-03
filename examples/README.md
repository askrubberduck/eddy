# Shop example

A small shop that exercises eddy's public contracts. It is intentionally not an application
template. Nobody needs architecture copied from a shop that cannot sell anything.

## Run it

From the repository root:

```sh
npx tsx examples/shop/main.ts
npm run check:examples
```

`main.ts` uses Node assertions. A green check names a contract that executed; prose-only demos are
very accommodating of broken code.

`ui.tsx` is type-checked but not rendered. There is no browser build in this repository.

## Map

| File                        | Value demonstrated                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `shop/api.ts`               | Async success, failure, latency, and `AbortSignal` cooperation                                   |
| `shop/domains/catalog.ts`   | Pure reducers and a view depending on another view                                               |
| `shop/domains/cart.ts`      | Command stages, `latest`, cross-domain reads, views, watcher, and `on` reducers                  |
| `shop/domains/session.ts`   | A small command domain used by neighbours                                                        |
| `shop/domains/analytics.ts` | Typed effects over invocation and outcome addresses                                              |
| `shop/main.ts`              | Scope creation, action recording, no-op identity, failure, cancellation, isolation, and disposal |
| `shop/ui.tsx`               | Scope hooks, provider override, selected values, local state, and cleanup                        |

## Domain wiring

```text
catalog ──reprice──────────────▶ cart
session ──signOut──────────────▶ cart
catalog ──read product─────────▶ cart.add handler
session ──read user────────────▶ cart.checkout handler
catalog/session/cart actions ──▶ analytics effects
```

Arrows show declared reachability, not imports. Each scope hosts all four domains because `cart` and
`analytics` declare those neighbours. Removing one makes scope construction fail. A silent wire to a
domain that is not there would be shorter code and a worse product.

## Things worth noticing

- Prices are integer pence. Floating-point currency remains available to anyone who wants two bugs.
- `cart.remove` returns a fresh array even when no SKU matches. Deep equality preserves the existing
  state reference and sends no notification.
- `cart.applyCoupon` uses `latest`. The old promise rejects with `CommandAborted`; only the newer
  terminal action folds.
- Analytics writes to a module-level array. Two scopes therefore share its events even though their
  domain state is isolated. The example asserts this because scope isolation has a boundary.
- React command handlers attach rejection handlers. `void` alone does not handle a rejected promise.

The API imports point at `../src`, so the example checks the current source rather than an installed
package. Published usage imports from `@askrubberduck/eddy` and `@askrubberduck/eddy/react`.
