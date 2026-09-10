import { checkActionRules, checkDeclarationShape, checkViewRules, type DeclarationMap } from './domain'
import type { CommandEntry, DomainDef, EffectEntry, ReduceEntry, ViewEntry, WatchEntry } from './domain'
import { isAddressSegment, parseAddress } from './internal/address'
import type { Log } from './internal/log'
import {
  checkState,
  cloneState,
  describeValue,
  inDevelopment,
  isPlainObject,
  namingTheRead,
  refusal,
  refuseProtoKeyDeep,
} from './internal/state-value'
import type { LogLevel } from './types'
import { assemble, resolveViews, type ViewCache } from './views'

// Domain definitions are copied at construction so later mutation cannot enter a live dispatch.
export type Hosted = DomainState & {
  name: string
  uses: readonly string[]
  // Held per instance: `written` is the live instances keyed by id. `false` for an ordinary domain,
  // where `written` is the domain's own state.
  instanced: boolean
  seedInstance: () => Record<string, unknown>
  // One entry per live id. `owners` is how many handles hold it; the last one out disposes.
  // `generation` counts how many times the id has been seeded, so a handle can tell its instance
  // from a later one wearing the same string: the identity is the id *and* the generation.
  instances: Map<string, { owners: number; generation: number }>
  // Instances already reported for receiving a fold after disposal, so a stranded command reports
  // once rather than once per terminal stage.
  reportedOrphans: Set<string>
  // Neighbours this domain has already been reported for reaching undeclared, this scope.
  reportedUndeclared: Set<string>
  actions: Record<string, DeclaredAction>

  views: Record<string, DeclaredView>
  watchers: Record<string, DeclaredWatcher>
  on: Record<string, DeclaredReduce>
  effects: Record<string, DeclaredEffect>
}

type NormalStages = {
  readonly called: CommandEntry['stages']['called']
  readonly done: CommandEntry['stages']['done']
  readonly failed: CommandEntry['stages']['failed']
  readonly finally: CommandEntry['stages']['finally']
  readonly latest: CommandEntry['stages']['latest']
  readonly join: CommandEntry['stages']['join']
}

type DeclaredReduce = { readonly kind: 'reduce'; readonly handler: ReduceEntry['handler'] }
export type DeclaredCommand = {
  readonly kind: 'cmd'
  readonly handler: CommandEntry['handler']
  readonly stages: NormalStages
}
export type DeclaredAction = DeclaredReduce | DeclaredCommand
export type DeclaredView = {
  readonly kind: 'view'
  readonly input: ViewEntry['input']
  readonly transform: ViewEntry['transform']
}
type DeclaredWatcher = {
  readonly kind: 'watch'
  readonly source: WatchEntry['source']
  readonly handler: WatchEntry['handler']
}
type DeclaredEffect = { readonly kind: 'effect'; readonly handler: EffectEntry['handler'] }

export type DomainState = {
  written: Record<string, unknown>

  // Drafts clone this cache because view resolution writes it before the transaction commits.
  cache: ViewCache
  state: Record<string, unknown>
}
type DeclarationKind = 'cmd' | 'reduce' | 'view' | 'watch' | 'effect'

const REQUIRED: Record<DeclarationKind, ReadonlyArray<readonly [field: string, shape: 'function' | 'present']>> = {
  cmd: [['handler', 'function']],
  reduce: [['handler', 'present']],
  view: [
    ['input', 'function'],
    ['transform', 'function'],
  ],
  watch: [
    ['source', 'function'],
    ['handler', 'function'],
  ],
  effect: [['handler', 'function']],
}

