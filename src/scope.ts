import { consoleLogger, contain, defaultReporter, defaultSettings, promiseThen, validate } from './config'
import type { DomainDef, Teardown } from './domain'
import { hostDomains, type DeclaredAction, type DeclaredCommand, type DomainState, type Hosted } from './hosting'
import { parseAddress } from './internal/address'
import type { ParsedAddress } from './internal/address'
import { changedKeys, isEqual } from './internal/equal'
import { fromAction, type Log } from './internal/log'
import {
  checkState,
  cloneState,
  describeValue,
  freezeState,
  isPlainObject,
  namingTheRead,
  refusal,
  refusing,
} from './internal/state-value'
import { nextVersion } from './internal/version'
import type {
  Ctx,
  DispatchedAction,
  Settings,
  DomainName,
  Emit,
  ScopeEmit,
  Readable,
  SingleState,
  Instanced,
  InstancesOf,
  WrittenOf,
  Descriptor,
  ActionFor,
  Stamped,
  ReportedAction,
} from './types'
import { assemble, resolveViews } from './views'

export class CommandAborted extends Error {
  constructor(address: string, reason = 'was superseded by a newer call') {
    super(`Command '${address}' ${reason}`)
    this.name = 'CommandAborted'
  }
}

/**
 * The cascade guard's abort. A class so a runaway fold is told from an application failure without a
 * regex over prose. `causes` holds what emitted each of the last ten jobs — an action type, a
 * watcher id, or `'emit'` — because the question is what keeps feeding the loop.
 */
export class CascadeAborted extends Error {
  readonly scope: string
  readonly limit: number
  readonly causes: readonly string[]

  constructor(scope: string, limit: number, causes: readonly string[]) {
    super(
      `Unable to drain scope '${scope}': more than ${limit} actions in one cascade, most recently caused by [${causes.join(' -> ')}]`,
    )
    this.name = 'CascadeAborted'
    this.scope = scope
    this.limit = limit
    this.causes = [...causes]
  }
}

export type ScopeOptions<TDefs extends readonly DomainDef[]> = {
  name?: string
  domains: TDefs

  preloadedState?: { [D in TDefs[number]['name'] & DomainName]?: WrittenOf<D> }

  onAction?: (action: DispatchedAction) => void
} & Partial<Settings>

/**
 * What a scope was doing at one instant. A window, never a lever: nothing in this library reads it.
 * Every call allocates.
 */
export type ScopeReport = {
  /** Jobs waiting in the queue. Non-zero only when read from inside a dispatch. */
  queueDepth: number

  /**
   * Addresses of command handlers that have started and not returned, one per handler, never inputs.
   * A handler the scope cancelled stays here until it returns: its late failure is still reported.
   */
  inFlight: string[]

  /** Calls whose caller is still owed an outcome: queued, running, or waiting on the terminal fold. */
  live: number

  /** Drains the cascade guard aborted. A count, not a flag: one last week and a loop now differ. */
  cascades: { count: number; lastCause: string | undefined }
}

type InstanceHandle<TNames extends DomainName, D extends TNames> = {
  readonly id: string
  read(): Readable<D>
  emit: Emit<TNames>
  dispose(): void
}

type PreparedInstance<TNames extends DomainName, D extends TNames> = Pick<
  InstanceHandle<TNames, D>,
  'read' | 'emit'
> & {
  mount(): () => void
}

const PREPARE_INSTANCE: unique symbol = Symbol('prepare instance')

export type Scope<TNames extends DomainName> = {
  readonly name: string

  emit: ScopeEmit<TNames>

  read<D extends TNames>(domain: D & SingleState<D>): Readable<D>

  /**
   * Every live instance of an instanced domain, keyed by id — the only surface that speaks the
   * aggregate. `read` refuses an instanced domain rather than answering with this.
   */
  instances<D extends TNames>(domain: D & Instanced<D>): InstancesOf<D>

  getState(): Record<TNames, unknown>

  /** Written fields only, no view keys — the shape `preloadedState` accepts back. */
  getWrittenState(): { [D in TNames]: WrittenOf<D> }

  on<A extends Descriptor<TNames>>(descriptor: A, handler: (action: ActionFor<A, TNames> & Stamped) => void): () => void
  on<A extends Descriptor<TNames>>(
    descriptors: readonly A[],
    handler: (action: ActionFor<A, TNames> & Stamped) => void,
  ): () => void
  subscribe(listener: () => void): () => void

  inspect(): ScopeReport

  /**
   * A handle on one instance of an instanced domain, seeded on first use. `emit` from the handle
   * carries the identity on the action, so a command's terminal fold reaches the instance it came
   * from and every instance stays in the one scope where a fold is one transaction.
   *
   * Each handle is one lease; `dispose` releases it and the last one out removes the instance. A
   * command in flight still settles its caller's promise — only the fold is dropped, and reported.
   */
  instance<D extends TNames>(domain: D & Instanced<D>, id: string): InstanceHandle<TNames, D>

  dispose(): void
}

type InternalScope<TNames extends DomainName> = Scope<TNames> & {
  [PREPARE_INSTANCE]<D extends TNames>(domain: D, id: string): PreparedInstance<TNames, D>
}

// React needs state on its first render but may only publish after commit. Kept off the package
// surface: ordinary callers take an owning handle through `scope.instance`.
export const prepareDomainInstance = <TNames extends DomainName, D extends TNames>(
  scope: Scope<TNames>,
  domain: D,
  id: string,
): PreparedInstance<TNames, D> => (scope as InternalScope<TNames>)[PREPARE_INSTANCE](domain, id)

// Not an address, and deliberately unable to be one: `internal/address` builds its grammar from
// `[A-Za-z_$][A-Za-z0-9_$]*`, so no action can be named `*` and this key cannot shadow one.
const WILDCARD = '*'

let anonymousCount = 0

// `{ logLevel: undefined }` means "unset": spreading it over the defaults would otherwise erase
// them with an absence.
const stripUndefined = (options: object): Partial<Settings> => {
  const settings: Record<string, unknown> = {}
  for (const key of ['logger', 'logLevel', 'onUnhandledError'] as const) {
    const value = (options as Record<string, unknown>)[key]
    if (value !== undefined) {
      settings[key] = value
    }
  }
  return settings as Partial<Settings>
}

// The generation names which instance of an id an action was made for. It stays off the public
// type: nothing outside the scope may compare it.
type Dispatched = DispatchedAction & { readonly __generation?: number }

type Draft = DomainState & {
  entry: Hosted

  viewValues: Record<string, unknown>

  candidates: Set<string>
}

