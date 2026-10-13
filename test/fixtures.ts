import { cmd, defineDomain, effect, reduce, view, watch } from '../src/index'
import type { Cmd, DomainType, Reduce } from '../src/index'

export type CartItem = { id: string; sku: string; qty: number; price: number }

export type CartState = {
  items: CartItem[]
  coupon: string | null
  taxRate: number
  pending: boolean
  error: string | null
}

export type CartViews = {
  skus: string[]
  subtotal: number
  tax: number
  total: number
  itemCount: number
}

export type CartActions = {
  add: Cmd<{ sku: string; qty: number }, CartItem>
  checkout: Cmd<void, string>
  fail: Cmd<void, never>
  slow: Cmd<{ tag: string }, string>
  clear: Reduce
  reorder: Reduce<{ from: number; to: number }>

  markUp: Reduce

  countAfterAwait: Cmd<void, number>
}

export type SessionState = { userId: string | null; email: string | null }
export type SessionActions = {
  signIn: Cmd<{ email: string }, { id: string }>
  signOut: Reduce
}

export type UploadState = { files: number; progress: number }
export type UploadActions = { pick: Reduce<{ count: number }>; start: Cmd<void, string[]> }

export type AuditState = { seen: string[] }
export type AuditActions = { note: Reduce<{ what: string }> }

declare module '../src/types' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews, 'session'>
    session: DomainType<SessionState, SessionActions>
    audit: DomainType<AuditState, AuditActions, {}, 'cart' | 'session'>
    upload: DomainType<UploadState, UploadActions>
    draft: DomainType<DraftState, DraftActions, {}, 'session', true>
  }
}

export const api = {
  priced: [] as CartItem[],
  nextId: 0,
  aborts: 0,
  async priceItem(sku: string, qty: number, signal: AbortSignal): Promise<CartItem> {
    await tick()
    if (signal.aborted) {
      api.aborts += 1
    }
    const item = { id: `item-${++api.nextId}`, sku, qty, price: 10 }
    api.priced.push(item)
    return item
  },
  async checkout(): Promise<{ id: string }> {
    await tick()
    return { id: `order-${++api.nextId}` }
  },
  reset() {
    api.priced = []
    api.nextId = 0
    api.aborts = 0
  },
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

export const observed = {
  added: [] as string[],
  signedIn: [] as string[],
  failures: [] as string[],
  emptied: [] as boolean[],
  reset() {
    observed.added = []
    observed.signedIn = []
    observed.failures = []
    observed.emptied = []
  },
}

export const cart = defineDomain('cart', ['session'], {
  state: () => ({ items: [], coupon: null, taxRate: 0.2, pending: false, error: null }),

  actions: {
    add: cmd(
      async (input, ctx) => {
        if (input.qty < 1) {
          throw new RangeError(`qty must be at least 1, got ${input.qty} for '${input.sku}'`)
        }
        return api.priceItem(input.sku, input.qty, ctx.signal)
      },
      {
        called: { pending: true, error: null },
        done: (state, action) => ({ items: [...state.items, action.result] }),
        failed: (_state, action) => ({ error: String(action.error) }),
        finally: { pending: false },
      },
    ),

    checkout: cmd(
      async (_input, ctx) => {
        const session = ctx.read('session')
        if (!session.userId) {
          throw new Error('Unable to checkout: no session')
        }
        const order = await api.checkout()
        return order.id
      },
      { done: { items: [], coupon: null } },
    ),

    fail: cmd(async () => {
      throw new Error('always fails')
    }),

    slow: cmd(
      async (input, ctx) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (ctx.signal.aborted) {
          throw new Error('should have been aborted before this line matters')
        }
        return input.tag
      },
      { latest: true, done: (_state, action) => ({ coupon: action.result }) },
    ),

    markUp: reduce(state => ({ items: state.items.map(item => ({ ...item, price: item.price + 1 })) })),

    countAfterAwait: cmd(async (_input, ctx) => {
      await new Promise(resolve => setTimeout(resolve, 20))

      return ctx.state.itemCount
    }),

    clear: reduce({ items: [], coupon: null }),

    reorder: reduce((state, action) => {
      const items = [...state.items]
      const [moved] = items.splice(action.input.from, 1)
      items.splice(action.input.to, 0, moved)
      return { items }
    }),
  },

  views: {
    skus: view(
      state => state.items,
      items => items.map(item => item.sku),
    ),
    subtotal: view(
      state => state.items,
      items => items.reduce((sum, item) => sum + item.price * item.qty, 0),
    ),
    itemCount: view(
      state => state.items,
      items => items.length,
    ),

    tax: view(
      state => ({ subtotal: state.subtotal, rate: state.taxRate }),
      ({ subtotal, rate }) => subtotal * rate,
    ),
    total: view(
      state => ({ subtotal: state.subtotal, tax: state.tax }),
      ({ subtotal, tax }) => subtotal + tax,
    ),
  },

  watch: {
    emptied: watch(
      state => state.items.length === 0,
      isEmpty => {
        observed.emptied.push(isEmpty)
      },
    ),
  },

  on: {
    'session.signOut': reduce({ items: [], coupon: null, error: null }),
  },
})

export const session = defineDomain('session', [], {
  state: { userId: null, email: null },
  actions: {
    signIn: cmd(
      async input => {
        await tick()
        return { id: `user-${input.email}` }
      },
      {
        done: (_state, action) => ({ userId: action.result.id, email: action.input.email }),
      },
    ),
    signOut: reduce({ userId: null, email: null }),
  },
})

export const audit = defineDomain('audit', ['cart', 'session'], {
  state: { seen: [] },
  actions: {
    note: reduce((state, action) => ({ seen: [...state.seen, action.input.what] })),
  },
  effects: {
    'cart.add.done': effect(action => {
      observed.added.push(`${action.input.sku}:${action.result.id}`)
    }),
    'session.signIn.done': effect(action => {
      observed.signedIn.push(action.result.id)
    }),
    'cart.add.failed': effect(action => {
      observed.failures.push(String(action.error))
    }),
  },
})

export const upload = defineDomain('upload', [], {
  state: () => ({ files: 0, progress: 0 }),
  actions: {
    pick: reduce((state, action) => ({ files: state.files + action.input.count })),
    start: cmd(
      async (_input, ctx) => {
        await tick()
        return Array.from({ length: ctx.state.files }, (_, i) => `url-${i}`)
      },
      { done: { progress: 100 } },
    ),
  },
})

export type DraftState = { text: string; saved: boolean }
export type DraftActions = { type: Reduce<string>; save: Cmd<void, string> }

// Instanced: one per mounted editor, all of them in the application's own scope, so a draft reads
// `session` and commits in the same transaction as everything else.
export const draft = defineDomain('draft', ['session'], {
  instanced: true,
  state: () => ({ text: '', saved: false }),
  actions: {
    type: reduce((_state, action) => ({ text: action.input })),
    save: cmd(
      async (_input, ctx) => {
        if (!ctx.read('session').userId) {
          throw new Error('signed out')
        }
        await tick()
        return 'saved'
      },
      { done: { saved: true } },
    ),
  },
})
