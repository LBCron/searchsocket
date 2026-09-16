---
name: release
description: "Cut and publish a SearchSocket release to NPM following Git Flow. Bumps the version, writes the CHANGELOG entry, runs the full validation gate, merges the release branch into both main and develop, and pushes the v* tag that triggers the Trusted Publishing workflow. Also handles hotfix releases branched from main. Use when the user asks to release, cut a release, publish to NPM, ship a version, or tag a new version."
argument-hint: "[patch|minor|major|X.Y.Z] (optional — auto-detected from commits if omitted; add 'hotfix' to branch from main)"
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(pnpm:*)
  - Bash(npm:*)
  - Bash(node:*)
  - Bash(head:*)
  - Bash(sed:*)
  - Bash(grep:*)
  - Read
  - Edit
  - Write
---

# Releasing SearchSocket

Publishing is fully automated: pushing a `v*` tag to GitHub triggers
`.github/workflows/publish.yml`, which typechecks, builds, tests, and runs
`pnpm publish --provenance --access public` using NPM Trusted Publishing (OIDC).
**There is no NPM token anywhere** — nothing to configure, but also nothing to
fall back on if the workflow itself breaks.

The workflow picks the npm dist-tag from the tag itself: a version containing a
hyphen (`1.0.0-rc.1`) publishes to **`next`**, everything else to **`latest`**.
So a prerelease tag is safe to push — it cannot take `latest` away from the
stable release — and installing one is `npm install searchsocket@next`.

Your job is everything that happens before that tag exists, and verifying what
happens after.

## Non-negotiables

- **Never commit directly to `main`.** It only ever receives `--no-ff` merges
  from `release/*` or `hotfix/*`, plus the tag.
- **The tag lives on `main`**, created after the merge, never on `develop` or on
  the release branch.
- **A published version is permanent.** NPM refuses to republish a version
  number, even after `npm unpublish`. If a release is bad, the fix is always the
  *next* patch version, never a re-tag.
- **Push the tag last.** `git push origin main` alone publishes nothing; the tag
  push is the trigger. Push main first so the tagged commit is already reachable.
- **Attribution**: commit messages and release notes never mention Claude, AI,
  or generated content.

## Step 1 — Preflight

```bash
pwd
git status --porcelain          # must be empty
git branch --show-current       # must be develop (or main for a hotfix)
git fetch origin
git log --oneline origin/develop..develop   # must be empty
git log --oneline develop..origin/develop   # must be empty
node -p "require('./package.json').version"
git describe --tags --abbrev=0
git log $(git describe --tags --abbrev=0)..develop --oneline
```

Stop and report if the tree is dirty, the branch is wrong, or local and origin
have diverged. Do not stash or auto-commit stray changes — that is the user's
call.

Also confirm `main` is not ahead of `develop` in a way that would be lost
(`git log --oneline develop..origin/main`). If it is, merge main into develop
first and stop for review.

## Step 2 — Choose the version

If the user passed an explicit bump or version, use it. Otherwise read every
commit since the last tag and apply Conventional Commits:

- `BREAKING CHANGE:` in a body, or `!` after the type (`feat!:`) → **major**
  (while `0.x`, a breaking change is a **minor** bump)
- any `feat:` → **minor**
- otherwise → **patch**

State the detected bump and the resulting version before acting on it. If
nothing has landed since the last tag, say so and stop.

## Step 3 — Cut the release branch

```bash
git switch -c release/0.8.0 develop
```

For a hotfix (an urgent fix on top of what is already published, skipping
whatever is unreleased on develop):

```bash
git switch -c hotfix/0.7.2 main
```

Everything after this point is identical for both, except the branch name.

## Step 4 — Bump the version

```bash
npm version 0.8.0 --no-git-tag-version
```

This edits `package.json` only. It does **not** touch the CHANGELOG (do that by
hand, next) and does not tag or commit. `pnpm-lock.yaml` does not record the
root package version, so `--frozen-lockfile` in CI stays happy.

## Step 5 — Write the CHANGELOG entry

`CHANGELOG.md` follows Keep a Changelog. Insert a new section directly above the
previous version's heading:

```markdown
## [0.8.0] - YYYY-MM-DD

### Added
### Changed
### Fixed
```

Rules that matter here:

- Use today's real date (`date +%F`), not a guess.
- Drop any section with no entries.
- Write for someone who uses the package, not someone who reads the diff. One
  line per user-visible change; collapse the churn.
- Prefix genuinely breaking changes with `**Breaking:**` under `### Changed`.
- Mention the affected entry point when a change is scoped to one
  (`searchsocket/svelte`, `searchsocket/sveltekit`, the CLI).

