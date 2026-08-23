#!/usr/bin/env bash
# Copyright (C) 2026 StoneDogCode L.L.C.
# SPDX-License-Identifier: Apache-2.0
#
# Publish @stonedogcode/slack-notify to npm, end to end.
#
#   npm run publish:slack-notify
#
# Run it from a terminal, interactively. npm prompts for the 2FA one-time
# password itself (account `stonedogcode`) and the browser login flow needs a
# human — neither works unattended, which is why this is a script you run
# rather than a step in CI.
#
# Modelled on stonedog-theme's script of the same name, and deliberately close
# to it: two publish scripts that drift are two different definitions of "safe
# to publish". The verification half is identical for the reason that one gives
# — a publish that printed no error had already turned out not to have
# published anything, and during the propagation window every obvious check
# disagrees with every other one.
#
#   * **`npm view pkg@version` is the reliable probe** — it exits 1 when the
#     version is absent and 0 when present. The bare `npm view pkg` form 404s
#     mid-propagation and would report a successful publish as a failure.
#   * **Nothing short of an install proves it.** This ends by installing from
#     the registry into a temp directory, because that is the question a user
#     actually asks and it is the last one to start answering "yes".
#
# ## What is different about THIS package
#
# It ships a built `dist/` and `dist/` is gitignored, so it carries the same
# stale-artifact hazard stonedog-theme documents: a clean checkout has no
# `dist/` at all, and `files` names it, so without a build `npm pack` produces
# a package whose every export resolves to a file that is not there. Hence the
# build in step 5, every time, rather than trusting whatever is on disk.
#
# It also ships a **`bin`**, which theme does not, and that adds a failure with
# no analogue there: a CLI whose entry point lost its `#!/usr/bin/env node`
# line installs perfectly and then fails the moment anyone runs it, with an
# error about shell syntax rather than about the package. `tsc` preserves the
# shebang today; nothing guarantees a future build tool will, and the symptom
# would first appear inside somebody's deploy. Step 6 checks for it.
set -euo pipefail

