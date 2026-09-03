// Compiles the published declarations with the oldest TypeScript this package claims to support,
// as a consumer does: through the package specifier, with `skipLibCheck` off.
//
// Nothing else in the repository looks at `output/`. `tsconfig.json`, `test/tsconfig.json`,
// `examples/tsconfig.json` and `test/empty-registry/tsconfig.json` all exclude it, and the only
// compiler otherwise in play is the devDependency — which is four majors above the floor. That gap
// is how `const` type parameters and `NoInfer` reached the artifact without anything noticing that
// they put the floor at TypeScript 5.4.
import { cmd, createScope, defineDomain, reduce, view } from '../../output/index'
import type { Cmd, DomainType, Reduce } from '../../output/index'

type Item = { sku: string; qty: number }
type CartState = { items: Item[]; pending: boolean }
type CartViews = { count: number }
type CartActions = { add: Cmd<{ sku: string }, Item>; clear: Reduce }

type DraftState = { text: string }
type DraftActions = { type: Reduce<string> }

declare module '../../output/index' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews>
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    draft: DomainType<DraftState, DraftActions, {}, never, true>
  }
}

declare const api: { price: (sku: string) => Promise<Item> }

const cart = defineDomain('cart', [], {
  state: () => ({ items: [], pending: false }),
  actions: {
    add: cmd(async input => api.price(input.sku), {
      called: { pending: true },
      done: (state, action) => ({ items: [...state.items, action.result] }),
      finally: { pending: false },
    }),
    clear: reduce({ items: [] }),
  },
  views: {
    count: view(
      state => state.items,
      items => items.length,
    ),
  },
})

const draft = defineDomain('draft', [], {
  instanced: true,
  state: () => ({ text: '' }),
  actions: { type: reduce((_state, action) => ({ text: action.input })) },
})

const scope = createScope({ name: 'artifact-probe', domains: [cart, draft] })

// The inference the floor exists for: `NoInfer` keeps the declaration, not the wrapper argument,
// deciding these types, and `const` type parameters keep `domains` a tuple of literal names.
export const added: Promise<Item> = scope.emit('cart.add', { sku: 'MUG-1' })
export const count: number = scope.read('cart').count
export const pending: boolean = scope.read('cart').pending

// The argument guards, which are branded template-literal types: they must resolve to `unknown` on
// the floor for the calls above to type at all, and must still refuse the halves they fence.
export const live: string | undefined = scope.instances('draft')['row']?.text

// @ts-expect-error an instanced domain has no single state
scope.read('draft')

// @ts-expect-error an ordinary domain has no instances
scope.instances('cart')

// @ts-expect-error a scope-level emit names no instance for an instanced domain to fold into
scope.emit('draft.type', 'walked')
