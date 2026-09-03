import { isAddressSegment } from './internal/address'
import { checkState, cloneState, describeValue, inDevelopment, isPlainObject } from './internal/state-value'
import type {
  ActionsOf,
  Cmd,
  Ctx,
  EffectCtx,
  DomainName,
  Readable,
  Reduce,
  Stage,
  Stages,
  StateOf,
  SubscribableIn,
  ActionAt,
  InputOfAddress,
  Stamped,
  ViewsOf,
} from './types'

export type CommandEntry<D extends DomainName = any, TReach extends DomainName = any, TInput = any, TResult = any> = {
  readonly $: 'cmd'
  handler: (input: TInput, ctx: Ctx<D, TReach>) => TResult | Promise<TResult>
  stages: Stages<D, TInput, TResult>
}

// TAction is what the handler receives. Its default covers an own action, whose payload is its
// input; an `on` entry folding a neighbour's outcome passes the full `ActionAt<A>` instead.
export type ReduceEntry<D extends DomainName = any, TInput = any, TAction = { input: TInput }> = {
  readonly $: 'reduce'
  handler: Stage<D, TAction>
}

export type ViewEntry<D extends DomainName = any, TOut = any> = {
  readonly $: 'view'
  input: (state: Readable<D>) => unknown
  transform: (value: any) => TOut
}

export type Teardown = () => void

export type WatchEntry<D extends DomainName = any, TReach extends DomainName = any> = {
  readonly $: 'watch'
  source: (state: Readable<D>, read: <N extends TReach>(domain: N) => Readable<N>) => unknown
  handler: (next: any, previous: any, ctx: EffectCtx<TReach>) => void | Teardown | Promise<void>
}

export type EffectEntry<TAction = any, TReach extends DomainName = any> = {
  readonly $: 'effect'
  handler: (action: TAction, ctx: EffectCtx<TReach>) => void | Promise<void>
}

// NoInfer makes the domain declaration, not wrapper arguments, determine these types.
export function cmd<D extends DomainName, TReach extends DomainName, TInput, TResult>(
  handler: (input: NoInfer<TInput>, ctx: Ctx<NoInfer<D>, NoInfer<TReach>>) => TResult | Promise<TResult>,
  stages?: NoInfer<Stages<D, TInput, TResult>>,
): CommandEntry<D, TReach, TInput, TResult> {
  return { $: 'cmd', handler, stages: stages ?? {} }
}

export function reduce<D extends DomainName, TAction = { input: unknown }>(
  handler: NoInfer<Stage<D, TAction>>,
): ReduceEntry<D, any, TAction> {
  return { $: 'reduce', handler }
}

export function view<D extends DomainName, TIn, TOut>(
  input: (state: Readable<NoInfer<D>>) => TIn,
  transform: (value: TIn) => TOut,
): ViewEntry<D, TOut> {
  return { $: 'view', input: input as (state: Readable<D>) => unknown, transform }
}

// A declared neighbour moving re-runs the watcher, or a source that reads one would never be
// re-read. Only domains named in `uses` trigger; dedup on the recomputed source decides whether the
// handler runs.
export function watch<D extends DomainName, T, TReach extends DomainName = DomainName>(
  source: (state: Readable<NoInfer<D>>, read: <N extends NoInfer<TReach>>(domain: N) => Readable<N>) => T,
  handler: (next: T, previous: T, ctx: EffectCtx<NoInfer<TReach>>) => void | Teardown | Promise<void>,
): WatchEntry<D, TReach> {
  return { $: 'watch', source: source as WatchEntry<D, TReach>['source'], handler }
}

export function effect<A extends SubscribableIn<DomainName>, TReach extends DomainName = DomainName>(
  handler: (action: ActionAt<A> & Stamped, ctx: EffectCtx<NoInfer<TReach>>) => void | Promise<void>,
): EffectEntry<ActionAt<A> & Stamped, TReach> {
  return { $: 'effect', handler }
}

export type ActionEntries<D extends DomainName, TReach extends DomainName> = {
  [K in keyof ActionsOf<D>]: ActionsOf<D>[K] extends Cmd<infer I, infer R>
    ? CommandEntry<D, TReach, I, R>
    : ActionsOf<D>[K] extends Reduce<infer I2>
      ? ReduceEntry<D, I2>
      : never
}

export type ViewEntries<D extends DomainName> = { [K in keyof ViewsOf<D>]: ViewEntry<D, ViewsOf<D>[K]> }

