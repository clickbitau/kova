#!/usr/bin/env bash
# Update a native Kova install: back up, pull, install dependencies, restart, check health.
# Run as root inside the Kova machine/LXC:  bash /opt/kova/deploy/update.sh
set -euo pipefail

KOVA_DIR=${KOVA_DIR:-/opt/kova}
DATA_DIR=${KOVA_DATA:-/var/lib/kova}
ENV_FILE=/etc/kova/kova.env

if [[ -t 1 ]]; then B=$'\033[1;36m' R=$'\033[1;31m' N=$'\033[0m'; else B='' R='' N=''; fi
log() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
die() { printf '%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root"
[[ -d "$KOVA_DIR/.git" ]] || die "$KOVA_DIR isn't a git checkout (installed with --source? copy the new code over and re-run deploy/install.sh instead)"

log "Backing up $DATA_DIR"
if [[ -f "$DATA_DIR/kova.db" ]]; then
  # Safe while the hub runs: SQLite's backup API takes a consistent snapshot.
  bdir=$(sed -n 's/^KOVA_BACKUP_DIR=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  keep=$(sed -n 's/^KOVA_BACKUP_KEEP=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  (cd "$KOVA_DIR/hub" && runuser -u kova -- env KOVA_DATA="$DATA_DIR" KOVA_BACKUP_DIR="$bdir" KOVA_BACKUP_KEEP="${keep:-14}" node --import tsx src/tools/backup.ts) \
    || die "Backup failed; not updating"
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

log "Restarting kova"
systemctl restart kova

port=$(sed -n 's/^KOVA_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
port=${port:-8140}
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/api/health"; then echo; log "Kova $new is up"; exit 0; fi
  sleep 1
done

journalctl -u kova --no-pager -n 40 || true
cat >&2 <<EOF

Kova didn't come back after the update. To go back to $old:
  git -C $KOVA_DIR checkout $old && (cd $KOVA_DIR && npm ci --omit=dev -w hub --include-workspace-root) && systemctl restart kova
and if the data needs to go back too, restore the backup made above (newest file in $DATA_DIR/backups/):
  systemctl stop kova
  cd $KOVA_DIR/hub && runuser -u kova -- env KOVA_DATA=$DATA_DIR node --import tsx src/tools/restore.ts $DATA_DIR/backups/<file>
  systemctl start kova
EOF
exit 1
