// Keep this literal shape so bundlers can replace `process.env.NODE_ENV` and erase development checks.
declare const process: { env?: Record<string, string | undefined> } | undefined

// `process.env` is guarded separately: a browser or test shim that defines `process` without `env`
// is common.
export const inDevelopment =
  typeof process !== 'undefined' && typeof process.env !== 'undefined' && process.env.NODE_ENV !== 'production'

// 2^32-1 is an ordinary property name, not an array index.
const isArrayIndex = (key: string): boolean => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1

const validated = new WeakSet<object>()

// Retired from the state model, with the article the message needs.
const RETIRED: Record<string, string> = {
  Map: 'a Map',
  Set: 'a Set',
  RegExp: 'a RegExp',
  Error: 'an Error',
}

export function checkState(value: unknown, subject: string): void {
  if (!inDevelopment) {
    return
  }
  walk(value, subject, '', new WeakSet<object>())
}

/**
 * The one walk that runs in a production build, over one value: a payload whose caller declares it
 * external. It looks for an own `__proto__` key and nothing else, because `JSON.parse` keeps that
 * key and `clone` below deliberately preserves it, so a reader copying the value out with
 * `Object.assign` has its target's prototype replaced. `describeFailure` receives the path to the
 * key, and the first one found stops the walk.
 */
export function refuseProtoKeyDeep(value: unknown, describeFailure: (path: string) => string): void {
  scanProtoKey(value, '', new WeakSet<object>(), describeFailure)
}

function scanProtoKey(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  describeFailure: (path: string) => string,
): void {
  if (value === null || typeof value !== 'object') {
    return
  }

  const object = value as object
  if (seen.has(object)) {
    return
  }
  seen.add(object)

  const array = Array.isArray(object)

  // `Reflect.ownKeys` and descriptors, not `Object.keys`: the clone this runs beside happens to
  // drop non-enumerables and materialise getters, and a guard resting on another function's current
  // implementation drifts with it.
  for (const key of Reflect.ownKeys(object)) {
    if (key === '__proto__') {
      throw new Error(describeFailure(`${path}.__proto__`))
    }

    const at = array && typeof key === 'string' && isArrayIndex(key) ? `${path}[${key}]` : `${path}.${String(key)}`

    // Data properties only. Invoking an accessor would run code carried by a payload that crossed
    // the trust boundary, and would read a value the clone read separately.
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!
    if ('value' in descriptor) {
      scanProtoKey(descriptor.value, at, seen, describeFailure)
    }
  }
}

function reject(subject: string, path: string, reason: string): never {
  throw refusal(new TypeError(`Unable to accept ${subject}${path}: ${reason} is not a supported state value`))
}

function walk(value: unknown, subject: string, path: string, seen: WeakSet<object>): void {
  if (value === null) {
    return
  }

  const type = typeof value
  if (type === 'undefined' || type === 'boolean' || type === 'number' || type === 'string' || type === 'bigint') {
    return
  }
  if (type === 'symbol') {
    reject(subject, path, 'a symbol')
  }
  if (type === 'function') {
    reject(subject, path, 'a function')
  }

  const object = value as object
  if (seen.has(object) || validated.has(object)) {
    return
  }
  seen.add(object)

  if (Array.isArray(object)) {
    // Array.isArray is realm-independent; equality dispatches on prototype identity, so an array
    // from another realm could never compare equal to its twin and would churn every fold.
    if (Object.getPrototypeOf(object) !== Array.prototype) {
      reject(subject, path, 'an array from another realm')
    }

    for (const key of Reflect.ownKeys(object)) {
      if (key === 'length') {
        continue
      }
      if (typeof key !== 'string' || !isArrayIndex(key)) {
        reject(subject, path, `${keyName(key)} on an array`)
      }

      const element = Object.getOwnPropertyDescriptor(object, key)!
      if (element.get || element.set) {
        reject(subject, `${path}[${key}]`, 'an accessor property')
      }
      if (!element.enumerable) {
        reject(subject, `${path}[${key}]`, 'a non-enumerable property')
      }

      walk(element.value, subject, `${path}[${key}]`, seen)
    }
  } else if (Object.getPrototypeOf(object) === Object.prototype) {
    walkOwn(object, subject, path, seen)
  } else if (Object.getPrototypeOf(object) === Date.prototype) {
    if (!isCleanDate(object)) {
      reject(subject, path, unsupported(object))
    }
  } else {
    const tag = Object.prototype.toString.call(object).slice(8, -1)

    // Retired when the model narrowed to what serialises; named so the failure is a migration.
    const retired = RETIRED[tag]
    if (retired !== undefined) {
      throw refusal(
        new TypeError(
          `Unable to accept ${subject}${path}: ${retired} is not a supported state value — state holds primitives, ` +
            `plain objects, arrays and Dates, so carry it as plain data (a pattern source, an array of entries, a message and a code)`,
        ),
      )
    }

    reject(subject, path, unsupported(object))
  }
}

