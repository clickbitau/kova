# Kova

A local-first smart home platform. Kova is organised around **time** and **the
state of the house**, not around entities. The home is always in a mode; overlays
sit on top and end by themselves. Every change records *why*, and every rule is
tested against your real history.

- `hub/`: the backend that runs in the home (TypeScript, Node 22+, SQLite)
- `web/`: the web app (the v3 design, wired to the hub)
- `docs/architecture.md`: how it fits together
- `docs/design/`: the design handoff (prototypes, design language, sitemap)

## Run it

```bash
npm install
npm run dev          # http://localhost:8140, with a demo home of virtual devices
npm test             # engine, findings, assistant, adapters (against fake devices, Matter on a simulated network), API
```

### Your own devices

```bash
cd hub
npx tsx src/tools/import-ha.ts /path/to/homeassistant/.storage ../data   # one-time import
npm run dev                                                              # now runs your real home
```

Or write `data/integrations.json` by hand: see [docs/architecture.md](docs/architecture.md#integrationsjson).

| Env var | Default | |
|---|---|---|
| `KOVA_PORT` | `8140` | |
| `KOVA_DATA` | `./data` | Where `kova.db`, `integrations.json` and pairing data (HomeKit, Samsung TV tokens) live |
| `KOVA_DEMO` | on when there's no `integrations.json` | Force the virtual demo home on (`1`) or off (`0`) |
| `KOVA_SONOS` | off | `1` to discover Sonos speakers |
| `KOVA_SONOS_HOSTS` | | Comma-separated speaker IPs (for speakers on another VLAN) |
| `KOVA_MATTER` | off | `1` to run the Matter controller (state in `<KOVA_DATA>/matter`; needs IPv6 + mDNS on the host network) |
| `KOVA_TOKEN` | | Require a bearer token on the API |
| `KOVA_WEATHER` | on | `0` to skip Met.no weather |
| `KOVA_HOMEKIT` | off | `1` to publish an Apple Home (HomeKit) bridge; setup code is in the log and at `/api/integrations/homekit` |
| `KOVA_HOMEKIT_PORT` | `51826` | TCP port for the HomeKit bridge |

`KOVA_DATA` also holds `push/vapid.json` (Web Push keys, made on first run, 0600).

**Who's home and notifications** (replacing Home Assistant's iPhone app) are set up in `integrations.json`
under `presence` and `notify`; see [docs/architecture.md](docs/architecture.md#presence-and-notifications).
In short: give Kova your OPNsense API key and each person's phone MAC, add an iOS Shortcut per person from
`GET /api/presence/setup`, and either subscribe to an [ntfy](https://ntfy.sh) topic (works over plain HTTP,
nothing else to set up) or turn on notifications in the Kova phone app (needs HTTPS and the app on the Home Screen).

## Docker

```bash
docker build -t kova .
docker run -d --name kova --network host -v kova-data:/data kova
```

Host networking lets Kova discover devices over mDNS and SSDP.

## Try the demo

Everything in the demo home is simulated, so it's safe to play with. To trigger
the things cameras and phones would normally do:

```bash
curl -X POST localhost:8140/api/devices/doorbell/event -H 'content-type: application/json' -d '{"type":"person"}'
curl -X POST localhost:8140/api/people/brishti/presence -H 'content-type: application/json' -d '{"home":false}'
curl -X POST localhost:8140/api/devices/dining/physical -H 'content-type: application/json' -d '{"on":true}'   # someone used a wall switch
```
