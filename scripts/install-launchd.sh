#!/usr/bin/env bash
#
# Install (or re-install) the daily scrape LaunchAgent for the current user.
#
#   scripts/install-launchd.sh             render + install + load
#   scripts/install-launchd.sh --dry-run   render to stdout, lint, touch nothing
#   scripts/install-launchd.sh --uninstall unload and delete the installed plist
#
# Renders launchd/com.calloutcheck.scrape.plist, replacing __REPO__ with this
# repo's absolute path and __NODE_BIN__ with the directory of `node`, copies it to
# ~/Library/LaunchAgents/, then bootout (ignore errors) + bootstrap into gui/<uid>.
# The job fires at 06:00 in the Mac's local time zone (Pacific on this machine).
#
# Works with the macOS /bin/bash 3.2.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="com.calloutcheck.scrape"
REPO="$(pwd -P)"
SRC="$REPO/launchd/$LABEL.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"
MODE="${1:-install}"

case "$MODE" in
  install|--dry-run|--uninstall) ;;
  *) echo "usage: $0 [--dry-run|--uninstall]" >&2; exit 2 ;;
esac

if [ "$MODE" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
  rm -f "$DEST"
  echo "Unloaded and removed $DEST"
  exit 0
fi

[ -f "$SRC" ] || { echo "template not found: $SRC" >&2; exit 1; }

# The repo path is embedded inside a double-quoted zsh string; refuse characters
# that would need escaping there (spaces are fine).
case "$REPO" in
  *[\"\$\`\\]*) echo "repo path contains \" \$ \` or \\, which the plist template cannot quote: $REPO" >&2; exit 1 ;;
esac

NODE_PATH_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_PATH_BIN" ]; then
  echo "node not found on PATH; install Node 22 first (the job needs npm)" >&2
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

# Pure-bash substitution: the replacement is taken literally (no sed escaping).
content="$(cat "$SRC")"
content="${content//__REPO__/$REPO_XML}"
content="${content//__NODE_BIN__/$NODE_BIN_XML}"

if [ "$MODE" = "--dry-run" ]; then
  tmp="$(mktemp -t calloutcheck-plist)"
  printf '%s\n' "$content" > "$tmp"
  plutil -lint "$tmp" >/dev/null
  printf '%s\n' "$content"
  rm -f "$tmp"
  echo "--- dry run: lint ok; would install to $DEST and bootstrap into $DOMAIN" >&2
  exit 0
fi

mkdir -p "$DEST_DIR" "$REPO/data/logs"
printf '%s\n' "$content" > "$DEST"
plutil -lint "$DEST" >/dev/null

# Reload: bootout fails when the job is not loaded yet, which is fine.
launchctl bootout "$DOMAIN" "$DEST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"

cat <<MSG
Installed $DEST
Loaded into $DOMAIN as $LABEL; runs daily at 06:00 local time (Pacific on this Mac).
Logs: $REPO/data/logs/launchd.out.log and launchd.err.log

Run it now:   launchctl kickstart -k $DOMAIN/$LABEL
Status:       launchctl print $DOMAIN/$LABEL | head -n 30
Unload:       launchctl bootout $DOMAIN "$DEST"
              (or: scripts/install-launchd.sh --uninstall)
MSG
