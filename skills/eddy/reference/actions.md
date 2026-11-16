# Actions

Reducers, commands, their stages, the command context, `latest`, `join`, `isStale`, and the cascade guard.

```ts
import { cmd, createScope, defineDomain, isStale, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'

type SearchState = { query: string; results: string[]; pending: boolean }
type SearchActions = { run: Cmd<{ text: string }, string[]>; clear: Reduce; touched: Reduce }

declare module '@askrubberduck/eddy' {
  interface Domains {
    search: DomainType<SearchState, SearchActions>
  }
}

const api = {
  async search(text: string, signal: AbortSignal): Promise<string[]> {
    await new Promise(resolve => setTimeout(resolve, 10))
    if (signal.aborted) {
      throw signal.reason
    }
    return ['duck', 'duckling', 'ducat'].filter(word => word.startsWith(text))
  },
}

export const search = defineDomain('search', [], {
  state: { query: '', results: [], pending: false },
  actions: {
    run: cmd(async (input, ctx) => api.search(input.text, ctx.signal), {
      latest: true,
      called: (_state, action) => ({ query: action.input.text, pending: true }),
      done: (_state, action) => ({ results: action.result, pending: false }),
      failed: { pending: false },
    }),
    clear: reduce({ query: '', results: [] }),
    touched: reduce({}),
  },
})

export const scope = createScope({ domains: [search] })
```

## Addresses

- Each segment is an identifier. The stage suffix is `done` or `failed` only.
- Emit only the two-segment form. Listen on the `.done` and `.failed` forms.
- `'*'` is valid only in `scope.on`. It means every action.
- An action with `void` input takes no second argument to `emit`.

## `reduce`

- Give a partial object, or a function `(state, action) => partial | undefined`.
- `state` includes the views. `action.input` holds the input.
- The scope merges the result over the written state, then resolves the views again.
- An equal result folds nothing. The scope still dispatches the action, so listeners hear it.
- A reducer that throws rejects the emit. Nothing from that fold is published.

## `cmd(handler, stages?)`

The handler is `async (input, ctx) => result`. The caller's promise gets its result or its error.

| Stage     | Folds                                      | The action carries |
| --------- | ------------------------------------------ | ------------------ |
| `called`  | before the handler starts, as `search.run` | `input`            |
| `done`    | after it resolves, as `search.run.done`    | `input`, `result`  |
| `failed`  | after it rejects, as `search.run.failed`   | `input`, `error`   |
| `finally` | after `done` or `failed`, in the same fold | `input`            |

- An emit from outside a dispatch folds `called` before `emit` returns.
- So `scope.read('search').pending` is `true` on the next line.
- A `called` stage that throws rejects the emit. The handler does not start.
- A `done` or `failed` stage that throws goes to the reporter. The caller still gets the handler outcome.
- Put an error the user must see in a `failed` stage. Let a log-only error throw without a stage.

## The context

| Member        | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `ctx.state`   | A getter over this domain's current state and views. It moves after `await`. |
| `ctx.signal`  | An `AbortSignal`. It aborts on supersession and on scope disposal.           |
| `ctx.version` | The sequence number of the `called` action.                                  |
| `ctx.read`    | Reads this domain or a declared neighbour.                                   |
| `ctx.emit`    | Emits into this domain or a declared neighbour.                              |

Pass `ctx.signal` to the work. A handler that ignores it runs to the end, and the scope drops its outcome.

## What `emit` rejects with

- An invalid address, a domain the scope does not host, or an unknown action.
- An emit into a domain that is not in `uses`.
- A disposed scope, a superseded call, or a cancelled call: `CommandAborted`.
- A command handler's own error.

An unawaited command that rejects is an unhandled platform rejection. The reporter does not get it.

## `latest` and `join`

| Option         | A second call while the first runs                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `latest: true` | Supersedes the first. Its promise rejects with `CommandAborted`. Its signal aborts. Its terminal stages do not fold. |
| `join: true`   | Gets the first call's promise. No second handler starts.                                                             |

- Do not use `latest` and `join` together. `defineDomain` refuses it.
- Do not use `latest` with a `finally` stage. `defineDomain` refuses it. Clean up in the handler.
- On an instanced domain, both options apply per instance.

```ts
const slow = scope.emit('search.run', { text: 'duc' })
const fast = scope.emit('search.run', { text: 'duck' })

await fast
scope.read('search').results // ['duck', 'duckling']
await slow.catch(error => error.name) // 'CommandAborted'
```

## `isStale`: every call runs, the newest result lands

Every action carries `__seq`. Every outcome carries `__originSeq`. Store `__seq` in `called` and compare in `done`:

```ts
type LookupState = { results: string[]; requestSeq?: number }
type LookupActions = { run: Cmd<{ text: string }, string[]> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    lookup: DomainType<LookupState, LookupActions>
  }
}

export const lookup = defineDomain('lookup', [], {
  state: { results: [] },
  actions: {
    run: cmd(async (input, ctx) => api.search(input.text, ctx.signal), {
      called: (_state, action) => ({ requestSeq: action.__seq }),
      done: (state, action) => (isStale(action, state.requestSeq) ? undefined : { results: action.result }),
    }),
  },
})
```

## The cascade guard

- One dispatch can drain 10,000 actions. The next one rejects with `CascadeAborted`.
- `error.causes` names the source of each of the last ten actions.
- The scope rejects the queue, reports the error, and stays usable.
- `scope.inspect().cascades` counts the guard events.
