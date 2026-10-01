# Versions, store builds and over-the-air updates

Kova ships two things that move independently:

| Component | Version file | Ships as |
| --- | --- | --- |
| Kova hub | `hub/package.json` | Release bundles from ClickBit's catalog (`scripts/build-release.sh`, [DOCKBIT.md](DOCKBIT.md)); `git pull` while boxes move over; the Docker image |
| Kova (phone app) | `mobile/src/version.json` | a TestFlight / App Store / Play binary per native train, and JavaScript over the air from the hub |

`release/components.json` maps source paths to components. `node scripts/check-versions.mjs
--against <base>` fails a change that touches a component without bumping its version.

## The phone app: MAJOR.MINOR.PATCH

The owner's standard for every app (the same as Helix and Warden):

- **MAJOR** is the App Store line. `X.0.0` is what Apple approves. Kova's first App Store release
  will be **1.0.0**.
- **MINOR** is a native store build on that line. It changes when native code changes and a new
  binary is built. Kova starts at **0.1.0**.
- **PATCH** is an over-the-air update: JavaScript and assets only, with no store build (0.1.1,
  0.1.2, and so on).

### Rules

1. A store binary is always `X.Y.0`. A new native build bumps MINOR and resets PATCH (0.1.3 →
   0.2.0).
2. Over-the-air updates only ever bump PATCH, on top of the binary they run on (0.2.0 → 0.2.1).
3. No native change, no store build. If the native fingerprint equals the last store build's, ship
   over the air.
4. Never reuse an approved version; versions only go up.
5. A new MAJOR is a new App Store line, starting at `X.0.0` (`store-release.mjs mobile --major`).
6. Each binary has a native **train** named after the version line it builds:
   `kova-mobile-<MAJOR>.<MINOR>` of its store version. `kova-mobile-0.1` builds 0.1.0 and its
   updates 0.1.x; `kova-mobile-0.2` builds 0.2.0; `kova-mobile-1.0` builds 1.0.0. The train is
   app.json's `runtimeVersion` and `mobile/src/version.json`'s `train`, and a bundle only reaches
   binaries on its train. `check-versions.mjs` refuses a train that doesn't name its store
   version's line.
7. Build numbers (iOS `CFBundleVersion`, Android `versionCode`) only go up, per platform. EAS keeps
   them (`appVersionSource: remote`, `autoIncrement`), and `release/store-builds.json` records each
   one.

`mobile/src/version.json` holds:
- `train`;
- `store`, the `X.Y.0` the binary carries, which is app.json's `version`;
- `version`, what runs, store or over the air;
- `history`, newest first.

The More screen shows the running version.

### Where updates come from

Never Expo's cloud. The app updates from the **Kova hub it's connected to**, the same model as
Helix Server. The bundle comes from the box on the home network, so it works with the internet
down.

- **In the app:**
  - app.json's `updates.url` is a placeholder (`https://updates.invalid/...`).
  - Once the app knows its hub, `mobile/src/native/updates.ts` points expo-updates at
    `<hub>/api/app/manifest` with `setUpdateURLAndRequestHeadersOverride`. That needs
    `disableAntiBrickingMeasures`.
  - It does this once per hub address, with no request headers. expo-updates only launches a
    downloaded update whose URL and headers still match, so changing either would strand
    everything already downloaded.
  - The app checks when it connects and when it comes back to the front, at most every 30 min.
  - A downloaded update runs from the next launch.
- **On the hub:** `hub/src/api/app-updates.ts` speaks Expo's updates protocol (v1).
  - It serves the newest `ota/<train>/<update>/` for the phone's `expo-runtime-version` and
    `expo-platform`.
  - It answers 204 when there is nothing, or when the phone already runs it.
  - Asset URLs point back at the address the phone used.
  - The manifest and assets need no token: the headers must never change, and the bundle is the
    app's own code. Everything else under `/api` still needs one.
  - `KOVA_OTA_DIR` moves the folder.
- **Update ids** are derived from content. The same bundle has the same id wherever it is
  published, so a phone isn't offered what it already runs.
- **Rolling back** is deleting the newest `ota/<train>/<update>/`.

### Doing it

| What | Command |
| --- | --- |
| Over-the-air release | `node scripts/export-ota.mjs "What changed"`. It checks the native lock, bumps PATCH, adds the history entry, runs `expo export` (iOS and Android) into `ota/<train>/<timestamp>/` with the bundle's version in `expoConfig.json`, and keeps the newest 2 per train. Commit `mobile/src/version.json` and `ota/` together, with a hub PATCH bump (`ota/` ships in the hub's release bundle); hubs get it with their next update. |
| New native build (MINOR) | `node scripts/store-release.mjs mobile "What's new"`. It moves to `X.(Y+1).0` on train `kova-mobile-X.(Y+1)`, and rewrites app.json, version.json and `mobile/native-lock.json`. It refuses when nothing native changed since the last store build. |
| New App Store line (MAJOR) | `node scripts/store-release.mjs mobile --major "Kova 1.0"`, giving `(X+1).0.0` on `kova-mobile-(X+1).0`. |
| Before a store build (DockBit) | `node scripts/check-versions.mjs --store-build mobile` |
| After an upload (DockBit) | `node scripts/store-release.mjs --shipped mobile <build> --platform ios --channel testflight` |
| After App Review approves | `node scripts/store-release.mjs --approved mobile <version> <build>` |
| Check everything | `node scripts/check-versions.mjs`, `node scripts/native-fingerprint.mjs`, `node --test scripts/versioning.test.mjs` |

### The native fingerprint

`mobile/native-lock.json` pins the train to a fingerprint (`scripts/native-fingerprint.mjs`) of
everything the binary is built from:
- the phone app's dependencies, minus the JavaScript-only ones in `scripts/js-only-deps.txt`, at
  the versions `package-lock.json` resolves;
- app.json's native config, minus `version`, `runtimeVersion`, `extra` and `owner`;
- the images that config names;
- every tracked file under `mobile/targets/`, `mobile/modules/`, `mobile/plugins/` and
  `mobile/ios-app/`.

`--check` fails when the fingerprint moved but the train didn't. `export-ota.mjs` runs it first,
so a bundle can never reach a binary that lacks its native code. `--print` is what DockBit
records with each store build, for rule 3. `--write` updates the lock, and only while the train
has no store build.

### Store setup

- **iOS:**
  - bundle ID `au.clickbit.kova`, team `G5W29SJ797`;
  - App Group `group.au.clickbit.kova`;
  - widget extension `au.clickbit.kova.widget` (target `KovaWidgets`: widgets, the Live Activity
    and the Siri intents).
- **Android:** package `au.clickbit.kova`.
- **EAS:** `mobile/eas.json` `production` profile (store distribution, remote auto-increment). The
  Expo project (`extra.eas.projectId`) comes from `eas init` under the owner's Expo account
  (`owner: dkathel`, like Helix and Warden).
