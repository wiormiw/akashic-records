#!/usr/bin/env bash
# Vercel's ignoreCommand: exit 0 skips the build, exit 1 runs it.
# Runs with cwd apps/web (the project root), so paths below are resolved from the repo root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

previous="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"

# Vercel clones shallowly, and a first deploy has no previous SHA. When the base isn't in the
# history we can't prove nothing changed, so build.
if ! git cat-file -e "${previous}^{commit}" 2>/dev/null; then
	echo "vercel-ignore: ${previous} is not in the local history; building."
	exit 1
fi

if git diff --quiet "$previous" HEAD -- \
	apps/web packages/contracts packages/lib/src/enums.ts bun.lock; then
	echo "vercel-ignore: nothing the web app depends on changed; skipping."
	exit 0
fi

echo "vercel-ignore: web inputs changed; building."
exit 1
