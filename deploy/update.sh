#!/usr/bin/env bash
# Update a native Kova install from git (only while boxes move to releases, deploy/updater.sh): back up, pull,
# install dependencies, restart, check health, and if the new version doesn't come up, go back to the old one (and
# the backup) by itself.
# Run as root inside the Kova machine/LXC:  bash /opt/kova/deploy/update.sh
# (The Update button runs this through deploy/updater.sh.) Exit 0: updated. 3: rolled back. Else: failed.
set -euo pipefail

KOVA_DIR=${KOVA_DIR:-/opt/kova}
DATA_DIR=${KOVA_DATA:-/var/lib/kova}
ENV_FILE=${KOVA_ENV_FILE:-/etc/kova/kova.env}
# How long to wait for Kova to answer after a restart, in seconds.
HEALTH_WAIT=${KOVA_HEALTH_WAIT:-60}

if [[ -t 1 ]]; then B=$'\033[1;36m' R=$'\033[1;31m' N=$'\033[0m'; else B='' R='' N=''; fi
log() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
die() { printf '%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root"
[[ "$(readlink "$KOVA_DIR/current" 2>/dev/null || true)" != releases/* ]] || die "This box runs Kova releases now: update from Integrations → Kova updates, or run $KOVA_DIR/current/deploy/updater.sh apply"
[[ -d "$KOVA_DIR/.git" ]] || die "$KOVA_DIR isn't a git checkout (installed with --source? copy the new code over and re-run deploy/install.sh instead)"

log "Backing up $DATA_DIR"
backup=""
if [[ -f "$DATA_DIR/kova.db" ]]; then
  # Safe while the hub runs: SQLite's backup API takes a consistent snapshot.
  bdir=$(sed -n 's/^KOVA_BACKUP_DIR=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  keep=$(sed -n 's/^KOVA_BACKUP_KEEP=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  (cd "$KOVA_DIR/hub" && runuser -u kova -- env KOVA_DATA="$DATA_DIR" KOVA_BACKUP_DIR="$bdir" KOVA_BACKUP_KEEP="${keep:-14}" node --import tsx src/tools/backup.ts) \
    || die "Backup failed; not updating"
  backup=$(ls -1t "${bdir:-$DATA_DIR/backups}"/* 2>/dev/null | head -n1 || true)
else
  echo "No database yet; skipping."
fi

old=$(git -C "$KOVA_DIR" rev-parse --short HEAD)
log "Pulling (currently $old)"
git -C "$KOVA_DIR" pull --ff-only
new=$(git -C "$KOVA_DIR" rev-parse --short HEAD)
if [[ "$old" == "$new" ]]; then
  log "Already up to date ($new); restarting anyway"
else
  git -C "$KOVA_DIR" --no-pager log --oneline "$old..$new" | head -20 || true
fi

log "Installing dependencies"
(cd "$KOVA_DIR" && npm ci --omit=dev -w hub --include-workspace-root --no-audit --no-fund)

# The updater's own units, in case this install predates them (or they changed).
bash "$KOVA_DIR/deploy/install-updater.sh" "$KOVA_DIR" "$DATA_DIR" || echo "Couldn't install the updater units; updating anyway." >&2

log "Restarting kova"
systemctl restart kova

port=$(sed -n 's/^KOVA_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
port=${port:-8140}
for _ in $(seq 1 "$HEALTH_WAIT"); do
  if curl -fsS "http://127.0.0.1:$port/api/health"; then echo; log "Kova $new is up"; exit 0; fi
  sleep 1
done

journalctl -u kova --no-pager -n 40 || true
log "Kova $new didn't come back: going back to $old"
git -C "$KOVA_DIR" reset --hard --quiet "$old"
(cd "$KOVA_DIR" && npm ci --omit=dev -w hub --include-workspace-root --no-audit --no-fund) || true
systemctl stop kova || true
if [[ -n "$backup" ]]; then
  log "Restoring $backup"
  (cd "$KOVA_DIR/hub" && runuser -u kova -- env KOVA_DATA="$DATA_DIR" node --import tsx src/tools/restore.ts "$backup") || echo "Restoring the backup failed; the data is as the new version left it." >&2
fi
systemctl start kova
for _ in $(seq 1 "$HEALTH_WAIT"); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then log "Back on Kova $old"; exit 3; fi
  sleep 1
done
journalctl -u kova --no-pager -n 40 || true
die "Kova $old didn't come back either. See: journalctl -u kova -e"
