# Signals

eddy ships no signals entry point. Two public methods are the whole contract a signal library needs:
`scope.read(domain)` answers a domain's current state, and `scope.subscribe(listener)` says when some
state moved. The adapter below joins them for `@preact/signals-core`; any library with a writable
signal and a read-only derivation takes the same ten lines.

## The example on this page

A cart, a theme beside it, and one signal per domain.

```ts
import { computed, signal } from '@preact/signals-core'
import { createScope, defineDomain, reduce } from '@askrubberduck/eddy'
import type { DomainName, DomainType, Reduce, Scope } from '@askrubberduck/eddy'

export function domainSignal<TNames extends DomainName, D extends TNames>(scope: Scope<TNames>, domain: D) {
  const read = () => scope.read<D>(domain as never)
  const latest = signal(read())
  const stop = scope.subscribe(() => {
    latest.value = read()
  })
  return { state: computed(() => latest.value), stop }
}

type CartState = { lines: string[] }
type CartActions = { add: Reduce<{ sku: string }> }
type ThemeState = { dark: boolean }
type ThemeActions = { toggle: Reduce }

declare module '@askrubberduck/eddy' {
  interface Domains {
    cart: DomainType<CartState, CartActions>
    theme: DomainType<ThemeState, ThemeActions>
  }
}

const cart = defineDomain('cart', [], {
  state: { lines: [] },
  actions: { add: reduce((state, action) => ({ lines: [...state.lines, action.input.sku] })) },
})

const theme = defineDomain('theme', [], {
  state: { dark: false },
  actions: { toggle: reduce(state => ({ dark: !state.dark })) },
})

const scope = createScope({ name: 'app', domains: [cart, theme] })
const lines = domainSignal(scope, 'cart')
```

`state` is a `computed`, so a reader cannot write to it; the scope is the only writer. `domain as
never` hands the type to `D`: `read` refuses an instanced domain, and the refusal type is not
exported. The cast also lifts that refusal: given an instanced domain, `read` returns every
instance keyed by id, while the signal's type still says one state. Read one instance through its
handle from [Instances](Instances) instead.

## An effect over the signal

```ts
import { effect } from '@preact/signals-core'

const count = computed(() => lines.state.value.lines.length)
const dispose = effect(() => console.log(`${count.value} in the cart`)) // 0 in the cart

await scope.emit('cart.add', { sku: 'duck' }) // 1 in the cart
await scope.emit('theme.toggle') // nothing
```

`subscribe` fires after every commit that moved any domain, so the listener runs for the theme too.
It writes the same reference back: `read` keeps a domain's state while no fold moves it, as
[State](State) describes, and a signal ignores a write of the value it already holds. The adapter
needs no equality check of its own.

## Stopping

`stop` removes the listener. `scope.dispose()` clears every listener as well, so a signal created
next to its scope and dropped with it does not need `stop`. A signal made for one screen inside a
longer-lived scope does.

```ts
lines.stop()
dispose()
```

## Ask the duck

- Does the application already render through hooks? The [React](React) binding subscribes per
  component, with selectors and equality; a signal earns its place where a component reads
  `.value` and no hook runs.
- Does the signal live as long as the scope, or as long as a screen?
- Is one signal per domain enough, or does a `computed` over it say what the component reads?
