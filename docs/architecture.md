# Kova architecture

Kova is a local-first smart home platform. It is a product, not a Home Assistant
add-on: nothing in Kova depends on HA. The design reference lives in
[`docs/design/`](design/), and the web app in `web/` is that design wired to a real backend.

## The parts

```
┌──────────────┐   REST + WebSocket   ┌───────────────────────────────────────────┐
│  web/ (UI)   │ ◀──────────────────▶ │  hub/  (runs in the customer's home)      │
└──────────────┘                      │                                           │
   later: mobile app, Kova Cloud      │  Engine ── modes, moments, overlays,      │
   relay for remote access            │            behaviours, why, preview, undo │
                                      │  Checker ─ "teach, test, trust" findings  │
                                      │  Assistant ─ Ask Kova                     │
                                      │  Registry ─ every device + live state     │
                                      │  Store ─── SQLite: event log + config     │
                                      │  Adapters ─ one per brand/protocol        │
                                      └───────────────────────────────────────────┘
```

* **Hub** (`hub/`): TypeScript on Node 22. One process per home, one SQLite file.
  It must keep working with the internet down.
* **Web app** (`web/index.html`): the v3 design, served by the hub. The markup is
  unchanged from the design. The logic block at the bottom now reads from the
  hub (`/api/boot.js` for the first paint, `/api/ws` for live updates) and sends
  every action to the API.
* **Later:** Kova Cloud (accounts, remote access relay, push, backups, updates)
  and a mobile app (presence, notifications). Neither exists yet.

## Domain model (`hub/src/model/types.ts`)

| Concept | What it is |
|---|---|
| **Device** | A thing with capabilities (`onoff`, `brightness`, `colorTemp`, `media`, `volume`…). State uses fixed units across brands (brightness 0–100, Kelvin, volume 0–100). |
| **Cause** | Why something changed: `mode`, `moment`, `overlay`, `behaviour`, `user`, `device`, `presence`, `assistant`, `undo`. Attached to every state change. |
| **Rhythm** | A movable time: a clock time, a sun event (± offset), or a prayer time. |
| **Mode** | A time-of-day state (Day, Evening, Wind down, Night, Dawn), with target states. Modes run in the order they're listed. |
| **Moment** | A one-off timed action inside the day ("21:00 rain sounds"). |
| **Overlay** | A temporary state on top of the mode (Movie, Away…). It ends by itself: at a time, when a device turns off, when someone arrives, or manually. |
| **Behaviour** | A reaction rule tied to modes. v1 ships *Light the way*: a camera sees someone, or someone arrives, and their lights come on for N minutes. |
| **Event log** | Every change, with its cause. It powers the timeline, *Why?*, the Activity feed, and the history replay. |

## How the engine works (`hub/src/engine/`)

* **Planner** resolves a *Kova day*: from the first mode's start (sunrise) to the
  same point the next day. Each mode's rhythm is placed in sequence. If a mode
  would land out of order (e.g. a late sunset in summer), it is skipped that
  day, not reordered.
* **Tick**: the engine fires due plan items once a second. On startup it takes
  the current mode as-is and does not replay events it missed while it was off.
* **Overlays** snapshot the devices they change. If a mode starts during an
  overlay, the change is queued into the snapshot for the devices the overlay
  controls, and applied now for everything else. Ending the overlay therefore
  returns the home to the *current* mode, not to where it was an hour ago.
* **Light the way** turns lights on, then turns them back off after N minutes.
  It never turns off a light that was already on, and it stops managing a
  light the moment someone changes it by hand.
* **Only when someone's home**: a mode with this flag still becomes the current
  mode, but its "on" targets wait until someone arrives.
* **Undo**: every user action returns an undo id that is valid for 15 minutes.
* **Why?**: the last cause from the log, plus the next plan item or behaviour
  timer that will touch the device.
* **Preview**: replays today's plan up to any hour to show what the home will
  look like.

### Teach, test, trust (`findings.ts`)

* **Static check**: walks the day's modes and flags a bright light that one mode
  turns on and no later mode mentions before night. From the demo config it
  finds: *Kitchen ceiling stays on all night*. Fix: add "off" to the next mode.
