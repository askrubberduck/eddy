## Validation

Treat source code and tests as authoritative. Prefer the narrowest quiet validation that proves the
changed behaviour, and preserve complete failure output.

## History

**`main` is linear, and a branch lands as exactly one squashed commit, through a pull request.**

Open a pull request and merge it with GitHub's squash merge. The PR title becomes the commit subject
and the PR body becomes the commit body, so the body carries the full argued message. Before this
was enforced, two things happened here and both had to be force-pushed away: `git merge --no-ff`,
which put a merge commit on `main`, and a rebase that preserved the branch's own commits, which
landed one packet as four — three of them only correcting the one before.

A branch's internal history is scaffolding. The failed rounds, the fixups and the verifier's
corrections are working notes; what belongs on `main` is the change and the argument for it.

The repository ruleset `main` enforces this: no direct push, no force push and no deletion; squash
is the only merge method; history stays linear; and `test (20)`, `test (22)`, `no-internal-refs` and
`release-gate / gate` must pass on a head that is up to date with `main`. CI runs on pull requests,
not on branch pushes. An organization admin can bypass the requirements only by merging a pull
request, never by pushing.

`release.yml` triggers on tags rather than pushes, so no merge to `main` can publish. Rewriting
`main` is now a deliberate act: the ruleset has to be disabled first, the repository is public, so a
rewrite reaches every clone and never touches a commit a release tag points at. Tag the pre-rewrite
commit first, prove the tree is unchanged (`git diff <backup> main` empty) before pushing, and
re-enable the ruleset after.
