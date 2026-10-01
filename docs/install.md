# Installing Kova

Kova is one Node process with one data folder. It runs natively in a Proxmox LXC
(recommended: no Docker layer, easy backups and snapshots), on any Debian or
Ubuntu machine, or in Docker.

| | Path (native install) | Path (Docker) |
|---|---|---|
| Code | `/opt/kova` (root-owned, read-only to Kova) | inside the image |
| Data: `kova.db`, `integrations.json`, `home.json`, pairings, `backups/` | `/var/lib/kova` (user `kova`, mode 0700) | `./data` → `/data` (uid 1000) |
| Settings (`KOVA_TOKEN`, `KOVA_HOMEKIT`…) | `/etc/kova/kova.env` (root:kova, 0640) | `environment:` in `docker-compose.yml` |
| Service | `systemctl status kova`, `journalctl -u kova -f` | `docker compose logs -f kova` |

## 1. Proxmox LXC (recommended)

On the **Proxmox host**, as root:

```bash
curl -fsSLO https://raw.githubusercontent.com/clickbitau/kova/main/deploy/proxmox/create-kova-lxc.sh
bash create-kova-lxc.sh --dry-run --ctid 106 --ip 10.10.10.151/24 --gw 10.10.10.1   # look first
bash create-kova-lxc.sh           --ctid 106 --ip 10.10.10.151/24 --gw 10.10.10.1
```

(If the repository is private, `git clone` it on the host and run
`bash kova/deploy/proxmox/create-kova-lxc.sh --source ./kova …` instead: the code is
pushed into the container rather than cloned there.)

It creates an unprivileged Debian 12 container set up like the Home Assistant one
(CT 105): `nesting=1,keyctl=1`, `onboot=1`, 2 cores, 2 GB RAM, 512 MB swap, bridge
`vmbr0` tagged VLAN 10, plus IPv6 by SLAAC (`ip6=auto`) and an 8 GB disk on
`zfs-storage` (or `local-zfs` / `local-lvm`, whichever exists). Every one of those
is a flag; see `--help`. Then, inside the container, it runs `deploy/install.sh`
(below), and prints the URL, e.g. `http://10.10.10.151:8140/?token=…`.

Running it again with the same `--ctid` and `--hostname` reuses the container and
re-runs the installer, which only does what's missing.

**Networking notes**