export function createScope<const TDefs extends readonly DomainDef[]>(
  options: ScopeOptions<TDefs>,
): Scope<TDefs[number]['name'] & DomainName> {
  const { domains } = options

  const name = options.name ?? `anonymous-${++anonymousCount}`

  const supplied = stripUndefined(options)
  refusing(() => validate(supplied, `Unable to create scope '${name}'`))

  const chosen = { ...defaultSettings, ...supplied }
  const settings = {
    ...chosen,
    onUnhandledError: chosen.onUnhandledError ?? defaultReporter(chosen.logger),
  }
  const logLevel = settings.logLevel

  // Per scope, not per module: a shared re-entrancy guard drops the second scope's record when two
  // scopes log into each other's sinks.
  let logging = false

  // `'error'` is never gated: a silent trace is not a silent failure channel. The other two levels
  // are checked by their callers.
  const log: Log = (level, event, record) => {
    // Reports whether the line went out: a caller that dedupes must not mark a report as made when
    // this guard dropped it, or that subject falls silent forever.
    if (logging) {
      return false
    }
    logging = true

    try {
      let delivered = true
      contain(
        () => {
          const returned = settings.logger[level](`eddy: ${event}`, record)

          // A thenable sink may fail after this returns, which is unknowable here. Counted as not
          // delivered, so a deduplicating caller retries rather than falling permanently silent.
          if (typeof (returned as { then?: unknown } | undefined)?.then === 'function') {
            delivered = false
          }

          return returned
        },
        () => {
          delivered = false
        },
      )

      return delivered
    } finally {
      logging = false
    }
  }

  // The reporter is host code and can fail. The backstop is `console.error`, not
  // `settings.logger.error`: a broken reporter usually arrived with the logger beside it, and
  // routing there loses the original error to the same fault twice.
  //
  // The action is narrowed here and only here. The reporter is the one channel handed a whole
  // action and the one a host wires off-process, so payloads holding credentials would otherwise
  // reach a remote sink. The shape refuses it rather than a warning about it.
  const reportUnhandled = (error: unknown, action?: Dispatched): void => {
    if (disposed && interruptions.has(error as object)) {
      return
    }

    const reported: ReportedAction | undefined = action && {
      type: action.type,
      __seq: action.__seq,
      __originSeq: action.__originSeq,
    }

    contain(
      () => settings.onUnhandledError(error, reported),
      reporterFailure => {
        contain(
          () => consoleLogger.error('eddy: onUnhandledError threw', reporterFailure, '— while reporting', error),
          () => undefined,
        )
      },
    )
  }

  const readingWatcher = <T>(id: string, read: () => T): T => {
    try {
      return read()
    } catch (error) {
      throw namingTheRead(
        error,
        detail => `Unable to create scope '${name}': seeding watcher '${id}' failed — ${detail}`,
      )
    }
  }

  let disposed = false

  // The disposal boundary. Every host callback on the path from dispatch to publication — reducer,
  // stage, selector, transform, watcher, effect, listener, subscriber, handler, `onAction` — enters
  // through this, so none starts once the scope is disposed, wherever the dispose came from. The
  // logger and the reporter stay outside: telling the host about the disposal is their job.
  // Teardowns stay outside too, because disposal is what runs them.
  // What a callback reached after disposal throws instead of running. A refusal, so a wrapper naming
  // a failed read passes it through; never reported, because disposal is not a fault. Told apart by
  // identity, never `instanceof`: a host may throw a Proxy whose prototype trap throws.
  const interruptions = new WeakSet<object>()
  const interrupted = () => {
    const error = refusal(new CommandAborted(name, `was interrupted: scope '${name}' was disposed`))
    interruptions.add(error)
    return error
  }

  const guard = <T>(callback: T): T =>
    (typeof callback !== 'function'
      ? callback
      : (...args: unknown[]) => {
          if (disposed) {
            throw interrupted()
          }
          return (callback as (...args: unknown[]) => unknown)(...args)
        }) as T

  const onAction = guard(options.onAction)

  // Marked as the library's, so a watcher source that builds a scope of its own is not re-wrapped.
  const hosted = refusing(() => hostDomains(name, domains, options.preloadedState, log, logLevel, guard))

  // Build and validate the next root before publishing any per-domain candidate.
  const buildRoot = (candidates?: ReadonlyMap<Hosted, DomainState>): Record<string, unknown> => {
    const next: Record<string, unknown> = {}
    for (const [domainName, entry] of hosted) {
      next[domainName] = candidates?.get(entry)?.state ?? entry.state
    }

    checkState(next, `the state of scope '${name}'`)
    return next
  }

  let root: Record<string, unknown> = buildRoot()
  freezeState(root)

  const listeners = new Set<() => void>()
  const actionListeners = new Map<string, Set<(action: Dispatched) => void>>()
  const watcherValues = new Map<string, unknown>()

  const watcherTeardowns = new Map<string, Teardown>()

  const refusedByDisposal = () => new CommandAborted(name, `was refused: scope '${name}' has been disposed`)
  const cancelledByDisposal = () => new CommandAborted(name, `was cancelled: scope '${name}' was disposed`)

  const refuseAfterDisposal = (verb: string): never => {
    throw new CommandAborted(name, `cannot ${verb}: scope '${name}' has been disposed`)
  }

  // Refused without throwing: `useSyncExternalStore` subscribes from a passive effect, and under
  // StrictMode the captured scope is already disposed and rebuilt. Throwing turns a remount into a
  // crash. Nothing registers and nothing will ever notify, which the log records.
  const refuseRegistration = (verb: string): (() => void) => {
    // The no-op must not also be invisible: a subtree that renders once and never updates again is
    // the worst shape to leave without a trace.
    log('error', 'rejected', { scope: name, cause: `${verb} after disposal` })
    return () => undefined
  }

  const notify = (action?: Dispatched) => {
    // Snapshotting prevents unsubscribe-during-notification from skipping a neighbour.
    for (const listener of [...listeners]) {
      contain(listener, error => reportUnhandled(error, action))
    }
  }

  type FieldChanges = ReadonlyMap<string, ReadonlySet<string>>

  // Candidate keys are rechecked after every stage, so a later stage may restore a prior value.
  const applyStage = (draft: Draft, stage: unknown, action: Dispatched): boolean => {
    const entry = draft.entry

    // An instanced domain's written state is its live instances keyed by id, so a stage folds into
    // one of them. `lands` has already checked that the action names a live one.
    const instanceId = entry.instanced ? action.__instance : undefined

    const target = instanceId === undefined ? draft.state : (draft.written[instanceId] as object)

    const produced =
      typeof stage === 'function' ? (stage as (state: unknown, action: unknown) => unknown)(target, action) : stage

    if (produced === undefined || produced === null) {
      return false
    }

    const foldSubject = `'${action.type}' into domain '${entry.name}'`

    const stateSubject = `the state '${action.type}' folds into domain '${entry.name}'`

    const contained = <T>(read: () => T): T => {
      try {
        return read()
      } catch (error) {
        throw namingTheRead(
          error,
          detail => `Unable to fold ${foldSubject}: reading the state it produced failed — ${detail}`,
        )
      }
    }

    return contained(() => {
      // A stage returns a partial object of fields or nothing. Enumerating anything else spreads it:
      // a reducer returning 'ab' yields state fields '0' and '1' and passes every later check.
      // Inside `contained`, so a value that throws while being inspected is still named.
      if (!isPlainObject(produced)) {
        throw refusal(
          new TypeError(
            `Unable to fold ${foldSubject}: a stage returns a partial object of fields, or nothing at all, but ` +
              `${describeValue(produced)} arrived`,
          ),
        )
      }

      // Every build: a `hasOwn` per written key, against production keeping an invisible junk field
      // or losing the write behind a derived value.
      for (const key of Object.keys(produced as object)) {
        if (Object.hasOwn(entry.views, key)) {
          throw refusal(new Error(`Unable to fold ${foldSubject}: it writes '${key}', which is a view`))
        }
      }

      if (Object.hasOwn(produced as object, '__proto__')) {
        throw refusal(
          new Error(
            `Unable to fold ${foldSubject}: it writes '__proto__', which is not a state field — ` +
              `assembly would carry it out to every reader, where a bracket assignment reaches the ` +
              `prototype instead of the object`,
          ),
        )
      }

      checkState(produced, stateSubject)

      if (instanceId !== undefined) {
        const before = draft.written[instanceId] as object
        if (changedKeys(produced as object, before).length === 0) {
          return false
        }

        // The instance id is the moved key, so the commit check and the change map name it.
        draft.candidates.add(instanceId)
        draft.written = { ...draft.written, [instanceId]: { ...before, ...(produced as object) } }
        return true
      }

      const moved = changedKeys(produced as object, draft.written)
      if (moved.length === 0) {
        return false
      }

      for (const key of moved) {
        draft.candidates.add(key)
      }

      draft.written = { ...draft.written, ...(produced as object) }
      return true
    })
  }

  // Re-resolve after each effective stage so the next stage reads updated derived state.
  const materialise = (draft: Draft, action: Dispatched) => {
    const { name, views, state } = draft.entry

    try {
      draft.viewValues = resolveViews(name, views, draft.written, draft.cache, draft.entry.cache)
      draft.state = assemble(draft.written, draft.viewValues, state)
    } catch (error) {
      throw namingTheRead(
        error,
        detail =>
          `Unable to fold '${action.type}' into domain '${name}': reading the state it derives failed — ${detail}`,
      )
    }
  }

  const stagesFor = (entry: Hosted, action: Dispatched, parsed: ParsedAddress | undefined): unknown[] => {
    const out: unknown[] = []

    if (parsed && parsed.domain === entry.name) {
      const declared = entry.actions[parsed.action]

      if (declared) {
        if (declared.kind === 'reduce') {
          if (!parsed.stage) {
            out.push(declared.handler)
          }
        } else {
          const { stages } = declared
          if (!parsed.stage) {
            out.push(stages.called)
          } else if (parsed.stage === 'done') {
            out.push(stages.done, stages.finally)
          } else {
            out.push(stages.failed, stages.finally)
          }
        }
      }
    }

    const wired = Object.hasOwn(entry.on, action.type) ? entry.on[action.type] : undefined
    if (wired && wired.kind === 'reduce') {
      out.push(wired.handler)
    }

    return out.filter(stage => stage !== undefined)
  }

  // Whether an action can fold into an instanced domain at all, decided once per fold so a dropped
  // fold is reported once however many stages it carries. The caller's promise still settles with
  // the handler's real outcome.
  const lands = (entry: Hosted, action: Dispatched): boolean => {
    const instanceId = action.__instance

    if (instanceId === undefined) {
      throw new Error(
        `Unable to fold '${action.type}' into domain '${entry.name}': it is instanced, so the action must name ` +
          `an instance. Emit through the handle from scope.instance('${entry.name}', id)`,
      )
    }

    if (!Object.hasOwn(entry.written, instanceId)) {
      reportDropped(entry, `an instance of domain '${entry.name}' is gone, so the fold was dropped`, action)
      return false
    }

    // Liveness is not identity: the same string can name a later instance than the action's.
    //
    // Only for the action's own domain. A generation is minted by one domain's book and means
    // nothing in another's, so comparing it across a neighbour `on` wire would drop a live
    // instance's fold whenever an unrelated domain recycled the id. That wire matches by id alone.
    if (
      parseAddress(action.type)?.domain === entry.name &&
      entry.instances.get(instanceId)?.generation !== action.__generation
    ) {
      reportDropped(
        entry,
        `an instance of domain '${entry.name}' was replaced before this fold, so it was dropped`,
        action,
      )
      return false
    }

    return true
  }

  // Draft every affected domain before committing any of them.
  const fold = (action: Dispatched, onCommitted?: () => void): FieldChanges => {
    const drafts = new Map<Hosted, Draft>()

    const parsed = parseAddress(action.type)

    for (const entry of hosted.values()) {
      // A domain participates by owning the address or by wiring a reducer to it. `uses` says
      // nothing here: it is a contract, not authorization, so a wire to an undeclared domain folds.
      if ((!parsed || parsed.domain !== entry.name) && !Object.hasOwn(entry.on, action.type)) {
        continue
      }

      const stages = stagesFor(entry, action, parsed)
      if (stages.length === 0 || (entry.instanced && !lands(entry, action))) {
        continue
      }

      const draft: Draft = {
        entry,
        written: entry.written,

        // Cloned here and never again. Entries are replaced rather than mutated, so this stays a
        // rollback snapshot for the whole fold while one stage's memo stays visible to the next;
        // aliasing `entry.cache` would let a resolution that later throws survive the rollback.
        cache: new Map(entry.cache),
        state: entry.state,
        viewValues: {},
        candidates: new Set(),
      }

      for (const stage of stages) {
        if (applyStage(draft, stage, action)) {
          materialise(draft, action)
        }
      }

      drafts.set(entry, draft)
    }

    const changes = new Map<string, ReadonlySet<string>>()

    // Net movement decides a commit: a field one stage moved and the next put back arrives in a
    // fresh object and must not commit. Deciding before assignment also keeps host-controlled
    // equality traps out of a half-published fold.
    const committing = new Map<Hosted, Draft>()
    for (const [entry, draft] of drafts) {
      const moved = new Set<string>()

      for (const key of draft.candidates) {
        // Presence is part of the shape, as it is in `changedKeys`: a key arriving with `undefined`
        // where none existed has moved, though both sides read alike.
        if (!Object.hasOwn(entry.written, key) || !isEqual(draft.written[key], entry.written[key])) {
          moved.add(key)
        }
      }

      for (const key of Object.keys(draft.viewValues)) {
        if (!Object.is(draft.viewValues[key], entry.state[key])) {
          moved.add(key)
        }
      }

      if (moved.size > 0) {
        committing.set(entry, draft)
        changes.set(entry.name, moved)
      }
    }

    // The commit point, after the last host callback of the draft: a scope disposed while drafting
    // publishes nothing and decides nothing.
    if (disposed) {
      throw interrupted()
    }

    if (committing.size === 0) {
      onCommitted?.()
      return changes
    }

    commit(committing, changes, onCommitted, action)

    return changes
  }

  // The one place state becomes readable. Every caller derives its own candidates and hands them
  // here; this owns the order and nothing else.
  //
  // The freeze is fallible — `Object.freeze` throws on an exotic object whose `preventExtensions`
  // refuses — so it runs on a candidate root before anything is assigned, or a throw would publish
  // the state while telling the caller it had failed.
  //
  // From the liveness check to the assignment and `decide`, no host code runs: building and freezing
  // can reach a trap that disposes the scope, so the check comes after them, and every line the
  // host hears about this fold — the trace, subscribers, watchers — comes after publication. `decide`
  // is the library's own bookkeeping and must be done before the host hears anything, because what
  // the host does next may be to dispose.
  const commit = (
    candidates: ReadonlyMap<Hosted, DomainState>,
    changes: FieldChanges,
    decide?: () => void,
    action?: Dispatched,
  ) => {
    const next = buildRoot(candidates)

    freezeState(next)

    if (disposed) {
      throw interrupted()
    }

    for (const [entry, candidate] of candidates) {
      entry.written = candidate.written
      entry.cache = candidate.cache
      entry.state = candidate.state
    }
    root = next

    decide?.()

    // Published and decided: from here a host failure is reported, and never reaches the caller.
    contain(
      () => {
        if (action && logLevel === 'debug') {
          log('debug', 'folded', {
            ...fromAction(name, action),
            // An instanced domain's changed keys are its instance ids, which an application sets to
            // a row key or a server-issued token. Naming the domain is the diagnostic value; naming
            // the instance would put application data in a metadata-only sink.
            fields: Object.fromEntries(
              [...changes].map(([domain, keys]) => [domain, hosted.get(domain)?.instanced ? [] : [...keys]]),
            ),
          })
        }

        notify(action)
        runWatchers(changes, action)
      },
      error => reportUnhandled(error, action),
    )
  }

  // A watcher runs when its own domain moved **or** when a declared neighbour did. Without the
  // second half a source that reads only foreign domains never runs at all.
  //
  // `uses` is the trigger set, so this over-triggers by design; the equality check below decides
  // whether the handler fires.
  const triggeredBy = (entry: Hosted, changes: FieldChanges): boolean =>
    changes.has(entry.name) || entry.uses.some(neighbour => changes.has(neighbour))

  const runWatchers = (changes: FieldChanges, action?: Dispatched) => {
    for (const entry of hosted.values()) {
      if (!triggeredBy(entry, changes)) {
        continue
      }

      for (const [key, watcher] of Object.entries(entry.watchers)) {
        const id = `${entry.name}.${key}`

        let next: unknown
        try {
          next = watcher.source(entry.state as never, reachFrom(entry.name).read as never)
          checkState(next, `the value watched by '${id}'`)
          freezeState(next)
        } catch (error) {
          reportUnhandled(
            namingTheRead(
              error,
              detail => `Unable to run watcher '${id}': reading the value it watches failed — ${detail}`,
            ),
            action,
          )
          continue
        }

        const previous = watcherValues.get(id)

        if (isEqual(previous, next)) {
          continue
        }

        // The source or the equality read may have disposed the scope, which released these values.
        if (disposed) {
          return
        }

        watcherValues.set(id, next)

        runTeardown(id, action)

        const outcome = runEffect(
          () => withCause(id, () => watcher.handler(next, previous, reachFrom(entry.name) as never)),
          action,
        )

        if (typeof outcome === 'function') {
          if (disposed) {
            // Disposal already swept the map, so a teardown returned during it runs immediately.
            runEffect(outcome as Teardown, action)
          } else {
            watcherTeardowns.set(id, outcome as Teardown)
          }
        }
      }
    }
  }

  const runEffects = (action: Dispatched, listeners: ReadonlyArray<(action: Dispatched) => void>) => {
    for (const entry of hosted.values()) {
      const wired = Object.hasOwn(entry.effects, action.type) ? entry.effects[action.type] : undefined
      if (!wired) {
        continue
      }

      // Heard from one of its own instances, an effect reaches that instance as a command does.
      const identity =
        entry.instanced && action.__instance !== undefined && parseAddress(action.type)?.domain === entry.name
          ? { id: action.__instance, generation: action.__generation }
          : undefined
      runEffect(() => wired.handler(action, reachFrom(entry.name, identity) as never), action)
    }

    for (const listener of listeners) {
      runEffect(() => listener(action), action)
    }

    if (logLevel === 'debug') {
      log('debug', 'effects', fromAction(name, action))
    }
  }

  const runEffect = (run: () => unknown, action?: Dispatched): unknown =>
    contain(run, error => reportUnhandled(error, action))

  const runTeardown = (id: string, action?: Dispatched) => {
    const teardown = watcherTeardowns.get(id)
    if (!teardown) {
      return
    }

    // Delete first because a teardown may dispose and re-enter this function.
    watcherTeardowns.delete(id)
    runEffect(teardown, action)
  }

  type Settlement = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

  type Settled = { ok: true; result: unknown } | { ok: false; error: unknown }

  type ActionJob =
    | { kind: 'reduce'; action: Dispatched; settle: Settlement; cause: string }
    | { kind: 'called'; action: Dispatched; invocation: Invocation; cause: string }
    | { kind: 'terminal'; action: Dispatched; invocation: Invocation; outcome: Settled; cause: string }

  // Fixed, not a setting, until a legitimate cascade comes near it. Not `10_000`: a numeric
  // separator survives an ES2022 emit and metro 0.72's minifier cannot parse it. `check:bundler`
  // pins it.
  const CASCADE_LIMIT = 10000

  const queue: ActionJob[] = []
  let draining = false

  let cascadeCount = 0
  let cascadeLastCause: string | undefined

  // The cause of a job is whoever emitted it on the current synchronous stack, and no more than
  // that: after an await the stack is gone and the cause is a bare 'emit'. Carrying it further would
  // be a tracing system growing inside a state manager.
  let currentCause = 'emit'

  const withCause = <T>(cause: string, run: () => T): T => {
    const outer = currentCause
    currentCause = cause
    try {
      return run()
    } finally {
      currentCause = outer
    }
  }

  const enqueue = (job: ActionJob) => {
    // Queue order and version order must be assigned atomically with respect to host callbacks.
    job.action = { ...job.action, __seq: nextVersion() }

    // An early participant writing `type` reroutes every domain drafted after it. Shallow, on an
    // object the library just built, so every build pays it. The payload stays the caller's.
    Object.freeze(job.action)

    queue.push(job)
    drain()
  }

  const dropQueue = (error: unknown) => {
    const dropped = queue.splice(0, queue.length)
    for (const job of dropped) {
      contain(
        () => (job.kind === 'reduce' ? job.settle.reject(error) : cancelInvocation(job.invocation, error)),
        failure => reportUnhandled(failure),
      )
    }
  }

  const drain = () => {
    // Nested emits append; top-level emits still drain synchronously.
    if (draining) {
      return
    }

    draining = true
    let processed = 0
    const causes: string[] = []

    try {
      while (queue.length > 0) {
        if (disposed) {
          dropQueue(refusedByDisposal())
          return
        }

        processed += 1
        causes.push(queue[0].cause)
        if (causes.length > 10) {
          causes.shift()
        }

        if (processed > CASCADE_LIMIT) {
          const error = new CascadeAborted(name, CASCADE_LIMIT, causes)
          cascadeCount += 1
          cascadeLastCause = causes.join(' -> ')

          dropQueue(error)
          reportUnhandled(error)
          return
        }

        runJob(queue.shift()!)
      }
    } finally {
      draining = false
    }
  }

  const runJob = (job: ActionJob) => {
    if (job.kind !== 'reduce' && job.invocation.tombstoned) {
      return
    }

    const action = job.action

    if (logLevel === 'debug') {
      log('debug', 'started', { ...fromAction(name, action), cause: job.cause })
    }

    if (onAction) {
      // Runtime copy backs the type-level readonly contract.
      const seen = { ...action }
      runEffect(() => onAction(seen), seen)
    }

    // One boundary for every job kind: after disposal nothing folds, resolves, or publishes,
    // whether the job is a reduce, a command about to start, or a computed terminal outcome.
    if (disposed) {
      if (job.kind === 'reduce') {
        job.settle.reject(refusedByDisposal())
      } else {
        cancelInvocation(job.invocation, cancelledByDisposal())
      }
      return
    }

    // Rechecked: `onAction` is host code, and may have emitted a `latest` sibling that tombstoned
    // this one.
    if (job.kind !== 'reduce' && job.invocation.tombstoned) {
      return
    }

    // Captured before folding, so a listener registered by this action's own reactions first hears
    // the next one.
    const reactionListeners = [...(actionListeners.get(action.type) ?? []), ...(actionListeners.get(WILDCARD) ?? [])]

    const markDecided = () => {
      if (job.kind === 'terminal') {
        job.invocation.decided = job.outcome
      }
    }

    try {
      fold(action, markDecided)
    } catch (error) {
      // Whatever the draft threw, a disposed scope refuses the action as an unstarted one is refused.
      if (disposed) {
        if (job.kind === 'reduce') {
          job.settle.reject(refusedByDisposal())
        } else {
          cancelInvocation(job.invocation, cancelledByDisposal())
        }
        return
      }

      if (logLevel !== 'silent') {
        log('info', 'rejected', fromAction(name, action))
      }

      if (job.kind === 'reduce') {
        job.settle.reject(error)
      } else if (job.kind === 'terminal') {
        // The handler already finished and its outcome is what the caller asked about. A stage that
        // throws while recording it is a second, separate failure: reported, never substituted for
        // the first, or a bad `done` reducer makes a completed side effect look failed.
        reportUnhandled(error, action)
        settleInvocation(job.invocation, job.outcome)
      } else {
        settleInvocation(job.invocation, { ok: false, error })
      }
      return
    }

    withCause(action.type, () => runEffects(action, reactionListeners))

    if (job.kind === 'reduce') {
      job.settle.resolve(undefined)
      return
    }

    if (job.kind === 'terminal') {
      if (job.outcome.ok) {
        if (logLevel === 'debug') {
          log('debug', 'settled', fromAction(name, action))
        }
      } else if (logLevel !== 'silent') {
        log('info', 'rejected', fromAction(name, action))
      }

      settleInvocation(job.invocation, job.outcome)
      return
    }

    job.invocation.version = action.__seq as number
    if (job.invocation.tombstoned) {
      return
    }

    startHandler(job.invocation)
  }

  // Which instance an action is about. The generation as much as the id: the id can be retaken
  // while a command is in flight, and the string then names a different instance. `undefined`
  // before the id has ever been seeded.
  type Identity = { readonly id: string; readonly generation: number | undefined }

  type Invocation = {
    address: string
    domainName: string
    entry: DeclaredCommand
    input: unknown
    controller: AbortController
    settle: Settlement
    promise: Promise<unknown>

    version: number

    // Carried so the terminal fold reaches the instance the invocation was emitted from.
    identity?: Identity

    // Which concurrency slot this invocation occupies. `latest` and `join` ask whether another call
    // is running, and on an instanced domain that is per instance: two instances are two subjects.
    slot: string

    settled: boolean

    tombstoned: boolean

    // What the library aborted this invocation with, kept where a handler cannot reach it: a
    // shadowed `signal.reason` would let user code match an unrelated failure and silence it.
    cancelledWith?: unknown

    decided?: Settled
  }

  // Keyed by concurrency slot, generation included: a call belonging to a replaced instance must
  // not be joined by its successor, whose fold commits nothing while the caller is told it worked.
  const slotFor = (address: string, identity?: Identity) =>
    identity === undefined ? address : `${address}|${identity.generation}|${identity.id}`

  // Which invocation owns a concurrency slot. Written only for `latest` and `join`; `live` below is
  // every invocation the scope still owns.
  const slots = new Map<string, Invocation>()

  const live = new Set<Invocation>()

  const running = new Set<Invocation>()

  const settleInvocation = (invocation: Invocation, outcome: Settled) => {
    if (invocation.settled) {
      return
    }
    invocation.settled = true
    live.delete(invocation)
    releaseSlot(invocation)

    if (outcome.ok) {
      invocation.settle.resolve(outcome.result)
    } else {
      invocation.settle.reject(outcome.error)
    }
  }

  const cancelInvocation = (invocation: Invocation, error: unknown) => {
    if (invocation.settled) {
      return
    }
    invocation.tombstoned = true
    invocation.cancelledWith = error

    // Settled through the library's own resolver first: the caller's promise is public, and its
    // holder may have redefined `then` or `constructor` on it.
    settleInvocation(invocation, { ok: false, error })

    // Scope-initiated cancellation is control flow, not an unhandled rejection. Marking the promise
    // handled reads its `constructor`, so a poisoned one is left to reject as the platform decides.
    try {
      promiseThen.call(invocation.promise, undefined, () => undefined)
    } catch {
      // The caller broke the promise it was handed; it has still been rejected.
    }

    contain(
      () => invocation.controller.abort(error),
      failure => reportUnhandled(failure),
    )
  }

  // A newer invocation may already own the slot, in which case this one holds nothing to release.
  const releaseSlot = (invocation: Invocation) => {
    if (slots.get(invocation.slot) === invocation) {
      slots.delete(invocation.slot)
    }
  }

  const startHandler = (invocation: Invocation) => {
    const local = invocation.controller

    // The pump must not await handlers: a handler may await an action it emits into this queue.
    const ctx = makeCtx(invocation.domainName, local.signal, invocation.version, invocation.identity)

    running.add(invocation)

    // A promise of the library's own, resolved with whatever the handler returned or threw. Not
    // `Promise.resolve`, which hands a native promise back as it is, own `then` included: resolving
    // a fresh one reads `then` inside the resolver, where a throw becomes this call's failure.
    const handled = new Promise(resolve => resolve(invocation.entry.handler(invocation.input, ctx)))

    const finish = (outcome: Settled) => {
      running.delete(invocation)
      finishHandler(invocation, outcome)
    }

    void promiseThen.call(
      handled,
      result => finish({ ok: true, result }),
      (error: unknown) => finish({ ok: false, error }),
    )
  }

  const finishHandler = (invocation: Invocation, outcome: Settled) => {
    // Dropping a cancelled invocation's fold is correct; its state is stale. Dropping its failure
    // is not: nothing else mentions it, and it is a handler bug rather than the cancellation.
    const reportLate = () => {
      // A handler passing `ctx.signal` to its work rejects with the reason the library installed,
      // and reporting that files a cancellation as an application fault — one entry per keystroke of
      // a typeahead. Matched by identity, not class: a handler's own `AbortError` is an error.
      if (outcome.ok || (invocation.cancelledWith !== undefined && outcome.error === invocation.cancelledWith)) {
        return
      }

      reportUnhandled(outcome.error, { type: `${invocation.address}.failed` })
    }

    if (invocation.tombstoned || invocation.controller.signal.aborted) {
      reportLate()
      return
    }
    if (invocation.entry.stages.latest && slots.get(invocation.slot) !== invocation) {
      reportLate()
      return
    }

    // `latest` releases its slot here, before the terminal fold: held past the fold, a terminal
    // reaction could supersede a handler that already finished. `join` holds its slot until it
    // settles, because a caller arriving between here and the fold must still join it.
    if (!invocation.entry.stages.join) {
      releaseSlot(invocation)
    }

    const __originSeq = invocation.version

    enqueue({
      kind: 'terminal',
      action: outcome.ok
        ? {
            type: `${invocation.address}.done`,
            input: invocation.input,
            result: outcome.result,
            __originSeq,
            __instance: invocation.identity?.id,
            __generation: invocation.identity?.generation,
          }
        : {
            type: `${invocation.address}.failed`,
            input: invocation.input,
            error: outcome.error,
            __originSeq,
            __instance: invocation.identity?.id,
            __generation: invocation.identity?.generation,
          },
      invocation,
      outcome,
      cause: invocation.address,
    })
  }

  const declares = (domainName: string, reached: string): boolean =>
    reached === domainName || hosted.get(domainName)!.uses.includes(reached)

  // Set only for a command invoked through an instance handle, so its own emits name that instance.
  // Without it the fold refuses them: an instanced action must name an instance.
  const reachFrom = (domainName: string, identity?: Identity) => ({
    read: (domain: string) => {
      // A read has no refusal value that is not a lie — its type says the state is there — so it
      // answers and the violation goes on the record instead.
      if (typeof domain === 'string' && hosted.has(domain) && !declares(domainName, domain)) {
        reportUndeclared(domainName, domain, 'reads')
      }
      return readState(domain) as never
    },

    emit: ((address: string, input?: unknown) => {
      const parsed = typeof address === 'string' ? parseAddress(address) : undefined

      if (parsed && hosted.has(parsed.domain) && !declares(domainName, parsed.domain)) {
        reportUndeclared(domainName, parsed.domain, 'emits into')
        return Promise.reject(
          new Error(
            `Unable to emit '${address}' from domain '${domainName}': it does not declare '${parsed.domain}' in its ` +
              `'uses', and a domain may only reach what it declares`,
          ),
        )
      }

      return parsed?.domain === domainName
        ? emit(address as never, input as never, identity)
        : emit(address as never, input as never)
    }) as Ctx<any>['emit'],
  })

  const makeCtx = (domainName: string, signal: AbortSignal, version: number, identity?: Identity): Ctx<any> => {
    // Survives the instance being disposed mid-await, which would otherwise make `ctx.state`
    // undefined against a type promising the instance's state. Answers with the last committed
    // value, as a disposed scope's `read` does. Seeded now, not on first read: a handler that only
    // touches `ctx.state` after an await is exactly the case this exists for.
    let last: unknown =
      identity === undefined ? undefined : (hosted.get(domainName)!.state as Record<string, unknown>)[identity.id]

    return {
      // Commands read current state after awaits, not a start-time snapshot.
      get state() {
        const entry = hosted.get(domainName)!
        if (identity === undefined) {
          // Reached without a handle there is no instance to be about, and the type promises one:
          // refused, as the fold refuses an instanced action naming no instance, never handed the
          // aggregate.
          if (entry.instanced) {
            throw new Error(
              `Unable to read state for a command on domain '${entry.name}': it is instanced, so the command must ` +
                `be emitted through the handle from scope.instance('${entry.name}', id)`,
            )
          }
          return entry.state as never
        }
        // Only while it is still the same instance: the id can be retaken mid-await, and adopting
        // the live value would hand this command its successor's state.
        const live =
          entry.instances.get(identity.id)?.generation === identity.generation
            ? (entry.state as Record<string, unknown>)[identity.id]
            : undefined
        if (live !== undefined) {
          last = live
        }
        return last as never
      },
      signal,
      version,
      ...reachFrom(domainName, identity),
    }
  }

  const reportUndeclared = (domainName: string, reached: string, verb: string) => {
    // On the offending domain rather than a scope-wide map keyed by an interpolated pair: `Hosted`
    // is already per scope, so this dedupes per (domain, neighbour) with no key to collide.
    const entry = hosted.get(domainName)
    if (entry?.reportedUndeclared.has(reached)) {
      return
    }

    const reported = log('error', 'rejected', {
      scope: name,
      cause: `domain '${domainName}' ${verb} '${reached}' without declaring it in 'uses'`,
    })

    // Marked only once a line went out: a first violation dropped by the re-entrancy guard would
    // otherwise leave that neighbour permanently silent rather than merely late.
    if (reported) {
      entry?.reportedUndeclared.add(reached)
    }
  }

  // On the ungated channel. The id stays out: it is application data.
  const reportDropped = (entry: Hosted, cause: string, action: Dispatched) => {
    log('error', 'rejected', { scope: name, type: action.type, cause })
  }

  const readState = (domain: string) => {
    const entry = hosted.get(domain)
    if (!entry) {
      throw new Error(`Unable to read '${domain}' from scope '${name}': the domain is not hosted here`)
    }
    return entry.state
  }

  const lookupAction = (
    parsed: { domain: string; action: string },
    address: string,
    verb: 'emit' | 'observe',
  ): { host: Hosted; declared: DeclaredAction } | string => {
    const host = hosted.get(parsed.domain)
    if (!host) {
      return `Unable to ${verb} '${address}' in scope '${name}': domain '${parsed.domain}' is not hosted here`
    }
    // Prototype names such as `constructor` are not declarations.
    if (!Object.hasOwn(host.actions, parsed.action)) {
      return `Unable to ${verb} '${address}': domain '${parsed.domain}' declares no such action`
    }
    return { host, declared: host.actions[parsed.action] }
  }

  const checkDescriptor = (descriptor: unknown): string => {
    if (typeof descriptor !== 'string') {
      throw new Error(`Unable to observe: an address must be a string, but ${describeValue(descriptor)} arrived`)
    }

    // `'*'` names the scope rather than an action, so there is nothing to resolve.
    if (descriptor === WILDCARD) {
      return descriptor
    }

    const parsed = parseAddress(descriptor)
    if (!parsed) {
      throw new Error(`Unable to observe '${descriptor}': not a valid address`)
    }

    const found = lookupAction(parsed, descriptor, 'observe')
    if (typeof found === 'string') {
      throw new Error(found)
    }

    if (parsed.stage && found.declared.kind !== 'cmd') {
      throw new Error(
        `Unable to observe '${descriptor}': '${parsed.base}' is a pure action, so it has no '${parsed.stage}' outcome`,
      )
    }

    return descriptor
  }

  const listen = (address: string, handler: (action: Dispatched) => void): (() => void) => {
    const set = actionListeners.get(address) ?? new Set()

    // Independent registrations of the same function need independent lifetimes.
    const registration = guard((action: Dispatched) => handler(action))
    set.add(registration)
    actionListeners.set(address, set)
    return () => {
      set.delete(registration)

      // A stale unsubscribe must not delete a newer set for the same address.
      if (set.size === 0 && actionListeners.get(address) === set) {
        actionListeners.delete(address)
      }
    }
  }

  function emit(address: string, input?: unknown, identity?: Identity): Promise<unknown> {
    if (typeof address !== 'string') {
      return Promise.reject(
        new Error(`Unable to emit: an address must be a string, but ${describeValue(address)} arrived`),
      )
    }

    if (disposed) {
      return Promise.reject(new CommandAborted(address, `cannot be emitted: scope '${name}' has been disposed`))
    }

    const parsed = parseAddress(address)
    if (!parsed || parsed.stage) {
      return Promise.reject(new Error(`Unable to emit '${address}': not an invocable address`))
    }

    const found = lookupAction(parsed, address, 'emit')
    if (typeof found === 'string') {
      return Promise.reject(new Error(found))
    }
    const { declared } = found

    const cause = currentCause

    if (declared.kind === 'reduce') {
      return new Promise((resolve, reject) => {
        enqueue({
          kind: 'reduce',
          action: { type: address, input, __instance: identity?.id, __generation: identity?.generation },
          settle: { resolve, reject },
          cause,
        })
      })
    }

    const entry = declared

    const slot = slotFor(address, identity)

    if (entry.stages.join) {
      const running = slots.get(slot)

      // Answered before an invocation exists, or the joiner leaks one into `live` that nothing
      // settles. The first invocation's promise is the whole mechanism — no waiter list, no second
      // settlement path — so the joiner's outcome is computed from the first caller's input.
      if (running && !running.settled) {
        return running.promise
      }
    }

    const invocation = {
      address,
      domainName: parsed.domain,
      entry,
      input,
      controller: new AbortController(),
      version: 0,
      settled: false,
      tombstoned: false,
      slot,
      identity,
    } as Invocation

    invocation.promise = new Promise((resolve, reject) => {
      invocation.settle = { resolve, reject }
    })
    live.add(invocation)

    if (entry.stages.join) {
      slots.set(slot, invocation)
    }

    if (entry.stages.latest) {
      const previous = slots.get(slot)

      // Publish the replacement before abort listeners can synchronously re-enter emit.
      slots.set(slot, invocation)
      if (previous) {
        if (logLevel !== 'silent') {
          log('info', 'superseded', { scope: name, address })
        }
        cancelInvocation(previous, new CommandAborted(address))
      }
    }

    enqueue({
      kind: 'called',
      action: { type: address, input, __instance: identity?.id, __generation: identity?.generation },
      invocation,
      cause,
    })

    return invocation.promise
  }

  const instanceEntry = (domain: string, id: string): Hosted => {
    const entry = hosted.get(domain)
    if (!entry) {
      throw new Error(`Unable to take an instance of '${domain}' in scope '${name}': the domain is not hosted here`)
    }
    if (!entry.instanced) {
      throw new Error(
        `Unable to take an instance of '${domain}': the domain is not instanced. Declare 'instanced: true' on it, ` +
          `or read it with scope.read('${domain}')`,
      )
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Unable to take an instance of '${domain}': an instance id must be a non-empty string`)
    }
    if (id === '__proto__') {
      throw new Error(`Unable to take an instance of '${domain}': an instance id must not be '__proto__'`)
    }
    if (disposed) {
      refuseAfterDisposal(`take an instance of '${domain}'`)
    }
    return entry
  }

  // An instance arriving or leaving moves an instanced domain's written state and nothing else: no
  // view resolves against the aggregate, and the change names no field, because the key that moved
  // is an instance id rather than anything a watcher reads.
  const instanceCandidate = (entry: Hosted, written: Record<string, unknown>) =>
    new Map([[entry, { written, cache: entry.cache, state: assemble(written, {}, entry.state) }]])

  const instanceChange = (entry: Hosted): FieldChanges => new Map([[entry.name, new Set<string>()]])

  // Scope-wide rather than per id, so a book can leave with its instance and a stale handle still
  // never matches a later instance under the same id. Zero is a preloaded instance's.
  let generations = 0

  const acquireInstance = (
    entry: Hosted,
    id: string,
    prepared?: Record<string, unknown>,
  ): InstanceHandle<never, never> => {
    const book = entry.instances.get(id) ?? { owners: 0, generation: 0 }

    // Claimed before any subscriber hears of the arrival: a subscriber may synchronously take and
    // release the same id, and must not remove the instance from under the handle whose arrival
    // notified it. Handed to `commit` rather than run here, so an arrival that never publishes
    // claims no owner either.
    const claim = () => {
      book.owners += 1
      entry.instances.set(id, book)
    }

    if (Object.hasOwn(entry.written, id)) {
      claim()
    } else {
      const written = { ...entry.written, [id]: prepared ?? entry.seedInstance() }

      commit(instanceCandidate(entry, written), instanceChange(entry), () => {
        claim()
        book.generation = ++generations
      })
    }

    let released = false
    const generation = book.generation

    // A released handle is dead on its own account, which the generation cannot say: two holders
    // share one, so a match proves only that *somebody* holds the instance. The id stays out of the
    // message — it is application data, and an error goes off-process as readily as a report.
    const refuseReleased = (verb: string) =>
      new Error(
        `Unable to ${verb} an instance of domain '${entry.name}': this handle was released, and a released lease ` +
          `addresses nothing — take a new one from scope.instance('${entry.name}', id)`,
      )

    return {
      id,
      // Throwing on a released read is deliberate and asymmetric with PREPARE_INSTANCE's read, which
      // stays total after spent: a handle addresses one acquisition, so a released one has nothing
      // left to answer with, while the prepared object's read is getSnapshot and cannot throw.
      read: () => {
        if (released) {
          throw refuseReleased('read')
        }
        return (entry.written as Record<string, unknown>)[id] as never
      },

      emit: ((address: string, input?: unknown) =>
        released
          ? Promise.reject(refuseReleased('emit into'))
          : emit(address as never, input as never, { id, generation })) as Emit<never>,
      dispose: () => {
        if (released || disposed) {
          return
        }
        released = true

        const remaining = (entry.instances.get(id)?.owners ?? 1) - 1
        if (remaining > 0) {
          entry.instances.set(id, { owners: remaining, generation })
          return
        }

        const departed = () => entry.instances.delete(id)

        if (!Object.hasOwn(entry.written, id)) {
          departed()
          return
        }

        const { [id]: _gone, ...rest } = entry.written as Record<string, unknown>
        commit(instanceCandidate(entry, rest), instanceChange(entry), departed)
      },
    }
  }

  const scope = {
    name,
    emit,
    read: (domain: string) => readState(domain),

    // The aggregate lives here and nowhere else. The mirror holds: an ordinary domain has no
    // instances, so this refuses rather than becoming a second surface for a single state.
    instances: (domain: string) => {
      const entry = hosted.get(domain)
      if (entry && !entry.instanced) {
        throw new Error(
          `Unable to take the instances of '${domain}': it is not instanced, so scope.read('${domain}') is its state`,
        )
      }
      return readState(domain)
    },
    getState: () => {
      if (disposed) {
        refuseAfterDisposal('read every domain')
      }
      return root
    },
    getWrittenState: () => {
      if (disposed) {
        refuseAfterDisposal('read every domain')
      }

      // Cloned, not handed out: `entry.written` is the object the fold builds on, and returning it
      // lets a caller edit committed state with no action, equality check, notification or freeze.
      const written: Record<string, unknown> = {}
      for (const [domainName, entry] of hosted) {
        written[domainName] = cloneState(
          entry.written,
          detail =>
            `Unable to read the written state of domain '${domainName}' from scope '${name}': it must be ` +
            `structured-cloneable to be handed out or persisted — ${detail}.`,
        )
      }
      return written
    },
    on: (descriptor: unknown, handler: (action: Dispatched) => void) => {
      const descriptors = Array.isArray(descriptor) ? (descriptor as unknown[]) : [descriptor]

      // Every decision below reads this one answer. `length` is not a fact: a `Proxy` answers each
      // read separately and an element getter can shorten the list mid-loop, so a second read is a
      // second answer — enough to pass the empty check and then validate nothing.
      const count = descriptors.length

      // No type refuses this: `readonly A[]` admits `[]`, and a subscription observing nothing while
      // handing back a working unsubscriber is the silent gap `'*'` exists to remove.
      if (count === 0) {
        throw new Error('Unable to observe: a list must name at least one address, but an empty one arrived')
      }

      // Checked before any is registered: a list that half-registers observes less than it was
      // asked to and says nothing about it.
      //
      // Indexed, not `map`, `forEach` or `Array.from`: the first two skip holes, and the third walks
      // a `Symbol.iterator` the caller's array can override to yield fewer members than it holds.
      // Both passes walk `addresses` — dense, and ours — so a hole arrives as `undefined` and is
      // refused like any other non-address.
      const addresses: string[] = []
      for (let index = 0; index < count; index += 1) {
        addresses.push(checkDescriptor(descriptors[index]))
      }

      if (disposed) {
        return refuseRegistration(`observe '${addresses.join("', '")}'`)
      }

      const stops = addresses.map(address => listen(address, handler))
      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    },
    subscribe: (listener: () => void) => {
      if (disposed) {
        return refuseRegistration('subscribe')
      }

      const registration = guard(() => listener())
      listeners.add(registration)
      return () => {
        listeners.delete(registration)
      }
    },
    // Materialised, never an iterator: an iterator would read the live set at whatever instant the
    // caller consumed it. The queue and `live` are guarded on `disposed` rather than read: `dispose`
    // empties them in stages, and an abort listener firing mid-teardown would read a half-torn scope.
    inspect: (): ScopeReport => ({
      queueDepth: disposed ? 0 : queue.length,
      inFlight: [...running].map(invocation => invocation.address),
      live: disposed ? 0 : live.size,
      cascades: { count: cascadeCount, lastCause: cascadeLastCause },
    }),

    instance: (domain: string, id: string) => acquireInstance(instanceEntry(domain, id), id),

    [PREPARE_INSTANCE]: (domain: string, id: string) => {
      const entry = instanceEntry(domain, id)

      // A seed, never a snapshot of a live instance: this object is consulted only when the id is
      // absent — by `read` below and by `mount` when the lease arrives — so a snapshot would resurrect
      // an instance that is gone. The gap between preparing and mounting is unbounded, because React
      // keeps the newest effect closure even when the dependencies match and an `<Activity>` show
      // mounts whatever the last render prepared. Passing this to `acquireInstance` makes the
      // published state and the render-phase fallback one reference, so a show costs one render.
      const prepared = entry.seedInstance()

      // Before mount there is no lease: render may read, and an emit addresses whatever generation
      // is live — also true of an object the binding rebuilds for an unchanged identity, which holds
      // no lease until the installed effect re-runs, and it may never. After mount every call goes
      // through the handle. After unmount the object is spent, which gates emit and not read: read
      // is a getSnapshot and must stay total, so it falls through to `entry.written[id]` and can
      // answer with the id's next owner. Safe only while react.ts is the sole caller; exporting this
      // object reopens the question.
      let held: ReturnType<typeof acquireInstance> | undefined
      let spent = false

      return {
        // `Object.hasOwn`, not `??`: the aggregate is an ordinary object, so an id naming a member of
        // `Object.prototype` — `constructor`, `toString` — resolves that member, which is truthy and
        // would never fall through to the seed.
        read: () =>
          held
            ? held.read()
            : Object.hasOwn(entry.written, id)
              ? ((entry.written as Record<string, unknown>)[id] as Record<string, unknown>)
              : prepared,
        emit: ((address: string, input?: unknown) => {
          if (held) {
            return (held.emit as unknown as (a: string, i?: unknown) => Promise<unknown>)(address, input)
          }
          if (spent) {
            return Promise.reject(
              new Error(
                `Unable to emit into an instance of domain '${entry.name}': the mount that held it is gone, and ` +
                  `its lease went with it`,
              ),
            )
          }
          return emit(address as never, input as never, { id, generation: entry.instances.get(id)?.generation })
        }) as Emit<never>,
        mount: () => {
          const handle = acquireInstance(entry, id, prepared)
          held = handle
          return () => {
            spent = true
            held = undefined
            handle.dispose()
          }
        },
      }
    },

    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true

      if (logLevel !== 'silent') {
        log('info', 'disposed', { scope: name })
      }

      // Every obligation that can reach host code is contained on its own, so each completes
      // whatever the others throw, and a second dispose has nothing left to finish.
      dropQueue(refusedByDisposal())

      // Preserve a terminal result committed before disposal interrupted its reactions.
      for (const invocation of [...live]) {
        contain(
          () =>
            invocation.decided
              ? settleInvocation(invocation, invocation.decided)
              : cancelInvocation(invocation, cancelledByDisposal()),
          error => reportUnhandled(error),
        )
      }

      listeners.clear()
      actionListeners.clear()

      for (const id of [...watcherTeardowns.keys()]) {
        runTeardown(id)
      }

      watcherValues.clear()
      watcherTeardowns.clear()
      for (const entry of hosted.values()) {
        entry.cache.clear()
      }
    },
  }

  for (const entry of hosted.values()) {
    for (const [key, watcher] of Object.entries(entry.watchers)) {
      const id = `${entry.name}.${key}`

      // Wrapped so a throwing source names the scope it failed to build.
      const seeded = readingWatcher(id, () => watcher.source(entry.state as never, reachFrom(entry.name).read as never))
      readingWatcher(id, () => {
        checkState(seeded, `the value watched by '${id}'`)
        freezeState(seeded)
      })
      watcherValues.set(id, seeded)
    }
  }

  return scope as unknown as Scope<TDefs[number]['name'] & DomainName>
}
