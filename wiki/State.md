# State

State is data: primitives, plain objects, arrays and Dates, nested as deep as you like and nothing
else. That one rule is what lets a development build freeze everything, lets equality decide
whether a fold changed anything, and lets written state leave the process and come back. Where the
rule is enforced depends on the build: development refuses, production trusts.

## The example on this page

A domain whose seed carries every kind of value state may hold.

```ts
import { createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { DomainType, Reduce } from '@askrubberduck/eddy'

type Note = { text: string; tags: readonly string[]; pinned: boolean; at: Date }
type NotesState = { notes: Note[]; cursor: number | null; quota: bigint }
type NotesActions = { add: Reduce<Note>; pin: Reduce<{ index: number }> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    notes: DomainType<NotesState, NotesActions>
  }
}

export const notes = defineDomain('notes', [], {
  state: () => ({ notes: [], cursor: null, quota: 100n }),
  actions: {
    add: reduce((state, action) => ({ notes: [...state.notes, action.input] })),
    pin: reduce((state, action) => ({
      notes: state.notes.map((note, index) => (index === action.input.index ? { ...note, pinned: true } : note)),
    })),
  },
})

export const scope = createScope({ domains: [notes] })
```

## What state may hold

`StateValue` is the type: `undefined`, `null`, a boolean, a number, a string, a bigint, a `Date`, an
array of state values, or a plain object of them. A `Date` is admitted when it is a clean local one —
`Date.prototype`, a time value, and not one own property — and two Dates are compared by their time,
invalid ones included.

Refused, by name, with the thing to carry instead: a `Map` and a `Set` (carry an array of entries), a
`RegExp` (carry its source), an `Error` (carry a message and a code), a class instance, a
null-prototype object, a function, a symbol as a key or a value, a typed array, an accessor
property, a non-enumerable property, and an array, object or `Date` from another realm. A `Date`
with a property of its own, or a subclass of `Date`, is refused too, because equality is about to
trust the time value and must not silently ignore anything beside it.

A `__proto__` key is refused as a field name in every build, because the scope carries fields out to
readers as own properties, and a reader copying one back with a bracket assignment would reach the
prototype instead of the object.

## Development refuses, production trusts

A build is development unless `process.env.NODE_ENV` is `'production'`; a runtime with no `process`
at all, such as a script tag in a browser, is production too and pays nothing. The check is written
so a bundler that replaces `process.env.NODE_ENV` erases the development branch.

In development every ingress is walked and refused if it breaks the rule — the seed, the preloaded
state, what a stage returns, a view's input and its value, a watcher's value — and everything the
scope publishes is frozen to the leaves, so a nested write throws instead of silently defeating
change detection. The exception the freeze cannot make is `Date.prototype.setTime`, which mutates an
internal slot; build a new `Date` instead.

In production there is no walk and no freeze. A stage that returns something other than a plain
object is still refused, a stage that writes a view key is still refused, and the preloaded state is
still scanned to its leaves for a `__proto__` key, because that is the one ingress meant for data
from outside the process. Everything else is trusted: a reducer that mutates the state it was handed
keeps the mutation even when the action rejects, and nothing notices. The contract is stated so
that a hot-path scan does not have to make it true.

## Equality, and what counts as a change

Equality is structural and deep: two objects with the same keys and equal values are equal, two
arrays likewise, `NaN` equals `NaN`, and a `Date` equals a `Date` with the same time. A stage whose
output is equal to what is written folds nothing. A field that one stage moved and a later stage put
back has not moved. A key that arrives holding `undefined` where none existed has moved, because
presence is part of the shape.

The consequence is reference stability at every level. A domain that did not move keeps its state
object, so a component subscribed to it does not render; a view whose input held still keeps its
value; the object `getState()` returns is replaced only when some domain moved.

## Persistence

`getWrittenState()` hands back the written fields of every domain, cloned, with no view keys, and
`preloadedState` accepts that shape back:

```ts
const saved = scope.getWrittenState()

const restored = createScope({ domains: [notes], preloadedState: saved })
restored.read('notes').quota // 100n
```

A preloaded domain is a partial: the fields it names are merged over the seed, and the rest come
from the seed. Views are recomputed from what arrived, and a payload that names a view key, that is
not a plain object, or that names a domain the scope does not host is refused, refused, and logged
and ignored, respectively.

`JSON.stringify` is the application's choice and has two consequences: a `bigint` throws, and a
`Date` becomes a string, so a reviver or a timestamp field is needed on the way back. `getState()`
includes views and is for reading, not for saving.

## Ask the duck

- Is it data, or is it a handle — a socket, a cache, an element? A handle is held by the module that
  opened it, and state holds the id.
- Would a copy of it be as good as the original? If not, it is not a state value, whatever its
  type says.
- Is a `Date` doing the work of a number? A timestamp survives JSON; a `Date` survives the freeze
  only if nothing calls `setTime` on it.