export type OnEntries<D extends DomainName, TReach extends DomainName> = {
  [A in SubscribableIn<TReach>]?: ReduceEntry<D, InputOfAddress<A>, ActionAt<A> & Stamped>
}

export type EffectEntries<TReach extends DomainName> = {
  [A in SubscribableIn<TReach>]?: EffectEntry<ActionAt<A> & Stamped, TReach>
}

export type DomainOptions<D extends DomainName, TReach extends DomainName> = {
  /** For an instanced domain, the seed for **one** instance. Everything else is declared as usual. */
  state: StateOf<D> | (() => StateOf<D>)

  /**
   * Hold this domain per instance. A handle comes from `scope.instance`; the identity rides on the
   * action, so every instance lives in one scope and a fold stays one transaction. Shared state is
   * a separate domain.
   */
  instanced?: true
  actions: ActionEntries<D, TReach>
  views?: ViewEntries<D>
  watch?: Record<string, WatchEntry<D, TReach>>
  on?: OnEntries<D, TReach>
  effects?: EffectEntries<TReach>
}

export type DomainDef<TName extends string = string> = {
  readonly name: TName
  readonly uses: readonly string[]
  /** Optional so a hand-built definition, which `createScope` re-validates, still satisfies this. */
  readonly instanced?: boolean
  readonly seed: () => Record<string, unknown>
  readonly actions: Record<string, CommandEntry | ReduceEntry>
  readonly views: Record<string, ViewEntry>
  readonly watchers: Record<string, WatchEntry>
  readonly on: Record<string, ReduceEntry>
  readonly effects: Record<string, EffectEntry>
}

const READ_BY = {
  actions: 'invokes an action',
  on: "folds a neighbour's action",
  effects: 'reacts to an action',
  views: 'resolves a view',
  watch: 'runs a watcher',
} as const

// One rule set, two callers: `createScope` rechecks because a definition may never have gone
// through `defineDomain`. The subject string is the only per-caller input.
export type DeclarationMap = keyof typeof READ_BY

// Every runtime lookup reads own enumerable string keys; anything else is stored and never reached.
export function checkDeclarationShape(subject: string, map: DeclarationMap, entries: object): void {
  for (const key of Reflect.ownKeys(entries)) {
    if (typeof key === 'symbol') {
      throw new Error(
        `${subject}: the '${map}' object declares a symbol key (${String(key)}), and every ` +
          `lookup that ${READ_BY[map]} reads string keys only — so nothing declared there could ever be reached`,
      )
    }

    if (!Object.getOwnPropertyDescriptor(entries, key)!.enumerable) {
      throw new Error(
        `${subject}: the '${map}' object declares '${key}' as a non-enumerable property, and ` +
          `every lookup that ${READ_BY[map]} enumerates own keys — so it would be seeded and run inconsistently, ` +
          `or not at all`,
      )
    }
  }

  checkOwnKeysOnly(subject, map, entries)
}

// All consumers read own keys; inherited declarations would be unreachable.
function checkOwnKeysOnly(subject: string, map: DeclarationMap, entries: object): void {
  const proto = Object.getPrototypeOf(entries) as object | null
  const inherited = proto === null || proto === Object.prototype ? [] : Object.keys(proto)
  if (inherited.some(key => !Object.hasOwn(entries, key))) {
    throw new Error(
      `${subject}: the '${map}' object's prototype carries enumerable properties, and ` +
        `every lookup that ${READ_BY[map]} reads own keys only — so nothing declared there could ever be ` +
        `reached. Writing a literal '__proto__:' produces exactly this, because it replaces the prototype ` +
        `instead of declaring an entry; a computed key (['__proto__']) declares one`,
    )
  }
}

// Against the stored copy, never the caller's object: a getter can answer valid once and fold
// something else afterwards.
export function checkActionRules(subject: string, actions: object): void {
  for (const key of Object.keys(actions)) {
    if (!isAddressSegment(key)) {
      throw new Error(
        `${subject}: action '${key}' must be a plain identifier, because it is the second segment of the address that invokes it`,
      )
    }

    // Authoring spells it `$`; the normalised copy spells it `kind`. This rule reads either.
    type Declared = { $?: unknown; kind?: unknown; stages?: { latest?: unknown; finally?: unknown; join?: unknown } }
    const entry = (actions as Record<string, Declared | undefined>)[key]
    const isCommand = entry?.$ === 'cmd' || entry?.kind === 'cmd'

    if (isCommand && entry?.stages?.latest && entry.stages.join) {
      throw new Error(
        `${subject}: command '${key}' declares both 'latest' and 'join', which are opposite answers to ` +
          `the same question. 'latest' cancels the invocation in flight for a newer caller; 'join' hands ` +
          `that caller the one already running. Pick the one the command's work needs.`,
      )
    }

    if (isCommand && entry?.stages?.latest && entry.stages.finally) {
      throw new Error(
        `${subject}: command '${key}' declares both 'latest' and a 'finally' stage. A ` +
          `superseded invocation never reaches its terminal stages, so cleanup keyed to the input that started it ` +
          `would be stranded — do that work where you can see the cancellation, in the handler around its await`,
      )
    }
  }
}

