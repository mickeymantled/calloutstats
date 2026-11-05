#!/usr/bin/env bash
#
# Commit and push the data produced by a scrape run. Invoked by `npm run publish`
# and by the launchd job right after `npm run scrape -- --no-interactive`.
#
# What gets committed:
#   data/              runs/*.json, discovered_endpoints.json
#                      (.gitignore excludes the sqlite DB, browser profile,
#                       raw/ text dumps and logs/; they never leave this machine)
#   site/public/data/  the exported JSON bundle the site builds from
#
# Exit status: 0 after a successful commit+push, when there is nothing to
# commit, or when no upstream / remote is configured (printed clearly).
# Non-zero only on a real git error (not a repo, commit or push failed).
#
# Works with the macOS /bin/bash 3.2: no arrays, no bash-4 features.
set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf 'publish: %s\n' "$*"; }

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "error: $(pwd) is not a git repository" >&2
  exit 1
fi

# Only add paths that exist (git add fails on a missing pathspec). Ignored files
# are skipped by git add itself; never force-add here.
set --
for p in data site/public/data; do
  if [ -e "$p" ]; then set -- "$@" "$p"; fi
done
if [ $# -eq 0 ]; then
  log "nothing to add: neither data/ nor site/public/data/ exists"
  exit 0
fi

git add -- "$@"

# Only look at our paths so unrelated changes the user staged are left alone.
if git diff --cached --quiet -- "$@"; then
  log "nothing to commit: data unchanged since the last publish"
  exit 0
fi

stamp="$(date -u +%Y-%m-%dT%H:%MZ)"
msg="data: ${stamp} run"
# `git commit -- <paths>` commits only these paths (--only), leaving anything
# else the user may have staged untouched.
git commit --quiet -m "$msg" -- "$@"
log "committed \"$msg\" ($(git show --stat --format= HEAD | tail -n 1 | sed 's/^ *//'))"

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [ -z "$branch" ]; then
  log "detached HEAD: committed locally, not pushing"
  exit 0
fi

if upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
  log "pushing $branch -> $upstream"
  git push --quiet
  log "pushed"
else
  remotes="$(git remote)"
  if [ -n "$remotes" ]; then
    first_remote="$(printf '%s\n' "$remotes" | head -n 1)"
    log "branch '$branch' has no upstream: committed locally only."
    log "link it once with:  git push -u $first_remote $branch"
  else
    log "no git remote configured: committed locally only"
  fi
fi
exit 0
