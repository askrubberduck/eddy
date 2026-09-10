# Changelog

This file ships inside the published package, so a consumer reads what changed without opening the
repository.

Versions follow [semantic versioning](https://semver.org/) with the `0.x` caveat the README states:
**a minor release may break a public API until `1.0.0`.** That is what this document is for.

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
