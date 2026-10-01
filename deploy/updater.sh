#!/usr/bin/env bash
# Kova's updater, run as root by systemd on the hub's behalf (the hub runs as the unprivileged `kova` user):
#
#   updater.sh check     say whether a newer Kova is out (kova-update-check.timer, every 6 h)
#   updater.sh apply     update to it, backing up first and going back by itself if the new version doesn't come up
#   updater.sh request   do what the hub asked: it writes "check" or "apply" to $DATA_DIR/update/request,
#                        which kova-update.path watches
#
# Where updates come from:
#   release  ClickBit's catalog (clickbit-admin), like Helix and Warden: the licence's device token asks for the
#            newest Kova, the bundle is downloaded and checked against the catalog's sha256, then
#            deploy/install-release.sh unpacks it beside the running one in $KOVA_DIR/releases/<version>,
#            switches $KOVA_DIR/current to it, and switches back when it doesn't come up. Used once a licence is
#            installed (Integrations → Kova updates), or when the box already runs a release.
#   git      the box is a git checkout without a licence: fetch the branch, deploy/update.sh pulls. Only while boxes
#            move to releases; KOVA_UPDATE_SOURCE=git|release in kova.env picks one.
#
# Everything the hub shows comes from $DATA_DIR/update/status.json, written here (readable by kova).
set -uo pipefail

KOVA_DIR=${KOVA_DIR:-/opt/kova}
DATA_DIR=${KOVA_DATA:-/var/lib/kova}
ENV_FILE=${KOVA_ENV_FILE:-/etc/kova/kova.env}
BRANCH=${KOVA_BRANCH:-main}
UPD="$DATA_DIR/update"
STATUS="$UPD/status.json"
LOG="$UPD/last-update.log"

install -d -o kova -g kova -m 0750 "$UPD" 2>/dev/null || mkdir -p "$UPD"

# A setting from kova.env, unless the environment has it.
setting() { local v="${!1:-}"; [[ -n "$v" ]] || v=$(sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n1 || true); printf '%s' "$v"; }
# The running Kova: $KOVA_DIR/current (a release, or "." for the checkout itself), or the checkout before that.
root_dir() { if [[ -d "$KOVA_DIR/current/hub" ]]; then echo "$KOVA_DIR/current"; else echo "$KOVA_DIR"; fi; }
on_release() { [[ "$(readlink "$KOVA_DIR/current" 2>/dev/null || true)" == releases/* ]]; }
has_licence() { [[ -f "$UPD/licence.json" ]] && grep -q '"key"' "$UPD/licence.json"; }
source_kind() {
  local s; s=$(setting KOVA_UPDATE_SOURCE)
  if [[ "$s" == git || "$s" == release ]]; then echo "$s"
  elif on_release || has_licence || [[ ! -d "$KOVA_DIR/.git" ]]; then echo release
  else echo git; fi
}

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
running_version() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)}catch{console.log("")}' "$(root_dir)/hub/package.json"; }
version_at() { git -C "$KOVA_DIR" show "$1:hub/package.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})'; }
json_lines() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))'; }

# src/tools/release.ts of the running Kova, with the catalog settings from kova.env.
release_tool() {
  local sha=""
  [[ -d "$KOVA_DIR/.git" ]] && ! on_release && sha=$(git -C "$KOVA_DIR" rev-parse HEAD 2>/dev/null || true)
  (cd "$(root_dir)/hub" && env KOVA_DATA="$DATA_DIR" KOVA_GIT_SHA="$sha" \
    KOVA_UPDATE_URL="$(setting KOVA_UPDATE_URL)" KOVA_UPDATE_CHANNEL="$(setting KOVA_UPDATE_CHANNEL)" KOVA_PRODUCT="$(setting KOVA_PRODUCT)" \
    node --import tsx src/tools/release.ts "$@")
}

check_release() {
  local out
  out=$(release_tool check 2>"$UPD/check.err"); local code=$?
  [[ -n "$out" ]] || out=$(head -c 300 "$UPD/check.err" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({error:s.trim()||"The release check didn’t run"})))')
  status "$(node -e '
    const [r, at, cur] = [JSON.parse(process.argv[1]), Number(process.argv[2]), process.argv[3]];
    const o = r.offer;
    const changes = o && o.releaseNotes ? String(o.releaseNotes).split("\n").map(s => s.replace(/^\s*[-*•·]\s*/, "").trim()).filter(Boolean).slice(0, 20) : [];
    const p = { state: "idle", updater: 1, source: "release", checkedAt: at, checkError: r.error ? [r.error] : null, soft: r.soft || null };
    if (!r.error) {
      p.current = { version: (r.current && r.current.version) || cur, ...(r.current && r.current.commit ? { commit: r.current.commit.slice(0, 7) } : {}) };
      p.available = o ? { version: o.version, commit: (o.gitSha || "").slice(0, 7), behind: Math.max(changes.length, 1), changes } : null;
    }
    console.log(JSON.stringify(p));
  ' "$out" "$(now)" "$(running_version)")"
  return $code
}

