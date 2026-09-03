# Domains

A domain is a named slice of state with its own actions, its own views, and a declared list of the
neighbours it may reach. It is declared once with `defineDomain` and hosted by any number of scopes,
each of which starts it from its own copy of the seed. A domain never imports another domain; it
names addresses, and the registry types them.

## The example on this page

A session that signs in, and a profile that empties itself when the session signs out.

```ts
import { cmd, defineDomain, reduce } from '@askrubberduck/eddy'
import type { Cmd, DomainType, Reduce } from '@askrubberduck/eddy'

type SessionState = { userId: string | null; signingIn: boolean }
type SessionActions = {
  signIn: Cmd<{ email: string }, { id: string }>
  signOut: Reduce
}

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
```

## The registry

Every address in eddy is a string, and the strings are typed because the application registers its
domains once, at the type level, by augmenting the `Domains` interface. `DomainType` takes the state,
the actions, and optionally the views, the neighbours, and whether the domain is
[instanced](Instances):

```ts
type CartState = { lines: string[] }
type CartActions = {}
type CartViews = { count: number }

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions, CartViews, 'session', false>
  }
}
```

An action is `Cmd<Input, Result>` or `Reduce<Input>`; both inputs default to `void`, and an action
whose input is `void` is emitted with no second argument. Views are read as fields, so `Readable<D>`
is the state and the views of `D` flattened into one read-only shape. With nothing registered the
name type becomes an error message that says what to write, so the first compile error a new
project meets is the instruction.

The registry is the one thing eddy asks you to keep in sync by hand: the type says `signIn` is a
command, and `defineDomain` demands a `cmd()` under that key. A missing key, a wrong kind, or a
result that does not match is a compile error at the declaration, not a runtime surprise at the
first emit.

## The seed

`state` is the first value of the domain, as a plain object or as a function that builds one. A
value seed is copied for every scope; a factory is called for every scope and must build a fresh
object each time, because a factory that returns the same root twice would hand two scopes one
state, and a development build refuses it by name. What the seed may contain is the
[State](State) contract.

## `uses`: what a domain may reach

The second argument names the neighbours this domain may read from, emit into, fold from through
`on`, and react to through `effects`. It types four things: `ctx.read` and `ctx.emit` inside a
command, the addresses `on` and `effects` may be keyed by, and the `read` a watcher's source
receives. A domain reaching past its list does not compile:

<!-- fence: expect-error -->

```ts
defineDomain('profile', ['session'], {
  state: { name: '' },
  actions: {
    rename: reduce((_state, action) => ({ name: action.input.name })),
    load: cmd(async (_input, ctx) => ctx.read('cart').lines.join(', ')),
  },
})
```

At runtime the list is a contract, not a wall. Same-realm code holding the scope can reach every
domain it hosts, so what the runtime does is make a violation visible rather than pretend it cannot
happen: an `emit` into an undeclared domain rejects; a `read` of one answers, because a typed read
has no refusal that is not a lie; both are reported on the error channel, once per neighbour; a
neighbour named in `uses` that the scope does not host fails `createScope` outright, in whatever
order the domains were listed. Two domains may name each other. Nothing is sorted.

The `on` and `effects` maps are not checked against `uses`. A wire to an action a _declared_
neighbour does not have is a typo about something you believe exists, and `createScope` throws.
A wire into a domain the scope does not host at all may be a blueprint hosted in a smaller scope,
so it is dropped, logged on the error channel, and the scope builds.

## What a declaration refuses

`defineDomain` reads the declaration once and refuses, with the reason, anything the runtime would
store and never reach. A domain or action name must be a plain identifier, because it is a segment
of an address; `__proto__` is refused everywhere a name can go. A key declared both as an action
and as a view is refused. A symbol key, a non-enumerable property, or an entry inherited from a
prototype in any of the five maps is refused, because every lookup reads own enumerable string
keys. `latest` beside `join`, and `latest` beside a `finally` stage, are refused for reasons the
[Actions](Actions) page gives. Everything a scope hosts goes through the same checks again, so a
definition built by hand is held to the same rules.

## Ask the duck

- Would these two slices ever need to live in different scopes, or be preloaded separately? Then
  they are two domains, whatever they have in common.
- Does one domain need to read another's field to decide anything? Put the neighbour in `uses` and
  let the compiler tell you the next time you forget.
- Is a domain reaching into four neighbours? The duck will not say that is wrong. It will ask what
  the domain is for.
