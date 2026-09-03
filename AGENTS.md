## Validation

Treat source code and tests as authoritative. Prefer the narrowest quiet validation that proves the
changed behaviour, and preserve complete failure output.

## History

**`main` is linear, and a branch lands as exactly one squashed commit.**

Squash the branch, write the full argued message on that single commit, then fast-forward. Two
things this forbids, both of which have happened here and both of which had to be force-pushed away:
`git merge --no-ff`, which puts a merge commit on `main`, and a rebase that preserves the branch's
own commits, which landed one packet as four — three of them only correcting the one before.

A branch's internal history is scaffolding. The failed rounds, the fixups and the verifier's
corrections are working notes; what belongs on `main` is the change and the argument for it.

No config enforces this. `merge.ff = only` is set locally, but an explicit `--no-ff` on the command
line overrides it and it says nothing about squashing, so this paragraph is the whole mechanism.

Rewriting `main` is permitted here and has been done deliberately: it has one committer, `main` is
unprotected, and `release.yml` triggers on tags rather than pushes, so no push to `main` can
publish. That makes history cheap to correct — it does not make a force-push routine, and the
repository is public, so a rewrite reaches every clone and never touches a commit a release tag
points at. Tag the pre-rewrite commit first, and prove the tree is unchanged
(`git diff <backup> main` empty) before pushing.
