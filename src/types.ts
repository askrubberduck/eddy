declare const KIND: unique symbol

export type Cmd<TInput = void, TResult = void> = { readonly [KIND]: 'cmd'; input: TInput; result: TResult }

export type Reduce<TInput = void> = { readonly [KIND]: 'reduce'; input: TInput }

export type AnyAction = Cmd<any, any> | Reduce<any>
export type ActionsShape = Record<string, AnyAction>

/**
 * What state may hold. An approximation: prototypes, descriptors, symbol keys and realm of origin
 * are the runtime's to check. `RegExp`, `Error`, `Map` and `Set` are absent because the runtime
 * throws for them; a `Date` is admitted clean — no own keys — and compared by its time value.
 */
export type StateValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | readonly StateValue[]
  | { readonly [key: string]: StateValue }

export type DomainType<
  TState,
  TActions extends ActionsShape,
  TViews = {},
  TUses extends DomainName = never,
  // Whether this domain is held per instance. When it is, `TState` is what **one** instance holds;
  // the declaration shape is unchanged. Shared state is a different domain.
  TInstanced extends boolean = false,
> = { state: TState; actions: TActions; views: TViews; uses: TUses; instanced: TInstanced }

export interface Domains {}

type Registered = keyof Domains & string

export type DomainName = [Registered] extends [never]
  ? "ERROR: no domain is registered. Augment the registry: declare module '@askrubberduck/eddy' { interface Domains { cart: DomainType<CartState, CartActions, CartViews> } }"
  : Registered

export type StateOf<D extends DomainName> = Domains[D & keyof Domains] extends { state: infer S } ? S : never

/** Whether `D` is held per instance. */
export type IsInstanced<D extends DomainName> = Domains[D & keyof Domains] extends { instanced: true } ? true : false

declare const SINGLE_STATE_ONLY: unique symbol
declare const INSTANCED_ONLY: unique symbol
declare const NOT_INSTANCED_ONLY: unique symbol

/**
 * The two guards a domain argument carries, each refusing the half of the mirror it does not
 * belong to. Both are written for **argument position, intersected with a naked `D`**:
 *
 * ```ts
 * read<D extends TNames>(domain: D & SingleState<D>): Readable<D>
 * ```
 *
 * The naked `D &` is load-bearing. A conditional type is not an inference site, so a parameter
 * typed only by one leaves `D` to fall back to its constraint and widens the return to a union of
 * every hosted domain. Fencing the *return* instead refuses nothing: `never` is assignable to
 * everything, so only property access errors.
 *
 * The branded half is unsatisfiable by construction, and its message is the type the caller reads.
 */
export type SingleState<D extends DomainName> =
  true extends EachInstanced<D>
    ? {
        readonly [SINGLE_STATE_ONLY]: `'${D}' is instanced: read one instance, or scope.instances('${D}') for the live aggregate`
      }
    : unknown

export type Instanced<D extends DomainName> =
  false extends EachInstanced<D>
    ? { readonly [INSTANCED_ONLY]: `'${D}' is not instanced: scope.read('${D}') is its state` }
    : unknown

// Distributed, so a union of names answers once per member. `IsInstanced` checks
// `Domains[D & keyof Domains]`, which is not a naked type parameter: handed `'cart' | 'draft'` it
// tests the union as one type, finds it extends neither, and calls the pair not instanced.
type EachInstanced<D extends DomainName> = D extends DomainName ? IsInstanced<D> : never

/**
 * The third guard, written for an **address** rather than a domain name and used only by
 * `ScopeEmit`. Same argument-position shape as the pair above, and distributed the same way: a
 * union of addresses is refused when any member names an instanced domain.
 */
export type NotInstanced<A extends string> =
  true extends EachAddressInstanced<A>
    ? {
        readonly [NOT_INSTANCED_ONLY]: `'${A}' is on an instanced domain: emit it from the handle scope.instance returns`
      }
    : unknown

type EachAddressInstanced<A extends string> = A extends `${infer D}.${string}`
  ? D extends DomainName
    ? IsInstanced<D>
    : false
  : false

/**
 * Every live instance of an instanced domain, keyed by id. `| undefined` because any string is a
 * key of a `Record<string, …>` and only the live ids are there — the declaration would otherwise
 * promise a consumer, under their own compiler settings, that every lookup answers.
 */
export type InstancesOf<D extends DomainName> = Readonly<Record<string, Readable<D> | undefined>>

/** Written state accepted by preload and returned for persistence. */
export type WrittenOf<D extends DomainName> =
  IsInstanced<D> extends true ? Record<string, Partial<StateOf<D>>> : Partial<StateOf<D>>

export type ActionsOf<D extends DomainName> = Domains[D & keyof Domains] extends { actions: infer A } ? A : never

export type ViewsOf<D extends DomainName> = Domains[D & keyof Domains] extends { views: infer V } ? V : {}

export type UsesOf<D extends DomainName> = Domains[D & keyof Domains] extends { uses: infer U } ? U : never

export type Readable<D extends DomainName> = Flat<StateOf<D> & ViewsOf<D>>

type Flat<T> = { readonly [K in keyof T]: T[K] }

export type AddressIn<TNames extends DomainName> = {
  [D in TNames]: `${D}.${keyof ActionsOf<D> & string}`
}[TNames]