export function checkViewRules(subject: string, views: object, actions: object): void {
  for (const key of Object.keys(views)) {
    if (key === '__proto__') {
      throw new Error(
        `${subject}: a view must not be named '__proto__', because resolving it writes into the assembled state with a bracket assignment, and that key reaches the accessor Object.prototype defines instead of creating an own property — the resolved value would be silently lost`,
      )
    }

    if (Object.hasOwn(actions, key)) {
      throw new Error(`${subject}: '${key}' is declared as both an action and a view`)
    }
  }
}

export function defineDomain<const TName extends DomainName, const TUses extends readonly DomainName[] = []>(
  name: TName,
  uses: TUses,
  options: DomainOptions<TName, TName | TUses[number]>,
): DomainDef<TName> {
  if (!isAddressSegment(name)) {
    throw new Error(
      `Unable to define domain '${name}': the name must be a plain identifier, because it is the first segment of every address this domain answers to`,
    )
  }

  if ((name as string) === '__proto__') {
    throw new Error(
      `Unable to define domain '${name}': the name must not be '__proto__', because a scope keys every domain's state by name on a plain object, where that key replaces the prototype instead of adding the domain`,
    )
  }

  const actions = options?.actions as unknown
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new Error(
      `Unable to define domain '${name}': 'actions' must be an object of action declarations, but ${describeValue(actions)} arrived`,
    )
  }

  const subject = `Unable to define domain '${name}'`

  for (const map of Object.keys(READ_BY) as DeclarationMap[]) {
    checkDeclarationShape(subject, map, (map === 'actions' ? actions : (options[map] ?? {})) as object)
  }

  checkActionRules(subject, actions)
  checkViewRules(subject, options.views ?? {}, actions)

  const isFactory = typeof options.state === 'function'
  const seed = isFactory ? (options.state as () => object) : () => options.state as object

  // A factory that returns the same root every time is a value seed wearing a function, and every
  // scope then shares one object.
  let lastRoot: object | undefined

  const validated = (): object => {
    const produced = seed() as object

    if (inDevelopment && isFactory) {
      if (produced === lastRoot) {
        throw new TypeError(
          `Unable to seed domain '${name}': the factory returned the same object it returned last time, so every ` +
            `scope would share one state graph. Build the object inside the factory, or declare it as a value seed ` +
            `(state: {...}), whose top level is copied per scope`,
        )
      }
      lastRoot = produced
    }

    if (!isPlainObject(produced)) {
      throw new TypeError(
        `Unable to seed domain '${name}': state must be a plain object of fields, but ${describeValue(produced)} arrived`,
      )
    }

    checkState(produced, `the seed for domain '${name}'`)
    return produced
  }

  if (options.instanced !== undefined && options.instanced !== true) {
    throw new Error(
      `Unable to define domain '${name}': 'instanced' takes true or nothing, but ${describeValue(options.instanced)} arrived`,
    )
  }

  return {
    name,
    // Copied here as well as in the scope: aliasing lets a push after `defineDomain` change what
    // every scope built from it declares.
    uses: [...uses] as typeof uses,
    instanced: options.instanced === true,
    seed: () => {
      const state = { ...validated() } as Record<string, unknown>
      return !inDevelopment && !isFactory
        ? cloneState(
            state,
            detail => `Unable to seed domain '${name}': copying the value seed failed — ${detail}.`,
            // Production still carries unsupported seed leaves by reference.
            true,
          )
        : state
    },
    actions: actions as Record<string, CommandEntry | ReduceEntry>,
    views: (options.views ?? {}) as Record<string, ViewEntry>,
    watchers: (options.watch ?? {}) as Record<string, WatchEntry>,
    on: (options.on ?? {}) as Record<string, ReduceEntry>,
    effects: (options.effects ?? {}) as Record<string, EffectEntry>,
  }
}
