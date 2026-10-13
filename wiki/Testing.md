# Testing

A domain is tested by hosting it in a scope, emitting at it, and reading what folded. The
`@askrubberduck/eddy/testing` module adds the two things a test wants beyond that: a record of every
action the scope dispatched, and a way to wait for the scope to be done that asks the scope rather
than guessing turns.

```ts
import { createTestScope, flush, settled } from '@askrubberduck/eddy/testing'
```

## The example on this page

A domain whose command emits another action from its handler.

```ts
import { cmd, defineDomain, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'
import { createTestScope, settled } from '@askrubberduck/eddy/testing'

type UploadState = { files: string[]; progress: number }
type UploadActions = { pick: Reduce<{ file: string }>; start: Cmd<void, number>; tick: Reduce }

declare module '@askrubberduck/eddy' {
  interface Domains {
    upload: DomainType<UploadState, UploadActions>
  }
}

export const upload = defineDomain('upload', [], {
  state: { files: [], progress: 0 },
  actions: {
    pick: reduce((state, action) => ({ files: [...state.files, action.input.file] })),
    start: cmd(
      async (_input, ctx) => {
        for (const _file of ctx.state.files) {
          await ctx.emit('upload.tick')
        }
        return ctx.state.progress
      },
      { done: { files: [] } },
    ),
    tick: reduce(state => ({ progress: state.progress + 1 })),
  },
})

export const scope = createTestScope({ domains: [upload] })
```

## `createTestScope`

A scope with the same options as `createScope`, a generated name when none is given, and three
extra methods: `actions()` is every action dispatched so far, stamped, as a copy; `actionTypes()`
is their addresses; `clearActions()` forgets them. An `onAction` you pass is composed after the
recorder, so it sees the same actions.

```ts
await scope.emit('upload.pick', { file: 'a.txt' })
await scope.emit('upload.pick', { file: 'b.txt' })
await scope.emit('upload.start')

scope.actionTypes()
// ['upload.pick', 'upload.pick', 'upload.start', 'upload.tick', 'upload.tick', 'upload.start.done']
scope.read('upload') // { files: [], progress: 2 }
```

The record is the shape most tests assert against: which addresses fired, in what order, and with
what payload. It is cheaper than a subscriber and it does not miss the actions that changed nothing.

## `settled(scope, { timeout }?)`

Waits until the scope has nothing queued, no caller owed an outcome and no command handler
running — a cancelled handler that ignores its signal included, so its late failure is reported
inside the test that caused it. It reads `scope.inspect()` between host turns and throws after the
timeout — one second unless told otherwise — naming what was still outstanding. It is the wait for
a command you did not await, and for the commands a reaction emitted.

```ts
void scope.emit('upload.start')
await settled(scope)
```

## `flush(times?)`

Yields to the host a few times, three unless told otherwise. It is the wait for work the scope does
not track: an effect that awaited something, a handler's own timer. `settled` cannot see those,
because the scope does not own them.

## `resetVersion()`

Rewinds the process-wide sequence counter, in a development build only, for a test that asserts on
sequence numbers. A production build ignores it, because a reissued number would make `isStale`
call a stale outcome fresh.

## What a test does not need

A mock of the scope. A domain is a description and a scope runs it, so a test hosts the real domain
with a stubbed API behind its handlers and reads real state. Two tests that want isolation create two
scopes; a test that wants the effects of a neighbour hosts the neighbour. The `examples/shop`
directory in the repository is one such test, written as a script that asserts twelve contracts and
prints a line per contract that held.

## Ask the duck

- Is the assertion about state, or about what happened? `read` answers the first; `actionTypes`
  the second, and it is often the sharper one.
- Did the test wait for the scope, or for a number of turns that happens to be enough today?
  `settled` asks; a loop of `await Promise.resolve()` guesses.
- Does the test need a mock at all, or a real scope with a stubbed API?
