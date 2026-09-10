import { isCleanDate } from './state-value'

// Derived from dequal v2.0.3 (MIT, Copyright Luke Edwards), narrowed to supported state values.
// Active counterpart maps preserve cycle shape; they are unwound after each recursive branch.
type Pairs = { ab: WeakMap<object, object>; ba: WeakMap<object, object> }

export const isEqual = (a: unknown, b: unknown): boolean => equals(a, b, undefined)

function equals(a: unknown, b: unknown, pairs: Pairs | undefined): boolean {
  if (a === b) {
    return true
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a !== a && b !== b
  }

  return compare(a, b, pairs ?? { ab: new WeakMap(), ba: new WeakMap() })
}

function compare(a: object, b: object, pairs: Pairs): boolean {
  const pairedB = pairs.ab.get(a)
  const pairedA = pairs.ba.get(b)

  if (pairedB !== undefined || pairedA !== undefined) {
    return pairedB === b && pairedA === a
  }

  pairs.ab.set(a, b)
  pairs.ba.set(b, a)

  try {
    return structurally(a as any, b as any, pairs)
  } catch {
    // Invalid branded objects, hostile getters, and excessive recursion compare unequal.
    return false
  } finally {
    pairs.ab.delete(a)
    pairs.ba.delete(b)
  }
}

function structurally(a: any, b: any, pairs: Pairs): boolean {
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b)) {
    return false
  }

  if (proto === Array.prototype) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && sameOwnEnumerable(a, b, pairs)
  }

  if (proto === Object.prototype) {
    return sameOwnEnumerable(a, b, pairs)
  }

  if (proto === Date.prototype) {
    return sameDate(a, b)
  }

  return false
}

/**
 * Two objects wearing `Date.prototype`, by time value, and only when both are clean: a production
 * build has no walk to refuse a decorated or forged Date before it gets here, so the same rule the
 * walk applies is applied again, and anything failing it is equal to nothing but itself.
 */
export function sameDate(a: object, b: object): boolean {
  return isCleanDate(a) && isCleanDate(b) && Object.is(Date.prototype.getTime.call(a), Date.prototype.getTime.call(b))
}

function sameOwnEnumerable(a: any, b: any, pairs: Pairs): boolean {
  // Enumerating present indices avoids scanning billions of holes in a sparse array.
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) {
    return false
  }
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !equals(a[key], b[key], pairs)) {
      return false
    }
  }
  return true
}

export function changedKeys<T extends object>(next: T, current: T | undefined): string[] {
  const moved: string[] = []
  for (const [key, value] of Object.entries(next)) {
    // Presence is part of the shape: a key arriving with `undefined` where none existed has moved,
    // though both sides read alike.
    if (current === undefined || !Object.hasOwn(current, key)) {
      moved.push(key)
      continue
    }

    if (!isEqual(value, (current as Record<string, unknown>)[key])) {
      moved.push(key)
    }
  }
  return moved
}
