# Scopes

A scope hosts a set of domains and holds their state. It is an object the application creates and
keeps, not a global: two scopes over the same definitions start from two copies of the seed, dispatch
independently, and can be disposed independently. Everything that reads, emits or listens does so
through a scope.

## The example on this page

A counter hosted twice.

```ts
import { createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { DomainType, Reduce } from '@askrubberduck/eddy'

type CounterState = { value: number }
type CounterActions = { bump: Reduce<{ by: number }> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    counter: DomainType<CounterState, CounterActions>
  }
}

export const counter = defineDomain('counter', [], {
  state: { value: 0 },
  actions: {
    bump: reduce((state, action) => ({ value: state.value + action.input.by })),
  },
})

export const live = createScope({ name: 'live', domains: [counter] })
export const preview = createScope({ name: 'preview', domains: [counter], preloadedState: { counter: { value: 40 } } })
```

## Creating one

`createScope` takes the domains to host and, optionally, a `name`, a `preloadedState`, an
`onAction` tap, and three diagnostics settings. Construction is where everything that can be
decided early is decided: each definition is read once into the scope's own records, so a
definition mutated afterwards changes nothing here; seeds and preloaded state are accepted or
refused; every neighbour named in `uses` must be hosted; every `on` and `effects` wire is resolved,
dropped, or refused as the [Domains](Domains) page describes; and every view and watcher is
evaluated once so a cycle or a throwing source fails now, with the scope's name on it, rather than
on the first emit.

The type of the scope is `Scope<'counter'>`, the union of the names it hosts, and every address it
accepts is typed by that union.

The name is a label for diagnostics. Two scopes may share it.

## Reading

`read(domain)` returns that domain's state with its views, as one frozen object in development, and
it is the same reference until the domain moves. `getState()` returns every domain keyed by name and
is likewise stable until something moves. `getWrittenState()` returns the written fields only,
cloned, in the shape `preloadedState` accepts back — the [State](State) page covers persistence.
`instances(domain)` is the aggregate of an [instanced](Instances) domain, keyed by id, and `read`
refuses one at the type level.

```ts
await live.emit('counter.bump', { by: 2 })

live.read('counter').value // 2
preview.read('counter').value // 40
live.getState() // { counter: { value: 2 } }
```

## Inspecting

`inspect()` answers what the scope is doing at this instant, and nothing in the library reads the
answer: how many jobs are queued, which command addresses have handlers that have not settled, how
many invocations the scope still owns, and how many times the [cascade guard](Actions) fired and
what it last named. Addresses only, never inputs. It answers after disposal too, because that is
when the question gets asked.

## Disposing

`dispose()` is one boundary, and after it nothing folds, resolves or publishes. Every queued action
is rejected with `CommandAborted`; every command in flight is cancelled with it, its signal aborted,
unless its outcome had already been decided before disposal interrupted the reactions to it, in
which case the caller still gets that outcome. Listeners are cleared, watcher teardowns run, and
the view caches are released.

What a disposed scope answers is decided by what the caller survives. `read` still answers, with
the last committed state, because a component that renders once more after unmount is not a crash.
`getState` and `getWrittenState` throw. `emit` rejects. `on` and `subscribe` still validate their
address and then return an unsubscribe that does nothing, and say so on the error channel, because
React subscribes from a passive effect that may run against a scope StrictMode has already
replaced. `instance` throws. Disposing twice does nothing the second time.

```ts
preview.dispose()

preview.read('counter').value // 40, still
await preview.emit('counter.bump', { by: 1 }).catch(error => error.name) // 'CommandAborted'
```

## Settings

`logger`, `logLevel` and `onUnhandledError` are the three settings and they belong to the scope: two
scopes with different levels do not hear each other. They are validated whole before the scope
exists — a logger missing one of `debug`, `info` and `error`, an unknown level, or a reporter that
is not a function fails construction — and a field passed as `undefined` counts as not passed. What
each hears is the [Diagnostics](Diagnostics) page.

## `onAction`

An `onAction` tap sees every action the scope dispatches, stamped and in order, before its fold. It
receives a copy: it cannot rewrite the action, and a tap that throws is reported and the fold
proceeds. It is the hook the [testing](Testing) module records through; for reacting after the fold,
`scope.on('*')` is the [reaction](Reactions).

## Ask the duck

- Does a part of the application need its own copy of the state — a preview, a wizard, a request on
  a server? That is a scope, and it is disposed when the part is.
- Does the application need exactly one? Then create one at the top and pass it down. A module-level
  scope is fine until the first test wants a fresh one.
- Is something outside the scope holding a reference to state it read? It holds a frozen snapshot,
  and nothing will update it.
