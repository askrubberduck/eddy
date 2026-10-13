# Diagnostics

A scope has two channels out: a logger that traces what it does, and a reporter that hears about
failures nobody else can. Both are settings of the scope and both are validated before the scope
exists. The trace never carries an input, a result or an error, because a diagnostic sink is the
one place where a payload leaves the process. The reporter is handed the error itself — that is
what it is for — and the action narrowed to its type and sequence numbers.

## The example on this page

A scope that traces at `debug` and reports to a sink of its own.

```ts
import { createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { DomainType, Logger, Reduce, ReportedAction } from '@askrubberduck/eddy'

type ClockState = { ticks: number }
type ClockActions = { tick: Reduce; explode: Reduce }

declare module '@askrubberduck/eddy' {
  interface Domains {
    clock: DomainType<ClockState, ClockActions>
  }
}

export const clock = defineDomain('clock', [], {
  state: { ticks: 0 },
  actions: {
    tick: reduce(state => ({ ticks: state.ticks + 1 })),
    explode: reduce(() => {
      throw new Error('boom')
    }),
  },
})

export const lines: unknown[][] = []
export const failures: { error: unknown; action: ReportedAction | undefined }[] = []

const logger: Logger = {
  debug: (...args) => lines.push(args),
  info: (...args) => lines.push(args),
  error: (...args) => lines.push(args),
}

export const scope = createScope({
  name: 'clock',
  domains: [clock],
  logger,
  logLevel: 'debug',
  onUnhandledError: (error, action) => failures.push({ error, action }),
})
```

## The logger

A `Logger` is three functions, `debug`, `info` and `error`, and the default is the console. The
level gates the first two: `'silent'`, the default, traces nothing; `'info'` adds a line for a
rejection, a supersession and a disposal; `'debug'` adds the trace of every dispatch. The `error` channel is
never gated, because a silent trace must not become a silent failure.

Every trace line is `eddy: <event>` followed by one record. The record carries the scope's name, the
action's type and sequence numbers, sometimes an address or a cause, and for a fold the names of
the fields that moved per domain. It never carries an input, a result, an error, or an instance id,
which an application may have set to a token.

| Level   | Event        | When                                                                                                                                                       |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug` | `started`    | a job leaves the queue, with its cause: the action whose reactions emitted it, the watcher that did, or `emit` from outside a dispatch                     |
| `debug` | `folded`     | a fold committed, with the moved fields per domain — `[]` for an instanced domain, whose moved keys are ids                                                |
| `debug` | `effects`    | the reactions to an action have run                                                                                                                        |
| `debug` | `settled`    | a command's outcome folded and its caller was resolved                                                                                                     |
| `info`  | `rejected`   | a command rejected, a fold threw, or a preloaded key named no hosted domain                                                                                |
| `info`  | `superseded` | `latest` cancelled an invocation, by address                                                                                                               |
| `info`  | `disposed`   | the scope was disposed                                                                                                                                     |
| `error` | `rejected`   | an undeclared read or emit, a wire the scope could not resolve, a registration after disposal, or a fold dropped because its instance was gone or replaced |

```ts
await scope.emit('clock.tick')
lines.map(([event]) => event)
// ['eddy: started', 'eddy: folded', 'eddy: effects']
```

A logger that throws is contained and its failure is not routed back through it. A logger that
returns a promise which rejects is observed and dropped. A line the logger caused itself — by
emitting from inside `debug`, say — is dropped rather than recursed into.

## The reporter

`onUnhandledError(error, action)` hears every failure that has no caller to hear it: a subscriber,
a watcher, a teardown, an effect or an `on` listener that threw; an `onAction` tap that threw; a
terminal stage that threw after the handler had already decided the outcome; a watcher source that
could not be read; a handler that failed on its own account after its invocation was cancelled;
and the cascade guard. `action` is `{ type, __seq, __originSeq }` and nothing more, or `undefined`
when no action was in hand.

```ts
await scope.emit('clock.explode').catch(() => undefined)
failures // [], because the caller heard that one

scope.on('clock.tick', () => {
  throw new Error('listener')
})
await scope.emit('clock.tick')
failures[0]?.action?.type // 'clock.tick'
```

The default reporter is `logger.error('eddy: unhandled error', type, error)` on the scope's own
logger — the one line on the logger that carries an error object, stack included. A reporter that throws is itself contained, and the original error goes to `console.error`
rather than back through the logger it probably arrived with.

## What reaches neither

The rejection of a promise you were given. A command that rejects is the caller's to catch, and one
nobody awaited is an unhandled rejection on the platform, exactly as any promise is. A
supersession, a disposal, and a handler rejecting with the very reason the scope installed on its
signal are cancellations, not faults, and are not reported.

## Ask the duck

- Is the reporter wired to a service outside the process? It receives a type and two numbers, and
  the error object, which is the application's own. What is in that error's message is the
  application's to decide.
- Is the trace on in production? `debug` allocates a record per dispatch. `info` costs nothing
  until something goes wrong.
- Did a failure vanish? It went to the reporter, and the default reporter is the logger's `error`,
  which is never gated, so the console had it before the code did.
