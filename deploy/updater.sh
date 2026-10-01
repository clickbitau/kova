#!/usr/bin/env bash
# Kova's updater, run as root by systemd on the hub's behalf (the hub runs as the unprivileged `kova` user):
#
#   updater.sh check     fetch, and say whether a newer Kova is on the branch (kova-update-check.timer, every 6 h)
#   updater.sh apply     update with deploy/update.sh, which backs up first and rolls back by itself if the new
#                        version doesn't come up healthy
#   updater.sh request   do what the hub asked: it writes "check" or "apply" to $DATA_DIR/update/request,
#                        which kova-update.path watches
#
# Everything the hub shows comes from $DATA_DIR/update/status.json, written here (readable by kova).
set -uo pipefail

KOVA_DIR=${KOVA_DIR:-/opt/kova}
DATA_DIR=${KOVA_DATA:-/var/lib/kova}
BRANCH=${KOVA_BRANCH:-main}
UPD="$DATA_DIR/update"
STATUS="$UPD/status.json"
LOG="$UPD/last-update.log"

install -d -o kova -g kova -m 0750 "$UPD" 2>/dev/null || mkdir -p "$UPD"

# Merge fields into status.json (as JSON, through node, so nothing in a commit message can break it).
status() {
  node -e '
    const fs = require("fs"); const [file, patch] = [process.argv[1], JSON.parse(process.argv[2])];
    let s = {}; try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    fs.writeFileSync(file + ".tmp", JSON.stringify({ ...s, ...patch }, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
  ' "$STATUS" "$1"
  chown kova:kova "$STATUS" 2>/dev/null || true
  chmod 0640 "$STATUS" 2>/dev/null || true
}
now() { date +%s000; }
version_at() { git -C "$KOVA_DIR" show "$1:hub/package.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})'; }
json_lines() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))'; }

check() {
  status "{\"state\":\"checking\"}"
  if ! git -C "$KOVA_DIR" fetch --quiet origin "$BRANCH" 2>"$UPD/fetch.err"; then
    status "{\"state\":\"idle\",\"checkedAt\":$(now),\"checkError\":$(head -c 300 "$UPD/fetch.err" | json_lines)}"
    return 1
  fi
  local head remote behind
  head=$(git -C "$KOVA_DIR" rev-parse HEAD)
  remote=$(git -C "$KOVA_DIR" rev-parse "origin/$BRANCH")
  behind=$(git -C "$KOVA_DIR" rev-list --count "HEAD..origin/$BRANCH")
  local changes
  changes=$(git -C "$KOVA_DIR" log --format=%s --no-merges "HEAD..origin/$BRANCH" | head -20 | json_lines)
  status "$(node -e '
    const [head, remote, behind, cur, next, changes, at] = process.argv.slice(1);
    console.log(JSON.stringify({
      state: "idle", updater: 1, checkedAt: Number(at), checkError: null,
      current: { version: cur, commit: head.slice(0, 7) },
      available: Number(behind) > 0 ? { version: next, commit: remote.slice(0, 7), behind: Number(behind), changes: JSON.parse(changes) } : null,
    }));
  ' "$head" "$remote" "$behind" "$(version_at HEAD)" "$(version_at "origin/$BRANCH")" "$changes" "$(now)")"
}

apply() {
  local from to code
  from=$(version_at HEAD)
  status "{\"state\":\"updating\",\"startedAt\":$(now)}"
  # Run a copy: the pull replaces update.sh while it runs, and bash reads a script as it goes.
  local copy; copy=$(mktemp /tmp/kova-update.XXXXXX.sh)
  cp "$KOVA_DIR/deploy/update.sh" "$copy"
  KOVA_DIR="$KOVA_DIR" KOVA_DATA="$DATA_DIR" bash "$copy" >"$LOG" 2>&1
  code=$?
  rm -f "$copy"
  to=$(version_at HEAD)
  chown kova:kova "$LOG" 2>/dev/null || true
  local tail; tail=$(tail -n 15 "$LOG" | json_lines)
  case $code in
    0) status "{\"state\":\"idle\",\"last\":{\"result\":\"updated\",\"from\":\"$from\",\"to\":\"$to\",\"at\":$(now),\"log\":$tail}}" ;;
    3) status "{\"state\":\"idle\",\"last\":{\"result\":\"rolled-back\",\"from\":\"$from\",\"to\":\"$from\",\"at\":$(now),\"log\":$tail}}" ;;
    *) status "{\"state\":\"idle\",\"last\":{\"result\":\"failed\",\"from\":\"$from\",\"to\":\"$to\",\"at\":$(now),\"log\":$tail}}" ;;
  esac
  check || true
}

case "${1:-}" in
  check) check ;;
  apply) apply ;;
  request)
    req=$(cat "$UPD/request" 2>/dev/null || true)
    rm -f "$UPD/request"
    case "$req" in
      apply*) apply ;;
      check*) check ;;
      *) echo "Nothing asked (\"$req\")" ;;
    esac ;;
  *) echo "Usage: updater.sh check|apply|request" >&2; exit 64 ;;
esac