// Reads each authored declaration once into private records, including symbol and non-enumerable keys.
function normaliseDeclarations<K extends DeclarationKind, T, U>(
  scopeName: string,
  domainName: string,
  slot: string,
  kinds: readonly K[],
  entries: Record<string, T>,
  normalise: (entry: T, kind: K) => U,
): Record<string, U> {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    const property = slot === 'watch' ? 'watchers' : slot
    throw new Error(
      `Unable to create scope '${scopeName}': domain '${domainName}' declares '${property}' as ${describeValue(entries)}, but it must be an object of declarations`,
    )
  }

  // On the raw map: a copy normalises enumerability away, so this is the only place it is visible.
  checkDeclarationShape(
    `Unable to create scope '${scopeName}': domain '${domainName}'`,
    slot as DeclarationMap,
    entries,
  )

  const declarations: Record<string, U> = {}
  for (const key of Reflect.ownKeys(entries)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(entries, key)
    if (descriptor) {
      const refuse = (because: string) => {
        throw new Error(
          `Unable to create scope '${scopeName}': domain '${domainName}' declares '${String(key)}' in '${slot}', but ${because}`,
        )
      }

      const entry = (entries as Record<PropertyKey, T>)[key]
      const declared = (entry as { $?: unknown } | null | undefined)?.$

      const kind = kinds.find(allowed => allowed === declared)
      if (kind === undefined) {
        refuse(
          `its '$' is ${declared === undefined ? 'missing' : JSON.stringify(String(declared))}, and '${slot}' takes ${kinds.map(k => `'${k}()'`).join(' or ')} declarations`,
        )
      }

      const declaration = normalise(entry, kind as K)

      for (const [field, shape] of REQUIRED[kind as K]) {
        const value = (declaration as Record<string, unknown>)[field]
        const carried = shape === 'function' ? typeof value === 'function' : value !== undefined && value !== null
        if (!carried) {
          refuse(
            `its '${field}' is ${value === undefined ? 'missing' : String(value)} — a '${kind}()' declaration must carry ${shape === 'function' ? 'a function' : 'a function or a constant to merge'} there, or nothing can run it`,
          )
        }
      }

      // Every survivor is enumerable — `checkDeclarationShape` refused the rest. Copying the flag
      // through would let the dead-wire sweep and the fold disagree: one enumerates, the other `hasOwn`s.
      Object.defineProperty(declarations, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: declaration,
      })
    }
  }
  return declarations
}
/**
 * Everything `createScope` decides before it runs anything: each definition read once into a
 * private record, seeds and preloaded state accepted or refused, neighbours and wires resolved, and
 * the first assembled state of every domain. What comes back is the scope's fixed view of its
 * domains; the runtime mutates the state slots and nothing else.
 */
