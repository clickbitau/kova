# Kova for DockBit

What DockBit needs to build, publish and ship Kova releases. The hub takes them from ClickBit's catalog the way
Helix's server does (helix `docs/DOCKBIT.md`, `server/internal/update`).

## Release build

The artifact service **`kova-hub`**, product **`kova`**:

```yaml
artifactConfig:
  buildCmd:     ./scripts/build-release.sh
  artifactPath: dist/kova-release.tar.gz
  versionCmd:   ./scripts/version.sh
```

- `scripts/version.sh` prints the release version: `$VERSION` when set, else `hub/package.json`'s version. Every
  hub change bumps it (`scripts/check-versions.mjs` enforces that in CI), so each merge to `main` that touches the
  hub is a new version; one that doesn't changes nothing the hub would install.
- `scripts/build-release.sh` needs Node 22 (`>=22.13`, `hub/package.json` engines), npm, git and network for npm.
  It runs `npm ci`, the hub's typecheck and tests (`KOVA_RELEASE_SKIP_TESTS=1` skips them), takes the tracked
  files from git, installs production dependencies, and packs. A failure exits non-zero and leaves **no**
  `dist/kova-release.tar.gz` (also `dist/kova-release.tar.gz.sha256`, the whole file's hash).
- Build on **linux-x64**, the boxes' platform: the bundle carries `node_modules` installed by the builder's Node
  (`hap-controller` has a native part). A box whose Node ABI, OS or CPU differs installs them itself from the
  lockfile instead (`npm ci`). `KOVA_RELEASE_MODULES=0` leaves `node_modules` out entirely.

The tarball (`scripts/pack-release.mjs` writes it to a temp name, reads it back and checks it, then renames):

```
root.tar.gz          package.json, package-lock.json
hub.tar.gz           hub/ (package.json, tsconfig.json, src/)
web.tar.gz           web/
ota.tar.gz           ota/ (the app's over-the-air bundles)
deploy.tar.gz        deploy/ (updater, installer, systemd units)
node_modules.tar.gz  optional
manifest.json        last entry
```

```json
{
  "product": "kova", "version": "0.7.0", "gitSha": "<40 hex>", "builtAt": "2026-10-01T10:56:40Z",
  "node": { "min": "22.13", "abi": "127", "platform": "linux", "arch": "x64" },
  "parts": { "hub": { "file": "hub.tar.gz", "sha256": "<64 hex>", "size": 274391 }, "…": {} }
}
```

## Licences

- Each hub has a **hub ID**, `KOVA-` and 12 base32 characters (`KOVA-7QH2-M9XC-4TPR`), made once and shown on its
  update card. An admin issues the Kova licence for it (Licensing → Kova → New licence); it is the key's `site` and
  the `siteId` the hub activates with.
- Keys are ClickBit's `CR1-<payload>.<signature>` (Ed25519, the same signing key as Helix and Warden, compiled into
  `hub/src/services/licence-key.ts`; `GET /v1/public/pubkey` serves it). The hub accepts a key only when the
  signature verifies, `product` is `kova` (keys without a product are refused), `site` is this hub's ID (or empty),
  and it isn't past `expiresAt`, so a wrong key is caught before anything is sent.
- The licence gates release updates only. `features` and `edition` are shown on the card; no Kova feature is
  locked behind them yet.

## What the hub asks the catalog

Same calls and auth as Helix (`https://admin.clickbit.com.au/api`; `KOVA_UPDATE_URL` overrides):

