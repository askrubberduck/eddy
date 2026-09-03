import { cmd, defineDomain, reduce, view, watch } from '../../../src/index'
import type { Cmd, DomainType, Reduce } from '../../../src/index'
import { api } from '../api'

export type CartLine = { sku: string; title: string; qty: number; unitPrice: number }
export type Coupon = { code: string; percent: number }

export type CartState = {
  lines: CartLine[]
  coupon: Coupon | null
  pending: boolean

  lastError: string | null
  orderId: string | null
}

export type CartViews = {
  subtotal: number
  itemCount: number

  shipping: number

  discount: number

  total: number
}

export type CartActions = {
  add: Cmd<{ sku: string; qty: number }, CartLine>
  checkout: Cmd<void, string>
  applyCoupon: Cmd<{ code: string }, Coupon>
  remove: Reduce<{ sku: string }>
  clear: Reduce
}

declare module '../../../src/types' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews, 'catalog' | 'session'>
  }
}

const FREE_DELIVERY_OVER = 5000
const DELIVERY_FEE = 495

export const watchLog: string[] = []

export const cart = defineDomain('cart', ['catalog', 'session'], {
  state: () => ({ lines: [], coupon: null, pending: false, lastError: null, orderId: null }),

  actions: {
    add: cmd(
      async (input, ctx) => {
        const product = ctx.read('catalog').products.find(candidate => candidate.sku === input.sku)

        if (!product) {
          throw new Error(`Unable to add '${input.sku}': no such product`)
        }

        const reservation = await api.reserve(product.sku, input.qty, product.price, ctx.signal)

        return {
          sku: product.sku,
          title: product.title,
          qty: reservation.qty,
          unitPrice: reservation.unitPrice,
        }
      },
      {
        called: { pending: true, lastError: null },
        done: (state, action) => {
          const existing = state.lines.find(line => line.sku === action.result.sku)
          return {
            lines: existing
              ? state.lines.map(line =>
                  line.sku === action.result.sku ? { ...line, qty: line.qty + action.result.qty } : line,
                )
              : [...state.lines, action.result],
          }
        },
        failed: (_state, action) => ({ lastError: describe(action.error) }),
        finally: { pending: false },
      },
    ),

    checkout: cmd(
      async (_input, ctx) => {
        const { userId } = ctx.read('session')

        if (!userId) {
          throw new Error('Unable to check out: not signed in')
        }

        if (ctx.state.lines.length === 0) {
          throw new Error('Unable to check out: the cart is empty')
        }

        const order = await api.placeOrder(ctx.state.total, ctx.signal)
        return order.id
      },
      {
        called: { pending: true, lastError: null },
        done: (_state, action) => ({ orderId: action.result, lines: [], coupon: null }),
        failed: (_state, action) => ({ lastError: describe(action.error) }),
        finally: { pending: false },
      },
    ),

    applyCoupon: cmd(async (input, ctx) => api.validateCoupon(input.code, ctx.signal), {
      latest: true,
      done: (_state, action) => ({ coupon: action.result }),
      failed: (_state, action) => ({ lastError: describe(action.error) }),
    }),

    remove: reduce((state, action) => ({ lines: state.lines.filter(line => line.sku !== action.input.sku) })),

    clear: reduce({ lines: [], coupon: null }),
  },

  views: {
    subtotal: view(
      state => state.lines,
      lines => lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0),
    ),

    itemCount: view(
      state => state.lines,
      lines => lines.reduce((count, line) => count + line.qty, 0),
    ),

    shipping: view(
      state => state.subtotal,
      subtotal => (subtotal === 0 || subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEE),
    ),

    discount: view(
      state => ({ subtotal: state.subtotal, coupon: state.coupon }),
      ({ subtotal, coupon }) => (coupon ? Math.round((subtotal * coupon.percent) / 100) : 0),
    ),

    total: view(
      state => ({ subtotal: state.subtotal, discount: state.discount, shipping: state.shipping }),
      ({ subtotal, discount, shipping }) => subtotal - discount + shipping,
    ),
  },

  watch: {
    empty: watch(
      state => state.itemCount === 0,
      (next, previous) => {
        watchLog.push(`cart empty: ${previous} -> ${next}`)
      },
    ),
  },

  on: {
    'session.signOut': reduce({ lines: [], coupon: null, orderId: null, lastError: null }),

    'catalog.reprice': reduce((state, action) => ({
      lines: state.lines.map(line =>
        line.sku === action.input.sku ? { ...line, unitPrice: action.input.price } : line,
      ),
    })),
  },
})

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
