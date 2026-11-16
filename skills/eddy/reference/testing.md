# Testing

`@askrubberduck/eddy/testing`: a recording scope and two waits.

```ts
import { cmd, defineDomain, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'
import { createTestScope, flush, settled } from '@askrubberduck/eddy/testing'

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

## Rules

- Host the real domain in a scope. Stub the API behind its handlers. Do not mock the scope.
- Create a new scope in each test that needs isolation.
- Host a neighbour when the test needs its reactions.

## `createTestScope(options)`

It takes the `createScope` options. It adds three methods:

| Method           | Returns                                         |
| ---------------- | ----------------------------------------------- |
| `actions()`      | a copy of every dispatched action, stamped      |
| `actionTypes()`  | the address of each dispatched action, in order |
| `clearActions()` | nothing; it clears the record                   |

```ts
await scope.emit('upload.pick', { file: 'a.txt' })
await scope.emit('upload.start')

scope.actionTypes() // ['upload.pick', 'upload.start', 'upload.tick', 'upload.start.done']
scope.read('upload') // { files: [], progress: 1 }
```

- Assert on `actionTypes()` to test what happened. It includes actions that changed nothing.
- Assert on `read` to test the result.
- An `onAction` that you pass runs after the recorder.

## `settled(scope, { timeout }?)`

```ts
void scope.emit('upload.start')
await settled(scope)
```

- It waits until nothing is queued, no caller waits, and no handler runs.
- It throws after `timeout` (default 1000 ms) and names what is still open.
- Use it for an emit you did not await and for emits from reactions.

## `flush(times?)`

- It yields to the host `times` times (default 3), with one zero-delay timer each time.
- It does not wait for completion. Work that waits for a longer timer or for I/O can still run after it.
- Use it only for work that ends within a few host turns.
- For a longer effect, make it emit an action at the end. Then wait for that action, for example with `scope.on`.
- `settled` does not see an effect, because the scope does not track it.

## `resetVersion()`

- It resets the process-wide sequence counter, in development builds only.
- Use it when a test asserts on `__seq` values.
