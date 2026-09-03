// Prepended to every page by `check:wiki-fences`. The wiki is written as fragments around one
// running example — a cart and a session — and a fragment is what a reader copies. This supplies
// the imports and the registry those fragments assume, so the fences themselves stay fragments.
//
// It is not shipped and not part of the surface. If a page needs something only it uses, the fence
// should declare it; if a page cannot join the shared program, its fence opts out with
// `<!-- fence: skip reason -->`.
import {
  cmd,
  createScope,
  defineDomain,
  effect,
  isStale,
  reduce,
  view,
  watch,
  CommandAborted,
} from '@askrubberduck/eddy'
import type {
  ActionAt,
  ActionsOf,
  AddressIn,
  Cmd,
  CmdAddressIn,
  Ctx,
  DispatchedAction,
  DomainType,
  EffectCtx,
  Emit,
  InputOfAddress,
  LogLevel,
  Logger,
  Readable,
  Reduce,
  ResultOfAddress,
  Scope,
  ScopeReport,
  Settings,
  StateOf,
  StateValue,
  SubscribableIn,
  Teardown,
  UsesOf,
  ViewsOf,
} from '@askrubberduck/eddy'
import { createScopeHooks, shallowEqual } from '@askrubberduck/eddy/react'
import { createTestScope, flush, resetVersion, settled } from '@askrubberduck/eddy/testing'

export type Item = { sku: string; qty: number; price: number }
export type CartItem = Item

export type CartState = { items: Item[]; pending: boolean; error: string | null }
export type CartViews = { subtotal: number; total: number }
export type CartActions = {
  add: Cmd<{ sku: string; qty: number }, Item>
  clear: Reduce
  load: Cmd<{ userId: string }, void>
  applyCoupon: Cmd<{ code: string }, number>
  remove: Reduce<{ sku: string }>
}

export type SessionState = { userId: string | null; accountId: string }
export type SessionActions = { signIn: Cmd<{ email: string }, { id: string }>; signOut: Reduce }

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews, 'session'>
    session: DomainType<SessionState, SessionActions>
  }
}

// Values the fences reference without declaring.
declare const api: {
  price: (sku: string, qty: number, signal?: AbortSignal) => Promise<Item>
  validateCoupon: (code: string, signal?: AbortSignal) => Promise<number>
  fetchCart: (userId: string) => Promise<void>
}
declare const audit: (id: string) => void
declare const reportEmptyCart: () => void
declare const refresh: (accountId: string) => void
declare const logger: Logger

// React, and the hooks a page builds from a scope before using them in later fences.
declare const useCallback: <T extends (...a: never[]) => unknown>(fn: T, deps: unknown[]) => T
declare const scope: Scope<'cart' | 'session'>
declare const previewScope: Scope<'cart' | 'session'>
declare const cart: ReturnType<typeof defineDomain<'cart', ['session']>>
declare const session: ReturnType<typeof defineDomain<'session', []>>
declare const uploadDomain: ReturnType<typeof defineDomain<'cart', []>>
declare const ScopeProvider: ReturnType<typeof createScopeHooks<'cart' | 'session'>>['ScopeProvider']
declare const useScope: ReturnType<typeof createScopeHooks<'cart' | 'session'>>['useScope']
declare const useDomain: ReturnType<typeof createScopeHooks<'cart' | 'session'>>['useDomain']
declare const useDomainValue: ReturnType<typeof createScopeHooks<'cart' | 'session'>>['useDomainValue']
declare const useEmit: ReturnType<typeof createScopeHooks<'cart' | 'session'>>['useEmit']
declare const render: (state: unknown) => void
declare const record: (...args: unknown[]) => void
declare type DomainName = 'cart' | 'session'

export {
  cmd,
  createScope,
  defineDomain,
  effect,
  isStale,
  reduce,
  view,
  watch,
  CommandAborted,
  createScopeHooks,
  shallowEqual,
  createTestScope,
  flush,
  resetVersion,
  settled,
  api,
  audit,
  reportEmptyCart,
  refresh,
  logger,
  useCallback,
  scope,
  previewScope,
  cart,
  session,
  uploadDomain,
  ScopeProvider,
  useScope,
  useDomain,
  useDomainValue,
  useEmit,
  render,
  record,
}
export type {
  ActionAt,
  AddressIn,
  Cmd,
  CmdAddressIn,
  Ctx,
  DispatchedAction,
  DomainType,
  EffectCtx,
  Emit,
  InputOfAddress,
  LogLevel,
  Logger,
  Readable,
  Reduce,
  ResultOfAddress,
  Scope,
  ScopeReport,
  Settings,
  StateValue,
  SubscribableIn,
  Teardown,
  DomainName,
}