export function hostDomains(
  name: string,
  domains: readonly DomainDef[],
  preloadOption: unknown,
  log: Log,
  logLevel: LogLevel | undefined,
): Map<string, Hosted> {
  const readingPreload = <T>(subject: string, read: () => T): T => {
    try {
      return read()
    } catch (error) {
      throw namingTheRead(error, detail => `Unable to create scope '${name}': reading ${subject} failed — ${detail}`)
    }
  }

  const checkPreloadShape = (value: unknown, subject: string, shape: string): void => {
    if (isPlainObject(value)) {
      return
    }
    throw refusal(
      new TypeError(
        `Unable to create scope '${name}': ${subject} must be ${shape}, but ${describeValue(value)} arrived.`,
      ),
    )
  }

  if (preloadOption != null) {
    readingPreload("'preloadedState'", () =>
      checkPreloadShape(preloadOption, "'preloadedState'", 'a plain object keyed by domain name'),
    )
  }

  const preloadedState = (preloadOption ?? {}) as Record<string, unknown>

  const hosted = new Map<string, Hosted>()

  // Assembly spreads written fields to every reader as own properties, so a reader copying state
  // back with a bracket assignment hits the `__proto__` setter and replaces its own prototype.
  // The top level only, in every build: this covers what the application itself writes, whose depth
  // a development build walks. Preloaded state is the payload from outside and is scanned to the
  // leaves instead, below.
  const refuseTopLevelProtoKey = (fields: object, source: string, domainName: string) => {
    if (Object.hasOwn(fields, '__proto__')) {
      throw new Error(
        `Unable to create scope '${name}': ${source} for domain '${domainName}' sets '__proto__', ` +
          `which is not a state field — assembly would carry it out to every reader, where a ` +
          `bracket assignment reaches the prototype instead of the object`,
      )
    }
  }

  const refuseViewKeys = (fields: object, views: Record<string, DeclaredView>, source: string, domainName: string) => {
    for (const key of Object.keys(views)) {
      if (Object.hasOwn(fields, key)) {
        throw new Error(
          `Unable to create scope '${name}': ${source} for domain '${domainName}' sets '${key}', which is a view`,
        )
      }
    }
  }

  for (const def of domains) {
    // Read once: a data-built definition may expose accessor-backed fields.
    const domainName = def.name

    if (!isAddressSegment(domainName)) {
      throw new Error(
        `Unable to create scope '${name}': domain name '${String(domainName)}' must be a plain identifier, because it is the first segment of every address that domain answers to`,
      )
    }
    if ((domainName as string) === '__proto__') {
      throw new Error(
        `Unable to create scope '${name}': a domain must not be named '__proto__', because the state root keys every domain by name and that key replaces the prototype instead of adding the domain`,
      )
    }

    if (hosted.has(domainName)) {
      throw new Error(`Unable to create scope '${name}': domain '${domainName}' is hosted twice`)
    }

    const declaredSubject = `Unable to create scope '${name}': domain '${domainName}'`

    const declaredIn = <K extends DeclarationKind, T, U>(
      slot: string,
      kinds: readonly K[],
      entries: Record<string, T>,
      normalise: (entry: T, kind: K) => U,
    ) => normaliseDeclarations(name, domainName, slot, kinds, entries, normalise)

    const actions = declaredIn('actions', ['cmd', 'reduce'], def.actions, (entry, kind) => {
      if (kind === 'reduce') {
        return { kind, handler: (entry as ReduceEntry).handler } as DeclaredAction
      }
      const command = entry as CommandEntry

      const stages = command.stages ?? ({} as CommandEntry['stages'])
      return {
        kind,
        handler: command.handler,
        stages: {
          called: stages.called,
          done: stages.done,
          failed: stages.failed,
          finally: stages.finally,
          latest: stages.latest,
          join: stages.join,
        },
      } as DeclaredAction
    })
    const views = declaredIn('views', ['view'], def.views, (entry, kind) => ({
      kind,
      input: entry.input,
      transform: entry.transform,
    }))
    const watchers = declaredIn('watch', ['watch'], def.watchers, (entry, kind) => ({
      kind,
      source: entry.source,
      handler: entry.handler,
    }))

    checkActionRules(declaredSubject, actions)
    checkViewRules(declaredSubject, views, actions)

    const on = declaredIn('on', ['reduce'], def.on, (entry, kind) => ({ kind, handler: entry.handler }))
    const effects = declaredIn('effects', ['effect'], def.effects, (entry, kind) => ({
      kind,
      handler: entry.handler,
    }))

    const preloaded = readingPreload(`the preloaded state for domain '${domainName}'`, () =>
      Object.hasOwn(preloadedState, domainName) ? preloadedState[domainName] : undefined,
    )

    const instanced = def.instanced === true

    if (instanced && Object.keys(views).length > 0) {
      throw new Error(
        `Unable to create scope '${name}': domain '${domainName}' is instanced and declares views. A view derives ` +
          `from one readable state, and an instanced domain has one per instance — derive in the reader, or hold ` +
          `the derived value in a domain that is not instanced`,
      )
    }

    if (instanced && Object.keys(watchers).length > 0) {
      throw new Error(
        `Unable to create scope '${name}': domain '${domainName}' is instanced and declares watchers, which have ` +
          `no instance handle to read from`,
      )
    }

    const seedInstance = () => {
      const seeded = def.seed() as Record<string, unknown>
      refuseViewKeys(seeded, views, 'the instance seed', domainName)
      refuseTopLevelProtoKey(seeded, 'the instance seed', domainName)
      checkState(seeded, `the instance seed for domain '${domainName}'`)
      return seeded
    }

    // An instanced domain starts empty; `scope.instance` seeds each one on first use.
    let written = instanced ? {} : (def.seed() as Record<string, unknown>)

    refuseViewKeys(written, views, 'the seed', domainName)
    refuseTopLevelProtoKey(written, 'the seed', domainName)

    if (preloaded !== undefined) {
      checkPreloadShape(
        preloaded,
        `the preloaded state for domain '${domainName}'`,
        instanced ? 'a plain object keyed by instance id' : 'a plain object of written fields',
      )

      checkState(preloaded, `the preloaded state for domain '${domainName}'`)

      // Development freezes the accepted graph below; production clones instead, so a caller
      // retaining the payload cannot mutate live state around the fold.
      const acceptedPreload = inDevelopment
        ? preloaded
        : cloneState(
            preloaded,
            detail =>
              `Unable to create scope '${name}': copying the preloaded state for domain '${domainName}' failed — ${detail}.`,
          )

      // The one recursive scan a production build runs, at the one ingress the library intends for
      // data from outside: `getWrittenState` output is persisted, read back with `JSON.parse`, and
      // handed straight back here, and `JSON.parse` keeps an own `__proto__` key that the clone
      // above preserves. Once per domain at construction, never on the fold path.
      refuseProtoKeyDeep(
        acceptedPreload,
        at =>
          `Unable to create scope '${name}': the preloaded state for domain '${domainName}' sets ` +
          `'__proto__' at '${at}', which is not a state field — remove it from the persisted payload ` +
          `before passing it as 'preloadedState', because a reader copying this object out with ` +
          `Object.assign has its target's prototype replaced instead`,
      )

      if (instanced) {
        const instances: Record<string, unknown> = {}
        for (const id of Object.keys(acceptedPreload as object)) {
          if (id.length === 0) {
            throw new Error(
              `Unable to create scope '${name}': the preloaded state for instanced domain '${domainName}' ` +
                `contains an empty instance id`,
            )
          }

          const supplied = (acceptedPreload as Record<string, unknown>)[id]
          checkPreloadShape(
            supplied,
            `the preloaded instance in domain '${domainName}'`,
            'a plain object of written fields',
          )
          refuseViewKeys(supplied as object, views, 'the preloaded instance', domainName)
          instances[id] = { ...seedInstance(), ...(supplied as Record<string, unknown>) }
        }
        written = instances
      } else {
        refuseViewKeys(acceptedPreload as object, views, 'the preloaded state', domainName)

        written = { ...written, ...(acceptedPreload as Record<string, unknown>) }
      }
    }

    hosted.set(domainName, {
      reportedUndeclared: new Set<string>(),
      reportedOrphans: new Set<string>(),
      instances: new Map<string, { owners: number; generation: number }>(),
      instanced,
      seedInstance,
      name: domainName,
      // Copied, not aliased: the caller still holds the array, and pushing to it after construction
      // would widen what this scope permits.
      uses: [...def.uses],

      actions,
      views,
      watchers,
      on,
      effects,
      written,
      cache: new Map(),
      state: {},
    })
  }

  // Validate neighbours after all domains are hosted, so declaration order is irrelevant.
  for (const entry of hosted.values()) {
    for (const neighbour of entry.uses) {
      if (!hosted.has(neighbour)) {
        throw new Error(
          `Unable to create scope '${name}': domain '${entry.name}' declares neighbour '${neighbour}', which this scope does not host`,
        )
      }
    }
  }

  const wireResolves = (address: string): boolean => {
    const parsed = parseAddress(address)
    if (!parsed) {
      return false
    }

    const host = hosted.get(parsed.domain)
    if (!host || !Object.hasOwn(host.actions, parsed.action)) {
      return false
    }

    // A '.done' or '.failed' outcome exists only for a command.
    return !parsed.stage || host.actions[parsed.action].kind === 'cmd'
  }

  // Split by what the author can have meant. A wire naming a domain this one declares in `uses` is
  // a typo about something it believes exists, so it throws. A wire into a domain the scope does not
  // host may be legitimate — a blueprint hosted in a smaller scope — so it is dropped and logged.
  const wireWasDeclared = (entry: Hosted, address: string): boolean => {
    const parsed = parseAddress(address)
    return parsed !== undefined && entry.uses.includes(parsed.domain)
  }

  // A declared wire that resolves to nothing is silently inert. TypeScript is the loud failure;
  // here the wire is dropped and logged.
  for (const entry of hosted.values()) {
    for (const map of ['on', 'effects'] as const) {
      for (const address of Object.keys(entry[map])) {
        if (wireResolves(address)) {
          continue
        }

        if (wireWasDeclared(entry, address)) {
          throw new Error(
            `Unable to create scope '${name}': domain '${entry.name}' declares '${map}' for '${address}', and ` +
              `'${parseAddress(address)?.domain}' is in its 'uses' but has no such action — a wire to nowhere is ` +
              `not architecture`,
          )
        }

        delete entry[map][address]

        log('error', 'rejected', {
          scope: name,
          address,
          cause: `domain '${entry.name}' declares '${map}' for an address this scope cannot resolve`,
        })
      }
    }
  }

  if (logLevel !== 'silent') {
    for (const key of Object.keys(preloadedState)) {
      if (!hosted.has(key)) {
        log('info', 'rejected', {
          scope: name,
          cause: `the preloaded state names '${key}', which this scope does not host`,
        })
      }
    }
  }

  for (const entry of hosted.values()) {
    // Nothing is published yet, so the cache is its own settled half.
    entry.state = assemble(
      entry.written,
      resolveViews(entry.name, entry.views, entry.written, entry.cache, entry.cache),
      undefined,
    )
  }

  return hosted
}
