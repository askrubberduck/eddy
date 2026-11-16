# Scopes

Creating, reading, inspecting and disposing a scope. Instanced domains. The logger and the reporter.

```ts
import { cmd, createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Logger, Reduce } from '@askrubberduck/eddy'

type RowsState = { titles: Record<string, string> }
type RowsActions = { save: Cmd<{ id: string; title: string }, void> }

type DraftState = { title: string; dirty: boolean }
type DraftActions = { type: Reduce<{ title: string }>; commit: Cmd<{ id: string }, void> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    rows: DomainType<RowsState, RowsActions>
    draft: DomainType<DraftState, DraftActions, {}, 'rows', true>
  }
}

export const rows = defineDomain('rows', [], {
  state: { titles: { a: 'Alpha', b: 'Beta' } },
  actions: {
    save: cmd(async () => {}, {
      done: (state, action) => ({ titles: { ...state.titles, [action.input.id]: action.input.title } }),
    }),
  },
})

export const draft = defineDomain('draft', ['rows'], {
  instanced: true,
  state: () => ({ title: '', dirty: false }),
  actions: {
    type: reduce((_state, action) => ({ title: action.input.title, dirty: true })),
    commit: cmd(
      async (input, ctx) => {
        await ctx.emit('rows.save', { id: input.id, title: ctx.state.title })
      },
      { done: { dirty: false } },
    ),
  },
})

const logger: Logger = console

export const scope = createScope({
  name: 'app',
  domains: [rows, draft],
  logger,
  logLevel: 'info',
  onUnhandledError: (error, action) => console.error(action?.type, error),
})
```

## `createScope(options)`

| Option             | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `domains`          | The domains to host. Required.                                   |
| `name`             | A label for diagnostics. Names need not be unique.               |
| `preloadedState`   | Written state per domain, as `getWrittenState()` returns it.     |
| `onAction`         | A tap. It gets a copy of each action before its fold.            |
| `logger`           | An object with `debug`, `info` and `error`. Default: `console`.  |
| `logLevel`         | `'silent'` (default), `'info'` or `'debug'`.                     |
| `onUnhandledError` | `(error, action) => void`. It gets failures that have no caller. |

- `createScope` throws when a neighbour in `uses` is not hosted.
- It throws when a seed, a preload, a view or a watcher fails. The error names the scope.
- It reads each definition once. A later change to a definition has no effect.
- The scope type is `Scope<'rows' | 'draft'>`. It types every address the scope accepts.
- Create a scope for each part that needs its own state: a preview, a wizard, a server request.
- Dispose the scope when that part ends.

## Reading

| Call                | Returns                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `read(domain)`      | One domain's state and views. The reference is stable until the domain moves. |
| `getState()`        | All domains, keyed by name. Stable until a domain moves.                      |
| `getWrittenState()` | Written fields only, cloned. Use it to persist.                               |
| `instances(domain)` | An instanced domain's states, keyed by id. Values may be `undefined`.         |
| `inspect()`         | `ScopeReport`. Read-only. See below.                                          |

- The types refuse `read` of an instanced domain. `instances` throws on a domain that is not instanced.

`ScopeReport` fields:

- `queueDepth`: a number of queued jobs. `live`: a number of callers that wait for an outcome.
- `inFlight`: a `string[]` of the addresses of running command handlers.
- `cascades`: `{ count, lastCause }`. It is an object, not a number.
- After dispose, `queueDepth` and `live` are `0`.
- A `ScopeReport` is a new, unfrozen copy at each call. It does not update.
- A state reference from `read` or `getState` does not update either. Development builds freeze it.

## Disposing

`dispose()` is final. After it, nothing folds, resolves or publishes.

- Queued actions and commands in flight reject with `CommandAborted`. Their signals abort.
- Exception: a command whose outcome was decided before `dispose()` keeps that outcome.
- Listeners are cleared. Watcher teardowns run. View caches are released.
- No managed callback starts after `dispose()`, also when `dispose()` runs inside an action.
- A second `dispose()` does nothing.

| After dispose                             | Result                                                |
| ----------------------------------------- | ----------------------------------------------------- |
| `read`, `instances`                       | The last committed state                              |
| `getState`, `getWrittenState`, `instance` | Throws `CommandAborted`                               |
| `emit`                                    | Rejects with `CommandAborted`                         |
| `on`, `subscribe`                         | A no-op unsubscribe, plus a line on the error channel |
| `inspect`                                 | Still answers                                         |

## Instanced domains

- Set `instanced: true` in the declaration and `true` as the fifth argument of `DomainType`.
- The seed is for one instance. Use a factory.
- Do not declare views or watchers on an instanced domain. `createScope` throws, not `defineDomain`.
- Derive in the reader instead, or hold the value in a domain that is not instanced.
- Get a handle with `scope.instance(domain, id)`. It has `id`, `read()`, `emit` and `dispose()`.
- The first handle for an id seeds the instance. The last `dispose()` removes it.
- Emit an instanced address from a handle only. `scope.emit` refuses it at the type level.

```ts
const a = scope.instance('draft', 'a')
await a.emit('draft.type', { title: 'Alpha, revised' })

a.read().dirty // true
scope.instances('draft') // { a: { title: 'Alpha, revised', dirty: true } }
a.dispose()
```

- A command folds its terminal stages into the instance that emitted it.
- If that instance is gone or replaced, the fold is dropped and reported. The caller still gets the outcome.
- `ctx.emit` into the domain's own actions keeps the instance id. An emit into a neighbour does not carry it.
- An instanced domain's `on` cannot wire an action without an instance. That fold rejects the neighbour's action.
- A domain that is not instanced may wire an instanced action. It folds once for each action.
- A disposed handle's `read` throws and its `emit` rejects. Take a new handle.
- `preloadedState` for an instanced domain is one partial per id.

## The logger

| Level      | Adds                                                        |
| ---------- | ----------------------------------------------------------- |
| `'silent'` | Nothing. The `error` channel still works.                   |
| `'info'`   | `rejected`, `superseded`, `disposed`                        |
| `'debug'`  | `started`, `folded`, `effects`, `settled` for each dispatch |

- Each trace line is `eddy: <event>` and one record. It never carries an input, a result, an error or an instance id.
- The default reporter is different. It calls `logger.error('eddy: unhandled error', type, error)` with the error object.
- The `error` channel is never gated. It logs undeclared reads and emits, dropped wires, and dropped folds.
- Use `'debug'` only in development. It allocates one record for each dispatch.

## The reporter

`onUnhandledError(error, action)` gets failures that no caller can get:

- a subscriber, watcher, teardown, effect, `scope.on` handler or `onAction` that throws;
- a `done` or `failed` stage that throws;
- a watcher source that cannot be read;
- a cancelled handler that later fails with an error of its own;
- the cascade guard.

`action` is `{ type, __seq, __originSeq }` or `undefined`. The default reporter calls `logger.error`.
A rejected emit, a supersession and a disposal are not reported.
