# eddy

**State for TypeScript applications, cut into domains that never import each other. From
[askrubberduck](https://github.com/askrubberduck).**

Explain your state to a rubber duck and somewhere in the middle of the sentence you hear it: this
part is a search, that part is a history, and the history only cares when a search comes back. eddy
lets you write the sentence down. No runtime dependencies.

## Sixty seconds

A typeahead and a history of what was searched: two domains, one command, one wire between them.
Save it as `demo.mts`, run `npx tsx demo.mts`, and it prints what follows.

```ts
import { cmd, createScope, defineDomain, reduce, view } from '@askrubberduck/eddy'
import type { Cmd, DomainType } from '@askrubberduck/eddy'

type SearchState = { query: string; results: string[]; pending: boolean }
type SearchActions = { run: Cmd<{ text: string }, string[]> }

type HistoryState = { queries: string[] }
type HistoryViews = { recent: string[] }

declare module '@askrubberduck/eddy' {
  interface Domains {
    search: DomainType<SearchState, SearchActions>
    history: DomainType<HistoryState, {}, HistoryViews, 'search'>
  }
}

const api = {
  async search(text: string, signal: AbortSignal): Promise<string[]> {
    await new Promise(resolve => setTimeout(resolve, 10))
    return signal.aborted ? [] : ['duck', 'duckling', 'ducat'].filter(word => word.startsWith(text))
  },
}

const search = defineDomain('search', [], {
  state: { query: '', results: [], pending: false },
  actions: {
    run: cmd(async (input, ctx) => api.search(input.text, ctx.signal), {
      latest: true,
      called: (_state, action) => ({ query: action.input.text, pending: true }),
      done: (_state, action) => ({ results: action.result, pending: false }),
      failed: { pending: false },
    }),
  },
})

const history = defineDomain('history', ['search'], {
  state: { queries: [] },
  actions: {},
  views: {
    recent: view(
      state => state.queries,
      queries => queries.slice(-5).reverse(),
    ),
  },
  on: {
    'search.run.done': reduce((state, action) => ({ queries: [...state.queries, action.input.text] })),
  },
})

const scope = createScope({ domains: [search, history] })
scope.on('*', action => console.log(action.type))

const slow = scope.emit('search.run', { text: 'duc' })
const fast = scope.emit('search.run', { text: 'duck' })

await fast
console.log(scope.read('search').results, scope.read('history').recent)
await slow.catch((error: Error) => console.log(error.message))
```

It prints:

```
search.run
search.run
search.run.done
[ 'duck', 'duckling' ] [ 'duck' ]
Command 'search.run' was superseded by a newer call
```

Two calls went out and one outcome came back. `latest` aborted the first call's signal and rejected
its promise with `CommandAborted`, so the slow answer could never overwrite the fast one. The result
updated `search` and `history` in one transaction, because `history` listed `search` as a neighbour
and listens on `search.run.done`. `recent` is a derived value, read like a field. The `'*'` listener
heard each action after it was applied, in order.

## If you know Redux Toolkit

The nearest neighbour for each piece, so you can place eddy without reading it all first.

| Redux Toolkit                                               | eddy                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| a slice                                                     | a domain, which also names the neighbours it may read and emit into, and the type checker holds it to the list |
| `createAsyncThunk`, `pending`/`fulfilled`/`rejected`        | a `cmd`, whose `called`, `done`, `failed` and `finally` stages fold as ordinary actions                        |
| `extraReducers` on another slice's action                   | `on`, keyed by the same address string the emitter uses                                                        |
| `createSelector`                                            | a view: declared on the domain, memoised on its input, and present in state                                    |
| listener middleware                                         | `effects` keyed by address, and `watch` on a value                                                             |
| the store                                                   | a scope: an object you hold, as many as you like, sharing no state                                             |
| `condition`, `cancelActiveListeners`, `createEntityAdapter` | `join` and `latest` on a command; a domain `instanced` per id, folding in the same transaction as the rest     |

From Zustand: a scope stands where the store did, and the hooks come from `createScopeHooks(scope)`
in `@askrubberduck/eddy/react`.

## Who it is not for

- One component and two setters. `useState` already holds that.
- An application that wants to plug things into its state manager. Nothing plugs into eddy;
  [Design](https://github.com/askrubberduck/eddy/wiki/Design) says why.
- State that holds a `Map`, a `Set`, a class instance or a function. State here is plain data, so
  it can be compared, frozen in development and persisted.
- A build that needs an ECMAScript module artifact. The package is CommonJS.

## Install

```sh
npm install @askrubberduck/eddy
```

Node 20 or later. TypeScript 5.4 or later for the declarations. React 18 or 19, only if you import
`@askrubberduck/eddy/react`. `/react` and `/testing` have fallbacks for resolvers that predate
`exports`, so a React Native application on an older Metro bundles them too.

Upgrading from 0.4.1 or earlier? Remove any `.npmrc` line that routes `@askrubberduck` to GitHub
Packages.

Until `1.0.0`, a minor release may break a public API. `CHANGELOG.md` ships in the package and says
what changed.

## Read on

The [wiki](https://github.com/askrubberduck/eddy/wiki) is the specification. Each question below is one page.

- How do I declare a domain and say what it may reach? [Domains](https://github.com/askrubberduck/eddy/wiki/Domains)
- What does `emit` promise, and when is a command cancelled or shared? [Actions](https://github.com/askrubberduck/eddy/wiki/Actions)
- When does a derived value recompute? [Views](https://github.com/askrubberduck/eddy/wiki/Views)
- What may state hold, and how do I save and restore it? [State](https://github.com/askrubberduck/eddy/wiki/State)
- Who hears an action, and in what order? [Reactions](https://github.com/askrubberduck/eddy/wiki/Reactions)
- How do I create, inspect and dispose a scope? [Scopes](https://github.com/askrubberduck/eddy/wiki/Scopes)
- How does one domain hold a row per id? [Instances](https://github.com/askrubberduck/eddy/wiki/Instances)
- How does a component read and emit? [React](https://github.com/askrubberduck/eddy/wiki/React)
- How do I test a domain without sleeping? [Testing](https://github.com/askrubberduck/eddy/wiki/Testing)
- Where do errors go, and what never leaves the process? [Diagnostics](https://github.com/askrubberduck/eddy/wiki/Diagnostics)
- Why is it built this way, and what does it decline to build? [Design](https://github.com/askrubberduck/eddy/wiki/Design)

The repository holds a small shop that asserts twelve wiki contracts by running them, and
`npm run check:example-runs` runs it against the source.

## Ask the duck

- Which of your slices change because something happened somewhere else, and how does each one find
  out today?
- When an asynchronous call is replaced by a newer one, what stops the old answer from landing?
- Is there a value three components derive three ways?
- Have you ever needed a second copy of the same state, a preview beside the real thing, and what
  did it cost?

## Working on it

```sh
npm ci
npm test                    # type-checks the suite, then runs it
npm run check:examples      # the shop compiles
npm run check:example-runs  # the shop runs
npm run check:wiki-anchors  # every `file.ts#symbol` the wiki names exists
npm run check:format
```

The wiki lives in `wiki/` and is published from there; behaviour and its page change in the same
commit. A change lands on `main` through a pull request, squash-merged, with its argument in the
description.

MIT. askrubberduck builds tools in the voice of the duck you explain your problem to: it doesn't
judge, doesn't repeat, listens, and helps you think until the answer is yours.