- Kova finds devices with mDNS and SSDP, which don't cross VLANs by themselves.
  Put the container on the VLAN your devices are on, or give it a second NIC there
  (`pct set 106 --net1 name=eth1,bridge=vmbr0,tag=30,ip=dhcp,ip6=auto`), or run an
  mDNS reflector (Avahi, or your router's) between VLANs.
- **Matter needs IPv6 on the container.** Keep `--ip6 auto` (the default), make sure
  the VLAN has router advertisements, and check with `pct exec 106 -- ip -6 addr`
  that eth0 has a global or ULA address, not only `fe80::`.
- Ports to allow (Proxmox firewall on the CT, or between VLANs on the router):

  | Port | For |
  |---|---|
  | 8140/tcp | Web app and API (`KOVA_PORT`) |
  | 51826/tcp | Apple Home bridge (`KOVA_HOMEKIT=1`, `KOVA_HOMEKIT_PORT`) |
  | 5540/udp | Matter |
  | 5353/udp | mDNS (discovery, HomeKit, Matter, Cast) |
  | 1900/udp | SSDP (Sonos, Samsung TV discovery) |

## 2. An existing Debian/Ubuntu machine or LXC

As root on that machine:

```bash
git clone https://github.com/clickbitau/kova.git /opt/kova
bash /opt/kova/deploy/install.sh            # --dry-run to see what it would do
```

It installs git and Node 22 (from NodeSource, unless Node ≥ 22.13 is already
there), runs `npm ci`, creates the `kova` system user, `/var/lib/kova` and
`/etc/kova/kova.env` (with a random `KOVA_TOKEN`), installs
[`deploy/systemd/kova.service`](../deploy/systemd/kova.service), starts it, waits for
`/api/health` and prints the URL. Flags: `--dir`, `--data`, `--repo`, `--branch`,
`--source`, `--port`, `--no-token`.

Two optional extras, safe to add on a later run too:

- `--airplay` installs AirConnect's `aircast` (a static build for this machine) in
  `/opt/airconnect`, so Kova can put Cast speakers and groups into AirPlay. Turn it on in
  **Integrations → AirPlay to Cast**, leaving out speakers that have AirPlay of their own.
  Kova and the iPhones need to see the same mDNS: one network, or an mDNS reflector between
  VLANs.
- `--tailscale` installs Tailscale, joins your tailnet (it prints a sign-in link and waits)
  and serves Kova over HTTPS at `https://<machine>.<tailnet>.ts.net`, reachable only on the
  tailnet. In an LXC without `/dev/net/tun` it runs Tailscale in userspace mode, which is
  enough for this. Your tailnet needs HTTPS certificates and Serve on (it prints the link if
  not). Then set that address as Kova's public address under **Integrations →
  Notifications**: HTTPS is what lets the web app on an iPhone get notifications.

**Samsung soundbars (SmartThings)** need no extra tools: in **Integrations → Samsung
SmartThings**, *Set up with a token* takes a one-time token from
account.smartthings.com/tokens (Devices and Apps permissions), makes Kova's own app on your
account, and opens the Allow page.

The unit is sandboxed (`ProtectSystem=strict`, only `/var/lib/kova` writable). In an
LXC without `nesting=1`, systemd can't set that up and the service fails with
`status=226/NAMESPACE`: turn nesting on, or comment out the `Protect*`/`Private*`
lines in `/etc/systemd/system/kova.service`. If you set `KOVA_BACKUP_DIR` to another
folder, add it to `ReadWritePaths=` too.

## 3. Docker

```bash
git clone https://github.com/clickbitau/kova.git && cd kova
mkdir -p data && sudo chown -R 1000:1000 data     # Kova runs as uid 1000 in the image
docker compose up -d --build kova
docker compose logs -f kova
```

The image is pinned to Node 22.22.2 on Debian bookworm, runs as the non-root
`node` user, and has a `HEALTHCHECK` on `/api/health` (so `docker ps` shows
healthy/unhealthy). Use host networking (as the compose file does); discovery doesn't
work through Docker's NAT. Inside a Proxmox LXC, Docker needs `nesting=1,keyctl=1`,
like CT 105.

Set `KOVA_TOKEN` under `environment:` before exposing it to your network.

## First run: the demo home

With no `integrations.json`, Kova runs a demo home of 28 simulated devices, so you
can try everything safely. Open the URL the installer printed. With a token set,
open it once as `http://<ip>:8140/?token=<token>`; the web app remembers it.

## Importing from Home Assistant

Kova reads Home Assistant's configuration once. It never talks to Home Assistant,
and nothing in Home Assistant changes.

**In the app (easiest):** open **Import** in the sidebar and upload a backup
(Home Assistant → Settings → System → Backups → download one). Backups from
2025.1 on are encrypted: paste the backup's encryption key (Backups → ⋮ →
Encryption key) into the form. Kova keeps only the settings files and streams past
the history database, so large backups are fine. You get a preview (what moves to
Kova, what you set up again, what isn't needed, your automations in plain words and
a list of things that need you, such as the VeSync password), then **Switch over**.
From the demo home, switching over replaces it with your real home.

The same page can read a config folder already on the hub instead of an upload:
copy it over as below and give the path (e.g. `/tmp/ha-config`).

**From the command line:**

