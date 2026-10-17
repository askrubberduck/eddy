# Changelog

This file ships inside the published package, so a consumer reads what changed without opening the
repository.

Versions follow [semantic versioning](https://semver.org/) with the `0.x` caveat the README states:
**a minor release may break a public API until `1.0.0`.** That is what this document is for.

## 0.4.4 — 2026-10-17

The first published release of the 0.4.3 entry below. The `v0.4.3` tag was never published: its
README named `examples/shop`, which the package does not ship, and the release refused it.

## 0.4.3 — 2026-10-17

The README is rewritten: it opens on the problem, keeps one runnable program, and maps eddy's
concepts onto Redux Toolkit and Zustand. The code is unchanged from 0.4.2.

## 0.4.2 — 2026-10-17

Published to npm. Earlier versions went to GitHub Packages only; installing no longer needs a
registry line or a token. A project that added `@askrubberduck:registry=https://npm.pkg.github.com`
to an `.npmrc` keeps resolving the scope there and never sees this version: delete that line. The
code is unchanged from 0.4.1.

## 0.4.1 — 2026-10-13

The first published release of the changes below. The `v0.4.0` tag was never published: the
release gate's audit refused high advisories in development dependencies, fixed here in the lock
file alone.

### Changed

- Disposal is one boundary inside an action as well as between them. No callback starts once the
  scope is disposed, so an effect cannot act on a session the disposal ended; before, the rest of the
  action was delivered to a disposed scope. A dispose from inside a draft — a reducer, a selector, a
  transform — publishes nothing and refuses the action with `CommandAborted`; before, the draft
  published and the action resolved.
- `inspect().inFlight` names every command handler still running, one entry per handler, including
  one the scope cancelled that has not returned; `live` counts the callers still owed an outcome.
  The two were the same set before, so a superseded or disposal-cancelled handler vanished from
  both while it ran. `settled()` now waits for those handlers too, so a late failure of their own is
  reported inside the test that caused it rather than the next one.

- An `on` or `effects` wire to an address a hosted domain does not answer — the domain's own, or a
  hosted neighbour it does not declare in `uses` — fails `createScope`. Only a typo against a
  declared neighbour did before; the other two were dropped with an error line, though the domain
  was right there. A wire into a domain the scope does not host is still dropped and logged.

### Removed

- `DispatchedAction.__generation` is off the public type. It is the scope's own record of which
  instance of an id an action was made for, and nothing outside the scope can compare it to anything.

### Fixed

- Once a fold has published, nothing a reaction throws changes what its caller is told. A watcher
  that threw a value whose prototype trap throws — a revoked `Proxy` — escaped containment and
  rejected a reduce whose state had already committed.
- `dispose()` completes every obligation — cancelling commands and aborting their signals,
  clearing listeners, running teardowns, releasing caches — even when a teardown throws or a caller
  redefined the promise it was handed.
- A handler returning a promise whose own `then` throws fails that call. The throw escaped from
  `emit` and left the invocation running forever.
- Declared, not fixed: for a rejected promise host code returns whose own `constructor`, `then` or
  `Symbol.toStringTag` throws, eddy can leave the original rejection unobserved on the specific
  surfaces the Scopes page lists under "Host code". There it escapes as a platform unhandled
  rejection, which under Node's default policy terminates the process; state and the caller's
  outcome are correct up to then.

- `createTestScope` takes the options `createScope` takes. Its type had its own list, which left out
  `preloadedState`, though the option passed through at runtime.

- An effect on an instanced domain that hears one of its own instances' actions emits back into that
  instance. Its `ctx` carried no identity, so every emit into its own domain was refused, though the
  type admitted it.

- A fold dropped because its instance had gone is reported once per fold. Before, the report was
  deduplicated per id and the reset on re-seeding never matched, so after the first report every
  later instance under that id was stranded silently.
- A scope no longer keeps a record of every instance id it ever saw. `useDomainInstance` mints an id
  per mount, so a long-lived scope grew by about a hundred bytes per mount for its whole life.

## 0.3.0 — 2026-09-10

The first published release. Everything below is what the package contains, not a delta from a
version anyone could have installed — there is no earlier release to have broken. It is published to
GitHub Packages under the `@askrubberduck` scope, so installing it needs a registry line for that
scope and a GitHub token:

```
@askrubberduck:registry=https://npm.pkg.github.com
```

### Added

- `scope.on` accepts `'*'` and a list of addresses beside a single address. `'*'` observes every
  action whose fold completes, and its handler receives the union of every address — exported as
  `ActionIn<D>` — so a check on `action.type` still narrows to that address's exact payload. A list
  registers each member independently and returns one unsubscriber for all of them, validating every
  member before registering any.

  Whose fold _completes_, not whose fold _changes state_ and not merely _dispatched_, and the
  distinction is worth reading before attaching telemetry. A fold that commits nothing still fires
  `'*'`; a fold that throws fires nothing at all, on any descriptor — which has always been true of
  an exact address and is unchanged here. `'*'` sees every input, result and error that gets that
  far.

  `'*'` is the only subscription that keeps observing when a domain gains an action; a hand-written
  list silently misses it. Deliberately absent: no `'domain.*'` prefix, no predicate, and no
  descriptor on the declaration side. A predicate has no address, so nothing resolves it at
  construction — which is the one guarantee this library has that the alternatives do not.

- A `Date` is a supported state value. It is admitted at every ingress when it is a clean local
  `Date` — the `Date.prototype`, a time value, and not one own key of any class; a `Date` carrying
  a property, a `Date` from another realm, an object wearing `Date.prototype` without a time value,
  and a subclass are refused by name. Two Dates compare by their time value, invalid ones included,
  so an equal `Date` folds as a no-op and a view or a selector keeps its reference;
  `getWrittenState()` hands back a copy; `StateValue` includes `Date`.

  Two limits, stated: `JSON.stringify` turns a `Date` into a string, so persistence through JSON
  needs a reviver or a timestamp; and `Object.freeze` cannot stop `setTime`, so a development build
  cannot refuse a `Date` mutated in place — build a new one.

### Changed

- `react` is accepted as a peer dependency from 18 up to but excluding 20, widened from `>=18 <19`.
  The binding imports `createContext`, `createElement`, `useCallback`, `useContext`, `useEffect`,
  `useMemo`, `useRef` and `useSyncExternalStore` — all stable public API across both majors. The full test suite passes against `react@19.2.8`, and CI runs it against both lines.

  The upper bound is deliberate: the range promises only what CI actually runs. A future React major
  will need it widened again, after the suite is run against it.

### Removed

- `readServer`, the `serverRender` option and the server snapshot a hydrating scope retained. Both
  reference applications ship through Capacitor and React Native and render nothing on a server, and
  no consumer ever asked for the baseline. The React binding now hands `useSyncExternalStore` the
  live read as its server snapshot, which is what `readServer` already answered for every scope that
  had not declared `serverRender: 'hydrate'`. A server render still works — one scope per request
  through `ScopeProvider`, written state serialised and passed back as `preloadedState` — but a
  store that moves during the hydration pass is now a recoverable React mismatch rather than a pinned
  baseline, as it is for any external store.

### Packaging

- The package declares `sideEffects: false`, so a bundler may drop modules it does not use. The
  artifact is CommonJS, where exports resolve dynamically, so this permits dropping whole unused
  modules rather than individual unused exports. Moving to ECMAScript modules would lift that limit
  and is deliberately not done here.
