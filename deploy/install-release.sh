#!/usr/bin/env bash
# Install a Kova release bundle (scripts/build-release.sh) beside the running one, switch to it, and switch back by
# itself when it doesn't come up. deploy/updater.sh runs this after downloading and verifying the bundle; by hand:
#   bash /opt/kova/current/deploy/install-release.sh kova-release.tar.gz
# Exit 0: updated. 3: rolled back (the version is remembered as bad and not offered again). Else: failed, nothing
# changed.
#
#   $KOVA_DIR/releases/<version>/   each release: hub/ web/ ota/ deploy/ node_modules/ package*.json manifest.json
#   $KOVA_DIR/current               → releases/<version> (or "." while the box is still a git checkout)
#   kova.service                    WorkingDirectory=$KOVA_DIR/current/hub
set -euo pipefail

KOVA_DIR=${KOVA_DIR:-/opt/kova}
DATA_DIR=${KOVA_DATA:-/var/lib/kova}
ENV_FILE=${KOVA_ENV_FILE:-/etc/kova/kova.env}
HEALTH_WAIT=${KOVA_HEALTH_WAIT:-60}
KEEP=${KOVA_RELEASES_KEEP:-3}
BUNDLE=${1:?usage: install-release.sh <kova-release.tar.gz>}

log() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Run as root"
[[ -f "$BUNDLE" ]] || die "No bundle at $BUNDLE"

REL="$KOVA_DIR/releases"
mkdir -p "$REL"
# The running Kova (the old one), and what `current` points at now ("." = the git checkout).
prev=$(readlink "$KOVA_DIR/current" 2>/dev/null || echo .)
old_root="$KOVA_DIR/$prev"; [[ "$prev" == . ]] && old_root="$KOVA_DIR"
[[ -d "$old_root/hub" ]] || die "Can't find the running Kova (looked in $old_root)"
manifest_field() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],m);console.log(v==null?"":v)' "$1" "$2"; }

log "Unpacking $(basename "$BUNDLE")"
work=$(mktemp -d "$REL/.incoming.XXXXXX")
trap 'rm -rf "$work"' EXIT
tar -xzf "$BUNDLE" -C "$work"
# Checked by the running Kova's own code, part by part against manifest.json.
fit=$(cd "$old_root/hub" && node --import tsx src/tools/release.ts verify "$work") || die "The release didn't verify: $fit"
version=$(node -e 'console.log(JSON.parse(process.argv[1]).version)' "$fit")
[[ "$version" =~ ^[0-9A-Za-z._-]+$ ]] || die "Bad version in the manifest: $version"
[[ "$(node -e 'console.log(JSON.parse(process.argv[1]).runs)' "$fit")" == true ]] || die "Kova $version needs Node $(manifest_field "$work/manifest.json" node.min) or newer (this box has $(node --version))"
modules=$(node -e 'console.log(JSON.parse(process.argv[1]).modules)' "$fit")

dest="$REL/$version"
stage="$REL/.$version.new"
rm -rf "$stage"; mkdir -p "$stage"
for part in root hub web ota deploy; do
  tar -xzf "$work/$(manifest_field "$work/manifest.json" "parts.$part.file")" -C "$stage"
done
cp "$work/manifest.json" "$stage/manifest.json"
if [[ "$modules" == true ]]; then
  tar -xzf "$work/$(manifest_field "$work/manifest.json" parts.node_modules.file)" -C "$stage"
else
  log "Installing dependencies (this box's Node differs from the build's)"
  (cd "$stage" && npm ci --omit=dev -w hub --include-workspace-root --no-audit --no-fund)
fi
chown -R root:root "$stage"
if [[ "$prev" == "releases/$version" ]]; then die "Kova $version is the one running"; fi
rm -rf "$dest"; mv "$stage" "$dest"

log "Backing up $DATA_DIR"
backup=""
if [[ -f "$DATA_DIR/kova.db" ]]; then
  bdir=$(sed -n 's/^KOVA_BACKUP_DIR=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  keep=$(sed -n 's/^KOVA_BACKUP_KEEP=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  (cd "$old_root/hub" && runuser -u kova -- env KOVA_DATA="$DATA_DIR" KOVA_BACKUP_DIR="$bdir" KOVA_BACKUP_KEEP="${keep:-14}" node --import tsx src/tools/backup.ts) \
    || die "Backup failed; not updating"
  backup=$(ls -1t "${bdir:-$DATA_DIR/backups}"/* 2>/dev/null | head -n1 || true)
else
  echo "No database yet; skipping."
fi

# One rename: `current` is the old release or the new one, never neither.
point() { ln -sfn "$1" "$KOVA_DIR/.current.new" && mv -Tf "$KOVA_DIR/.current.new" "$KOVA_DIR/current"; }
units() { bash "$KOVA_DIR/current/deploy/install-updater.sh" "$KOVA_DIR" "$DATA_DIR" || echo "Couldn't install the updater units; carrying on." >&2; }
port=$(sed -n 's/^KOVA_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
port=${port:-8140}
healthy() { # version
  for _ in $(seq 1 "$HEALTH_WAIT"); do
    if curl -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q "\"version\":\"$1\""; then return 0; fi
    sleep 1
  done
  return 1
}
from=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$old_root/hub/package.json")

log "Switching from Kova $from to $version"
point "releases/$version"
units
systemctl restart kova
if healthy "$version"; then
  log "Kova $version is up"
  # Keep the newest few, and always the one before (to go back to by hand).
  { ls -1t "$REL" | grep -v '^\.' | grep -vxF "$version" | grep -vxF "${prev#releases/}" | tail -n +"$KEEP" || true; } \
    | while read -r old; do rm -rf "${REL:?}/$old"; done
  exit 0
fi

journalctl -u kova --no-pager -n 40 || true
log "Kova $version didn't come up: going back to $from"
echo "$version" >> "$DATA_DIR/update/bad-versions"
chown kova:kova "$DATA_DIR/update/bad-versions" 2>/dev/null || true
point "$prev"
units
systemctl stop kova || true
if [[ -n "$backup" ]]; then
  log "Restoring $backup"
  (cd "$old_root/hub" && runuser -u kova -- env KOVA_DATA="$DATA_DIR" node --import tsx src/tools/restore.ts "$backup") || echo "Restoring the backup failed; the data is as the new version left it." >&2
fi
systemctl start kova
if healthy "$from"; then log "Back on Kova $from"; exit 3; fi
journalctl -u kova --no-pager -n 40 || true
die "Kova $from didn't come back either. See: journalctl -u kova -e"