export type CmdAddressIn<TNames extends DomainName> = {
  [D in TNames]: {
    [K in keyof ActionsOf<D> & string]: ActionsOf<D>[K] extends Cmd<any, any> ? `${D}.${K}` : never
  }[keyof ActionsOf<D> & string]
}[TNames]

export type SubscribableIn<TNames extends DomainName> =
  AddressIn<TNames> | `${CmdAddressIn<TNames>}.done` | `${CmdAddressIn<TNames>}.failed`

export type Emit<TNames extends DomainName> = <A extends AddressIn<TNames>>(
  address: A,
  ...args: [InputOfAddress<A>] extends [void] ? [] : [input: InputOfAddress<A>]
) => Promise<ResultOfAddress<A>>

/**
 * `Scope.emit` alone. A scope-level emit carries no identity, so an instanced domain's address has
 * no instance to fold into and the runtime refuses it; `InstanceHandle.emit` and `Ctx.emit` carry
 * one and keep plain `Emit`, which is what makes this a separate type rather than a brand on that.
 */
export type ScopeEmit<TNames extends DomainName> = <A extends AddressIn<TNames>>(
  address: A & NotInstanced<A>,
  ...args: [InputOfAddress<A>] extends [void] ? [] : [input: InputOfAddress<A>]
) => Promise<ResultOfAddress<A>>

export type InputAt<D extends DomainName, K> = K extends keyof ActionsOf<D>
  ? ActionsOf<D>[K] extends Cmd<infer I, any>
    ? I
    : ActionsOf<D>[K] extends Reduce<infer I2>
      ? I2
      : never
  : never

export type ResultAt<D extends DomainName, K> = K extends keyof ActionsOf<D>
  ? ActionsOf<D>[K] extends Cmd<any, infer R>
    ? R
    : ActionsOf<D>[K] extends Reduce<any>
      ? void
      : never
  : never

export type InputOfAddress<A extends string> = A extends `${infer D}.${infer K}`
  ? D extends DomainName
    ? InputAt<D, K>
    : never
  : never

export type ResultOfAddress<A extends string> = A extends `${infer D}.${infer K}`
  ? D extends DomainName
    ? ResultAt<D, K>
    : never
  : never

export type ActionAt<A extends string> = A extends `${infer D}.${infer K}.done`
  ? D extends DomainName
    ? { type: A; input: InputAt<D, K>; result: ResultAt<D, K> }
    : never
  : A extends `${infer D}.${infer K}.failed`
    ? D extends DomainName
      ? { type: A; input: InputAt<D, K>; error: unknown }
      : never
    : A extends `${infer D}.${infer K}`
      ? D extends DomainName
        ? { type: A; input: InputAt<D, K> }
        : never
      : never

/** Every dispatchable action as one union discriminated by `type`, so `===` narrows without a cast. */
export type ActionIn<TNames extends DomainName> = {
  [A in SubscribableIn<TNames>]: ActionAt<A>
}[SubscribableIn<TNames>]

/** What `scope.on` accepts: any subscribable address, or `'*'` for every action the scope dispatches. */
export type Descriptor<TNames extends DomainName> = SubscribableIn<TNames> | '*'

export type ActionFor<A extends string, TNames extends DomainName> = A extends '*' ? ActionIn<TNames> : ActionAt<A>

/**
 * What a declarative effect receives beside its action. Not `Ctx`: an effect reacts to somebody
 * else's action, so it has no invocation, no stages, no supersession and no signal.
 */
export type EffectCtx<TReach extends DomainName> = {
  read<D extends TReach>(domain: D & SingleState<D>): Readable<D>

  emit: Emit<TReach>
}

export type DispatchedAction = {
  readonly type: string
  readonly __instance?: string
  readonly input?: unknown
  readonly result?: unknown
  readonly error?: unknown

  readonly __seq?: number

  readonly __originSeq?: number
}

export type Stamped = { readonly __seq?: number; readonly __originSeq?: number; readonly __instance?: string }

/**
 * What the failure reporter is told: enough to tie a report to a commit, and no `input`, `result`,
 * `error` or `__instance`. A reporter is the one channel where a payload leaves the process, and an
 * instance id is application data.
 */
export type ReportedAction = { readonly type: string; readonly __seq?: number; readonly __originSeq?: number }

export type Stage<D extends DomainName, TAction> =
  Partial<StateOf<D>> | ((state: Readable<D>, action: TAction & Stamped) => Partial<StateOf<D>> | void)

export type Stages<D extends DomainName, TInput, TResult> = {
  called?: Stage<D, { input: TInput }>

  done?: Stage<D, { input: TInput; result: TResult }>

  failed?: Stage<D, { input: TInput; error: unknown }>

  finally?: Stage<D, { input: TInput }>

  latest?: boolean
  join?: boolean
}

export type Ctx<TSelf extends DomainName, TReach extends DomainName = TSelf> = {
  readonly state: Readable<TSelf>

  readonly signal: AbortSignal

  readonly version: number

  read<D extends TReach>(domain: D & SingleState<D>): Readable<D>

  emit: Emit<TReach>
}

export type Logger = {
  debug: (...args: any[]) => void
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}

export type LogLevel = 'silent' | 'info' | 'debug'

export type Settings = {
  logger: Logger

  logLevel?: LogLevel

  onUnhandledError: (error: unknown, action: ReportedAction | undefined) => void
}
