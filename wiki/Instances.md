# Instances

An instanced domain is declared once and held once per id, in the same scope as everything else. A
row's draft, a panel's local state, a per-connection buffer: each instance has the state the seed
gives it, folds its own actions, reads the same neighbours, and takes part in the same transactions.
It is the answer to "this state is private to one of many" that does not cost a second store.

## The example on this page

A draft per editable row, in the scope that also holds the rows.

```ts
import { cmd, createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'

type RowsState = { titles: Record<string, string> }
type RowsActions = { save: Cmd<{ id: string; title: string }, void> }

type DraftState = { title: string; dirty: boolean }
type DraftActions = { type: Reduce<{ title: string }>; commit: Cmd<{ id: string }, void> }

declare module '@askrubberduck/eddy' {
  interface Domains {
    rows: DomainType<RowsState, RowsActions>
    draft: DomainType<DraftState, DraftActions, {}, 'rows', true>
  }
}

const api = {
  async save(_row: { id: string; title: string }): Promise<void> {},
}

export const rows = defineDomain('rows', [], {
  state: { titles: { a: 'Alpha', b: 'Beta' } },
  actions: {
    save: cmd(async input => api.save(input), {
      done: (state, action) => ({ titles: { ...state.titles, [action.input.id]: action.input.title } }),
    }),
  },
})

export const draft = defineDomain('draft', ['rows'], {
  instanced: true,
  state: () => ({ title: '', dirty: false }),
  actions: {
    type: reduce((_state, action) => ({ title: action.input.title, dirty: true })),
    commit: cmd(
      async (input, ctx) => {
        await ctx.emit('rows.save', { id: input.id, title: ctx.state.title })
      },
      { done: { dirty: false } },
    ),
  },
})

export const scope = createScope({ domains: [rows, draft] })
```

## Declaring one

`instanced: true` on the declaration, and `true` as the fifth argument of `DomainType` in the
registry. The seed is the seed of one instance, so it is usually a factory. An instanced domain
declares actions, `on` wires and `effects` as any domain does; it cannot declare views or watchers,
because both derive from one readable state and an instance has one per id — derive in the reader,
or hold the derived value in a domain that is not instanced.

## Taking a handle

`scope.instance(domain, id)` returns a handle: `id`, `read()`, `emit`, and `dispose()`. The first
handle for an id seeds the instance; the last one to be disposed removes it. A handle is a lease, and
two holders naming the same id share the instance until both have let go. The handle's `emit`
carries the identity on the action, which is why an instanced address must be emitted from a handle:
`scope.emit` refuses one at the type level, and a fold that reaches an instanced domain with no
instance to land in refuses at runtime.

```ts
const a = scope.instance('draft', 'a')
await a.emit('draft.type', { title: 'Alpha, revised' })

a.read().dirty // true
scope.instances('draft') // { a: { title: 'Alpha, revised', dirty: true } }

a.dispose()
scope.instances('draft') // {}
```

`scope.instances(domain)` is the aggregate, keyed by id, and its values are `| undefined` because
any string is a key of a record and only the live ids are there. It moves when an instance arrives
or leaves, so a subscriber sees the population change; `preloadedState` for an instanced domain is
that same shape, one partial per id.

## Commands and identity

A command emitted from a handle folds its terminal stages into the instance it came from — that
instance, not whichever one wears the id when the handler settles. If the instance was disposed
while the command was in flight, or disposed and re-seeded under the same id, the fold is dropped and
reported once, and the caller's promise still settles with the handler's real outcome. `ctx.state`
inside such a command answers with that instance's state and keeps answering with the last committed
value after the instance is gone. `latest` supersedes and `join` shares per instance: two instances
calling the same address are two subjects.

A command that emits its own domain's actions through `ctx.emit` keeps the identity on them. An
emit into a neighbour, as `draft.commit` does into `rows.save`, is an ordinary emit into a domain that
is not instanced.

## What an instanced domain cannot fold

An instanced domain's `on` map cannot wire an action that carries no instance. A neighbour's plain
action names no id, the fold has nowhere to land, and it refuses — and because a fold is one
transaction, that refusal fails the neighbour's own action. The other direction is fine: a domain
that is not instanced may wire an instanced domain's action through `on`, and folds once for each,
because the action arrives with the identity on it. An `effects` entry on an instanced domain works
either way, because an effect folds nothing.

## A released handle

A handle that has been disposed addresses nothing. Its `read` throws and its `emit` rejects, even
while another holder keeps the instance alive, because a lease that was released cannot say
whether the instance it remembers is the one that lives under that id now. Take a new one.

## In React

`useDomainInstance` on the [React](React) page takes and releases the handle with the mount, and
gives a component an instance of its own or one it shares by id.

## Ask the duck

- Is the state private to a mount, or private to a user? A mount's belongs in an instance; a user's
  belongs in a domain keyed by user.
- Does the instance need to read a neighbour, or fold in the same transaction as one? That is what
  puts it in the scope rather than in a component's own `useState`.
- Who owns the id? If something outside React does, pass it to the hook; if nothing does, let the
  mount mint one.