* **History replay**: each mode start records who was home and how many lights
  it switched on. Findings and the 14-day squares come from those records, so
  they fill in as the home runs. Fix: *only when someone's home*.

## Adapters (`hub/src/adapters/`)

An adapter announces devices, reports state changes, and carries out commands.
It never makes decisions. See `sdk.ts`.

| Adapter | Status |
|---|---|
| `virtual` | The demo home: 28 devices modelled on the owner's former setup. Runs when there's no `integrations.json` (or with `KOVA_DEMO=1`). |
| `tuya` | Tuya Wi-Fi switches and lights over the local network, protocol 3.3 and 3.4 (session-key handshake). One Kova device per switch channel, or a dimmable light from its data points. Persistent connection, heartbeat, reconnect with backoff. Needs each device's id, IP and local key. |
| `tapo` | TP-Link Tapo plugs and bulbs over KLAP v2 (local HTTP, AES). On/off, brightness, warmth and colour. Needs the TP-Link account credentials, or the credentials hash Home Assistant stored. Polls every 10 s. |
| `cast` | Google Cast speakers, displays and TVs over Cast v2 (TLS on port 8009) with mDNS discovery. Plays a source's stream URL, sets volume, stops. **Perfect sync:** commands that arrive together (e.g. a mode starting) and play the same source on several speakers go to the Cast group whose members are exactly those speakers, so the speakers sync themselves. Cast groups are made in the Google Home app; Google offers no API to create them. |
| `sonos` | Local UPnP. SSDP discovery or `KOVA_SONOS_HOSTS`. Play source / pause / volume. |
| `airplay` | Kova → AirPlay (Apple TV, HomePod, AirPlay speakers) through an [OwnTone](https://github.com/owntone/owntone-server) server, driven over its JSON API. OwnTone plays one source at a time to any set of AirPlay devices and keeps them in sync; playing the same source on another AirPlay device joins the running stream. OwnTone is GPL, so it runs as its own process (see `docker-compose.yml`). |
| `matter` | Matter over IP as a controller on Kova's own fabric, built on matter.js (`@matter/main` 0.17). On with `KOVA_MATTER=1`; fabric and paired nodes live in `<KOVA_DATA>/matter`. Add a device with its 11/21-digit pairing code or `MT:` QR payload (`POST /api/integrations/matter/commission`); devices already in Google Home / Apple Home join through multi-admin after opening a pairing window there. No BLE, so a brand-new Wi-Fi/Thread device must first be set up by a phone app. Announces one device per On/Off light (`light`), dimmable light (`dimmer`, + `colorTemp` / `color` from ColorControl) and plug (`plug`); ids `matter_<node>_<endpoint>`, room `unassigned` unless given when adding. Follows changes through a subscription and reports `online:false` when it drops. Needs IPv6 and mDNS on the host network (use host networking in Docker). Tested against a matter.js virtual light on matter.js's simulated network; not yet tried on real hardware. |
| `vesync` | Levoit Core 200S/300S/400S/600S purifiers through the **VeSync cloud** (these purifiers have no local API, so this one needs the internet). Logs in like the VeSync app (v1 login, MD5 password), lists devices, and relays `getPurifierStatus` / `setSwitch` / `setPurifierMode` / `setLevel` through `bypassV2`. Kova `fan` devices: on/off and mode `Auto` / `Sleep` / `Manual` (Manual = the last fan speed). Polls every 30 s; a purifier the cloud calls offline is `online: false`. Logs in again once when the token is rejected. `region: "eu"` uses smartapi.vesync.eu. |
| `samsungtv` | Samsung Tizen TVs (2016+) locally. Power state from `http://tv:8001/api/v2/` (`PowerState` on/standby; unreachable = off and offline), polled every 10 s. Keys over the remote-control WebSocket on `wss://tv:8002` (self-signed TLS): the first connection makes the TV ask to allow Kova, and the token it returns is kept in `<KOVA_DATA>/samsungtv/tokens.json` (0600). Off = `KEY_POWER`; on = Wake-on-LAN to the TV's MAC (from config or the info endpoint); volume = DLNA RenderingControl `SetVolume` on port 9197, falling back to `KEY_VOLUP`/`KEY_VOLDOWN` steps from the last volume DLNA reported. Playing sources isn't supported. |
| `goodwe` | GoodWe solar inverters over Modbus TCP (port 502, unit 247), read-only. Default register map is the DT family (PV strings 30103–30108, energy today 30144); every address can be overridden in `integrations.json` because maps differ between families and firmware. An inverter asleep at night reads as 0 W. Feeds the Energy screen. |
| Nest, Ecovacs | Planned. |

All adapters except `virtual` are tested against fake devices that speak the protocol; none has been tried on real hardware yet.

### integrations.json

Real devices are configured in `<KOVA_DATA>/integrations.json` (created with owner-only permissions; it holds device keys and never goes in git):

```json
{
  "tuya": { "devices": [{ "id": "bf…", "host": "192.168.1.230", "key": "16-char-local-key", "version": "3.3",
                          "switches": { "2": { "name": "Kitchen light", "room": "kitchen", "id": "kitchen_ceiling" } } }] },
  "tapo": { "username": "you@example.com", "password": "…", "devices": [{ "host": "10.10.30.218", "room": "lounge", "id": "lamp" }] },
  "cast": { "rooms": { "Music Room Speaker": "music" } },
  "vesync": { "email": "you@example.com", "password": "…", "region": "us", "devices": { "Bedroom Purifier": { "room": "bedroom", "id": "bedroom_purifier" } } },
  "samsungtv": { "tvs": [{ "host": "10.10.30.40", "mac": "a0:d7:f3:11:22:33", "room": "lounge", "id": "lounge_tv" }] }
}
```

`id` is optional everywhere; giving a device the id your modes already use lets you swap simulated devices for real ones without editing the modes.

**In-app setup.** The Integrations screen edits this file. Click a card to open its settings drawer; *Add integration* lists what isn't set up yet. The fields come from `GET /api/integrations/catalog` (`src/integrations-catalog.ts`), one entry per section, so a new section only needs a catalog entry to be configurable. `GET /api/integrations/config` returns the file with every secret (passwords, local keys, tokens, `authHash`, `clientSecret`, `refreshToken`…) replaced by `"••••"` plus a `hasX: true` flag; sending `"••••"` back in `PUT /api/integrations/config/:section` keeps the stored value. A PUT is checked against the catalog (required fields, numbers, rooms that exist, 16-character Tuya keys), written atomically with mode 0600, and applied: device adapters (Tuya, Tapo, Cast, Sonos, AirPlay, GoodWe, Matter, VeSync, Samsung TV) restart on their own, keeping their device ids (devices show offline in between); bridges (AirCast, Apple Home bridge) answer `restartRequired: true`. `DELETE` removes a section and its devices. `POST /api/integrations/:id/test` tries unsaved settings (Tapo, Tuya: the first device; VeSync: signs in; GoodWe, Samsung TV, OwnTone: reach it). All of it sits behind `KOVA_TOKEN` like the rest of `/api/`.

`npx tsx src/tools/import-ha.ts <homeassistant/.storage> ../data` (from `hub/`) writes `integrations.json` and `home.json` from a Home Assistant install: rooms from areas, people, location, localtuya devices with their keys, Tapo hosts plus HA's credentials hash, Cast names mapped to rooms, Samsung TV hosts and MACs, and the VeSync account email with purifier rooms. The VeSync password is not imported: add it as `vesync.password` (the adapter stays off until you do). Samsung TVs ask to allow Kova once, since HA's token belongs to HA. It only reads files; Kova never talks to Home Assistant.

## Bridges (`hub/src/bridges/`)

A bridge is the reverse of an adapter: it exposes Kova's devices to another
ecosystem. It sits on top of the registry, sends every write through
`engine.command()` (so it's logged, undoable and overlay-aware, with the cause
"Apple Home"), and pushes registry changes back out.

**Apple Home** (`homekit.ts`, on `hap-nodejs`; `KOVA_HOMEKIT=1`) publishes one
HAP bridge named after the home. Lights and dimmers become Lightbulbs (with
Brightness, ColorTemperature and Hue/Saturation when the device has them),
plugs become Outlets, purifiers become AirPurifiers (`Auto` ↔ AUTO, any other
mode ↔ MANUAL), and each overlay (Movie, Date, Party…) becomes a Switch that
starts or ends it. Speakers, TVs, cameras and sensors aren't exposed yet.
Accessory UUIDs are derived from device ids, and the bridge's MAC, setup code
and pairings live in `$KOVA_DATA/homekit/`, so restarts keep Home app rooms and
scenes. `GET /api/integrations/homekit` returns the setup code and the
`X-HM://` payload for a pairing QR code. mDNS uses ciao (pure JS), so the hub
needs host networking (or macvlan) for iPhones to find it.

**AirPlay → Cast** (`aircast.ts`) runs AirConnect's `aircast` (MIT) as a
supervised child process, so every Cast speaker, display and Cast group appears
as an AirPlay speaker on iPhones, iPads and Macs. Pick a Cast group in AirPlay
and its speakers play in perfect sync. Kova writes aircast's config, restarts it
with backoff if it dies, and shows its status on the Integrations screen.
Configure it in `integrations.json`:

```json
"aircast": { "binary": "/opt/airconnect/aircast-linux-x86_64", "bind": "eth0", "exclude": ["Bedroom Oled"] },
"airplay": { "url": "http://localhost:3689", "rooms": { "Apple TV": "lounge" } }
```

Sync across brands: speakers of one ecosystem sync with each other (Cast with
Cast through Cast groups, AirPlay with AirPlay through OwnTone). A Cast speaker
and an AirPlay speaker playing together are started at the same moment but
drift apart by up to a second or two; no public protocol lets a third party
sync them sample-accurately.


## API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | Everything the UI needs |
| GET | `/api/boot.js` | Same, as a script, for the first paint |
| GET | `/api/preview?hour=23.5` | Device states at that hour, per today's plan |
| WS | `/api/ws` | Pushes `{type:'state'}` on every change |
| POST | `/api/devices/:id` | Command `{on, bri, k, color, mode, media, vol}` → `{undo}` |
| POST | `/api/devices/:id/event` | Device event `{type:'person'|'ring'|…}` (webhooks, testing) |
| POST | `/api/integrations/matter/commission` | Add a Matter device `{code, room?, name?}` → `{ok, devices}` (needs `KOVA_MATTER=1`) |
| POST | `/api/rooms/:id/off` | Room lights off → `{undo}` |
| POST | `/api/overlays/:id/start`, `/api/overlays/end` | |
| POST | `/api/plan/skip` | `{id, skip}`: skip tonight |
| POST | `/api/findings/:id/fix`, `/dismiss` | → `{undo}` |
| PATCH | `/api/modes/:id` | `{lightTheWay, onlyWhenSomeoneHome}` → `{undo}` |
| POST | `/api/people/:id/presence` | `{home, source}`, e.g. from an iOS Shortcut until the app exists |
| POST | `/api/undo/:id` | |
| POST | `/api/ask`, `/api/ask/act` | Ask Kova |
| GET | `/api/integrations/homekit` | `{enabled, pincode, setupURI, paired}` for the Apple Home bridge |

Set `KOVA_TOKEN` to require `Authorization: Bearer <token>` on every API call.
Open the UI once with `?token=…` and it remembers the token. This is a stopgap
until real accounts exist.

## What's real and what's sample data in the UI

| Real (from the hub) | Still sample data |
|---|---|
| Now (mode, timeline, just happened, coming up, skip, overlays, rooms, findings, preview), Modes (editor, findings and fixes, Light the way, 14-day squares), Rooms and the device drawer, Media, Activity and inbox, Ask Kova, Integrations, Developer, people and events on Security | Energy numbers (needs an inverter/meter adapter), camera video (needs go2rtc/WebRTC), the Import from HA screen, and the imported-rules list |