// Separate from `walk`: a fold validates before it commits and `Object.freeze` has no inverse, so
// freezing inside validation would outlive a transaction that never published. Membership of
// `validated` means walked *and* frozen, which is what makes walk's short-circuit sound.
export function freezeState(value: unknown): void {
  if (!inDevelopment) {
    return
  }
  freeze(value, new WeakSet<object>())
}

function freeze(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') {
    return
  }

  const object = value as object
  if (validated.has(object) || seen.has(object)) {
    return
  }
  seen.add(object)

  // Children first: `validated` must never hold an object whose subtree is still mutable. Keyed on
  // it rather than `Object.isFrozen`, which would stop at a container the caller froze.
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor && 'value' in descriptor) {
      freeze(descriptor.value, seen)
    }
  }

  Object.freeze(object)
  validated.add(object)
}

function walkOwn(object: object, subject: string, path: string, seen: WeakSet<object>): void {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === 'symbol') {
      reject(subject, path, keyName(key))
    }
    const at = `${path}.${key}`

    // A nested own `__proto__` survives `JSON.parse` and `structuredClone`, and the ingress guards
    // in `hosting.ts` and `scope.ts` test the top level only. Preloaded state is scanned for it
    // recursively in every build, by `refuseProtoKeyDeep`; this walk catches the same key at every
    // other ingress, in a development build alone.
    if (key === '__proto__') {
      reject(subject, at, "the key '__proto__', which no reader can copy out safely")
    }

    const descriptor = Object.getOwnPropertyDescriptor(object, key)!
    if (descriptor.get || descriptor.set) {
      reject(subject, at, 'an accessor property')
    }
    if (!descriptor.enumerable) {
      reject(subject, at, 'a non-enumerable property')
    }
    walk(descriptor.value, subject, at, seen)
  }
}

const keyName = (key: string | symbol): string =>
  typeof key === 'symbol' ? `a symbol key (${String(key)})` : `a custom property '${key}'`

// The internal slot, proven by the intrinsic: `Object.create(Date.prototype)` has the prototype and
// no time value, and a `Proxy` over a Date throws on the wrong receiver.
const hasTimeValue = (object: object): boolean => {
  try {
    Date.prototype.getTime.call(object)
    return true
  } catch {
    return false
  }
}

// A clean local Date: the prototype, the slot, and not one own key of any class. What every ingress
// admits and the clone copies; the three failures are named by `unsupported`.
export const isCleanDate = (object: object): boolean =>
  Object.getPrototypeOf(object) === Date.prototype && hasTimeValue(object) && Reflect.ownKeys(object).length === 0

