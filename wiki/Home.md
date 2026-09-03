# Home

eddy is a domain-sliced state manager for TypeScript. An application declares domains, hosts them in
a scope, emits actions at addresses, and reads state that already contains its derived values. Every
asynchronous operation is a command whose stages fold as ordinary actions, so the rest of the scope
never learns that anything was asynchronous. There are no runtime dependencies and nothing plugs in.

This wiki is the specification. Behaviour and its page move in the same commit, and each page owns
one contract and does not restate the others. Where a choice is yours, the page ends by asking the
question rather than answering it. That is the duck's job: it does not judge, it does not repeat, it
listens, and it leaves you a little further along in your own thinking.

## Six words

| Word        | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| **domain**  | A named slice of state with its own actions, views and declared neighbours. `defineDomain` makes one.        |
| **action**  | A thing that happens at an address. A `reduce` folds synchronously; a `cmd` runs a handler first.            |
| **address** | `domain.action`, and for a command also `domain.action.done` and `domain.action.failed`.                     |
| **fold**    | One action drafted into every domain that answers to it, committed as one transaction or not at all.         |
| **view**    | A derived value declared on a domain, memoised on its input, and read beside the fields it derives from.     |
| **scope**   | An object that hosts a set of domains and holds their state. Two scopes over the same domains share nothing. |

## Reading order

1. [Domains](Domains) — declaring one, typing it, and naming what it may reach.
2. [Actions](Actions) — reducers, commands, stages, `latest` and `join`, and what `emit` promises.
3. [Views](Views) — derived values that live in state.
4. [State](State) — what state may hold, how equality is decided, and how state is persisted.
5. [Reactions](Reactions) — `on`, `subscribe`, `effects` and `watch`, and the order they run in.
6. [Scopes](Scopes) — creating, reading, inspecting and disposing one.
7. [Instances](Instances) — one domain, many ids, one transaction.
8. [React](React) — the hooks, the provider, and server rendering.
9. [Testing](Testing) — recording actions and waiting for a scope to settle.
10. [Diagnostics](Diagnostics) — the logger, the error reporter, and what never reaches either.
11. [Design](Design) — the positions the library holds, and what it refuses to build.

## Conventions on these pages

Each page opens with its own small example and every later block on the page builds on it, so the
first block is the one to copy. A name written as
`scope.ts#createScope` is a symbol in the source under `src/`, and the repository checks that every
one of them still exists.