## Step 6 — Validation gate

All four must pass. Any failure stops the release on the release branch, where
the fix can be committed before continuing.

```bash
pnpm run typecheck
pnpm run build
pnpm run test
npm pack --dry-run
```

`npm pack --dry-run` is not optional theatre. The `./svelte` subpath ships **raw
source**, not bundled output, so it can silently break when an import is added
to `src/svelte/*`. Check the file list for:

- `dist/` present, `dist/**/*.map` absent
- `src/svelte/` present
- **every non-`src/svelte` file that `src/svelte/*` imports at runtime** is also
  in the tarball (currently `src/types.ts` and `src/utils/structured-meta.ts`)

If `src/svelte` gained a new relative import, add that file to `files` in
`package.json` before releasing. This exact gap shipped broken in v0.7.1.

The build output goes to stdout and will corrupt any attempt to pipe
`npm pack --dry-run` into a JSON parser — read the `npm notice` lines instead.

## Step 7 — Commit and push the release branch

```bash
git add package.json CHANGELOG.md
git commit -m "chore: prepare for v0.8.0 release"
git push -u origin release/0.8.0
```

Pushing the branch lets CI run the Node 22/24 matrix against the exact commit
that is about to become the tag. Wait for it:

```bash
gh run watch --exit-status
```

If CI is red here, fix it on the release branch. Nothing has been tagged or
published yet, so this is a free checkpoint.

## Step 8 — Merge to main and tag

```bash
git switch main
git merge --no-ff release/0.8.0 -m "chore: release v0.8.0"
git tag -a v0.8.0 -m "Release version 0.8.0"
git push origin main
git push origin v0.8.0
```

The tag push starts the publish workflow. Watch it:

```bash
gh run watch --exit-status
```

After publishing it smoke-tests the release from the registry: it installs the
exact version and checks that the dist-tag it chose (`latest`, or `next` for a
prerelease) really resolves to it. Both steps retry, because registry metadata
converges a little behind the publish — a transient failure early in the run is
not yet a failed release.

## Step 9 — Merge back to develop

Do this even if the publish is still running — `develop` must carry the version
bump and the CHANGELOG entry, and for a hotfix it must carry the fix itself.

```bash
git switch develop
git merge --no-ff release/0.8.0 -m "chore: merge release v0.8.0 back into develop"
git push origin develop
git push origin --delete release/0.8.0
git branch -d release/0.8.0
```

## Step 10 — Verify and announce

```bash
npm view searchsocket dist-tags        # `latest` — or `next` for a prerelease —
                                       # must equal the released version
```

Then publish the GitHub release using the CHANGELOG section as the body:

```bash
gh release create v0.8.0 --title "v0.8.0" --notes "<the CHANGELOG section>"
```

Report to the user: the version, the NPM URL
(https://www.npmjs.com/package/searchsocket), the publish run's status, and the
headline changes.

## When the publish workflow fails

The tag already exists on `main` and cannot be reused for a different artifact.

- **Failed before publishing** (typecheck/build/test/OIDC error, nothing on NPM —
  confirm with `npm view searchsocket version`): fix the cause on a `hotfix/*`
  branch off `main`, then re-run the workflow against the existing tag with
  `gh run rerun <run-id>` **only if** the tagged tree itself is fine and the
  failure was infrastructural. If the tagged tree needs to change, cut the next
  patch version instead — never move a tag that has been pushed.
- **Failed after publishing**: the version is live. Roll forward with a new
  patch release. Do not `npm unpublish`; it blocks the version number for good
  and breaks anyone who already installed it.
- **OIDC/Trusted Publishing errors** (`403`, "provenance", "trusted publisher"):
  the NPM side expects the `publish.yml` workflow from `gregpriday/searchsocket`
  specifically. Renaming the workflow file, the repo, or the job breaks it, and
  it can only be repaired in NPM's package settings — not in this repo.

## Reference

- `main` — production, tags only, protected by convention.
- `develop` — default branch, integration target for `feature/*`.
- `release/*` — from `develop`, merges to **both** `main` and `develop`.
- `hotfix/*` — from `main`, merges to **both** `main` and `develop`.
- Branch prefixes are stored in git config: `git config --get-regexp '^gitflow\.'`
- CI (`ci.yml`) runs typecheck → build → test → check:package on Node 22 and 24;
  publish uses Node 24. Keep the matrix in step with `engines.node` (`>=22.12.0`).
- This repo *is* the `searchsocket` package, so its own bin is never linked into
  `node_modules/.bin`. Invoke the CLI as `node dist/cli.js`, never
  `pnpm searchsocket` — the latter only appears to work on a machine with a
  global install.
