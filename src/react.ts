import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { sameDate } from './internal/equal'
import { prepareDomainInstance, type Scope } from './scope'
import type { DomainName, Emit, Instanced, Readable, SingleState } from './types'

const identity = <T>(state: T): T => state

let instanceCount = 0

// The server snapshot is the live read. A server render reads whatever its request's scope holds,
// and a hydrating client keeps no pinned baseline, so a store that moves during the hydration pass
// is a recoverable mismatch — as it is for any external store. Neither reference application
// renders on a server.
function useDomainSnapshot<T>(scope: Scope<never>, domain: string, project: (state: unknown) => T): T {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => project(scope.read(domain as never)), [scope, domain, project])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const enumerableKeys = (value: object): PropertyKey[] =>
  Reflect.ownKeys(value).filter(key => Object.prototype.propertyIsEnumerable.call(value, key))

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false
  }

  // `enumerableKeys` skips holes, so `[1]` and `[1, <hole>]` present the same keys. Length is the
  // only thing that separates them.
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) {
    return false
  }

  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b)) {
    return false
  }

  if (proto === Date.prototype) {
    return sameDate(a as object, b as object)
  }

  if (proto !== Object.prototype && proto !== Array.prototype) {
    return false
  }

  const aKeys = enumerableKeys(a as object)
  const bKeys = enumerableKeys(b as object)

  if (aKeys.length !== bKeys.length) {
    return false
  }

  return aKeys.every(
    key =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      Object.is((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key]),
  )
}

export type ScopeHooks<TNames extends DomainName> = {
  ScopeProvider: (props: { scope: Scope<TNames>; children?: ReactNode }) => ReactNode

  useScope: () => Scope<TNames>

  useDomain: <D extends TNames>(domain: D & SingleState<D>) => Readable<D>

  useDomainValue: <D extends TNames, T>(
    domain: D & SingleState<D>,
    selector: (state: Readable<D>) => T,
    isEqual?: (a: T, b: T) => boolean,
  ) => T

  useEmit: () => Scope<TNames>['emit']

  /**
   * One instance of an instanced domain, owned by this mount and living in the provider's scope, so
   * it reads neighbours and folds in the same transaction as everything else. Pass an `id` when
   * something outside owns the identity; omit it and the mount gets its own. The emit returned is
   * the handle's, not the scope's: it carries the identity, so it takes the instanced addresses
   * `useEmit` refuses.
   */
  useDomainInstance: <D extends TNames>(domain: D & Instanced<D>, id?: string) => [Readable<D>, Emit<TNames>]
}

export function createScopeHooks<TNames extends DomainName>(scope: Scope<TNames>): ScopeHooks<TNames> {
  const ScopeContext = createContext<Scope<TNames>>(scope)

  const ScopeProvider = (props: { scope: Scope<TNames>; children?: ReactNode }): ReactNode =>
    createElement(ScopeContext.Provider, { value: props.scope }, props.children)

  const useScope = () => useContext(ScopeContext)

  // The guards live on `ScopeHooks`, which is what a caller meets. Restating them here as well
  // makes the implementation fail to match it: relating the two generic signatures instantiates
  // `D` with `D & SingleState<D>` and applies the guard a second time, to itself.
  const useDomain = <D extends TNames>(domain: D): Readable<D> =>
    useDomainSnapshot(useScope() as Scope<never>, domain, identity) as Readable<D>

  const useDomainValue = <D extends TNames, T>(
    domain: D,
    selector: (state: Readable<D>) => T,
    isEqual: (a: T, b: T) => boolean = shallowEqual,
  ): T => {
    const active = useScope()

    const cache = useRef<{
      state: unknown
      selector: (state: Readable<D>) => T
      isEqual: (a: T, b: T) => boolean
      value: T
    }>(undefined)

    const selectFrom = useMemo(() => {
      return (state: Readable<D>): T => {
        const previous = cache.current

        // Selector identity matters: selectors close over props, and a value produced under a
        // different one — by a render React discarded — must not reach the render that commits.
        const usable = previous !== undefined && previous.selector === selector && previous.isEqual === isEqual

        if (usable && previous.state === state) {
          return previous.value
        }

        const value = selector(state)

        // useSyncExternalStore requires equal snapshots to retain their reference.
        const settled = usable && isEqual(previous.value, value) ? previous.value : value

        cache.current = { state, selector, isEqual, value: settled }
        return settled
      }
    }, [selector, isEqual])

    return useDomainSnapshot(active as Scope<never>, domain, selectFrom as unknown as (state: unknown) => T)
  }

  const useEmit = () => useScope().emit

  const useDomainInstance = <D extends TNames>(domain: D, id?: string): [Readable<D>, Emit<TNames>] => {
    const active = useScope()

    // Stable for the life of the mount. A supplied id is shared by every component naming it; an
    // omitted one is this mount's alone.
    const own = useRef<string>(undefined)
    if (own.current === undefined) {
      own.current = `${String(domain)}-${++instanceCount}`
    }
    const key = id ?? own.current

    // Preparing computes first-render state without publishing it. The effect below takes the
    // owning lease after commit, when notifying aggregate subscribers is legal.
    const prepared = useRef<{
      scope: Scope<TNames>
      domain: D
      key: string
      handle: ReturnType<typeof prepareDomainInstance<TNames, D>>
    }>(undefined)
    if (
      prepared.current === undefined ||
      prepared.current.scope !== active ||
      prepared.current.domain !== domain ||
      prepared.current.key !== key
    ) {
      prepared.current = { scope: active, domain, key, handle: prepareDomainInstance(active, domain, key) }
    }
    const handle = prepared.current.handle

    // Adopted in the effect below, not here: a render React abandons runs this body too and writes
    // the same ref object the committed fiber reads, so a speculative render naming another id would
    // point the visible mount's emit at an instance that never arrived. Pairing the assignment with
    // the mount is what keeps this a handle that holds the lease — until the effect runs, the
    // previous one still does.
    const latest = useRef(handle)

    const emit = useRef<Emit<TNames>>(undefined)
    if (emit.current === undefined) {
      emit.current = ((...args: unknown[]) =>
        (latest.current.emit as unknown as (...passed: unknown[]) => Promise<unknown>)(
          ...args,
        )) as unknown as Emit<TNames>
    }

    // Keyed by the identity the lease is taken against, not by the handle object. `prepared` is a
    // single slot that a render React abandons writes too, so an abandoned render naming another id
    // makes the next render for the committed one rebuild: a new object for an unchanged
    // `(scope, domain, key)`. Listing `handle` would release and retake the lease for that, which
    // bumps the generation and strands any command already in flight. The handle this closure
    // captured is by construction the one holding the lease, because nothing but these three
    // changing can replace it.
    useEffect(() => {
      latest.current = handle
      return handle.mount()
    }, [active, domain, key])

    const state = useDomainSnapshot(active as Scope<never>, domain, () => handle.read()) as Readable<D>

    return [state, emit.current]
  }

  return { ScopeProvider, useScope, useDomain, useDomainValue, useEmit, useDomainInstance }
}
