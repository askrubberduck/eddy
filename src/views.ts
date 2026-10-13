import type { ViewEntry } from './domain'
import { isEqual } from './internal/equal'
import { checkState, inDevelopment, isRefusal, refusal } from './internal/state-value'

// Entries are replaced, never mutated, so a copied cache remains a rollback snapshot.
export type ViewCache = Map<string, { input: unknown; value: unknown }>

// Captured at module load, before any selector exists: reading them off `Object` would let a
// selector that replaces one answer the question about itself.
const ownKeys = Reflect.ownKeys
const describe = Object.getOwnPropertyDescriptor
const prototypeOf = Object.getPrototypeOf
const extensible = Object.isExtensible

export function resolveViews(
  domainName: string,
  views: Record<string, Pick<ViewEntry, 'input' | 'transform'>>,
  written: object,
  cache: ViewCache,
  // What the domain last published. The draft's cache carries the fold forward, so an input that
  // moves and comes back misses its committed entry there; a bounced view must still return the
  // published reference or the fold republishes.
  settled: ViewCache,
): Record<string, unknown> {
  const keys = Object.keys(views)

  if (keys.length === 0) {
    return {}
  }

  const resolved = new Map<string, unknown>()
  const inProgress = new Set<string>()

  // Views whose selector returned the lens whole. Per pass, not per domain: a selector may do it on
  // one fold and not the next.
  const wholeState = new Set<string>()

  const refuseWrite = (property: string | symbol): never => {
    throw refusal(
      new TypeError(
        `Unable to write '${String(property)}' while resolving the views of domain '${domainName}': ` +
          `a view input selector reads state, it does not write it`,
      ),
    )
  }

  // A plain object with an accessor per view key, not a Proxy: `in`, `Object.keys`, descriptors and
  // spread then answer from the language rather than from traps that must agree with each other.
  function lensFor(): Record<string, unknown> {
    const lens: Record<string, unknown> = { ...(written as Record<string, unknown>) }

    for (const key of keys) {
      if (Object.hasOwn(written, key)) {
        continue
      }

      Object.defineProperty(lens, key, {
        get: () => resolve(key),
        set: inDevelopment ? () => refuseWrite(key) : undefined,
        enumerable: true,
        configurable: true,
      })
    }

    if (inDevelopment) {
      // A written field is not writable through the lens either, and says so with the same words.
      for (const key of Object.keys(written)) {
        const value = (written as Record<string, unknown>)[key]
        Object.defineProperty(lens, key, {
          get: () => value,
          set: () => refuseWrite(key),
          enumerable: true,
          configurable: true,
        })
      }
    }

    return lens
  }

  // One lens for the whole pass. Its getters memoise through `resolve`, so a per-view lens would
  // answer identically at V times the accessor cost.
  const lens = lensFor()

  // One shared lens means one selector's escape reaches the next, so the whole shape is compared
  // after each. The key list is not enough: a redefinition leaves it identical, a symbol never
  // appears in it, and an attribute flag is not a key at all.
  type Shape = { proto: unknown; extensible: boolean; own: Map<string | symbol, PropertyDescriptor> }

  const shapeOf = (): Shape => ({
    proto: prototypeOf(lens),
    extensible: extensible(lens),
    own: new Map(ownKeys(lens).map(key => [key, describe(lens, key) as PropertyDescriptor])),
  })

  const shape = inDevelopment ? shapeOf() : undefined

  const sameDescriptor = (was: PropertyDescriptor, is: PropertyDescriptor): boolean =>
    is.get === was.get &&
    is.set === was.set &&
    Object.is(is.value, was.value) &&
    is.enumerable === was.enumerable &&
    is.configurable === was.configurable &&
    is.writable === was.writable

  const refuseTampering = (): void => {
    if (!shape) {
      return
    }

    const now = shapeOf()

    if (now.proto !== shape.proto) {
      refuseWrite('[[Prototype]]')
    }

    if (now.extensible !== shape.extensible) {
      refuseWrite('[[Extensible]]')
    }

    // Membership first, so an added or removed key is named rather than whichever its shift moved.
    for (const [key, descriptor] of shape.own) {
      const current = now.own.get(key)

      if (current === undefined || !sameDescriptor(descriptor, current)) {
        refuseWrite(key)
      }
    }

    const is = [...now.own.keys()]

    for (const key of is) {
      if (!shape.own.has(key)) {
        refuseWrite(key)
      }
    }

    // Then order, which `Object.keys` and spread both report: a selector that removes a key and puts
    // it back changes what the next one sees without changing any descriptor.
    const was = [...shape.own.keys()]

    for (const [index, key] of is.entries()) {
      if (was[index] !== key) {
        refuseWrite(key)
      }
    }
  }

  function resolve(key: string): unknown {
    if (resolved.has(key)) {
      return resolved.get(key)
    }

    if (inProgress.has(key)) {
      throw refusal(
        new Error(
          `Unable to resolve view '${domainName}.${key}': it depends on itself, through [${[...inProgress].join(' -> ')}]`,
        ),
      )
    }

    inProgress.add(key)
    try {
      const previous = cache.get(key)
      const published = settled.get(key)
      const entry = views[key]

      // Setters refuse assignment. `delete`, `defineProperty` and a prototype swap cannot be
      // intercepted on an ordinary object and freezing only silences them in sloppy mode, so the
      // shape is compared afterwards instead.
      let input: unknown = entry.input(lens as never)

      refuseTampering()

      // An identity selector keeps every sibling view. A lens nested inside a returned container is
      // refused by the state contract instead: accessor properties are not supported state.
      if (input === lens) {
        // Marked before the snapshot expands, so a sibling doing the same learns to skip back here
        // instead of re-entering and being reported as a cycle.
        wholeState.add(key)
        input = snapshot(key)
      }

      try {
        checkState(input, `the input of view '${domainName}.${key}'`)
      } catch (error) {
        // The lens exposes each view as an accessor, so a lens returned inside a container fails
        // here. Saying so turns a puzzling refusal into an instruction.
        if (isRefusal(error) && (error as Error).message.includes('an accessor property')) {
          throw refusal(
            new TypeError(
              `${(error as Error).message}. If that is the state object this selector received, return a plain ` +
                `copy of what it needs instead — the lens resolves each view through an accessor, and ` +
                `state holds data`,
              { cause: error },
            ),
          )
        }
        throw error
      }

      if (previous && isEqual(previous.input, input)) {
        resolved.set(key, previous.value)
        return previous.value
      }

      // A stage may move this view's input and a later one put it back; the published entry is then
      // not what `previous` holds. Met here, before the transform, whose result would only be
      // discarded when it matched.
      if (published && isEqual(published.input, input)) {
        cache.set(key, published)
        resolved.set(key, published.value)
        return published.value
      }

      const computed = entry.transform(input)
      checkState(computed, `the value of view '${domainName}.${key}'`)

      const value =
        previous && isEqual(previous.value, computed)
          ? previous.value
          : published && isEqual(published.value, computed)
            ? published.value
            : computed

      cache.set(key, { input, value })
      resolved.set(key, value)
      return value
    } finally {
      inProgress.delete(key)
    }
  }

  // What the assembled state will be: written fields plus every view resolved once. Only the view
  // being computed is left out — its own value cannot be part of its own input. Any other view
  // still in progress is a genuine cycle, and `resolve` reports it as one, in either declaration
  // order rather than only one of them.
  function snapshot(self: string): Record<string, unknown> {
    const plain: Record<string, unknown> = { ...(written as Record<string, unknown>) }
    for (const key of keys) {
      if (key === self || Object.hasOwn(written, key) || wholeState.has(key)) {
        continue
      }

      const value = resolve(key)

      // It may have turned out to be one while resolving, in which case the omission is mutual and
      // neither sees the other, whatever order they were declared in.
      if (!wholeState.has(key)) {
        plain[key] = value
      }
    }
    return plain
  }

  const output: Record<string, unknown> = {}
  for (const key of keys) {
    output[key] = resolve(key)
  }
  return output
}

export function assemble(
  written: object,
  viewValues: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...written, ...viewValues }

  checkState(next, 'the assembled state of a domain')

  if (!previous) {
    return next
  }

  const nextKeys = Object.keys(next)

  if (Object.keys(previous).length !== nextKeys.length) {
    return next
  }

  for (const key of nextKeys) {
    if (!Object.is(previous[key], next[key])) {
      return next
    }
  }

  return previous
}