| Call | When |
|---|---|
| `POST /v1/device/activate {licenceKey, siteId: <hub ID>, deviceFingerprint, productVersion}` → `{status, edition, features, deviceToken}` (`deviceToken` null with `reason`, e.g. `site_mismatch`, when it can't be used) | The owner enters the licence key (Integrations → Kova updates); again when the token is about to expire, and on any 401. A 403 from the catalog shows as "the licence isn't active for Kova updates" |
| `GET /v1/updates/check?product=kova&channel=stable&currentVersion=<v>`, `Authorization: Bearer <deviceToken>` → `{updateAvailable, version, gitSha, releaseNotes, sha256, size}` | Every 6 hours, and **Check now** |
| `POST /v1/updates/download-token {product, channel, version}` → `{downloadPath, sha256, size}` | **Update** (or overnight) |
| `GET <origin><downloadPath>` | Then; refused unless `sha256` and `size` are given, and kept only when the bytes match both |

- An offer is ignored when it is the running build (same `gitSha`, or same `version`), not newer by dotted
  comparison, or a version that was rolled back on that box.
- `releaseNotes`: one change per line (`- ` bullets fine); the first lines show on the update card and in the
  "Kova X is available" notification.
- `product` comes from `KOVA_PRODUCT` (or `CLICKBIT_PRODUCT_ID`, as Helix), default `kova`; `channel` from
  `KOVA_UPDATE_CHANNEL`, default `stable`.

## On the box

`deploy/install-release.sh` unpacks each release to `/opt/kova/releases/<version>`, verifies every part against
`manifest.json`, backs up the data, switches `/opt/kova/current`, restarts, and waits for `/api/health` to report the
new version; otherwise it switches back, restores the backup and records the version in
`/var/lib/kova/update/bad-versions`. See `docs/install.md` → Updating.

Boxes installed from git before this keep updating from git until a licence is added (the migration path);
`deploy/update.sh` refuses to run once a box is on releases.

## Running the hub as a DockBit app

The repo's `Dockerfile` is the whole hub: Node, ffmpeg (for seamless repeating sounds), the hub, the web pages and the
phone app's over-the-air updates (`ota/`). It runs as uid 1000 and writes only to `/data`.

- **Data.** Either copy a box's `/var/lib/kova` into `/data` as it is, owned by uid 1000, or restore one of its
  backups (below). Every path is relative to `KOVA_DATA`, except the AirPlay bridge's program, which
  `integrations.json` names (`aircast.binary`). The image ships it at the path a box uses,
  `/opt/airconnect/aircast-linux-<cpu>-static`, so nothing needs mounting.
  Leave `update/status.json` behind, or keep it: with `KOVA_UPDATES_BY` set, the hub ignores it.
- **Moving a hub with its own backup.** A backup holds everything the hub can't make again (`docs/install.md` →
  Backups), the hub's ID and licence included. On the old hub:
  1. `POST /api/backups` with the owner's token makes one now. It answers `{ backup: { name } }`.
  2. `GET /api/backups/<name>` downloads it. Treat the file like a password.
  3. Stop the old hub, so nothing changes after the backup.

  Into the new, stopped app's empty volume:
  `docker run --rm -v <volume>:/data -v <dir>:/in:ro <image> node --import tsx src/tools/restore.ts /in/<name>`.
  It refuses while a hub is using the folder. Restore is not offered in the app on purpose: it replaces the running
  hub's data, so it runs with the hub stopped.
- **Remote access.** The phone keeps every address the hub reports (`GET /api/connect/addresses`) and refreshes the
  list whenever it connects. The remote one is the hub's public URL (`KOVA_REMOTE_URL`, or the notification
  settings' public URL), a Tailscale name such as `https://kova.<tailnet>.ts.net` served by `tailscale serve`, never a
  `100.x` address. A new Tailscale node keeps working with no change in Kova or on phones if it takes the same name:
  remove the old node from the tailnet first (or carry its state), or Tailscale names the new one `kova-1`. If the
  name changes, update the public URL; each phone picks it up the next time it connects at home.
- **Updates.** Set `KOVA_UPDATES_BY=DockBit`. The hub then offers no Check or Update. Settings → Software update says
  updates come from DockBit. The box's own updater (systemd `kova-update*` units, `/opt/kova/releases`) isn't used.
- **Environment.**
  - Set in the image: `KOVA_DATA=/data`, `KOVA_PORT=8140`, `NODE_ENV=production`.
  - From the box's `kova.env`: `KOVA_TOKEN` and `KOVA_MATTER`.
  - Optional, when the box had them: `KOVA_UPDATE_URL`, `KOVA_UPDATE_CHANNEL`, `KOVA_PRODUCT`,
    `KOVA_LOCATION_PROXY_URL`, `KOVA_GOOGLE_MAPS_API_KEY`, `KOVA_BACKUP_TIME`, `KOVA_BACKUP_KEEP`, `KOVA_BACKUP_DIR`,
    `KOVA_HOMEKIT_PORT`, `KOVA_MATTER_BRIDGE_PORT`, `KOVA_SONOS_HOSTS` and `TZ`.
- **Its address at home.** Speakers and Helix fetch sounds from a link with the hub's own IP address in it. In a
  container on several networks (the Swarm overlay, a bridge, the LAN macvlan) the hub uses the address on the
  interface the kernel routes to that device through, not the first private one (an overlay address nothing at home
  can reach). `DOCKBIT_LAN_IP`, which DockBit sets to the app's LAN address, or `KOVA_LAN_IP` wins over that.
- **Network.** The hub must be on the home's LAN, with multicast:
  - mDNS (Cast, HomeKit, `_kova._tcp`, Warden),
  - SSDP (Sonos, TVs),
  - Matter over IPv6, which needs IPv6 link-local.

  Either network gives this: host networking, or a macvlan on the LAN with IPv6 enabled. With a macvlan, keep the
  box's MAC and IP, because the router (Warden), phones and saved pairings know the hub by them. A macvlan container
  can't be reached from its own Docker host, so health checks have to run inside the container (the image's
  HEALTHCHECK does). The phone app's remote address (Tailscale) needs Tailscale in the container's network, for
  example a sidecar sharing its network namespace.
- **Health.** `GET /api/health` on 8140 needs no token and says nothing about the home: `{ ok, version, uptimeS }`.
- **Not part of the hub.** OwnTone (the compose file's second service) is optional, and unused unless an OwnTone
  integration is set up. Chromium isn't used by the hub.
