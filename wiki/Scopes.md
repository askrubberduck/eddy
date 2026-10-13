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
`instances(domain)` is the aggregate of an [instanced](Instances) domain, keyed by id; `read`
refuses an instanced domain at the type level, and `instances` throws on one that is not.

```ts
await live.emit('counter.bump', { by: 2 })

live.read('counter').value // 2
preview.read('counter').value // 40
live.getState() // { counter: { value: 2 } }
```

## Inspecting

`inspect()` answers what the scope is doing at this instant, and nothing in the library reads the
answer: how many jobs are queued (`queueDepth`), the address of every command handler still running
(`inFlight`), how many callers are still owed an outcome (`live`), and how many times the
[cascade guard](Actions) fired and what it last named. Addresses only, never inputs. A handler the
scope cancelled — superseded, or cut off by disposal — has no caller left, so `live` no longer
counts it, but it stays in `inFlight` until it returns, because a failure of its own is still
reported. It answers after disposal too, because that is when the question gets asked.

## Disposing

`dispose()` is one boundary, and after it nothing folds, resolves or publishes. Every queued action
is rejected with `CommandAborted`; every command in flight is cancelled with it, its signal aborted,
unless its outcome had already been decided before disposal interrupted the reactions to it, in
which case the caller still gets that outcome. Listeners are cleared, watcher teardowns run, and
the view caches are released.

The boundary holds inside an action too, by two rules. No callback the scope manages starts once it
is disposed — one declared on a domain (a reducer, stage, handler, view selector or transform,
watcher or effect) or registered with it (`onAction`, `subscribe`, `on`) — wherever the `dispose()`
came from. And a fold publishes only if the scope is still live when it commits, so a dispose from
inside the draft leaves the last committed state in place and the action is refused with
`CommandAborted`. Everything the host hears about a fold — the `folded` trace, subscribers,
watchers, effects, listeners — comes after it published, so a dispose from any of those leaves that
fold standing and its caller still hears it resolve, while nothing after the disposing callback
hears the action.

Outside the first rule: the logger and the reporter, because telling you about the disposal is their
job; watcher teardowns, because disposal is what runs them; and code the scope does not call on a
schedule of its own — a `useDomainValue` selector runs whenever React renders, and a trap on a
`Proxy` you put in state runs whenever something reads it. A disposed scope's `read` still answers,
so both keep working; neither can make a fold publish.

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

## Host code

Everything you hand a scope — a declaration's callbacks, `onAction`, a subscriber, a listener, the
logger and the reporter — is host code, and the scope contains whatever it does. A callback that
throws, a handler that rejects or returns a promise whose own `then` or `constructor` throws, a value
that is a `Proxy` with throwing traps, and a promise you were handed and then redefined: each is
the failure of that one call or that one caller, reported or rejected, and the scope goes on. Once a
fold has published, nothing host code does changes what its caller is told. Every obligation of
`dispose()` — refusing the queue, settling or cancelling each command and aborting its signal,
clearing listeners, running teardowns, releasing caches — completes on its own, whatever the others
throw.

Outside that boundary, by design:

- A platform built-in the host patches — `Promise`, `WeakSet`, `Object` and their prototypes. The
  library calls the platform and trusts it; it captures `Promise.prototype.then` at load only so that
  a promise's own `then` is never the one called.
- A rejected promise that host code returns, whose own `constructor`, `then` or
  `Symbol.toStringTag` throws, on the surfaces below. Its original rejection is left unobserved:
  state has committed and the caller's outcome is correct, and then the rejection escapes as a
  platform unhandled rejection, which under Node's default policy terminates the process.
  - A throwing `constructor`: from a subscriber, listener, `onAction`, watcher handler, teardown,
    reporter, logger or command handler. This one is a platform limit: native
    `Promise.prototype.then` reads `constructor` for the species before it installs any reaction,
    so it cannot be bypassed without leaving the platform's promise protocol. The same holds for the
    promise `emit` handed a caller, if the caller redefines its `constructor`: when the scope
    cancels that command, it cannot mark the rejection handled.
  - A throwing `Symbol.toStringTag`: from a subscriber, listener, `onAction`, watcher handler,
    teardown, reporter or logger. This one is eddy's choice: it recognises a promise returned from
    those callbacks by reading the tag, and a throw there ends the check. A command handler's
    result is not classified this way, and stays contained.
  - A throwing own `then`: from a logger, whose return value eddy reads `then` on, or a command
    handler, whose result it resolves into a promise of its own. From the six other reaction
    surfaces it stays contained, because eddy never calls a promise's own `then`.
- A handler that never settles. It stays in `inspect().inFlight`, and `settled()` times out on it.
- A result whose `then` answers differently each time it is read. The library reads it once when
  the handler's promise settles and the platform reads it again when the caller's does; what the
  caller is told then follows the value, not the fold.
- The `join` promise. Every joining caller shares the first caller's promise, so a caller that
  poisons it poisons it for all of them.
- Host code the scope does not call: a `useDomainValue` selector runs whenever React renders, and a
  trap on a `Proxy` in state runs whenever anything reads it.

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
