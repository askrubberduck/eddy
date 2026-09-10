# eddy

**A domain-sliced state manager for TypeScript, from [askrubberduck](https://github.com/askrubberduck).**

Declared actions, procedural commands, derived views that live in state, and named scopes. No Redux,
no Zustand, no dependencies.

Ask a rubber duck about your state and it says nothing, which is how you notice the answer was three
domains, two commands and a view. eddy is that answer, written down.

## Sixty seconds

A search box with a typeahead, and a history that remembers what was searched. Two domains, one
command, one wire between them. Copy it whole; it runs.

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

Everything eddy is for is in those five lines. Two calls went out; `latest` cancelled the first,
aborted its signal, and rejected its promise by name. One outcome came back, and it folded into
`search` and into `history` as one transaction, because `history` wired `search.run.done` without
importing anything. The view `recent` is read like a field. The wildcard saw every action whose fold
completed, in order.

## What you get

- **Domains.** A named slice of state with its own actions, views and neighbours. The neighbours a
  domain may read or emit into are declared in `uses`, and the type checker holds you to it.
- **Two kinds of action.** A `reduce` folds synchronously. A `cmd` runs a handler with an
  `AbortSignal`, and its `called`, `done`, `failed` and `finally` stages fold as ordinary actions,
  so nothing else in the scope needs to know it was asynchronous. `latest` supersedes, `join` shares.
- **Views in state.** A derived value is declared once, memoised on its input, and read beside the
  fields it derives from. A neighbour reads it the same way.
- **One address for everything.** `cart.add`, `cart.add.done`, `cart.add.failed`. A reducer in
  another domain, an effect, a watcher, a test, and a wildcard tap all listen on the same strings.
- **Scopes.** A scope hosts a set of domains and is an object you hold. Two scopes over the same
  domains share nothing. Dispose one and it says so to everything that asks.
- **Instances.** A domain declared `instanced` is held once per id, in the same scope as everything
  else, so a per-row draft folds in the same transaction as the table it belongs to.
- **A React binding** with a provider, a domain hook, a selector hook, and a per-mount instance
  hook. **A testing module** that records actions and waits for a scope to settle.
- **Refusals that say what to do.** A development build walks every value that enters state and
  refuses what it cannot compare or freeze, by name, with the thing to carry instead. A production
  build skips the walk and the freeze, and trusts you.

## What you do not get

By design, and the reasons are on the [Design](https://github.com/askrubberduck/eddy/wiki/Design)
page. No middleware, no plugins, no global store, no devtools bridge, no runtime registration of
domains, no `Map` or `Set` in state. eddy is a kernel an application holds, not a platform other
packages extend. If the thing you need is a component and two setters, `useState` is right there and
the duck will not think less of you.

## Is it for you

The duck does not judge; it asks.

- Do you have more than one slice of state, and do some of them need to react to what happens in
  others without importing each other?
- Do asynchronous operations have a beginning, an end and a failure that the rest of the
  application wants to see as plain events?
- Is there a derived value that three components compute three ways today?
- Do you need two independent copies of the same state, such as a preview beside the real thing?

Two yeses and it earns its place. None and it is a heavier thing than you need.

## Install

It is published to GitHub Packages, not to npm, so the `@askrubberduck` scope needs a registry line
first — in `.npmrc` beside your `package.json`, or in `~/.npmrc`:

```
@askrubberduck:registry=https://npm.pkg.github.com
```

```sh
npm install @askrubberduck/eddy
```

GitHub Packages authenticates every read, public package or not, so npm also needs a token with
`read:packages` for that registry. `npm install github:askrubberduck/eddy` skips the registry
entirely and builds it on the way in. Node 20 or later; TypeScript 5.4 or later for the declarations; React 18 or 19 only
if you import `@askrubberduck/eddy/react`. The artifact is CommonJS with an `exports` map, and the
two subpaths have fallbacks for resolvers that predate it, so a React Native application on an
older Metro bundles it too.

Until `1.0.0` a minor release may break a public API. `CHANGELOG.md` ships in the package and says
what changed.

## Read on

The [wiki](https://github.com/askrubberduck/eddy/wiki) is the specification. Each page owns one
contract and does not restate the others.

| Page                                                                  | Answers                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Domains](https://github.com/askrubberduck/eddy/wiki/Domains)         | How a domain is declared, typed and wired to its neighbours            |
| [Actions](https://github.com/askrubberduck/eddy/wiki/Actions)         | Reducers, commands, stages, `latest`, `join`, and what `emit` promises |
| [Views](https://github.com/askrubberduck/eddy/wiki/Views)             | Derived values that live in state and when they recompute              |
| [State](https://github.com/askrubberduck/eddy/wiki/State)             | What state may hold, equality, freezing, and persistence               |
| [Reactions](https://github.com/askrubberduck/eddy/wiki/Reactions)     | `on`, `subscribe`, `effects`, `watch`, and the order they run in       |
| [Scopes](https://github.com/askrubberduck/eddy/wiki/Scopes)           | Creating, reading, inspecting and disposing a scope                    |
| [Instances](https://github.com/askrubberduck/eddy/wiki/Instances)     | One domain, many ids, one transaction                                  |
| [React](https://github.com/askrubberduck/eddy/wiki/React)             | The hooks, the provider, and server rendering                          |
| [Testing](https://github.com/askrubberduck/eddy/wiki/Testing)         | Recording actions and waiting for a scope to settle                    |
| [Diagnostics](https://github.com/askrubberduck/eddy/wiki/Diagnostics) | The logger, the error reporter, and what never reaches either          |
| [Design](https://github.com/askrubberduck/eddy/wiki/Design)           | The positions the library holds, and what it refuses to build          |

The repository ships a small shop that asserts twelve of these contracts by executing them, and
`npm run check:example-runs` runs it against the source.

## Working on it

```sh
npm ci
npm test                    # type-checks the suite, then runs it
npm run check:examples      # the shop compiles
npm run check:example-runs  # the shop runs
npm run check:wiki-anchors  # every `file.ts#symbol` the wiki names exists
npm run check:format
```

The wiki lives in `wiki/` and is published from there; behaviour and its page move in the same
commit. A branch lands on `main` as one squashed commit with the argument in its message.

## The duck

[askrubberduck](https://github.com/askrubberduck) builds tools in the voice of the duck you explain
your problem to. The duck does not judge, the duck does not repeat, the duck listens, and the duck
helps you think a little deeper until you find your own answer. eddy tries to be that: it refuses
loudly, once, with the reason and the remedy, and otherwise stays out of the way.

MIT.