export function unsupported(object: object): string {
  const proto = Object.getPrototypeOf(object) as object | null
  if (proto === null) {
    return 'an object with a null prototype'
  }

  if (proto === Date.prototype) {
    if (!hasTimeValue(object)) {
      return "an object with Date's prototype and no time value"
    }
    const [decoration] = Reflect.ownKeys(object)
    // A clean Date is a supported value that arrived where a container was required.
    return decoration === undefined ? 'a Date' : `a Date carrying ${keyName(decoration)}`
  }

  // The slot without the local prototype chain: a subclass has both, a Date from another realm
  // has the slot alone.
  if (hasTimeValue(object) && !Date.prototype.isPrototypeOf(object)) {
    return 'a Date from another realm'
  }

  const name = (object as { constructor?: { name?: string } }).constructor?.name

  if (name === 'Object' && Object.getPrototypeOf(proto) === null) {
    return 'a plain object from another realm (or an object with the same prototype shape)'
  }

  return name ? `an instance of ${name}` : 'an object of no recognised kind'
}

/**
 * A structural clone over supported state. Not `structuredClone`, which React Native lacks.
 * Preserved where a JSON round-trip would destroy them: `undefined` as a value, `NaN`, `bigint`,
 * array holes, and cycles. Anything outside the supported space throws rather than being mangled.
 */
function clone(value: unknown, seen: Map<object, unknown>, preserveUnsupported: boolean): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      if (preserveUnsupported) {
        return value
      }
      throw new TypeError(`${describeValue(value)} cannot be carried out of state`)
    }
    return value
  }

  const object = value as object
  const already = seen.get(object)
  if (already !== undefined) {
    return already
  }

  if (Array.isArray(object)) {
    if (Object.getPrototypeOf(object) !== Array.prototype) {
      throw new TypeError('an array from another realm cannot be carried out of state')
    }

    const copy: unknown[] = []
    seen.set(object, copy)
    copy.length = object.length

    // `Object.keys` skips holes, so a sparse array stays sparse. Defined rather than assigned for
    // the same reason as the object branch: an array can carry an enumerable own `__proto__` too.
    for (const key of Object.keys(object)) {
      Object.defineProperty(copy, key, {
        value: clone((object as unknown[])[key as unknown as number], seen, preserveUnsupported),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    return copy
  }

  if (isCleanDate(object)) {
    const copy = new Date(Date.prototype.getTime.call(object))
    seen.set(object, copy)
    return copy
  }

  if (Object.getPrototypeOf(object) !== Object.prototype) {
    if (preserveUnsupported) {
      return value
    }
    throw new TypeError(`${describeValue(object)} cannot be carried out of state`)
  }

  const copy: Record<string, unknown> = {}
  seen.set(object, copy)
  for (const [key, held] of Object.entries(object)) {
    // Defined, not assigned: `copy[key] = …` runs the `__proto__` setter and replaces the copy's
    // prototype instead of giving it that key. Production trusts ingress, so this path sees it.
    Object.defineProperty(copy, key, {
      value: clone(held, seen, preserveUnsupported),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return copy
}

export function cloneState<T>(value: T, describeFailure: (detail: string) => string, preserveUnsupported = false): T {
  try {
    return clone(value, new Map<object, unknown>(), preserveUnsupported) as T
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\.*\s*$/, '')
    throw new Error(describeFailure(detail), { cause: error })
  }
}

export const isPlainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

// Every refusal the library raises passes through `refusal`, so a wrapper naming a failed read can
// tell its own error from a host's without matching message text.
const refusals = new WeakSet<Error>()

export function refusal<E extends Error>(error: E): E {
  refusals.add(error)
  return error
}

export function refusing<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    throw error instanceof Error ? refusal(error) : error
  }
}

/**
 * Names the read that failed, once: a refusal the library raised is returned as it is; anything
 * else — a host getter, a trap, a selector — is wrapped with `describe` and kept as the cause.
 */
export function namingTheRead(error: unknown, describe: (detail: string) => string): Error {
  if (error instanceof Error && refusals.has(error)) {
    return error
  }
  return refusal(new Error(describe(describeThrown(error)), { cause: error }))
}

export function describeThrown(value: unknown): string {
  try {
    return (value instanceof Error ? value.message : String(value)).replace(/\.*\s*$/, '')
  } catch {
    return 'a value that cannot be described'
  }
}

export function describeValue(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (value === undefined) {
    return 'nothing'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  if (typeof value !== 'object') {
    return `a ${typeof value}`
  }
  return unsupported(value)
}
