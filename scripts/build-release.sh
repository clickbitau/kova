#!/usr/bin/env bash
# build-release.sh — the update-channel artifact for DockBit's artifactConfig (service kova-hub, product kova):
#
#   buildCmd:     ./scripts/build-release.sh
#   artifactPath: dist/kova-release.tar.gz
#   versionCmd:   ./scripts/version.sh
#
# The tar holds one Kova release, as parts the box unpacks into $KOVA_DIR/releases/<version>
# (deploy/install-release.sh):
#
#   root.tar.gz          package.json, package-lock.json (the npm workspace)
#   hub.tar.gz           hub/ (package.json, tsconfig.json, src/) — Node runs the TypeScript through tsx
#   web.tar.gz           web/ (the hub's pages)
#   ota.tar.gz           ota/ (the app's over-the-air bundles the hub serves)
#   deploy.tar.gz        deploy/ (the updater, the installer, the systemd units)
#   node_modules.tar.gz  production dependencies, installed with this Node (KOVA_RELEASE_MODULES=0 leaves them out;
#                        a box whose Node ABI, OS or CPU differs runs npm ci from the lockfile instead)
#   manifest.json        last: product, version, gitSha, the Node it needs, and each part's sha256 and size
#
# Files come from git (tracked files only), so nothing local leaks in. The hub's typecheck and tests run first
# (KOVA_RELEASE_SKIP_TESTS=1 skips them); any failure refuses the release and leaves no artifact behind.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { echo "== $(date +%T) $*"; }

VERSION="${VERSION:-$(./scripts/version.sh)}"
COMMIT="$(git rev-parse "${GIT_COMMIT_SHA:-HEAD}")"
OUT="dist/kova-release.tar.gz"
mkdir -p dist
# One build at a time per checkout: two builds share $OUT.
if command -v flock >/dev/null 2>&1; then exec 9>dist/.build-release.lock; flock 9; fi
# No artifact at all while building: a failed build must not leave the previous release where the publisher looks.
rm -f "$OUT" "$OUT.sha256"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kova-release.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
step "Kova $VERSION ($COMMIT)"

if [[ "${KOVA_RELEASE_SKIP_TESTS:-}" != 1 ]]; then
  step "npm ci"
  npm ci --no-audit --no-fund
  step "typecheck"
  npm run typecheck
  step "hub tests"
  npm test
fi

# The release tree, from git: the code as committed (the version above is the committed hub/package.json).
step "release tree"
TREE="$STAGE/tree"; PARTS="$STAGE/parts"; mkdir -p "$TREE" "$PARTS"
git ls-files -z -- package.json package-lock.json hub/package.json hub/tsconfig.json hub/src web ota deploy \
  | tar --null -T - -cf - | tar -xf - -C "$TREE"

if [[ "${KOVA_RELEASE_MODULES:-1}" != 0 ]]; then
  step "production dependencies (node $(node --version), $(node -p 'process.platform+"-"+process.arch'))"
  (cd "$TREE" && npm ci --omit=dev -w hub --include-workspace-root --no-audit --no-fund >/dev/null)
fi

step "parts"
tar_part() { local name=$1; shift; tar --owner=0 --group=0 --numeric-owner -czf "$PARTS/$name.tar.gz" -C "$TREE" "$@"; }
tar_part root package.json package-lock.json
tar_part hub --exclude=hub/node_modules hub
tar_part web web
mkdir -p "$TREE/ota"; tar_part ota ota
tar_part deploy deploy
if [[ -d "$TREE/node_modules" ]]; then
  # npm puts a dependency under hub/node_modules when the root's copy is another version.
  tar_part node_modules node_modules $([[ -d "$TREE/hub/node_modules" ]] && echo hub/node_modules)
fi

step "manifest.json + $OUT"
node ./scripts/pack-release.mjs --parts "$PARTS" --version "$VERSION" --commit "$COMMIT" --out "$OUT"
ls -la "$OUT" "$OUT.sha256"
