# Actions

An action is a thing that happens at an address. A `reduce` folds synchronously, a `cmd` runs a
handler and then folds its outcome, and the caller of either gets a promise that settles once the
fold has committed. Nothing else in the scope can tell them apart: a neighbour, an effect, a test
and a wildcard tap all see `search.run`, `search.run.done` and `search.run.failed` as three actions
with three addresses.

## The example on this page

A search whose newest call wins.

```ts
import { cmd, createScope, defineDomain, isStale, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'

type SearchState = { query: string; results: string[]; pending: boolean }
type SearchActions = {
  run: Cmd<{ text: string }, string[]>
  clear: Reduce
  touched: Reduce
}

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

An address is `domain.action`, and for a command also `domain.action.done` and
`domain.action.failed`. Each segment is an identifier: a letter, underscore or dollar, then letters,
digits, underscores and dollars. The stage suffix is exactly `done` or `failed`, lower case, and
nothing else is a stage. Only the two-segment form can be emitted; the outcome addresses exist to be
listened on. `'*'` is accepted by `scope.on` alone and names every action the scope dispatches.

## `reduce`

A reducer is a partial object of fields, or a function of the current state and the action that
returns one or returns nothing. Whatever it returns is merged over the written state of its domain.
Views are resolved again afterwards, so a later stage reads them fresh.

```ts
await scope.emit('search.run', { text: 'du' })
await scope.emit('search.clear')
scope.read('search').results // []
```

A reducer whose output equals what is written folds nothing — the [State](State) page says what
equal means and what follows from it. The action was still dispatched, so every listener on its
address still hears it. `reduce({})` is therefore how an action exists
only to be observed — `search.touched` above changes nothing and is still an event with a typed
address.

A reducer that throws rejects the emit with its own error, and nothing it drafted is published.

## `cmd`

A command is a handler and, optionally, its stages. The handler receives the input and a context;
what it returns or throws is what the caller's promise resolves or rejects with. The stages are
reducers that fold at four moments:

| Stage     | Folds                                      | The action carries |
| --------- | ------------------------------------------ | ------------------ |
| `called`  | before the handler starts, as `search.run` | `input`            |
| `done`    | after it resolves, as `search.run.done`    | `input`, `result`  |
| `failed`  | after it rejects, as `search.run.failed`   | `input`, `error`   |
| `finally` | after `done` or `failed`, in the same fold | `input`            |

A stage is a partial or a function, exactly as a reducer is. `search.run` folds before `emit`
returns when it is called from outside a dispatch, so `scope.read('search').pending` is `true` on
the line after the emit, and it folds after the current action completes when a reaction emits it.
The outcome folds once the handler settles, as one transaction with every domain wired to that
address.

A `called` stage that throws rejects the emit and the handler never starts. A `done` or `failed`
stage that throws is a second, separate failure: the caller still gets the handler's real outcome,
because a bad reducer must not make a completed side effect look failed, and the stage's error goes
to the [reporter](Diagnostics).

### The context

`ctx.state` is a getter over the current state of the command's own domain, views included, so a
handler that reads it after an `await` sees what has folded since. `ctx.signal` is an `AbortSignal`
that aborts when the invocation is superseded or the scope is disposed; passing it to the work is
how a cancelled command stops costing anything. `ctx.version` is the sequence number of the `called`
action. `ctx.read` and `ctx.emit` reach this domain and the neighbours it declared; a command that
emits its own domain's actions from `ctx` keeps its [instance](Instances) identity on them.

## What `emit` promises

`emit` returns a real `Promise` and never throws. A non-string, an address that is not invocable,
a domain the scope does not host, an unknown action, or a disposed scope all arrive as rejections,
so one `.catch` covers every way a call can fail. For a reducer the promise resolves with nothing;
for a command it resolves with the handler's result or rejects with its error, and a superseded or
cancelled invocation rejects with `CommandAborted`.

When the promise settles, the fold has committed and every synchronous reaction to it has run — the
subscribers, the watchers, the effects and the `on` listeners of that action, and of every action
they emitted in turn, because a dispatch drains synchronously until its queue is empty. An effect
that awaits is on its own: nothing waits for it, and the [testing](Testing) module's `settled` and
`flush` exist for the two kinds of waiting.

An unawaited command that rejects is an unhandled rejection on the platform, as any promise is. It
does not go to the reporter, which hears about failures nobody else can.

## `latest`: the newest call wins

Declared on the stages, `latest` makes a second call to a running address supersede the first. The
first invocation's promise rejects with `CommandAborted`, its signal aborts, and its terminal stages
never fold, whatever its handler eventually returns. A handler that ignores its signal and finishes
late is simply dropped; one that fails on its own account after being aborted is reported, because
that is a bug and the cancellation was not.

```ts
const slow = scope.emit('search.run', { text: 'duc' })
const fast = scope.emit('search.run', { text: 'duck' })

await fast
scope.read('search').results // ['duck', 'duckling']
await slow.catch(error => error.name) // 'CommandAborted'
```

`latest` cannot sit beside a `finally` stage: a superseded invocation never reaches its terminal
stages, so cleanup keyed to the input that started it would be stranded. Do that work in the handler,
around its `await`, where the cancellation is visible. On an [instanced](Instances) domain,
supersession is per instance.

## `join`: the first call is shared

`join` is the opposite answer to the same question. A second call to a running address adopts the
invocation already running: it gets the same promise, computed from the first caller's input, and no
second handler starts. Once the first settles, the next call starts fresh. `latest` and `join` are
refused together.

## Versioning by hand

Sometimes every request should run and only the newest response should land. Every action carries
`__seq`, the sequence number it was dispatched with, and every outcome carries `__originSeq`, the
`__seq` of the call it came from. `isStale` compares the two:

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

That is the whole mechanism. The sequence counter is shared by every scope in the process, so two
scopes never issue the same number.

## The cascade guard

A reaction that emits an action which triggers the reaction again is a loop, and it is bounded: a
single dispatch may drain ten thousand actions, and the one after that is refused with
`CascadeAborted`, whose `causes` name what emitted each of the last ten: the action whose reactions
emitted it, the watcher that did, or `emit` from outside a dispatch. Everything still queued is
rejected, the error is reported, and the scope stays usable. `scope.inspect().cascades` counts how
often it happened.

## Ask the duck

- Does a second call make the first one wrong? `latest`. Does it want the same answer? `join`. Does
  every call matter and only the newest answer? `isStale`. Are none of those true? Then the calls
  are independent and no declaration is needed.
- Is the failure a thing the user should see? It belongs in a `failed` stage, in state, where a
  component reads it. Is it a thing only the log should see? Let the handler throw and leave the
  stage out.
- Does the handler still need `ctx.state` after its `await`? Then it is reading state that may have
  moved while it waited, and that is the state it should read.
