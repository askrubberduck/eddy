import { defineDomain, effect } from '../../../src/index'
import type { DomainType } from '../../../src/index'

export type AnalyticsState = Record<string, never>
export type AnalyticsActions = Record<string, never>

declare module '../../../src/types' {
  interface Domains {
    analytics: DomainType<AnalyticsState, AnalyticsActions, Record<string, never>, 'session' | 'cart' | 'catalog'>
  }
}

export const events: string[] = []

export const analytics = defineDomain('analytics', ['session', 'cart', 'catalog'], {
  state: () => ({}),
  actions: {},

  effects: {
    'session.signIn.done': effect(action => {
      events.push(`signed in as ${action.result.id} (${action.input.email})`)
    }),

    'cart.add.done': effect(action => {
      events.push(`added ${action.result.qty} x ${action.result.sku} at ${action.result.unitPrice}p`)
    }),

    'cart.add.failed': effect(action => {
      events.push(`add '${action.input.sku}' failed: ${String(action.error)}`)
    }),

    'cart.checkout.done': effect(action => {
      events.push(`order placed: ${action.result}`)
    }),

    'catalog.select': effect(action => {
      events.push(`selected ${action.input.sku ?? '(nothing)'}`)
    }),
  },
})
