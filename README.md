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
npm test             # engine, findings, assistant, Sonos adapter, API
```

| Env var | Default | |
|---|---|---|
| `KOVA_PORT` | `8140` | |
| `KOVA_DATA` | `./data` | Where `kova.db` lives |
| `KOVA_DEMO` | on | `0` to run without the virtual demo home |
| `KOVA_SONOS` | off | `1` to discover Sonos speakers |
| `KOVA_SONOS_HOSTS` | | Comma-separated speaker IPs (for speakers on another VLAN) |
| `KOVA_TOKEN` | | Require a bearer token on the API |
| `KOVA_WEATHER` | on | `0` to skip Met.no weather |

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