PACKAGE_NAME="@stonedogcode/slack-notify"
# Sanity floor for the tarball. The real count is 8 (four dist files, README,
# LICENSE, NOTICE, package.json). An unbuilt or mis-configured package produces
# 4 — the metadata files and nothing else — so this sits between the two.
MIN_FILES=6
# Every path `exports` and `bin` name. A tarball missing one of these installs
# cleanly and fails at the consumer's first import or first invocation.
REQUIRED_PATHS=(
  "dist/index.js"
  "dist/index.d.ts"
  "dist/cli.js"
  "dist/cli.d.ts"
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mREFUSING: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Publish from a clean, current `main`.
# ---------------------------------------------------------------------------
say "Checking the working tree"
BRANCH="$(git branch --show-current)"
if [ -z "$BRANCH" ]; then
  fail "this checkout is in detached HEAD. Run: git checkout main && git pull"
fi
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH'. Publish from main, never a feature branch."
[ -z "$(git status --porcelain | grep -v '^??')" ] || fail "the working tree has uncommitted changes."

git fetch --quiet origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  fail "HEAD is not origin/main ($BEHIND commit(s) behind). A checkout one commit behind publishes a tarball missing the very thing you are publishing for, and it looks like a success. Run: git pull"
fi
echo "  clean, on main, at $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
# 2. Authenticate.
#
# `npm whoami` is the honest check. A 404 from `npm publish` means AUTH far
# more often than a missing package — npm answers 404 rather than 403 so it
# cannot leak whether a name exists — so establishing identity here turns that
# confusing failure into a clear one. An `_authToken` in ~/.npmrc can also be
# present but expired, which only whoami reveals. That is not hypothetical:
# this machine's token was expired when this package was first written, which
# is why consumers pin a git sha rather than a version.
# ---------------------------------------------------------------------------
say "Checking npm authentication"
if ! NPM_USER="$(npm whoami 2>/dev/null)"; then
  echo "  not logged in — starting the browser login flow"
  npm login
  NPM_USER="$(npm whoami)"
fi
echo "  authenticated as $NPM_USER"

if npm view "$PACKAGE_NAME" version >/dev/null 2>&1; then
  npm owner ls "$PACKAGE_NAME" 2>/dev/null | grep -q "^$NPM_USER " \
    || fail "'$NPM_USER' is not an owner of $PACKAGE_NAME, so publishing will fail with a misleading 404. Owners: $(npm owner ls "$PACKAGE_NAME" 2>/dev/null | tr '\n' ' ')"
  echo "  $NPM_USER is an owner of $PACKAGE_NAME"
fi

# ---------------------------------------------------------------------------
# 3. A version may be published at most once, ever.
# ---------------------------------------------------------------------------
VERSION="$(node -p "require('./package.json').version")"
say "Preparing $PACKAGE_NAME@$VERSION"

if npm view "$PACKAGE_NAME@$VERSION" version >/dev/null 2>&1; then
  fail "$PACKAGE_NAME@$VERSION is already published. A version can never be reused — bump it, land that, then re-run."
fi

# ---------------------------------------------------------------------------
# 3b. Install exactly what the lockfile says, before anything reads node_modules.
#
# Every check above is about GIT. None of them looks at node_modules, and the
# two diverge exactly when a manifest change has just been pulled — which is
# precisely when someone is about to publish. `npm ci` rather than
# `npm install`: it installs exactly the lockfile and FAILS when the lockfile
# and manifest disagree, which is itself a reason not to publish.
# ---------------------------------------------------------------------------
say "Installing dependencies from the lockfile"
[ -f package-lock.json ] || fail "there is no package-lock.json, so there is nothing to install reproducibly from."
npm ci
echo "  node_modules now matches package-lock.json"

# ---------------------------------------------------------------------------
# 4. The gate: typecheck, tests, build.
#
# Publishing is irreversible on a version number, so the gate runs here rather
# than being assumed from a green PR — this checkout may carry commits that
# merged after the last CI run, and CI is not always available.
# ---------------------------------------------------------------------------
say "Running the gate"
npm run gate

# ---------------------------------------------------------------------------
# 5. BUILD, every time.
#
# `dist/` is gitignored and `files` names it. Skipping this produces a tarball
# whose every export points at a file that is not in it: installs fine, fails
# at the consumer's first import, on a version number that can never be reused.
#
# Rebuilt rather than reused, because a `dist/` left over from another branch
# is indistinguishable from a correct one by looking at it.
# ---------------------------------------------------------------------------
say "Building dist/"
npm run build

# ---------------------------------------------------------------------------
# 6. Read the tarball before trusting it.
# ---------------------------------------------------------------------------
say "Verifying the tarball"
PACK_OUTPUT="$(npm pack --dry-run 2>&1)"
FILE_COUNT="$(printf '%s' "$PACK_OUTPUT" | sed -n 's/.*total files:[[:space:]]*\([0-9]*\).*/\1/p' | tail -1)"

[ -n "$FILE_COUNT" ] || fail "could not read a file count from npm pack."
[ "$FILE_COUNT" -ge "$MIN_FILES" ] \
  || fail "the tarball has only $FILE_COUNT files (expected >= $MIN_FILES). That is what an unbuilt or mis-configured package looks like, and publishing it burns a version number forever."

for path in "${REQUIRED_PATHS[@]}"; do
  printf '%s' "$PACK_OUTPUT" | grep -q "$path" \
    || fail "'$path' is not in the tarball, but package.json names it in \"exports\" or \"bin\". Every consumer would fail. Did the build run?"
done

# The bin's shebang. A CLI without it installs perfectly and then fails the
# moment anyone runs it — with an error about shell syntax rather than about
# this package, inside somebody's deploy script.
BIN_PATH="$(node -p "require('./package.json').bin['stonedog-slack-notify']")"
head -1 "$BIN_PATH" | grep -q '^#!' \
  || fail "$BIN_PATH has no shebang, so it is not runnable as a command. The build dropped it."
echo "  bin keeps its shebang: $(head -1 "$BIN_PATH")"

for doc in README.md LICENSE NOTICE; do
  printf '%s' "$PACK_OUTPUT" | grep -q "$doc" \
    || fail "no $doc in the tarball. This package is Apache-2.0 and ships its licence and notice."
done

echo "  $FILE_COUNT files; entry points, bin, README, LICENSE and NOTICE all present"

say "Tarball contents — read this before confirming"
printf '%s\n' "$PACK_OUTPUT" | sed -n 's/^npm notice[[:space:]]*[0-9.]*[kMG]*B*[[:space:]]*\(dist\/.*\)/  \1/p' | sort
echo "  ($FILE_COUNT files total)"

# ---------------------------------------------------------------------------
# 7. Publish. npm prompts for the OTP here.
#
# `--access public` is explicit AND `publishConfig.access` is in package.json.
# A scoped package defaults to access: restricted; publishing one privately
# succeeds, prints nothing unusual, and then 404s for every consumer —
# indistinguishable from a package that was never published. Being wrong about
# it is not recoverable on that version number.
# ---------------------------------------------------------------------------
say "Publishing $PACKAGE_NAME@$VERSION — npm will ask for your 2FA code"
npm publish --access public

# ---------------------------------------------------------------------------
# 8. PROVE IT. The step whose absence is the reason this script exists.
# ---------------------------------------------------------------------------
say "Verifying it is actually installable"
PROBE_DIR="$(mktemp -d)"
trap 'rm -rf "$PROBE_DIR"' EXIT

for attempt in $(seq 1 20); do
  if npm view "$PACKAGE_NAME@$VERSION" version >/dev/null 2>&1; then break; fi
  [ "$attempt" -lt 20 ] || fail "$PACKAGE_NAME@$VERSION is still not on the registry after publishing. The publish did NOT succeed, whatever it printed."
  sleep 3
done

printf '{"name":"probe","version":"1.0.0"}' > "$PROBE_DIR/package.json"
(cd "$PROBE_DIR" && npm install --silent "$PACKAGE_NAME@$VERSION" >/dev/null 2>&1) \
  || fail "$PACKAGE_NAME@$VERSION resolves but cannot be installed."

INSTALLED="$(node -p "require('$PROBE_DIR/node_modules/$PACKAGE_NAME/package.json').version")"
[ "$INSTALLED" = "$VERSION" ] || fail "installed $INSTALLED but published $VERSION."

for path in "${REQUIRED_PATHS[@]}"; do
  [ -f "$PROBE_DIR/node_modules/$PACKAGE_NAME/$path" ] \
    || fail "$path is missing from the INSTALLED package, though it was in the tarball."
done

# The library loads. A dist built from a broken source tree unpacks perfectly
# and throws on import.
(cd "$PROBE_DIR" && node -e "import('$PACKAGE_NAME').then(m => { if (typeof m.send !== 'function') { process.exit(1); } })") \
  || fail "$PACKAGE_NAME@$VERSION installs but does not export send(). The published dist/ is not loadable."

# And the CLI runs. This is the half a library-only probe would miss, and it is
# how every consumer actually uses this package — from a deploy script.
(cd "$PROBE_DIR" && ./node_modules/.bin/stonedog-slack-notify --help >/dev/null 2>&1) \
  || fail "$PACKAGE_NAME@$VERSION installs but its CLI does not run. Check the shebang and the bin path."

printf '\n\033[32m✓ %s@%s is published, installable, and its CLI runs.\033[0m\n' "$PACKAGE_NAME" "$VERSION"
echo "  https://www.npmjs.com/package/$PACKAGE_NAME"
printf '\n\033[1mNext:\033[0m the six consumers currently pin a git sha. Swap each to "^%s"\n' "$VERSION"
printf '  so they resolve from the registry rather than cloning this repo at build time.\n'
