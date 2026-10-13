import { describeValue } from './internal/state-value'
import type { LogLevel, Logger, Settings } from './types'

export const consoleLogger: Logger = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  error: (...args) => console.error(...args),
}

export const defaultSettings = {
  logger: consoleLogger,
  logLevel: 'silent',
} satisfies Omit<Required<Settings>, 'onUnhandledError'>

// Bound to the scope's own logger: a caller supplying a logger and no reporter is asking for errors
// on that logger, not on this module's.
export const defaultReporter =
  (logger: Logger): Required<Settings>['onUnhandledError'] =>
  (error, action) =>
    logger.error('eddy: unhandled error', action?.type, error)

const LEVELS: readonly LogLevel[] = ['silent', 'info', 'debug']

// Refused whole, never field by field: a scope with half-valid settings is worse than one that
// never opened.
export function validate(settings: Partial<Settings>, subject: string): void {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError(`${subject}: settings must be an object, but ${describeValue(settings)} arrived`)
  }

  if ('logger' in settings) {
    const logger = settings.logger as Logger | undefined
    const missing =
      logger === null || typeof logger !== 'object'
        ? 'all of them'
        : (['debug', 'info', 'error'] as const).filter(method => typeof logger[method] !== 'function').join(', ')

    if (missing.length > 0) {
      throw new TypeError(
        `${subject}: 'logger' must provide debug, info and error functions, but ${missing} ` +
          `${missing === 'all of them' ? 'are' : 'is'} missing`,
      )
    }
  }

  if ('logLevel' in settings && settings.logLevel !== undefined && !LEVELS.includes(settings.logLevel)) {
    throw new TypeError(
      `${subject}: 'logLevel' must be one of ${LEVELS.join(', ')}, but ${String(settings.logLevel)} arrived`,
    )
  }

  if ('onUnhandledError' in settings && typeof settings.onUnhandledError !== 'function') {
    throw new TypeError(
      `${subject}: 'onUnhandledError' must be a function, but ${describeValue(settings.onUnhandledError)} arrived`,
    )
  }
}

// Captured at load, so a promise's own `then`, which its holder can redefine, is never the one called.
export const promiseThen = Promise.prototype.then

// A genuine promise, never a thenable: reading `.then` off host data invokes an application field
// as a function, and an accessor-backed one runs on the read alone.
//
// Not `instanceof`, which is realm-bound and misses a promise from an iframe or a `vm` context. The
// brand below is cross-realm and reads no application field, but it is forgeable with
// `Symbol.toStringTag`, so the adoption goes through the intrinsic rather than the object's own
// `then`: `Promise.prototype.then` checks the internal slot and throws on anything that only looks
// like a promise.
function route(outcome: unknown, onFailure: (error: unknown) => void): void {
  if (Object.prototype.toString.call(outcome) !== '[object Promise]') {
    return
  }

  try {
    promiseThen.call(outcome as Promise<unknown>, undefined, onFailure)
  } catch {
    // Branded but not a promise, or a promise whose `constructor` throws. Nothing to observe.
  }
}

export function contain(run: () => unknown, onFailure: (error: unknown) => void): unknown {
  try {
    const outcome = run()
    route(outcome, onFailure)
    return outcome
  } catch (error) {
    onFailure(error)
    return undefined
  }
}
