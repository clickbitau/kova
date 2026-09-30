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
| `virtual` | The demo home: 28 devices modelled on the owner's former setup. On by default (`KOVA_DEMO=0` turns it off). |
| `sonos` | Local UPnP. Discovers speakers over SSDP, or uses `KOVA_SONOS_HOSTS` for speakers on another VLAN. Supports play source / pause / volume, and polls state every 5 s. Tested against a fake speaker only; not yet tried on real hardware. |
| Matter | Next. Planned on `matter.js`. |
| Google Cast, TP-Link (Kasa/Tapo), Tuya local, Hue, VeSync, Nest, GoodWe… | Planned. |

## API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | Everything the UI needs |
| GET | `/api/boot.js` | Same, as a script, for the first paint |
| GET | `/api/preview?hour=23.5` | Device states at that hour, per today's plan |
| WS | `/api/ws` | Pushes `{type:'state'}` on every change |
| POST | `/api/devices/:id` | Command `{on, bri, k, color, mode, media, vol}` → `{undo}` |
| POST | `/api/devices/:id/event` | Device event `{type:'person'|'ring'|…}` (webhooks, testing) |
| POST | `/api/rooms/:id/off` | Room lights off → `{undo}` |
| POST | `/api/overlays/:id/start`, `/api/overlays/end` | |
| POST | `/api/plan/skip` | `{id, skip}`: skip tonight |
| POST | `/api/findings/:id/fix`, `/dismiss` | → `{undo}` |
| PATCH | `/api/modes/:id` | `{lightTheWay, onlyWhenSomeoneHome}` → `{undo}` |
| POST | `/api/people/:id/presence` | `{home, source}`, e.g. from an iOS Shortcut until the app exists |
| POST | `/api/undo/:id` | |
| POST | `/api/ask`, `/api/ask/act` | Ask Kova |

Set `KOVA_TOKEN` to require `Authorization: Bearer <token>` on every API call.
Open the UI once with `?token=…` and it remembers the token. This is a stopgap
until real accounts exist.

## What's real and what's sample data in the UI

| Real (from the hub) | Still sample data |
|---|---|
| Now (mode, timeline, just happened, coming up, skip, overlays, rooms, findings, preview), Modes (editor, findings and fixes, Light the way, 14-day squares), Rooms and the device drawer, Media, Activity and inbox, Ask Kova, Integrations, Developer, people and events on Security | Energy numbers (needs an inverter/meter adapter), camera video (needs go2rtc/WebRTC), the Import from HA screen, and the imported-rules list |
