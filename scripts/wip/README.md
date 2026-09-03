# Not wired

`check-wiki-fences.mjs` compiles the TypeScript in `wiki/*.md`. It runs, and it is not in CI,
because it cannot currently pass.

## What was wrong with the script itself

Parked meant unmaintained, and it had rotted to unrunnable. Three bugs, all fixed, none of them
about the wiki:

- `root` resolved one directory short after the move here, so it looked for
  `scripts/scripts/wip/fences/prelude.ts` and died on `ENOENT` before compiling anything.
- the prelude imported `useLocalDomain`, which the library deleted. Every fence inherits the prelude, so
  **every fence failed** — 64 of 64, on a name the library no longer has.
- the prelude then imported `useDomainInstance` from `@askrubberduck/eddy/react`, where it does not
  live: it is returned by `createScopeHooks`, not exported by the module.

Fixing those three, plus adding `StateOf`, `ViewsOf`, `ActionsOf` and `UsesOf` to the prelude's type
imports, moved the count from **64 of 64 failing to 48 of 64** without touching a single fence.

## Why it still cannot pass

The obstacle is measured, not guessed. The wiki is written as fragments around one running example —
a cart and a session — and a fragment is what a reader copies. The prelude supplies the context those
fragments assume. Measured both ways, today:

| Prelude | Fences failing |
| ------- | -------------- |
| present | 48 of 64       |
| empty   | 61 of 64       |

So the shared context is worth 13 fences and cannot be dropped, and it is also what breaks the
fences that declare `CartState`/`CartActions` or a `scope` of their own — those fail on
`TS2300 Duplicate identifier`, `TS2395 merged declaration` and `TS2451 Cannot redeclare`, which are
collisions with the prelude rather than defects in the wiki. Making this pass needs per-fence context
selection, and that is a change to how the wiki is written rather than a script.

## What the residue is, since the number invites the wrong conclusion

The 48 were read through. They fall into three groups, and **none of the ones sampled is a defect in
the documentation**:

- collisions with the prelude, as above;
- deliberate fragments — `TS2304 Cannot find name 'report' / 'App' / 'payload' / 'domain'` — where
  the fence names something the surrounding prose supplies;
- object-literal fragments (`views: {`, a bare `done:` stage) that parse as `TS1109 Expression
expected` because they are not programs and no context makes them one.

Two that looked like real API drift were checked and are not. `Testing.md:22-24` calls
`actionTypes`, `actions` and `clearActions`, which do exist — on `createTestScope`'s return, and the
fence's `scope` collides with the prelude's, so it resolves to the plain `Scope` type instead.
`Domains.md:9`, which an earlier review reported as "the first fence on Domains does not
compile", fails on `Duplicate identifier`.

That matters for how the earlier count is read: **"13 of 60 fences do not compile" describes this
harness at least as much as it describes the wiki.** Do not carry it forward as a claim about the
documentation without re-measuring under a harness that gives each fence the right context.

Run it by hand:

    node scripts/wip/check-wiki-fences.mjs