```bash
# On the Proxmox host: copy HA's .storage from CT 105 into the Kova container (106).
pct exec 105 -- tar -C /opt/homeassistant -czf - .storage | pct exec 106 -- tar -C /tmp -xzf -

# Then inside the Kova container (pct enter 106):
cd /opt/kova/hub
chown -R kova /tmp/.storage
runuser -u kova -- node --import tsx src/tools/import-ha.ts /tmp/.storage /var/lib/kova
rm -rf /tmp/.storage                      # it holds HA's secrets
systemctl restart kova
```

With Docker: `docker compose run --rm kova node --import tsx src/tools/import-ha.ts /data/ha-storage /data`
after copying `.storage` to `./data/ha-storage` (then delete it).

What's imported and what isn't (e.g. the VeSync password) is in
[architecture.md](architecture.md#integrationsjson).

## Where secrets live

| Secret | Where |
|---|---|
| API token | `/etc/kova/kova.env` (`KOVA_TOKEN`), root:kova 0640 |
| Device keys and account passwords (Tuya, Tapo, VeSync…) | `/var/lib/kova/integrations.json`, 0600 |
| Apple Home setup code and pairings, Matter fabric, Samsung TV tokens | `/var/lib/kova/{homekit,matter,samsungtv,…}/` |
| AI engine API key (Ask Kova) | inside `kova.db` |
| **Backups (all of the above)** | `/var/lib/kova/backups/*.tar.gz`, 0600 |

Everything under `/var/lib/kova` belongs to `kova` and is private to it (the
service runs with `UMask=0077`). Treat backup files like passwords when you copy
them off the machine.

## Backups

Every night (03:10 in the home's timezone by default) Kova writes
`/var/lib/kova/backups/kova-backup-YYYYMMDD-HHMMSS.tar.gz`: a consistent snapshot
of `kova.db` (SQLite's online backup API, so the hub keeps running), plus
`integrations.json`, `home.json` and the pairing folders (`homekit`,
`homekit-controller`, `matter`, `matter-bridge`, `samsungtv`, `push`, aircast's
config). It keeps the newest 14. The Activity feed shows *Nightly backup finished
· 61 MB*, and Integrations has a **Backups** row with the last backup's status.

| Setting (`kova.env`) | Default | |
|---|---|---|
| `KOVA_BACKUP_TIME` | `03:10` | `HH:MM` in the home's timezone, or `off` |
| `KOVA_BACKUP_KEEP` | `14` | How many backups to keep |
| `KOVA_BACKUP_DIR` | `<KOVA_DATA>/backups` | e.g. a Proxmox mount point on other storage |

API (all need the token): `GET /api/backups` lists them, `POST /api/backups` makes
one now, `GET /api/backups/<name>` downloads one. Downloading needs `KOVA_TOKEN`
to be set, or a request from the machine itself.

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" http://10.10.10.151:8140/api/backups
curl -fsS -H "Authorization: Bearer $TOKEN" -o kova.tar.gz http://10.10.10.151:8140/api/backups/kova-backup-20261001-031000.tar.gz
```

Copy them off the box too: a Proxmox `vzdump` of the container (Datacenter →
Backup) captures `/var/lib/kova` including `backups/`.

### Restore

The hub must be stopped; the restore tool checks `kova.lock` and refuses otherwise.

```bash
systemctl stop kova
cd /opt/kova/hub
runuser -u kova -- env KOVA_DATA=/var/lib/kova node --import tsx src/tools/restore.ts /var/lib/kova/backups/kova-backup-20261001-031000.tar.gz
systemctl start kova
```

It unpacks and checks everything (the database must pass `PRAGMA integrity_check`)
before touching the data folder. Then it moves the current files into
`/var/lib/kova/.pre-restore-<time>/` and renames the restored ones into place;
if that fails part-way, it puts everything back. Delete the `.pre-restore-*`
folder once you're happy. A lock left by a hub that crashed goes stale after 90
seconds; `--force` skips the check if you're sure no hub is running.

Docker: `docker compose stop kova && docker compose run --rm kova node --import tsx src/tools/restore.ts /data/backups/<file> && docker compose start kova`.

## Updating

**From the app or the web page**: Integrations shows *Kova X is available* with what's new, an **Update**
button, **Check now**, and *Overnight updates* (off by default: at 3:00, when an update is waiting and nothing is
playing). You get a notification when a new version is out, and after an update, whether it worked.

**Releases come from ClickBit**, like Helix's and Warden's, and need a Kova licence:

1. The update card shows this hub's **hub ID** (`KOVA-XXXX-XXXX-XXXX`, made once, kept in `/var/lib/kova/hub-id`).
2. ClickBit issues a licence for that hub ID (clickbit-admin: Licensing → Kova → New licence) and gives you a key
   starting `CR1-` (shown once).
3. Tap **Add licence key** on the card and paste it. The hub checks it there and then (ClickBit's signature, that
   it's a Kova licence, for this hub, not expired), activates it with ClickBit, and keeps the key and the device
   token in `/var/lib/kova/update/licence.json` (never shown back). Updates then come from ClickBit's catalog.

Without a licence the card says *No device token — install a licence to enable updates*; a revoked or expired one,
or one issued for another hub, says so. The licence only unlocks updates: nothing in the home ever stops working.

How it works: the hub runs as the unprivileged `kova` user, so it can't update itself. A small updater runs as root
on the box instead (`deploy/updater.sh`, installed by `install.sh` as systemd units):

- `kova-update-check.timer` asks the catalog for a newer Kova every 6 hours and writes what it found to
  `/var/lib/kova/update/status.json`, which the hub shows.
- **Update** and **Check now** make the hub write `apply` or `check` to `/var/lib/kova/update/request`;
  `kova-update.path` sees it and runs `kova-update.service` (log in `/var/lib/kova/update/last-update.log`).
- An update downloads the release, keeps it only when its bytes are exactly the sha256 and size the catalog
  lists, and `deploy/install-release.sh` checks every part against the release's `manifest.json`, unpacks it
  **beside the running one** in `/opt/kova/releases/<version>`, makes a backup, switches `/opt/kova/current` to it
  (`kova.service` runs `/opt/kova/current/hub`) and restarts.
- **If Kova doesn't come back** (`/api/health` with the new version within a minute), it switches back to the
  release before, restores the backup it just made and starts that again; the app says so, and that version isn't
  offered again (`/var/lib/kova/update/bad-versions`). The last three releases stay in `/opt/kova/releases`.

Settings in `/etc/kova/kova.env` (all optional): `KOVA_UPDATE_URL` (the catalog, default
`https://admin.clickbit.com.au/api`), `KOVA_UPDATE_CHANNEL` (`stable`), `KOVA_PRODUCT` (`kova`).

By hand, as root inside the container: `bash /opt/kova/current/deploy/updater.sh apply` (or `check`), or install a
release file you have: `bash /opt/kova/current/deploy/install-release.sh kova-release.tar.gz`.

**Boxes installed from git** (before releases) keep updating from GitHub until a licence is added: the updater
then does `git fetch`, and `bash /opt/kova/deploy/update.sh` pulls, runs `npm ci`, restarts and goes back by itself
the same way. That update also moves the box onto `/opt/kova/current` (pointing at the checkout itself), so once a
licence is in, the next update installs the first release beside the checkout. `KOVA_UPDATE_SOURCE=git` in
`kova.env` keeps a box on git.

From the Proxmox host: `pct exec 106 -- bash /opt/kova/current/deploy/updater.sh apply`. For a
risky update, `pct snapshot 106 pre-update` first (ZFS makes that instant).

Docker: `git pull && docker compose up -d --build kova` (the Update button is for native installs).

## Health and shutdown

`GET /api/health` needs no token and returns only `{ok, version, uptimeS}`; use it
for monitoring (Uptime Kuma etc.). On SIGTERM (`systemctl stop`, `docker stop`)
Kova stops the web server and bridges, waits for a backup in progress, writes
device state, closes the database (checkpointing its WAL) and releases the lock.
The unit and compose file allow 30 s for this.
