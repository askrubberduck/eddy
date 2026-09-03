# Design

The positions this library holds, so a reader can predict what it will do before reading the code,
and a list of what it will not build, so nobody waits for it.

## A kernel, not a platform

eddy is an application-internal kernel. Nothing third-party plugs into it: there is no middleware,
no plugin, no scope registry, no runtime registration of domains, and no injection point. A devtools
bridge or a cross-tab replicator, if ever built, is built in the tree with full access rather than
negotiated through a public seam. `inspect()` is a window, not a lever — it reports and accepts
nothing. Every absence in that list is a choice.

## The invariants

1. **A fold is atomic, within one scope.** A dispatch publishes all of its drafts or none. The
   qualifier is real: a fold that emits into a second scope and then throws leaves the first rolled
   back and the second's commit standing.
2. **`emit` rejects; it never throws.** Declaring a domain and creating a scope are the two places
   that throw, because no promise exists yet.
3. **Development refuses, production trusts.** A development build walks and freezes every value
   that enters state; a production build does neither, and no hot-path scan exists to make a page
   true. The one production walk is the `__proto__` scan of `preloadedState`, the one ingress meant
   for data from outside.
4. **A refusal is observable**, and its channel is decided by what the caller survives: a rejected
   promise, a throw, or a no-op registration plus a diagnostic. Never strict mode alone, never
   `Object.freeze` alone, which a sloppy-mode host defeats silently.
5. **The specification is the product.** Behaviour and its page move in the same commit.

## What the runtime trusts you with

`uses` is a contract, not authorization: same-realm code holding the scope reaches everything it
hosts, so the runtime makes a violation visible rather than pretending it cannot happen. The
`AbortSignal` a command receives is an offer, not an enforcement: a handler that ignores it runs to
completion and has its outcome dropped. Production state is not frozen, so a reducer that mutates
what it was handed will get away with it, and the contract says so rather than pretending.

## What is not built, on purpose

Batching. Keyed supersession beyond `latest` per address and per instance. Attaching a domain to a
running scope. A post-commit observation seam other than `subscribe` and `on`. Per-domain error
handlers. An adapter for external streams — a scope is an object the application holds, and a
socket that emits into it is four lines the application writes. A cascade budget that survives an
`await`. A `'domain.*'` prefix or a predicate on `on`, because a predicate has no address and
nothing could resolve it when the scope is built. An ECMAScript module build; the artifact is
CommonJS with `sideEffects: false`, so a bundler drops unused modules and not unused exports.

Each of these was argued and cut, and the argument is the same: a state manager grows surface for a
consumer that exists and has asked, not for one nobody has described.

## Where things live

| File                                 | Owns                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `domain.ts#defineDomain`             | The declaration shape and its refusals, at authoring time. Runs nothing.               |
| `hosting.ts#hostDomains`             | Reading definitions into a scope once: seeds, preload, neighbours, wires, first state. |
| `scope.ts#createScope`               | The queue, the transaction, dispatch, observation, instances and disposal.             |
| `views.ts#resolveViews`              | Deriving values from one domain's written state, and the lens a selector sees.         |
| `internal/state-value.ts#checkState` | What a value may be, and the development refusal and freeze.                           |
| `internal/equal.ts#isEqual`          | Whether two supported values differ. It validates nothing.                             |
| `internal/version.ts#isStale`        | The process-wide sequence counter and the one comparison built on it.                  |
| `config.ts#validate`                 | The settings record and the containment of host callbacks.                             |
| `react.ts#createScopeHooks`          | Binding a scope to React's render lifecycle. No domain logic.                          |
| `testing.ts#createTestScope`         | The recorder and the two waits.                                                        |

## Ask the duck

- Is the feature you are about to add a thing the scope needs, or a thing one consumer needs once?
  The second is four lines in the consumer.
- Would deleting it end the problem? The duck asks this of every line, its own included.