check_git() {
  if ! git -C "$KOVA_DIR" fetch --quiet origin "$BRANCH" 2>"$UPD/fetch.err"; then
    status "{\"state\":\"idle\",\"source\":\"git\",\"checkedAt\":$(now),\"checkError\":$(head -c 300 "$UPD/fetch.err" | json_lines)}"
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
      state: "idle", updater: 1, source: "git", soft: null, checkedAt: Number(at), checkError: null,
      current: { version: cur, commit: head.slice(0, 7) },
      available: Number(behind) > 0 ? { version: next, commit: remote.slice(0, 7), behind: Number(behind), changes: JSON.parse(changes) } : null,
    }));
  ' "$head" "$remote" "$behind" "$(version_at HEAD)" "$(version_at "origin/$BRANCH")" "$changes" "$(now)")"
}

check() {
  status "{\"state\":\"checking\"}"
  if [[ "$(source_kind)" == release ]]; then check_release; else check_git; fi
}

# Run a copy of an install script: the update replaces it while it runs, and bash reads a script as it goes.
run_copy() {
  local script=$1; shift
  local copy; copy=$(mktemp /tmp/kova-update.XXXXXX.sh)
  cp "$script" "$copy"
  KOVA_DIR="$KOVA_DIR" KOVA_DATA="$DATA_DIR" KOVA_ENV_FILE="$ENV_FILE" bash "$copy" "$@" >>"$LOG" 2>&1
  local code=$?
  rm -f "$copy"
  return $code
}

apply() {
  local from to code kind
  from=$(running_version)
  kind=$(source_kind)
  status "{\"state\":\"updating\",\"startedAt\":$(now)}"
  : >"$LOG"
  if [[ "$kind" == release ]]; then
    # What the catalog has now (not what the last check saw), downloaded and verified, then installed beside this one.
    local version out
    out=$(release_tool check 2>>"$LOG")
    version=$(node -e 'try{const r=JSON.parse(process.argv[1]);console.log(r.offer?r.offer.version:"")}catch{console.log("")}' "$out")
    if [[ -z "$version" ]]; then
      echo "Nothing to update to: $out" >>"$LOG"; code=1
    else
      local bundle="$UPD/kova-$version.tar.gz"
      echo "==> Downloading Kova $version" >>"$LOG"
      if release_tool download "$version" "$bundle" >>"$LOG" 2>&1; then
        run_copy "$(root_dir)/deploy/install-release.sh" "$bundle"; code=$?
      else
        code=1
      fi
      rm -f "$bundle" "$bundle.part"
    fi
  else
    run_copy "$KOVA_DIR/deploy/update.sh"; code=$?
  fi
  to=$(running_version)
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
