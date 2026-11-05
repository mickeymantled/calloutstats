#!/usr/bin/env bash
#
# Install (or re-install) the Callout Check LaunchAgents for the current user.
#
#   scripts/install-launchd.sh                      render + install + load all three
#   scripts/install-launchd.sh --dry-run            render to stdout, lint, touch nothing
#   scripts/install-launchd.sh --uninstall          unload and delete the installed plists
#   scripts/install-launchd.sh --only <job> [...]   limit to one job: scrape | collector | chrome
#                                                   (combines with --dry-run / --uninstall)
#
# Jobs (templates in launchd/, rendered with __REPO__ -> this repo's absolute path and
# __NODE_BIN__ -> the directory of `node`, copied to ~/Library/LaunchAgents/, then
# bootout (ignore errors) + bootstrap into gui/<uid>):
#
#   collector  com.calloutcheck.collector  `npm run collector`, the always-on local HTTP
#              service (SQLite, parsing, export, publish). RunAtLoad + KeepAlive.
#   chrome     com.calloutcheck.chrome     opens Google Chrome with the dedicated profile
#              data/browser-profile-chrome on https://pump.fun/ at login; relaunched
#              only if it crashes (KeepAlive SuccessfulExit=false).
#   scrape     com.calloutcheck.scrape     the ORIGINAL Playwright path: headed browser
#              scrape + publish at 06:00 local time. Optional now that collection goes
#              through the collector; pump.fun's Cloudflare check blocks it unattended
#              (see README "Status"). Installed by default for compatibility; skip it with
#              `--only collector --only chrome`, or remove it with `--uninstall --only scrape`.
#
# Works with the macOS /bin/bash 3.2 (no arrays, no bash-4 features).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="$(pwd -P)"
DEST_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
ALL_JOBS="collector chrome scrape"

MODE="install"
JOBS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="--dry-run" ;;
    --uninstall) MODE="--uninstall" ;;
    install) MODE="install" ;;
    --only)
      shift
      case "${1:-}" in
        scrape|collector|chrome) JOBS="$JOBS $1" ;;
        *) echo "usage: $0 [--dry-run|--uninstall] [--only scrape|collector|chrome ...]" >&2; exit 2 ;;
      esac ;;
    --only=*)
      j="${1#--only=}"
      case "$j" in
        scrape|collector|chrome) JOBS="$JOBS $j" ;;
        *) echo "unknown job '$j'; expected scrape, collector or chrome" >&2; exit 2 ;;
      esac ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 [--dry-run|--uninstall] [--only scrape|collector|chrome ...]" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$JOBS" ] || JOBS="$ALL_JOBS"

label_of() { printf 'com.calloutcheck.%s' "$1"; }

if [ "$MODE" = "--uninstall" ]; then
  for job in $JOBS; do
    LABEL="$(label_of "$job")"
    DEST="$DEST_DIR/$LABEL.plist"
    launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
    rm -f "$DEST"
    echo "Unloaded and removed $DEST"
  done
  exit 0
fi

# The repo path is embedded inside a double-quoted zsh string in the scrape and
# collector templates; refuse characters that would need escaping there (spaces are fine).
case "$REPO" in
  *[\"\$\`\\]*) echo "repo path contains \" \$ \` or \\, which the plist templates cannot quote: $REPO" >&2; exit 1 ;;
esac

NODE_PATH_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_PATH_BIN" ]; then
  echo "node not found on PATH; install Node 22 first (the jobs need npm)" >&2
  exit 1
fi
NODE_BIN="$(cd "$(dirname "$NODE_PATH_BIN")" && pwd -P)"

# XML-escape the two values (& < > are the only characters that matter in text nodes).
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}
REPO_XML="$(xml_escape "$REPO")"
NODE_BIN_XML="$(xml_escape "$NODE_BIN")"

render() { # render <template-file> -> stdout (pure-bash substitution, replacement taken literally)
  local content
  content="$(cat "$1")"
  content="${content//__REPO__/$REPO_XML}"
  content="${content//__NODE_BIN__/$NODE_BIN_XML}"
  printf '%s\n' "$content"
}

case " $JOBS " in
  *" chrome "*)
    if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
      echo "warning: /Applications/Google Chrome.app not found; com.calloutcheck.chrome will fail to start until it is installed" >&2
    fi ;;
esac

for job in $JOBS; do
  LABEL="$(label_of "$job")"
  SRC="$REPO/launchd/$LABEL.plist"
  [ -f "$SRC" ] || { echo "template not found: $SRC" >&2; exit 1; }
done

if [ "$MODE" = "--dry-run" ]; then
  for job in $JOBS; do
    LABEL="$(label_of "$job")"
    SRC="$REPO/launchd/$LABEL.plist"
    DEST="$DEST_DIR/$LABEL.plist"
    tmp="$(mktemp -t calloutcheck-plist)"
    render "$SRC" > "$tmp"
    plutil -lint "$tmp" >/dev/null
    echo "### $LABEL"
    cat "$tmp"
    rm -f "$tmp"
    echo "--- dry run: lint ok; would install to $DEST and bootstrap into $DOMAIN" >&2
  done
  exit 0
fi

mkdir -p "$DEST_DIR" "$REPO/data/logs"
for job in $JOBS; do
  LABEL="$(label_of "$job")"
  SRC="$REPO/launchd/$LABEL.plist"
  DEST="$DEST_DIR/$LABEL.plist"
  render "$SRC" > "$DEST"
  plutil -lint "$DEST" >/dev/null
  # Reload: bootout fails when the job is not loaded yet, which is fine.
  launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$DEST"
  echo "Installed $DEST and loaded into $DOMAIN as $LABEL"
done

cat <<MSG

Jobs installed:$(for job in $JOBS; do printf ' %s' "$job"; done)
  collector: always on, http://127.0.0.1:47831  -> data/logs/collector.{out,err}.log, data/logs/<date>.log
  chrome:    opens the pump.fun Chrome profile at login (relaunch only on crash)
  scrape:    Playwright scrape + publish daily at 06:00 local time (optional, blocked unattended)

Useful commands (replace <job> with scrape | collector | chrome):
  launchctl kickstart -k $DOMAIN/com.calloutcheck.<job>     run / restart it now
  launchctl print $DOMAIN/com.calloutcheck.<job> | head -30 status, last exit code
  launchctl bootout $DOMAIN "$DEST_DIR/com.calloutcheck.<job>.plist"
  scripts/install-launchd.sh --uninstall [--only <job>]
MSG
