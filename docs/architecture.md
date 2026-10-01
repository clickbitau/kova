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
* **On a phone** the web app is the same `web/index.html`: below 760px wide, `web/responsive.css`
  folds the sidebar into a menu behind a top bar, stacks side-by-side layouts and tightens the
  page (`web/responsive.js` opens the menu). Hooks are `data-kova-*` attributes, so the desktop
  layout is untouched. It's installable from Safari (Add to Home Screen); its service worker
  (`web/sw.js`) shows push notifications, and Activity has the switch to turn them on.
* **Phone app page** (`web/phone.html`): now only used inside the Kova phone app
  (`?embed=1`); in a browser it forwards to `/`, keeping notification links
  (`?cam=`, `?do=lights-off`, `?page=`). Tabs: **Now** (the phone design's home screen;
  tap the mode for Modes), **Devices** (every device by room, search, room and type filters, All
  off per room; ⋯ opens the device panel), **Ask**, **Security** (live camera view over WebRTC, a
  grid of all cameras with their latest event image, who's home, today's events) and **More**
  (Modes, Activity, Energy, Media, Customise home, Integrations, Assistant). The device panel has
  every control the device has (brightness, warmth, colour, volume and sources, purifier modes,
  vacuum clean/dock, watch live, power readings), why it's like this and what's next, and its
  settings: name, room, favourite, hidden. **Add** (top of Devices, or *Add a device* when there
  are none) is the one place to add things: a Matter or HomeKit code, a brand's sign-in, speakers
  and TVs Kova found on the network, or a new speaker group. **Speaker groups** (Media, or Add →
  Speaker group) pick any speakers of any brand and name them. **Customise home** edits the home's name, rooms (name,
  icon, order, delete with where their devices go), people, favourites and hidden devices. Links:
  `?cam=<id>` opens that camera live (the doorbell notification's *View camera*),
  `?page=security|more|modes|activity|energy|media|integrations|customise`, `?do=lights-off`.
  A lock-screen Live Activity needs a native app, so it isn't here.
* **Native app** (`mobile/`): Kova for iPhone and Android, Expo SDK 57 / React Native, the same
  stack as the Warden and Helix apps. Same tabs and design as the phone web app, drawn natively:
  **Now**, **Devices** (tiles, the device panel with every control and its settings), **Ask**
  (with the "Understood" chips), **Security** (camera images, who's home, the network, today),
  **More** (Modes with findings and the 14-day test, Activity, This phone). Setup-heavy screens
  (Integrations, Customise, the mode editor, Energy, Media, Add) and live camera video open the
  web app's page in the app (`phone.html?embed=1`, whose back button returns to the app).
  - **Connecting:** scan the code from `web/connect.html` (the desktop sidebar's "Kova on your
    phone", or More in the phone web app): `GET /api/app-link` gives `kova://connect?url=…&token=…`
    and its QR code, to callers that already have the token. Or it looks for a hub on the phone's
    Wi-Fi (`/api/health` on port 8140 across the /24), or you type the address. Kept in the
    Keychain / Keystore.
  - **Live state:** `/api/ws`, reconnecting with backoff and when the app comes to the front;
    changes show at once and the hub's snapshot has the final word; every action's undo is a toast.
  - **Arrive and leave:** the OS watches a 150 m circle around the home (`home.location` in the
    snapshot) and wakes the app on crossing it, which posts to `/api/people/:id/presence` with that
    person's own key (source "Kova app (location)"). A "left" inside the circle is ignored.
  - **Notifications:** `POST /api/push/app {token, personId}` registers the phone's Expo push
    token; the notifier sends through Expo's push service alongside Web Push and ntfy. A tap on
    the doorbell opens its camera; *Turn them off* turns the lights off.
  - **Widgets** (iOS, `targets/widget`, a WidgetKit extension made by `@bacons/apple-targets`):
    *Home* (small, and the lock screen's inline, circular and rectangular) shows the mode, what's
    next and lights on; *Favourites* (medium, large) are buttons that switch a device without
    opening the app (App Intents). Widgets read `/api/state` themselves with the hub's address and
    token from the App Group `group.au.clickbit.kova` (written by `modules/kova-native`), and fall
    back to the last snapshot away from home. **Android**: one widget (`react-native-android-widget`)
    with the mode and four favourites; a tap switches the device from a headless task.
  - **Live Activity** (iOS): the design's lock-screen card and the Dynamic Island: the mode, lights
    on, the next planned change with a progress bar to the next mode, and *Skip* (a
    `LiveActivityIntent` that skips it on the hub). Started from This phone; the app updates it
    while it runs, and it's marked stale after the next change until then.
  - **Siri and Shortcuts**: "Ask Kova" (whatever you say goes to `/api/ask`, and Kova's answer is
    Siri's reply), "Switch the home with Kova" (Movie, Away…), "Turn off the lights with Kova".
    The App Shortcuts provider is in the app (`ios-app/`, added by `plugins/withSiriShortcuts.js`);
    the intents are shared with the widget.
  - **Quick actions** (long-press the icon, both platforms): two scenes, all lights off, Ask.
* **Later:** Kova Cloud (accounts, remote access relay, backups, updates). It doesn't exist yet.

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
* **Learned from you** (`learn.ts`): Kova reads the changes people made by hand
  (app, wall switch, voice) over the last 14 days and spots two habits:
  - the same fix within 30 minutes of a mode starting, on 3 or more days
    (*Wind down could set the lounge lamp the way you like it*). Fix: change
    the mode's target;
  - the same change within about 25 minutes of the same clock time, on 4 or
    more days, that isn't already planned (*You turn off the office ceiling
    around 22:15*). Fix: add a moment.

  Changes Kova made itself never count. Each suggestion says which days it's
  based on; applying one is undoable, and *Not now* hides it for good.

## Adapters (`hub/src/adapters/`)

An adapter announces devices, reports state changes, and carries out commands.
It never makes decisions. See `sdk.ts`. `derive` sets state that follows from
other devices (a speaker group's) without logging it as a change of its own,
`retract` removes devices the adapter no longer has, and `command` receives the
cause, so an adapter that passes a command on keeps who asked. `command` may
resolve with the state the device really took when that's more exact than what
was asked ("the office" → the episode Helix found), and the registry records that.

| Adapter | Status |
|---|---|
| `virtual` | The demo home: 28 devices modelled on the owner's former setup. Runs when there's no `integrations.json` (or with `KOVA_DEMO=1`). |
| `tuya` | Tuya Wi-Fi switches and lights over the local network, protocol 3.3, 3.4 (session-key handshake, HMAC frames) and 3.5 ("6699" frames sealed with AES-GCM, same nonce handshake; replies matched by command since 3.5 devices number their own). One Kova device per switch channel, or one light from its data points: on/off, brightness, warmth and colour, for both generations of Tuya lights (v1 DPs 1–5 with 25–255 brightness and `rrggbbhhhhssvv` colour; v2 DPs 20–24 with 10–1000 brightness and `hhhhssssvvvv` colour; JSON `{h,s,v}` colour is read too). Colour is Kova `#rrggbb` with brightness as the HSV value; dimming a light that shows a colour keeps the colour. Persistent connection, heartbeat, reconnect with backoff. Needs each device's id, IP and local key: from Home Assistant's localtuya (`import-ha.ts`) or, once, from the Tuya IoT cloud (`tuya-keys.ts`, below). A device without an IP yet stays offline. |
| `tapo` | TP-Link Tapo plugs and bulbs over KLAP v2 (local HTTP, AES). On/off, brightness, warmth and colour. Needs the TP-Link account credentials, or the credentials hash Home Assistant stored. Polls every 10 s. |
| `cast` | Google Cast speakers, displays and TVs over Cast v2 (TLS on port 8009) with mDNS discovery. Plays a source's stream URL, sets volume, stops; plays **Helix music as a queue** (below). **Perfect sync:** commands that arrive together (e.g. a mode starting) and play the same source on several speakers go to the Cast group whose members are exactly those speakers, so the speakers sync themselves. Cast groups are made in the Google Home app; Google offers no API to create them. |
| `sonos` | Local UPnP. SSDP discovery or `KOVA_SONOS_HOSTS`. Play source / pause / volume; plays **Helix music as a queue** (below). |
| `airplay` | Kova → AirPlay (Apple TV, HomePod, AirPlay speakers) through an [OwnTone](https://github.com/owntone/owntone-server) server, driven over its JSON API. OwnTone plays one source at a time to any set of AirPlay devices and keeps them in sync; playing the same source on another AirPlay device joins the running stream. Helix music plays as OwnTone's queue (below). OwnTone is GPL, so it runs as its own process (see `docker-compose.yml`). |
| `matter` | Matter over IP as a controller on Kova's own fabric, built on matter.js (`@matter/main` 0.17). On with `KOVA_MATTER=1`; fabric and paired nodes live in `<KOVA_DATA>/matter`. Add a device with its 11/21-digit pairing code or `MT:` QR payload (`POST /api/integrations/matter/commission`); devices already in Google Home / Apple Home join through multi-admin after opening a pairing window there. No BLE, so a brand-new Wi-Fi/Thread device must first be set up by a phone app. Announces one device per On/Off light (`light`), dimmable light (`dimmer`, + `colorTemp` / `color` from ColorControl) and plug (`plug`); ids `matter_<node>_<endpoint>`, room `unassigned` unless given when adding. Follows changes through a subscription and reports `online:false` when it drops. Needs IPv6 and mDNS on the host network (use host networking in Docker). Tested against a matter.js virtual light on matter.js's simulated network; not yet tried on real hardware. |
| `vesync` | Levoit Core 200S/300S/400S/600S purifiers through the **VeSync cloud** (these purifiers have no local API, so this one needs the internet). Logs in like the VeSync app (v1 login, MD5 password), lists devices, and relays `getPurifierStatus` / `setSwitch` / `setPurifierMode` / `setLevel` through `bypassV2`. Kova `fan` devices: on/off and mode `Auto` / `Sleep` / `Manual` (Manual = the last fan speed). Polls every 30 s; a purifier the cloud calls offline is `online: false`. Logs in again once when the token is rejected. `region: "eu"` uses smartapi.vesync.eu. |
| `samsungtv` | Samsung Tizen TVs (2016+) locally. Power state from `http://tv:8001/api/v2/` (`PowerState` on/standby; unreachable = off and offline), polled every 10 s. Keys over the remote-control WebSocket on `wss://tv:8002` (self-signed TLS): the first connection makes the TV ask to allow Kova, and the token it returns is kept in `<KOVA_DATA>/samsungtv/tokens.json` (0600). Off = `KEY_POWER`; on = Wake-on-LAN to the TV's MAC (from config or the info endpoint); volume = DLNA RenderingControl `SetVolume` on port 9197, falling back to `KEY_VOLUP`/`KEY_VOLDOWN` steps from the last volume DLNA reported. `input` (`hdmi1`…`hdmi4`, `tv`) presses `KEY_HDMI<n>`/`KEY_TV` while the TV is on; the TV can't say which source it's on, so `input` isn't kept as state and asking again presses the key again. Playing sources isn't supported. |
| `goodwe` | GoodWe solar inverters over Modbus TCP (port 502, unit 247), read-only. Default register map is the DT family (PV strings 30103–30108, energy today 30144); every address can be overridden in `integrations.json` because maps differ between families and firmware. An inverter asleep at night reads as 0 W. Feeds the Energy screen. |
| `homekit` | HomeKit accessories over IP, with Kova as the controller (like Home Assistant's `homekit_controller`; the reverse of the Apple Home bridge below). mDNS (`_hap._tcp`) discovery, pair-setup with the code on the label, pair-verify on every start, live updates through HAP event subscriptions, `online:false` and reconnect with backoff when an accessory drops, and mDNS to follow accessories that change IP. One Kova device per service, id `homekit_<accessory id>_<aid>_<iid>`: Lightbulb → light/dimmer (On, Brightness, ColorTemperature mireds ↔ K, Hue/Saturation ↔ `#rrggbb`), Outlet → plug, Switch → light, Fan/Fanv2/AirPurifier → fan (Active or On; TargetAirPurifierState/TargetFanState AUTO ↔ `Auto`, manual ↔ `Sleep`). Other services are ignored for now. Long-term keys live in `$KOVA_DATA/homekit-controller/pairings.json` (mode 0600). An accessory takes one admin controller, so remove it from the Home app (or reset it) before pairing it with Kova. Built on [`hap-controller`](https://github.com/Apollon77/hap-controller-node) (MPL-2.0, used unmodified as a dependency). Tested against a real `hap-nodejs` accessory; IP only, no BLE. |
| `ecovacs` | Ecovacs DEEBOT robot vacuums (T-series and other "mqtt/json" bots, e.g. the T50 OMNI) through the **Ecovacs cloud**. DEEBOTs have no local API, so this needs the internet and the Ecovacs account, and breaks if Ecovacs changes its API. Modelled on the behaviour of the open-source `deebot-client` library (no code taken): a three-step login (signed `user/login` on `gl-{country}-api.ecovacs.com` with an MD5 password → `getAuthCode` on `gl-{country}-openapi.ecovacs.com` → `loginByItToken` on the IoT portal `api-app.dc-{continent}.ww.ecouser.net`), `GetGlobalDeviceList`, then JSON commands through `iot/devmanager.do`: `clean_V2` (start/pause/resume/stop), `charge` (go to dock), and `getCleanInfo_V2` / `getChargeState` / `getBattery`. Kova `vacuum` devices: `on: true` starts (or resumes) an auto clean, `on: false` sends it to the dock; state has `activity` (cleaning, returning, docked, paused, idle, error) and `battery`. Polls every 60 s, plus once shortly after a command; a bot the cloud lists as offline, or that times out, is `online: false`. Logs in again once when the portal rejects the token. A wrong email/password shows on the Integrations screen and isn't retried until restart (to avoid locking the account). **Uncertain:** the app keys, host names, continent mapping and error codes are from memory of `deebot-client` and haven't been checked against the live service; each login step is a separate method so it can be fixed on its own, and `urls` in `integrations.json` overrides the hosts. No real-time MQTT, no room/zone cleaning, no legacy XMPP bots. |
| `nest` | Google Nest doorbells and cameras (and the Nest Hub Max) through Google's **Smart Device Management (SDM) cloud API**: there is no local API for these devices. Access tokens come from a stored refresh token (`oauth2.googleapis.com/token`) and are cached until a minute before they expire; a 401 gets a fresh token and one retry. Devices from `GET /v1/enterprises/{project}/devices` become Kova `camera` devices (`events`), named after the Google Home custom name or room, in the room given by `rooms` or the Google Home room name, with ids from `ids` or `nest_<last 12 of the device id>` (both keyed by SDM device name, device id or display name). **Events** come from the Cloud Pub/Sub subscription (REST `:pull` long-poll + `:acknowledge`, retry with backoff up to 5 min): `CameraPerson.Person` → `person`, `DoorbellChime.Chime` → `ring`, `CameraMotion.Motion` → `motion`, `CameraSound.Sound` → `sound`, each with `eventId`, `eventSessionId` and `timestamp`. Each eventId (and each event type per event session) fires once; events older than 2 minutes are ignored; every message is acked. These events drive Light the way. **Live view** over WebRTC for cameras whose `CameraLiveStream` trait lists `WEB_RTC` (`GenerateWebRtcStream` / `Extend…` / `Stop…`); the video goes straight from Google to the browser. `GET /api/devices/:id/snapshot` returns the latest event's image for cameras with `CameraEventImage` (older models only). Device list refreshed every 10 min (`pollMs`). |
| `warden` | **Warden OS**, the home's router (ClickBIT's own), over its REST API (`/api/v1`, HTTPS with the box's self-signed certificate pinned by SHA-256 fingerprint when linked; `util/lan-http.ts`). **Pairing**: `POST /apps/pair {name: "Kova", scopes}` asks for `devices:read devices:write pause events discovery people:read network:read`; Warden shows the code at `/apps` (System → Accounts → Apps) and Kova polls `GET /apps/pair/{id}` with `X-Pair-Secret` until an admin approves, collecting a token limited to those scopes (once). *Link by signing in* still works (admin login → an operator token named Kova → sign out; the password isn't kept), and so does any token made that way before. **Live events** come from `GET /feed` as Server-Sent Events (`util/lan-http.ts` `lanStream`), resumed with `Last-Event-ID` after a drop (a `feed.missed` triggers a full re-read): `wan.down`/`wan.up` → the **Internet** device (`warden_internet`, a sensor) off/on and `internet-down`/`internet-up`; `wan.failover` → `internet-failover`; `device.new` → `new-device` ("TP-Link device joined IoT"); `threat.blocked` and `ids.alert` → `threat`; `pause.changed` and `device.*` update the switches. `GET /dashboard` and `GET /devices` are re-read every 60 s as a check. **Internet switches** (`devices: [{deviceId? | mac?, name, room}]`) are `internet` devices; Warden's device record (`dev_…`, every MAC and IP the device has used) is what Kova pauses (`POST`/`DELETE /devices/{id}/pause`), found by `GET /devices/by-mac/{mac}` for switches set up by MAC, so a rotating private address or a second network card doesn't lose it; online is Warden's own `online`. Kova ids stay `warden_<mac>` for switches made by MAC. A Warden without device records or the feed (404) gets the old path: `GET /events?since=` incidents, `GET /clients`, `/clients/{mac}/pause` and the site document's `paused-devices`, polled every 20 s. **Kova tells Warden what it knows** (`services/warden-link.ts`, Warden's `docs/KOVA.md`, the `integration` scope; Warden never calls Kova): its devices on the LAN by IP or MAC with name, kind, room, maker and the ports Kova controls them on (`PUT /integrations/kova/devices`; Warden shows Kova's name where it has none and proposes a firewall rule letting Kova reach exactly those, approved by an admin at `/apps`), which Warden person each Kova person is (`PUT …/people`, from *Person in Warden*), every arrive/leave from a phone or the app (`POST …/presence`, so Warden doesn't alarm about the phone of someone Kova knows is home), the house mode (`PUT …/mode`: vacation/holiday, away (also when everyone's out), night/sleep/bed from the mode or overlay's name, else home; re-sent every 6 h), the device Kova runs on (`PUT …/hub`) and the plugs that feed network gear (`PUT …/outlets` from `outlets: [{plug, powers: dev_…|MAC|IP, role?: modem, wan?}]`). Each document is sent again only when it changed. **Restarts**: Warden publishes `power.cycle_requested` on the feed; Kova switches that plug off, waits `offSeconds` (≤ 60), switches it on, answers `POST /power-cycles/{id} {status: done|failed|refused}` and logs it in Activity. A plug not listed (or `canCycle: false`) is refused; an expired or repeated request is never acted on. A token from before the `integration` scope gets a 403 and the status says to pair again. |
| `helix` | **Helix**, the home's media server and TV boxes (ClickBIT's own). Kova **pairs** like any Helix app: `POST /v1/pair/start` gives a code, the owner types it in Helix Server → Devices, and Kova polls `GET /v1/pair/{id}` for its device token (revocable there). Helix Server doesn't announce itself, so *Find* probes the hub's /24 networks on port 8090 (`/v1/hello`), as the Helix apps do. Each box from `GET /v1/boxes` becomes a `tv` with `pause` and `library` (room from `rooms`, by box name). What it's playing comes **live** from Helix's feed (`GET /v1/events` as Server-Sent Events, resumed with `Last-Event-ID`; each connect reads every box once to catch up): `playback.started`/`resumed`/`paused`/`stopped`/`ended` and `player.online`/`offline`, keyed by the box's player id, give `on`, `media` (the title), `paused` and `online`, and the events `video-started`, `music-started`, `paused`, `resumed`, `stopped`. Volume, and everything while the feed is down (or on a Helix without it), comes from reading each box's state through the server's relay (`/v1/boxes/{id}/state`): every 30 s with the feed, every 3 s without. Control goes through the server, which holds each box's remote key, never to the box's own port: `POST /v1/players/{id}/play {itemId, positionMs}`, `pause`, `resume`, `stop`, `volume {level}`. `media` = spoken words is decided by Helix's `GET /v1/resolve?q=` (the episode you're on and where you stopped, a film, music); nothing found is a 404 ("Helix has nothing called …"). **The other way**: once paired, Kova calls `PUT /v1/integrations/kova {url, token, screens: [{playerId, tvDeviceId, tvName, helixInput?}]}` (`services/helix-link.ts`) with its own address (the hub's on Helix's /24, or `kovaUrl`), a token of its own for Helix (`kvh_…`, kept in `<KOVA_DATA>/helix-link.json`, 0600) and which TV each box sits on (the one other TV in the box's room, or `screens: {<box>: {tv, input}}`), again whenever that changes. Helix then turns that TV on and off and switches its input through Kova, from the Helix remotes. Each screen also carries `inputs` (the TV inputs Helix may pick) and, when the TV's room has a soundbar (or `screens: {<box>: {soundbar}}`), Helix's D98.11 soundbar fields: `soundbarDeviceId`, `soundbarName`, `soundbarInputs`, `soundbarModes`, `soundbarNight`, `soundbarTvInput` (`tv`, the eARC) and `soundbarAdapterInput` (the HDMI in the box's DP adapter feeds, `soundbarInput`, default `hdmi1`; D101). Kova never sends `autoSwitch`, so the owner's choice in Helix stands. That token can only `POST /api/devices/<linked TV>` with one of `{on}`, `{input}`, and `POST /api/devices/<linked soundbar>` with one of `{on}`, `{volumeStep: ±1}`, `{volume}`, `{mute}`, `{input}`, `{mode}`, `{nightMode}` (Helix's names, turned into Kova's `on`, `volStep`, `vol`, `muted`, `input`, `sound`, `night`; anything else is a 403). Its `GET /api/state` lists just those devices, by Helix's names: `on`, `input`, `volume`, `muted`, `mode`, `nightMode`, and `inputChangedAt`/`inputChangedBy`. **Switching when something plays is Helix's** (its `kova_soundbar.go`): it sends `X-Helix-Origin: auto` with those commands, Kova records them as `inputChangedBy: "helix-auto"` and anything else (Helix's remote, Kova's app, an automation, the soundbar's own remote read back) as who did it, so Helix never switches back an input someone chose. A TV can't say its input, so its `input` is the last one asked for through Kova. A Samsung TV holds an `input` sent right after `on` until it has woken (up to 30 s). **The doorbell on the TV** (`services/screen-notices.ts`, Helix's D98.5): when a doorbell rings, every Helix box that's on gets `POST /v1/players/{id}/notify {title, body, imageUrl, seconds: 15}`, the picture being the doorbell's snapshot behind a one-picture link (`/api/snap/<random key>`, no token, two minutes) that Helix Server fetches. |
| `smartthings` | **Samsung soundbars** (e.g. HW-Q930B) through SmartThings, Samsung's cloud: Samsung's local soundbar API (JSON-RPC) only exists on the 2024 "D" models and later. Each soundbar on the account (`ocf.deviceType` `oic.d.networkaudio`) is a `media` device with `onoff`, `volume`, `mute`, `input`, `sound`: `switch`, `audioVolume` (`setVolume`, and `volumeUp`/`volumeDown` for `volStep`), `audioMute`, `mediaInputSource` (Kova's `tv` = SmartThings's `digital`, the TV's eARC/optical; `hdmi1`, `hdmi2`, `bluetooth`, `wifi`), and sound mode / night mode through the soundbar's `execute` capability (`/sec/networkaudio/soundmode`, `/sec/networkaudio/advancedaudio`). Power, volume, mute and input are read back every 15 s; sound and night mode can't be, so they're what Kova last set. Signing in: an OAuth-In app made once with the SmartThings CLI (`smartthings apps:create`, scopes `r:devices:* x:devices:*`, redirect `https://httpbin.org/get`), linked from Integrations (*Link SmartThings*, then paste the code). SmartThings replaces the refresh token on every use, so Kova keeps the newest in `<KOVA_DATA>/smartthings/token.json` (0600). A personal access token also works, but SmartThings ends those after 24 h. |

All adapters except `virtual` are tested against fake devices that speak the protocol; none has been tried on real hardware yet.

### Helix music on any speaker (`services/helix-music.ts`)

Once Kova is paired with Helix, every Google Cast, Sonos and AirPlay speaker (and Kova speaker group) can play Helix music:
- **What there is to play:** "Shuffle all", "Loved", each music playlist, and "Station: <artist, album or song>". Ask also finds "Artist: …", "Album: …" and "Song: …" by name. These appear in the snapshot as `music`.
- **What media means:** a speaker's `media` is that name, and `shuffle` says whether the order is shuffled.
- **How a name becomes songs:** `HelixMusic.queueFor(name)` turns it into the songs to play.
  - Shuffle all is Helix's own uniform shuffle of the whole library (`/v1/music/tracks?shuffle=1`), falling back to paging the library on an older Helix.
  - Loved is `?loved=1`; a playlist is `/v1/playlists/{id}`.
  - A station is `/v1/music/mix` plus some of the artist's own songs, shuffled.
  - Kova shuffles everything else itself.
  - Asked again within 10 s, it answers the same order, so a group's speakers play the same queue.
- **Speaker queues:** the speakers play from their own queues, filled a window at a time.
  - Cast: `QUEUE_LOAD` of 20 songs, more added with `QUEUE_INSERT` as it plays. Each item carries its place in Kova's queue (`customData.kova`), so `MEDIA_STATUS` says which song is on.
  - Sonos: the speaker's queue (`AddURIToQueue` with DIDL title, artist and cover, `x-rincon-queue`), 50 songs at a time, followed with `GetPositionInfo`.
  - AirPlay: OwnTone's queue (`POST /api/queue/items/add?uris=…`), 50 songs at a time, played to every selected AirPlay speaker in sync. Kova follows it through the player's `item_id` and the queue position, and moves by position (`PUT /api/player/play?position=`). OwnTone's own shuffle is switched off, since Kova shuffles. OwnTone plays one queue, so AirPlay speakers play one piece of music at a time; another speaker asking for the same music joins it.
  - Speakers that match a Cast group exactly play one queue through it, in perfect sync.
- **What a speaker fetches:** Helix signs a URL per song (`POST /v1/items/{id}/play-url`, AAC at up to 48 kHz, 6 hours, no token in it), asked for just before each window is queued (`Queue.prepare`). An older Helix gets token URLs (`/stream?max=aac&token=…`). Covers are signed too (Helix 1.227): `play-url` returns the song's cover as `artUrl`, and any other cover in the window goes through `POST /v1/art-urls` in one call; one Helix won't sign is left out rather than sent with the token. A Helix without either keeps token cover URLs.
- **Control:**
  - `{skip: 1 | -1}` is next or previous song (momentary, never kept as state).
  - `{shuffle}` reorders what's left and carries on with the same song at the same position.
  - `{media: 'Radio'}` goes back to a plain stream.
- **State:** `track` (title, artist, album, cover, id) is read back from the speaker. Song changes are quiet: they don't go to Activity, but each one is counted as played in Helix (`POST /v1/music/tracks/{id}/played`, under the speaker's name).
- **Where it shows:**
  - The Media page (web and phone) shows the cover, title and artist, with shuffle, previous and next buttons, and a Helix music row: Shuffle all, Loved, playlists, a Shuffle switch and "Station from…".
  - The app's speaker panel has the same.
- **Ask:**
  - "play Bangla Collection on shuffle in the kitchen", "play my loved songs in the lounge", "play music in the kitchen" (Shuffle all), "play a station from Coke Studio in the lounge".
  - "next song" and "previous song in the kitchen", "what's playing?".
  - Music words (songs, playlist, station, shuffle, "by …") pick the speakers; otherwise a room with a Helix box plays the film or show there, as before.
  - Without a room, Ask uses the speakers already playing, or asks where.
- **AirPlay:** it can't play a queue yet, and says so.

### integrations.json

Real devices are configured in `<KOVA_DATA>/integrations.json` (created with owner-only permissions; it holds device keys and never goes in git):

```json
{
  "tuya": { "devices": [{ "id": "bf…", "host": "192.168.1.230", "key": "16-char-local-key", "version": "3.3",
                          "switches": { "2": { "name": "Kitchen light", "room": "kitchen", "id": "kitchen_ceiling" } } }] },
  "tapo": { "username": "you@example.com", "password": "…", "devices": [{ "host": "10.10.30.218", "room": "lounge", "id": "lamp" }] },
  "cast": { "rooms": { "Music Room Speaker": "music" } },
  "vesync": { "email": "you@example.com", "password": "…", "region": "us", "devices": { "Bedroom Purifier": { "room": "bedroom", "id": "bedroom_purifier" } } },
  "samsungtv": { "tvs": [{ "host": "10.10.30.40", "mac": "a0:d7:f3:11:22:33", "room": "lounge", "id": "lounge_tv" }] },
  "homekit": { "accessories": [{ "id": "0E:4B:0A:11:22:33", "name": "Desk lamp", "room": "study" }] }
  "nest": { "projectId": "device-access-project-uuid", "clientId": "….apps.googleusercontent.com", "clientSecret": "GOCSPX-…",
            "refreshToken": "1//0…", "subscription": "projects/my-gcp-project/subscriptions/kova-nest",
            "ids": { "Front door doorbell": "doorbell", "Garage camera": "garage_cam" }, "rooms": { "Front door doorbell": "front" } }
}
```

`homekit` switches on the HomeKit controller; `accessories` is optional and only overrides the name and room of accessories already paired (by their HAP id, as `discover` lists it). Pairing itself happens through the API below, since it needs the setup code once and then keeps keys, not config.

`id` is optional everywhere; giving a device the id your modes already use lets you swap simulated devices for real ones without editing the modes.

**In-app setup.** The Integrations screen edits this file. Click a card to open its settings drawer; *Add integration* lists what isn't set up yet. The fields come from `GET /api/integrations/catalog` (`src/integrations-catalog.ts`), one entry per section, so a new section only needs a catalog entry to be configurable. `GET /api/integrations/config` returns the file with every secret (passwords, local keys, tokens, `authHash`, `clientSecret`, `refreshToken`…) replaced by `"••••"` plus a `hasX: true` flag; sending `"••••"` back in `PUT /api/integrations/config/:section` keeps the stored value. A PUT is checked against the catalog (required fields, numbers, rooms that exist, 16-character Tuya keys), written atomically with mode 0600, and applied: device adapters (Tuya, Tapo, Cast, Sonos, AirPlay, GoodWe, Matter, VeSync, Samsung TV, Ecovacs, Nest, HomeKit devices) restart on their own, keeping their device ids (devices show offline in between); bridges and services (AirCast, the Apple Home and Matter bridges, Presence, Notifications) answer `restartRequired: true`. Tuya has a *Get keys from the Tuya cloud* action that runs the cloud import below and restarts Tuya with the result. `DELETE` removes a section and its devices. `POST /api/integrations/:id/test` tries unsaved settings (Tapo, Tuya: the first device; VeSync: signs in; GoodWe, Samsung TV, OwnTone: reach it). All of it sits behind `KOVA_TOKEN` like the rest of `/api/`.

Tuya lights have the same `host`/`key`/`version` and a `light` instead of `switches`: `"light": { "name": "TV Unit Light", "room": "lounge", "switch": "20", "mode": "21", "bri": "22", "briMin": 10, "briMax": 1000, "temp": "23", "tempMax": 1000, "colour": "24", "colourFormat": "hsv16" }`. `tuya-keys.ts --merge` fills these in.

**Import** in the web app does all of this from an uploaded Home Assistant backup (encrypted SecureTar backups too, with their key) or a config folder on the hub, shows a preview, and switches over (`hub/src/import/`: `ha-source.ts` streams the archive and keeps only `.storage` registries and the YAML files, in `<KOVA_DATA>/import/ha`, owner-only; `ha-scan.ts` builds the preview and turns automations into plain words). The command line does the same without the preview: `npx tsx src/tools/import-ha.ts <homeassistant/.storage> ../data` (from `hub/`) writes `integrations.json` and `home.json` from a Home Assistant install: rooms from areas, people, location, localtuya devices with their keys, Tapo hosts plus HA's credentials hash, Cast names mapped to rooms, Samsung TV hosts and MACs, the VeSync account email with purifier rooms, and the Ecovacs account email and country with vacuum rooms. Neither password is imported: add them as `vesync.password` / `ecovacs.password` (each adapter stays off until you do). Samsung TVs ask to allow Kova once, since HA's token belongs to HA. From HA's `nest` entry it takes the Device Access project id (`project_id`), the Pub/Sub subscription (`subscription_name`), and each Nest camera's room and id from the device registry (keyed by the SDM device name HA stores as the device identifier; the doorbell keeps the id `doorbell`, cameras become `<room>_cam`). HA's Google refresh token and OAuth client are imported only if they're stored in plain form (`token.refresh_token`, and `.storage/application_credentials`); otherwise the report tells you to link Nest (below). Secrets never appear in the report. It only reads files; Kova never talks to Home Assistant.

### Linking Google Nest

Nest devices are only reachable through Google's cloud, with your permission. You need, once:

1. **A Device Access project** (one-time US$5 fee) at <https://console.nest.google.com/device-access>. Its **project id** is `nest.projectId`. If you set up Nest in Home Assistant, you already have one, and the importer copied its id.
2. **An OAuth client** in the Google Cloud console (<https://console.cloud.google.com/apis/credentials>, type *Web application*), in a project with the *Smart Device Management API* and *Cloud Pub/Sub API* enabled. Add `https://www.google.com` to its **Authorized redirect URIs** (or the URI you'll pass as `redirectUri`). Put its id and secret in `nest.clientId` / `nest.clientSecret`, and the same client id in the Device Access project's OAuth client field. The client HA used works if you still have its secret.
3. **A Pub/Sub subscription** for events: in the Device Access console, enable events for the project (it shows a topic like `projects/sdm-prod/topics/enterprise-<project-id>`), then create a *pull* subscription to that topic in your Cloud project and set `nest.subscription` to `projects/<cloud-project>/subscriptions/<name>`. Don't share HA's subscription while HA is still running: each message goes to only one of them. The Google account you link needs permission to pull from it (it does if it owns the Cloud project).
4. **Link the account** (the hub must be running with `nest.projectId`, `clientId` and `clientSecret` set):
   * `GET /api/integrations/nest/auth-url` (optionally `?redirectUri=…`) returns a `url`. Open it, sign in with the Google account that owns the Nest devices, allow Kova to see the cameras and doorbell, and allow both permissions.
   * Google redirects to `https://www.google.com/?code=4/0Ab…&scope=…`. Copy the `code` value (it's valid for a few minutes, once).
   * `POST /api/integrations/nest/auth-code` with `{"code": "4/0Ab…", "redirectUri": "https://www.google.com"}` returns `{refreshToken}`.
   * Save it as `nest.refreshToken` in `integrations.json` and restart Kova. The Nest adapter starts once `projectId` and `refreshToken` are both set.
   * Or do all of this from the app: Integrations → Google Nest has *Link Google account* and *Finish linking*; with in-app setup, the token is saved for you and Nest starts right away (it never goes back to the browser).

If Google returns no refresh token, remove the app's access at <https://myaccount.google.com/permissions> and link again. Refresh tokens of OAuth clients left in *Testing* publishing status expire after 7 days; publish the OAuth consent screen (it can stay unverified for personal use) to keep them.

### Tuya local keys from the Tuya cloud

Tuya devices only talk locally to someone who has their 16-character *local key*, which the Tuya cloud hands out once. `hub/src/adapters/tuya/cloud.ts` is a small Tuya IoT Platform OpenAPI client (HMAC-SHA256 "new sign", `GET /v1.0/token?grant_type=1`), the same route tinytuya's wizard takes. It lists the devices of every app account linked to the cloud project (`/v1.0/iot-01/associated-users/devices`; with a uid, `/v1.0/users/{uid}/devices`, falling back to `/v1.3/iot-03/devices`), and reads each device's specification (`/v1.1/devices/{id}/specifications`, falling back to `/v1.0/devices/{id}/specifications` and `/v1.0/iot-03/devices/{id}/specification`) to map `switch_1…n` to switch channels and `switch_led`/`work_mode`/`bright_value(_v2)`/`temp_value(_v2)`/`colour_data(_v2)` to a light. When the spec has no `dp_id`, the standard numbering is assumed (v1: 1–5, v2: 20–24).

The cloud's `ip` is the home's public address, so it's ignored unless it's a LAN address. IPs come from `discover.ts` instead: Tuya devices broadcast their id, IP and protocol version on UDP 6666 (3.1, plain) and 6667 (3.3+, AES-ECB with md5("yGAdlopoPVldABfn"); 3.5 in a GCM "6699" frame with the same key). Import listens for 6 s. Some 3.5 devices only broadcast after a poke on UDP 7000, which Kova doesn't send yet.

Merging keeps what's already configured: an existing device keeps its host (unless discovery found a new one), switch names, rooms and Kova ids, and gets the fresh key; an existing light keeps its name, room and id and takes the spec's data points. New devices get a room guessed from their name (from `home.json`) and ids like `bedroom_led`. Gateway sub-devices (Zigbee/BLE) and unsupported categories are listed as skipped. The protocol version comes from discovery; without it 3.3 is assumed.

1. Create a free account at [iot.tuya.com](https://iot.tuya.com), then Cloud → Development → Create Cloud Project: any name, industry "Smart Home", development method "Smart Home", **data center = the one your app account is in** (Central Europe for this home: HA's Tuya entry points at `tuyaeu.com`). Accept the default API services (IoT Core and Authorization must be on).
2. In the project: Devices → Link App Account → Add App Account → scan the QR code with the Smart Life (or Tuya Smart) app (Me → the scan icon). Choose "Automatic" and "Read, write and control". The devices appear in the project.
3. Overview tab: copy the Access ID/Client ID and the Access Secret/Client Secret.
4. From `hub/`, on the same network as the devices:
   `TUYA_CLIENT_ID=… TUYA_SECRET=… npx tsx src/tools/tuya-keys.ts --region eu --merge ../data/integrations.json`
   It prints name, id, category, whether a key came back, IP and what Kova made of each device, never the keys; it writes the keys to `integrations.json` (0600). Without `--merge` it only prints. Restart the hub.
5. The IoT Core service is a free trial that expires after a while (it can be extended in the Tuya console). Kova only needs the cloud again when a device is re-paired, which changes its key.

## Bridges (`hub/src/bridges/`)

A bridge is the reverse of an adapter: it exposes Kova's devices to another
ecosystem. It sits on top of the registry, sends every write through
`engine.command()` (so it's logged, undoable and overlay-aware, with the cause
"Apple Home", "Google Home", "Alexa"…), and pushes registry changes back out.

**Apple Home** (`homekit.ts`, on `hap-nodejs`; `KOVA_HOMEKIT=1`) publishes one
HAP bridge named after the home. Lights and dimmers become Lightbulbs (with
Brightness, ColorTemperature and Hue/Saturation when the device has them),
plugs become Outlets, purifiers become AirPurifiers (`Auto` ↔ AUTO, any other
mode ↔ MANUAL), and each overlay (Movie, Date, Party…) becomes a Switch that
starts or ends it. TVs (Samsung, Cast TVs) are published as their own
Television accessories with power and volume, because HomeKit only shows one
bridged TV per bridge and shows it badly; add each TV in the Home app with the
same setup code. Speakers, cameras and sensors aren't exposed.
Devices Kova got from HomeKit or Matter are left out by default (they're
already in Apple Home), and `"homekitBridge": { "exclude": { "devices": [...] } }`
in `integrations.json` leaves out more. `"homekitBridge": {}` turns the bridge
on, like `KOVA_HOMEKIT=1`.
Accessory UUIDs are derived from device ids, and the bridge's MAC, setup code
and pairings live in `$KOVA_DATA/homekit/`, so restarts keep Home app rooms and
scenes. `GET /api/integrations/homekit` returns the setup code and the
`X-HM://` payload for a pairing QR code. mDNS uses ciao (pure JS), so the hub
needs host networking (or macvlan) for iPhones to find it.

**Matter bridge: Google Home, Alexa, SmartThings, Apple Home**
(`matter-bridge.ts`, on matter.js; `KOVA_MATTER_BRIDGE=1` or `"matterBridge": {}`
in `integrations.json`) is the reverse of the Matter adapter: Kova is the
Matter device, a bridge with an aggregator, and each Kova device is a bridged
endpoint, added locally over Matter with the manual pairing code or QR payload.
Lights become On/Off Lights, dimmers Dimmable / Color Temperature / Extended
Color Lights (by their capabilities), plugs On/Off Plug-in Units, purifiers Air
Purifiers (fan mode Off ↔ off, Auto ↔ `Auto`, Low ↔ `Sleep`, High ↔ `Manual`),
and each overlay an On/Off Plug-in Unit named "Kova Movie" that starts or ends
it. Names are "<Room> <Device>" (32 characters at most), and a device offline in
Kova reads as unreachable. Devices Kova got from the `matter` and `homekit`
adapters are left off by default, since they're already in those ecosystems;
`"matterBridge": {"exclude": {"adapters": [...], "devices": [...]}}` changes that
(a given `adapters` list replaces the default). Endpoint numbers are derived
from device ids and kept by matter.js, so a restart keeps rooms and routines in
Google Home. The passcode (random, never one the spec forbids), fabrics and
endpoint numbers live in `$KOVA_DATA/matter-bridge/`. `GET
/api/integrations/matter-bridge` returns the manual code, the `MT:` QR payload,
and which ecosystems it's paired with. Kova's changes are written to the
endpoints as local writes, which the bridge never reads back as a controller's
command, so nothing echoes. It uses Matter's test vendor id (0xFFF1): Apple Home
and SmartThings warn about an uncertified device and carry on; Google Home only
accepts it for accounts that registered that vendor/product id in the Google
Home Developer Console. Needs IPv6 and mDNS on the host network (UDP 5540,
`KOVA_MATTER_BRIDGE_PORT`).

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

**Kova speaker groups** (`hub/src/adapters/groups.ts`): a named set of speakers
of any brand, kept in `HomeConfig.speakerGroups`, appears as one media device
(`group_<id>`) that modes, scenes, routines and the assistant can use like any
speaker. A command to it goes to every member at the same instant (each
member's activity says *through Bedrooms*); its state is derived from its
members (on if any is, *Mixed* when they play different things, the average
volume). When the members are exactly a Cast group from the Google Home app,
the Cast adapter plays through that group, so they're in perfect sync; the
snapshot says `sync: 'perfect'` with the `castGroup`, otherwise `'together'`.


**Behaviours that come with Helix:** an overlay can start by itself on a device
event (`Overlay.startsOn: {device, event}`); Kova suggests "Start Movie when the
lounge Helix plays a film" (a finding) and, accepted, Movie also ends when the box
stops. When the doorbell rings, players that can pause are paused
(`HomeConfig.pauseForDoorbell`, on unless set to false) and the doorbell
notification says so. Ask Kova understands "play The Office in the lounge",
"pause" and "carry on"; the AI tool can set `paused` and a title as `media`.

## Presence and notifications (`hub/src/services/`)

These replace what Home Assistant's iPhone app did: knowing who's home (garage
lights on arrival, Away ending when someone comes home, "only when someone's
home" modes) and doorbell notifications.

### Presence (`presence.ts`)

Several optional sources per person, combined into one home/away that goes to
`engine.setPresence(person, home, source)` (the source shows in Activity):

* **Router (OPNsense)**: every 30 s Kova reads the ARP (and NDP) table from
  `/api/diagnostics/interface/getArp` with the API key/secret as basic auth. A
  person is home when any of their phone MACs is there. Home is immediate; away
  only after the phone has been gone `awayAfterMin` (default 10) minutes, since
  iPhones drop off Wi-Fi while asleep. Expired entries don't count. Source label
  "Router (OPNsense)".
* **Router (Warden)**: once Warden is linked, it replaces OPNsense (no restart
  needed). A person's phones count as here while a Warden device record that
  has used any of their MACs is `online` (`GET /api/v1/devices`), so a phone
  that rotates its private address is still found. People with no phones set
  in Kova use Warden's own presence (`GET /api/v1/people`) for the Warden person
  with the same name, or the one chosen as *Person in Warden* (`wardenPerson`).
  *Devices on your network* in Warden's setup lists names, owners, types,
  networks, MACs and `dev_` ids to pick from. An older Warden falls back to
  `GET /api/v1/clients` seen in the last 3 minutes. Source label "Router (Warden)".
* **Ping**: for phones with a fixed IP, a TCP connect to port 62078 (iPhone
  lockdownd). Accepted or refused = something is there; timeout = absent. ICMP
  isn't used because containers often can't send it. Same away debounce.
* **Phone automations**: `POST /api/people/:id/presence` from an iOS Shortcut
  ("Arrive"/"Leave" at Home → Get Contents of URL, method POST) or an Android
  automation. Each person has their own key (`?key=`), so a phone doesn't need
  the master token and can only report for that person. `GET
  /api/presence/setup` (master token) lists every person's arrive/leave URLs.
  Keys are generated once and kept in the database (or set `key` per person).
  Source label "Phone automation".

Conflicts: an "arrived" from any source wins at once. A phone automation's
"left" beats the router for 15 minutes (a phone stays on Wi-Fi while you drive
off), and after that the router only brings someone back once their phone has
dropped off and reappeared, so a stale ARP entry never says someone came home.

For router presence, turn off **Private Wi-Fi Address** (or set it to Fixed) for
the home network on each iPhone, and use that MAC. ARP entries can linger on the
router for up to ~20 minutes after a phone leaves, which the debounce and the
Shortcut "left" cover.

### Notifications (`notify.ts`)

`Notifier.notify({title, body, url?, tag?, people?, actions?})` sends to every
channel and logs the notification to Activity (`kind: 'system'`, feed `system`).

* **Web Push** to the phone app, with the `web-push` package (MPL-2.0, used
  unmodified). VAPID keys are made on first run and kept in
  `<KOVA_DATA>/push/vapid.json` (0600). The app's Activity screen has an
  "Enable notifications" row: it asks permission, subscribes with the hub's
  public key (`GET /api/push/vapid`) and sends the subscription to
  `POST /api/push/subscribe`. Subscriptions the push service reports as gone
  (404/410) are removed. **iPhone needs iOS 16.4+, the app added to the Home
  Screen, and HTTPS**: Safari won't register a service worker on plain
  `http://10.x.x.x:8140`. Put Kova behind a reverse proxy with a real
  certificate (e.g. Caddy or Nginx Proxy Manager with a DNS-challenge Let's
  Encrypt cert for `kova.yourdomain`, resolved to the hub on your LAN), then open
  that address and add it to the Home Screen.
* **The Kova app** (`mobile/`): through Expo's push service (`exp.host`, a cloud
  relay to Apple and Google), one request for every phone that registered with
  `POST /api/push/app`. The message carries the same `url` the app opens on a tap.
  Tokens Expo reports as `DeviceNotRegistered` are removed. Works on plain HTTP.
  `notify.expo.accessToken` if the Expo project requires one.
* **ntfy**: a JSON POST to an [ntfy](https://ntfy.sh) server (ntfy.sh or
  self-hosted). Install the ntfy app and subscribe to the topic. It works with
  Kova on plain HTTP, so it's the zero-setup option. Pick a long random topic
  name on ntfy.sh (anyone who knows it can read it), or use a token.

Built-in rules (each can be turned off in `notify.rules`):

| Rule | When | Notification |
|---|---|---|
| `doorbell` | a device event `ring` | "Someone's at the front door", plus which lights Light the way turned on and what was paused |
| `everyoneOut` | the last person leaves and, after `everyoneOutGraceSec` (60), lights are still on | "Everyone's out, N lights are on" with a *Turn them off* action (`/phone.html?do=lights-off` → `POST /api/lights/off`). Lights Light the way is holding don't count; they turn off by themselves. |
| `offline` | a device reports `online: false` for `offlineAfterMin` (10) | "X isn't responding", once per outage |
| `network` | Warden: the internet goes down, comes back or moves to the backup connection, a new device joins, an attack is blocked (live, from Warden's feed) | "The internet is down" / "is back", and Warden's own words for the rest |

The action links open the Kova app, so from outside the home they only work
if the app is reachable from outside (reverse proxy or VPN).

```json
"presence": {
  "opnsense": { "url": "https://10.10.0.1", "key": "…", "secret": "…", "insecureTls": true },
  "people": { "methel": { "phones": ["aa:bb:cc:dd:ee:01"] }, "brishti": { "phones": ["aa:bb:cc:dd:ee:02"] } },
  "pingHosts": { "brishti": "10.10.30.21" },
  "awayAfterMin": 10
},
"notify": {
  "ntfy": { "url": "https://ntfy.sh", "topic": "kova-7f3k2q9x", "token": "tk_…" },
  "publicUrl": "https://kova.example.com",
  "push": { "subject": "mailto:you@example.com" },
  "rules": { "doorbell": true, "everyoneOut": true, "offline": true }
}
```

The OPNsense key needs only the *Diagnostics: ARP Table* (and *NDP Table*)
privileges: create a dedicated user under System → Access → Users.
`insecureTls` accepts the router's self-signed certificate. Both services show
a row on the Integrations screen ("Router: 2 phones seen").

## API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | Everything the UI needs |
| GET | `/api/boot.js` | Same, as a script, for the first paint |
| GET | `/api/preview?hour=23.5` | Device states at that hour, per today's plan |
| WS | `/api/ws` | Pushes `{type:'state'}` on every change |
| POST | `/api/devices/:id` | Command `{on, bri, k, color, mode, media, vol}` → `{undo}` |
| POST | `/api/devices/:id/event` | Device event `{type:'person'|'ring'|…}` (webhooks, testing) |
| POST | `/api/integrations/tuya/cloud-import` | `{clientId, secret, region?, uid?}`: fetch Tuya local keys and data points from the Tuya IoT cloud and merge them into `integrations.json` → `{ok, devices, restartNeeded}` (never returns keys) |
| POST | `/api/integrations/matter/commission` | Add a Matter device `{code, room?, name?}` → `{ok, devices}` (needs `KOVA_MATTER=1`) |
| POST | `/api/rooms/:id/off` | Room lights off → `{undo}` |
| POST | `/api/overlays/:id/start`, `/api/overlays/end` | |
| POST | `/api/plan/skip` | `{id, skip}`: skip tonight |
| POST | `/api/findings/:id/fix`, `/dismiss` | → `{undo}` |
| PATCH | `/api/modes/:id` | `{lightTheWay, onlyWhenSomeoneHome}` → `{undo}` |
| POST | `/api/people/:id/presence` | `{home, source}` (or `?home=1`), e.g. from an iOS Shortcut. `?key=<person key>` works without the master token |
| GET | `/api/presence/setup` | Per-person keys and arrive/leave URLs for Shortcuts |
| GET | `/api/push/vapid` | `{publicKey}` for `pushManager.subscribe` |
| POST | `/api/push/subscribe`, `/api/push/unsubscribe` | `{subscription, personId?}` / `{endpoint}` |
| POST | `/api/push/test` | Send a test notification to every channel |
| POST | `/api/lights/off` | Every light off → `{undo}` |
| POST | `/api/undo/:id` | |
| POST | `/api/ask`, `/api/ask/act` | Ask Kova |
| GET | `/api/integrations/homekit` | `{enabled, pincode, setupURI, paired}` for the Apple Home bridge |
| GET | `/api/integrations/homekit-devices/discover` | HomeKit accessories on the network: `{accessories: [{id, name, category, host, port, paired}]}` (browses mDNS for 3 s) |
| POST | `/api/integrations/homekit-devices/pair` | `{id, code: "123-45-678", room?, name?}` pairs Kova with an accessory and returns its new devices; 400 with a message on a wrong code, an accessory that's already paired elsewhere, or when `homekit` isn't in integrations.json |
| GET | `/api/integrations/matter-bridge` | `{enabled, manualCode, qrCode, commissioned, fabrics:[{label, vendor}]}` for the Matter bridge |
| POST | `/api/devices/:id/webrtc` | Camera live view: `{offerSdp}` → `{answerSdp, mediaSessionId, expiresAt}`; 400 "Live view isn’t available for this camera yet" for cameras without WebRTC |
| POST | `/api/devices/:id/webrtc/extend`, `/stop` | `{mediaSessionId}`: keep a live stream going (they last about 5 min) or end it |
| GET | `/api/devices/:id/snapshot` | Latest event image, where the camera offers one (404 otherwise) |
| GET | `/api/integrations/nest/auth-url` | `?redirectUri=` → `{url, redirectUri}`: Google's page for linking Nest |
| POST | `/api/integrations/nest/auth-code` | `{code, redirectUri}` → `{refreshToken}` to save as `nest.refreshToken`; with in-app setup it's saved for you and the answer is `{ok, linked, status}` |
| GET | `/api/app-link` | `{url, link, qrSvg, hasToken}`: the `kova://connect` link (with the token) and its QR code, for the native app |
| POST, DELETE | `/api/push/app` | `{token, personId?, name?, platform?}`: the native app's Expo push token |
| GET | `/api/health` | `{ok, version, uptimeS}`; no token needed, no home data (for health checks) |
| PATCH | `/api/devices/:id/settings` | `{name?, room?, hidden?, favourite?}` (`null` name or room goes back to the integration's) → `{undo}`. Devices carry `hidden` and `original: {name, room}` when changed |
| PUT | `/api/home` | `{name}` |
| POST, PUT, DELETE | `/api/rooms`, `/api/rooms/:id` | `{name, icon?}`; delete takes `{moveTo}` when the room still has devices |
| PUT | `/api/rooms/order` | `{ids}`: every room id, in the new order |
| POST, PUT, DELETE | `/api/people`, `/api/people/:id` | `{name, detail?}` |
| POST, GET | `/api/integrations/warden/pair` | `{url?}` → `{code, next}`: Warden shows the same code at `/apps`; Kova saves its scoped token and the certificate's fingerprint once an admin approves. GET says `pending`, `approved`, `denied` or `expired` |
| POST | `/api/integrations/warden/link` | `{url, username, password, totp?}`: sign in once, save Kova's own Warden token and the certificate's fingerprint |
| GET | `/api/integrations/warden/clients` | Warden's device records (name, owner, type, vendor, network, MAC, IP, `deviceId`, online), for internet switches and phones |
| GET | `/api/integrations/helix/find` | Helix Servers on the hub's networks |
| POST, GET | `/api/integrations/helix/pair` | `{url?}` → `{code, next}`; Kova saves its token once the code is typed in Helix. GET says `pending`, `approved` or `expired` |
| POST | `/api/speaker-groups` | `{name, members, room?}` (two or more speakers) → `{id, deviceId, undo}`. Groups are in the snapshot as `speakerGroups` with `deviceId`, `missing`, `sync` and `castGroup` |
| PUT, DELETE | `/api/speaker-groups/:id` | `{name?, members?, room?}` (`null` room follows the members) → `{undo}` |
| PUT | `/api/favourites` | `{ids}`: the devices on Now, in order (also in the snapshot as `favourites`) |
| GET | `/api/import/ha` | The last Home Assistant import: source, stats, integrations and where each goes (`moves`, `set-up`, `built-in`, `handoff`, `unsupported`), review items, handoffs, `applied`; `{scanned:false}` before one |
| POST | `/api/import/ha/backup` | Body: a backup file (`application/octet-stream`, streamed); header `x-backup-key` for encrypted backups. 400 with `code` `needs-key`, `wrong-key` or `not-ha` |
| POST | `/api/import/ha/folder` | `{path}`: read a config folder (or its `.storage`) on the hub |
| GET | `/api/import/ha/automations` | HA automations in plain words: `{id, name, kind, at, when[], cond[], then[], enabled, lastRun, kova, yaml}` |
| POST | `/api/import/ha/review/:id` | Mark a review item or handoff done |
| POST | `/api/import/ha/apply` | Switch over: writes the integrations Kova doesn't have yet (keeps existing ones), starts them, brings rooms/people/location; leaves the demo home → `{written, kept, started, leftDemo}` |
| DELETE | `/api/import/ha` | Forget the import (deletes the kept files) |
| GET, POST | `/api/backups` | List backups / make one now (see [install.md](install.md#backups)) |
| GET | `/api/backups/:name` | Download a backup (needs `KOVA_TOKEN`, or a request from the machine itself) |

Set `KOVA_TOKEN` to require `Authorization: Bearer <token>` on every API call except `/api/health`.
Open the UI once with `?token=…` and it remembers the token. This is a stopgap
until real accounts exist.
The one exception: `POST /api/people/:id/presence?key=…` with that person's
own presence key.

## What's real and what's sample data in the UI

| Real (from the hub) | Still sample data |
|---|---|
| Now (mode, timeline, just happened, coming up, skip, overlays, rooms, findings, preview), Modes (editor, findings and fixes, Light the way, 14-day squares), Rooms and the device drawer, Media, Activity and inbox, Ask Kova, Integrations, Developer, people and events on Security, live video from Nest cameras that support WebRTC (the *Live* button on Security), Import from Home Assistant and the Automations list (your real HA automations) | Energy numbers (needs an inverter/meter adapter), camera thumbnails and video from non-WebRTC cameras |
