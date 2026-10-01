#!/usr/bin/env bash
# version.sh — the release version, for DockBit's artifactConfig (versionCmd): $VERSION when set, else the hub's
# version from hub/package.json (bumped with every hub change: scripts/check-versions.mjs, docs/VERSIONING.md).
set -euo pipefail
if [[ -n "${VERSION:-}" ]]; then echo "$VERSION"; exit 0; fi
cd "$(dirname "$0")/.."
node -p 'require("./hub/package.json").version'
