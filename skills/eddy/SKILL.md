---
name: eddy
description: Use for any work in a codebase that uses @askrubberduck/eddy. Covers domains, reducers, commands, views, reactions, watchers, scopes, instanced domains, the React hooks, tests with /testing, the logger and the error reporter. Also use it to find why an emit rejects, a view does not move, or a reaction does not run. Gives the model and the rules, then routes to one reference file per topic.
---

# eddy

eddy is a state manager with six terms. Use these terms and no synonyms.

| Term        | Meaning                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| **domain**  | A named part of state with its actions, views and declared neighbours. `defineDomain` makes it.  |
| **action**  | A thing that occurs at an address. A `reduce` folds at once. A `cmd` folds, then runs a handler. |
| **address** | `domain.action`. A command also has `domain.action.done` and `domain.action.failed`.             |
| **fold**    | One action applied to every domain that answers it, as one transaction.                          |
| **view**    | A value derived from one domain, memoised on its input, and read as a field.                     |
| **scope**   | An object that hosts domains and holds their state. Two scopes share nothing.                    |

## What this is not

- Not redux and not zustand. There is no store, no middleware, no `dispatch`, no action creators.
- Not immer. A reducer returns a partial object. Do not mutate state.
- Not extensible. Nothing plugs in. There is no plugin and no runtime registration of domains.
- Not for a `Map`, a `Set`, a class instance or a function in state. State is plain data.
- Not an ECMAScript module build. The package is CommonJS with `sideEffects: false`.

## A domain

```ts
import { cmd, createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'

type SessionState = { userId: string | null; signingIn: boolean }
type SessionActions = { signIn: Cmd<{ email: string }, { id: string }>; signOut: Reduce }

type ProfileState = { name: string }
type ProfileActions = { rename: Reduce<{ name: string }>; load: Cmd<void, string> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    session: DomainType<SessionState, SessionActions>
    profile: DomainType<ProfileState, ProfileActions, {}, 'session'>
  }
}

const auth = {
  async signIn(email: string): Promise<{ id: string }> {
    return { id: `usr-${email.split('@')[0]}` }
  },
}

export const session = defineDomain('session', [], {
  state: { userId: null, signingIn: false },
  actions: {
    signIn: cmd(async input => auth.signIn(input.email), {
      called: { signingIn: true },
      done: (_state, action) => ({ userId: action.result.id }),
      finally: { signingIn: false },
    }),
    signOut: reduce({ userId: null }),
  },
})

export const profile = defineDomain('profile', ['session'], {
  state: { name: '' },
  actions: {
    rename: reduce((_state, action) => ({ name: action.input.name })),
    load: cmd(async (_input, ctx) => ctx.read('session').userId ?? 'nobody'),
  },
  on: {
    'session.signOut': reduce({ name: '' }),
  },
})

export const scope = createScope({ domains: [session, profile] })
```

## The rules

**Register every domain in the `Domains` interface.** `DomainType<State, Actions, Views?, Uses?, Instanced?>`
types every address. `defineDomain` must then match its actions key by key. A wrong kind or a missing action is a compile error.
A missing view is not: it compiles and reads as `undefined`. Declare every view the type names.

**Declare neighbours in `uses`.** The second argument of `defineDomain` lists them. Repeat the list
as the fourth argument of `DomainType`. The types then refuse a read, an emit or a wire past the list.
At runtime, an emit into an unlisted domain rejects. An unlisted read answers and logs on the error channel.

**A reducer returns a partial, a function result, or nothing.** The scope merges the partial over
the written state. An equal result folds nothing. `reduce({})` makes an action that only signals.

**`emit` never throws.** It always returns a promise. Every failure is a rejection, so one `.catch` covers all.
Catch the rejection of an unawaited emit. `void` alone does not handle it.

**The emit promise settles after the fold commits.** All synchronous reactions have run by then.
An effect that awaits is not included, and no eddy call waits for it.
To wait for it, make the effect emit an action at the end.

**A command has four stages.** `called` folds before the handler. `done` and `failed` fold after it.
`finally` folds after `done` or `failed`, in the same fold. Each stage is a partial or a reducer.

**Use `on` to fold another domain's action into this domain.** It folds in the same transaction.
Use `effects` to emit after a fold. Use `watch` to react when a value changes.

**Do not write a view key.** A reducer, a seed or a preload that writes a view key is refused.

**Keep state as plain data.** Development builds check and freeze it. Production builds do not check.

**A domain never imports another domain.** It names addresses as strings. The registry types them.

## Types to name

| For                                     | Type                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| a command and a reducer in the registry | `Cmd<Input, Result>`, `Reduce<Input>` (both default to `void`) |
| one registry entry                      | `DomainType`                                                   |
| the registry                            | `Domains` (augment it), `DomainName`                           |
| state, views, both                      | `StateOf<D>`, `ViewsOf<D>`, `Readable<D>`                      |
| a value state may hold                  | `StateValue`                                                   |
| a command context, an effect context    | `Ctx<Self, Reach>`, `EffectCtx<Reach>`                         |
| a scope, its options, `inspect()`       | `Scope<Names>`, `ScopeOptions`, `ScopeReport`                  |
| an action from `'*'`, from `onAction`   | `ActionIn<Names>`, `DispatchedAction`                          |
| a logger, an action given to a reporter | `Logger`, `ReportedAction`                                     |
| a watcher teardown                      | `Teardown`                                                     |

`/react` adds `ScopeHooks`. `/testing` adds `TestScope`.

## Where to go next

Read only the file for your task.

| Task                                                                                                      | Read                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| reducers, commands, stages, `ctx`, `latest`, `join`, `isStale`, `CommandAborted`, `CascadeAborted`        | [reference/actions.md](reference/actions.md)     |
| views, what state may hold, equality, `getWrittenState`, `preloadedState`                                 | [reference/state.md](reference/state.md)         |
| `on`, `effects`, `watch`, `scope.on`, `subscribe`, the order they run in                                  | [reference/reactions.md](reference/reactions.md) |
| `createScope`, reading, `inspect`, `dispose`, instanced domains, logger, reporter                         | [reference/scope.md](reference/scope.md)         |
| `createScopeHooks`, `useDomain`, `useDomainValue`, `useDomainInstance`, server rendering, Preact, signals | [reference/react.md](reference/react.md)         |
| `createTestScope`, `settled`, `flush`, `resetVersion`                                                     | [reference/testing.md](reference/testing.md)     |
