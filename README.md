# Kova

A local-first smart home platform. Kova is organised around **time** and **the
state of the house**, not around entities. The home is always in a mode; overlays
sit on top and end by themselves. Every change records *why*, and every rule is
tested against your real history.

- `hub/`: the backend that runs in the home (TypeScript, Node 22+, SQLite)
- `web/`: the web app (the v3 design, wired to the hub)
- `docs/install.md`: **installing it for real** (Proxmox LXC, Debian/Ubuntu, Docker), backups, restore, updates
- `docs/DOCKBIT.md`: how releases are built (`scripts/build-release.sh`) and how hubs get them from ClickBit's catalog
- `docs/architecture.md`: how it fits together
- `docs/design/`: the design handoff (prototypes, design language, sitemap)

## Run it

```bash
npm install
npm run dev          # http://localhost:8140, with a demo home of virtual devices
npm test             # engine, findings, assistant, adapters (against fake devices, Matter on a simulated network), API
```

### Your own devices

Open **Import** in the app and upload a Home Assistant backup: you get a preview, then switch over. Or from the command line:

```bash
cd hub
npx tsx src/tools/import-ha.ts /path/to/homeassistant/.storage ../data   # one-time import
npm run dev                                                              # now runs your real home
```

Or write `data/integrations.json` by hand: see [docs/architecture.md](docs/architecture.md#integrationsjson).

| Env var | Default | |
|---|---|---|
| `KOVA_PORT` | `8140` | |
| `KOVA_DATA` | `./data` | Where `kova.db`, `integrations.json` and pairing data (HomeKit, Matter, Samsung TV tokens) live |
| `KOVA_DEMO` | on when there's no `integrations.json` | Force the virtual demo home on (`1`) or off (`0`) |
| `KOVA_SONOS` | off | `1` to discover Sonos speakers |
| `KOVA_SONOS_HOSTS` | | Comma-separated speaker IPs (for speakers on another VLAN) |
| `KOVA_MATTER` | off | `1` to run the Matter controller (state in `<KOVA_DATA>/matter`; needs IPv6 + mDNS on the host network) |
| `KOVA_TOKEN` | | Require a bearer token on the API |
| `KOVA_WEATHER` | on | `0` to skip Met.no weather |
| `KOVA_HOMEKIT` | off | `1` to publish an Apple Home (HomeKit) bridge; setup code is in the log and at `/api/integrations/homekit` |
| `KOVA_HOMEKIT_PORT` | `51826` | TCP port for the HomeKit bridge |
| `KOVA_HOST` | `0.0.0.0` | Address to listen on |
| `KOVA_BACKUP_TIME` | `03:10` | Nightly backup, in the home's timezone; `off` to disable |
| `KOVA_BACKUP_KEEP` | `14` | Backups to keep |
| `KOVA_BACKUP_DIR` | `<KOVA_DATA>/backups` | Where backups go |
| `KOVA_MATTER_BRIDGE` | off | `1` to run Kova as a Matter bridge for Google Home, Alexa, SmartThings and Apple Home; pairing code is in the log and at `/api/integrations/matter-bridge` (state in `<KOVA_DATA>/matter-bridge`; needs IPv6 + mDNS) |
| `KOVA_MATTER_BRIDGE_PORT` | `5540` | UDP port for the Matter bridge |

`KOVA_DATA` also holds `push/vapid.json` (Web Push keys, made on first run, 0600).

**Who's home and notifications** (replacing Home Assistant's iPhone app) are set up in `integrations.json`
under `presence` and `notify`; see [docs/architecture.md](docs/architecture.md#presence-and-notifications).
In short: give Kova your OPNsense API key and each person's phone MAC, add an iOS Shortcut per person from
`GET /api/presence/setup`, and either subscribe to an [ntfy](https://ntfy.sh) topic (works over plain HTTP,
nothing else to set up) or turn on notifications in the Kova phone app (needs HTTPS and the app on the Home Screen).

## Install

See **[docs/install.md](docs/install.md)**: a one-command Proxmox LXC installer
(`deploy/proxmox/create-kova-lxc.sh`), `deploy/install.sh` for any Debian/Ubuntu
machine (systemd service, `kova` user, data in `/var/lib/kova`), Docker, importing
from Home Assistant, nightly backups and restore, and `deploy/update.sh`.

## Docker

```bash
docker build -t kova .
docker run -d --name kova --network host -v kova-data:/data kova
```

Host networking lets Kova discover devices over mDNS and SSDP. The container runs as
uid 1000 and reports health from `/api/health`.

## Try the demo

Everything in the demo home is simulated, so it's safe to play with. To trigger
the things cameras and phones would normally do:

```bash
curl -X POST localhost:8140/api/devices/doorbell/event -H 'content-type: application/json' -d '{"type":"person"}'
curl -X POST localhost:8140/api/people/brishti/presence -H 'content-type: application/json' -d '{"home":false}'
curl -X POST localhost:8140/api/devices/dining/physical -H 'content-type: application/json' -d '{"on":true}'   # someone used a wall switch
```
