#!/usr/bin/env bash
# Install (or refresh) Kova's updater units: the Update button (kova-update.path → kova-update.service) and the
# check every 6 hours (kova-update-check.timer). Run as root by deploy/install.sh and deploy/update.sh.
#   install-updater.sh <kova dir> <data dir>
set -euo pipefail
KOVA_DIR=${1:?kova dir}
DATA_DIR=${2:?data dir}
UNITS=${KOVA_SYSTEMD_DIR:-/etc/systemd/system}
changed=0
for u in kova-update.service kova-update.path kova-update-check.service kova-update-check.timer; do
  want=$(sed -e "s|/opt/kova|$KOVA_DIR|g" -e "s|/var/lib/kova|$DATA_DIR|g" "$KOVA_DIR/deploy/systemd/$u")
  if [[ ! -f "$UNITS/$u" ]] || [[ "$(cat "$UNITS/$u")" != "$want" ]]; then
    printf '%s\n' "$want" > "$UNITS/$u"
    changed=1
  fi
done
install -d -o kova -g kova -m 0750 "$DATA_DIR/update"
if [[ $changed == 1 ]]; then systemctl daemon-reload; fi
systemctl enable --now kova-update.path kova-update-check.timer >/dev/null 2>&1 || systemctl enable --now kova-update.path kova-update-check.timer
