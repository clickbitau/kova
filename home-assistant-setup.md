# Home Assistant Setup — Full Documentation

> Snapshot taken **2026-09-30**. Covers Home Assistant and Matter/Thread only.

---

## 1. Overview

Home Assistant runs as a **Docker container inside an LXC container on the Proxmox host** (`10.10.0.253`).

| Item | Value |
|---|---|
| Proxmox CT | **105** (`homeassistant`) |
| CT IP | **10.10.10.150/24** (VLAN 10 — Servers), gateway `10.10.10.1` |
| HA Version | **2026.2.2** |
| Timezone | `Australia/Perth` |
| Docker containers | `homeassistant`, `matter-server` |

---

## 2. LXC Container Config (CT 105)

File: `/etc/pve/lxc/105.conf` on the Proxmox host (also backed up as `ct105-lxc.conf`).

```ini
arch: amd64
cores: 2
features: nesting=1,keyctl=1
hostname: homeassistant
memory: 2048
nameserver: 8.8.8.8
net0: name=eth0,bridge=vmbr0,gw=10.10.10.1,hwaddr=BC:24:11:0F:E2:73,ip=10.10.10.150/24,type=veth,tag=10
onboot: 1
ostype: debian
rootfs: zfs-storage:subvol-105-disk-0,size=16G
swap: 512
tags: media
unprivileged: 1
```

Key points: **unprivileged** container with **nesting + keyctl** enabled (required for Docker inside LXC), 2 vCPU / 2 GB RAM / 16 GB ZFS rootfs, VLAN tag 10, starts on boot.

---

## 3. Docker Containers

### 3.1 Home Assistant

```bash
docker run -d --name homeassistant \
  --privileged \
  --network=host \
  --restart=unless-stopped \
  -e TZ=Australia/Perth \
  -v /opt/homeassistant:/config \
  -v /run/dbus:/run/dbus:ro \
  ghcr.io/home-assistant/home-assistant:stable
```

- Config volume: `/opt/homeassistant` → `/config`
- Runs **privileged with host networking** (needed for mDNS, HomeKit, Sonos discovery, etc.)
- DBus mounted read-only (Bluetooth/Matter support)

### 3.2 Matter Server

```bash
docker run -d --name matter-server \
  --network=host \
  --restart=unless-stopped \
  --security-opt apparmor=unconfined \
  -v /opt/matter-server:/data \
  -v /run/dbus:/run/dbus:ro \
  ghcr.io/home-assistant-libs/python-matter-server:stable
```

- Home Assistant connects to it via WebSocket: `ws://localhost:5580/ws` (configured in the Matter integration, addon-free setup)
- Data dir: `/opt/matter-server` (backed up in `matter-server/`)
- Thread integration is also configured (empty dataset entry — Thread network credentials live in the Matter server data)

### 3.3 AirConnect *(documented, currently NOT running)*

```bash
docker run -d --name airconnect \
  --network=host \
  1activegeek/airconnect:latest
```

Purpose: AirPlay bridge for local audio devices.

---

## 4. Home Assistant Configuration

All files live in `/opt/homeassistant` inside CT 105 (backed up under `homeassistant/`).

### 4.1 `configuration.yaml`

```yaml
# Loads default set of integrations. Do not remove.
default_config:

# Load frontend themes from the themes folder
frontend:
  themes: !include_dir_merge_named themes
  extra_module_url:
    - /local/community/layout-card-modified/layout-card-modified.js

# Homio & MD3 Dashboards (YAML mode)
lovelace:
  mode: storage
  dashboards:
    dashboard-homio:
      mode: yaml
      title: "Homio"
      icon: mdi:star-plus-outline
      show_in_sidebar: true
      filename: dashboards/homio/homio.yaml
    dashboard-md3:
      mode: yaml
      title: "Material Design 3"
      icon: mdi:material-design
      show_in_sidebar: true
      filename: dashboards/md3/md3.yaml

# Packages (includes Homio helpers)
homeassistant:
  packages:
    homio_helpers: !include packages/homio_helpers.yaml

automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
```

### 4.2 Packages

`packages/shell_commands.yaml`:

```yaml
shell_command:
  copy_font: "python3 /opt/homeassistant/copy_font.py"
```

`packages/homio_helpers.yaml` — helpers for the Homio dashboard (see backup).

### 4.3 Directory layout

```
/opt/homeassistant/
├── configuration.yaml
├── automations.yaml
├── scripts.yaml
├── scenes.yaml            (empty)
├── secrets.yaml           (keys: some_password)
├── copy_font.py
├── .HA_VERSION            (2026.2.2)
├── .storage/              (integrations, registries, auth, Lovelace)
├── blueprints/
├── custom_components/     (see §5)
├── dashboards/            (homio, md3, templates)
├── image/
├── nest/
├── packages/
├── themes/                (dark_modern.yaml, homio, material_you, md3)
├── tts/
└── www/
```

---

## 5. Custom Components (HACS)

| Component | Purpose |
|---|---|
| `hacs` | Home Assistant Community Store |
| `browser_mod` | Browser popups / media-player control |
| `localtuya` | Local Tuya device control |
| `opnsense` | OPNsense router integration (hass-opnsense) |
| `opnsense_v060_backup` | Backup of older OPNsense component (v0.6.0) |

**OPNsense integration details** (from infra notes):
- URL: `https://10.10.0.1`
- Device Unique ID: `6c_92_bf_5f_16_ae` (physical MAC with underscores)
- Troubleshooting: config version must be `3` with `device_unique_id` present in `.storage/core.config_entries`

---

## 6. Configured Integrations

From `.storage/core.config_entries` (36 entries):

| Domain | Title / Notes |
|---|---|
| `matter` | Matter → ws://localhost:5580/ws (external server, no addon) |
| `thread` | Thread (dataset via Matter server) |
| `homekit` | HASS Bridge (port 21064, accessory mode excluded) |
| `homekit` | Bedroom OLED TV bridge (port 21065) |
| `tuya` | Cloud Tuya (kauserahamedmethel@outlook.com) |
| `localtuya` | Local Tuya |
| `sonos` | Sonos speakers |
| `cast` | Google Cast |
| `samsungtv` | Bedroom OLED (QA55S90DAWXXY) |
| `vesync` | Levoit purifiers (lounge + master bed) |
| `ecovacs` | Robot vacuum (dkathel@outlook.com) |
| `tplink` | Office Plug P100, Corridor Plug P100, Lamp L535 |
| `goodwe` | GoodWe solar inverter |
| `nest` | "SEL, The Ahmeds" — cameras/doorbell |
| `go2rtc` | Camera streaming engine |
| `switch_as_x` | Garage, Lounge, Backyard (switch→light conversions) |
| `brother` / `ipp` | MFC-L2730DW printer |
| `plex` | Plex @ http://10.10.10.101:32400 |
| `qbittorrent` | qBittorrent |
| `opnsense` | OPNsense firewall |
| `islamic_prayer_times` | Home (used by Quran automations) |
| `met` | Weather (Met.no) |
| `google_translate` | TTS |
| `radio_browser` | Radio sources |
| `backup` | HA backups |
| `shopping_list` | Shopping list |
| `browser_mod` | Browser Mod |
| `hacs` | HACS |
| `mobile_app` | Methel's iPhone Air, Brishti iPhone, Galaxy Tab |
| `sun` | Sun (sunrise/sunset triggers) |

---

## 7. Automations (13 total — 11 enabled, 2 disabled)

| Alias | Trigger | Action | State |
|---|---|---|---|
| Sunset — Turn on lights | Sunset −10 min | Kitchen, front door, laundry, lounge, garage lights on; lamp warm 3000K @ ~78%; TV backlight dim | ✅ |
| 8PM — Wind down | 20:00 | Outdoor/music/kitchen/garage off; lamp @ 5% 2000K; TV backlight dim | ✅ |
| Midnight — Sleep mode | 00:00 | Lounge/TV lights off; lamp dim 2500K | ❌ disabled |
| Sunrise — All lights off | Sunrise | All lights off; both purifiers → auto | ✅ |
| Garage — Auto on arrival | Either iPhone arrives home, after sunset | Garage + front door lights on, off after 10 min (`restart` mode) | ✅ |
| Office — Light on when occupied | Office camera `camera_person` event, after sunset | Office lights on, off after 10 min | ✅ |
| Front door camera — person detected | Doorbell cam `camera_person` event, after sunset | Front door lights on 5 min | ✅ |
| Garage camera — person detected | Garage cam `camera_person` event, after sunset | Garage light on 10 min | ✅ |
| Doorbell — Notify on ring | Doorbell chime event | Push to both iPhones (with "View Camera" → /dashboard-homio/outdoor); after sunset also front door lights 5 min | ✅ |
| Quran — Start at 11:30 PM | 23:30 | Qurango Tarateel stream on living room/music/guest/baby speakers @ 15% | ✅ |
| Quran — Stop at Fajr | `sensor.islamic_prayer_times_fajr_prayer` | Stop all 4 speakers | ✅ |
| Thunderstorm — Start at 9 PM | 21:00 | Rain sounds on master bedroom speaker @ 60% | ✅ |
| Thunderstorm — Stop at 7 AM | 07:00 | Stop master bedroom speaker | ✅ |
| Purifiers — Night mode | 00:00 | Purifiers → sleep, displays off | ❌ disabled |

Full YAML in `homeassistant/automations.yaml` in the backup.

---

## 8. Scripts (Scene-style routines)

From `scripts.yaml` — 4 routines. Note: 3 of the 4 have a duplicate `description: ''` key at the end (harmless YAML override bug worth fixing).

| Script | What it does |
|---|---|
| **Good Night** (`mdi:weather-night`) | All main lights off; lamp warm 2700K dim; TV backlight off; all media stopped; purifiers → sleep |
| **Movie Mode** (`mdi:movie-open`) | Distracting lights off; lamp 8% @ 2500K; TV backlight 12%; purifiers → sleep |
| **Date Mode** (`mdi:heart`) | Harsh lights off; lamp warm orange (255,140,100) @ 30%; TV backlight 20%; dining light on; jazz stream on living room @ 25%; purifiers → sleep |
| **Party Mode** (`mdi:party-popper`) | Room lights on; lamp blue @ 100%; TV + office LED strips @ 100%; upbeat stream on `media_player.home_speaker_group` @ 50%; purifiers → auto |

`scenes.yaml` is **empty** — scenes are implemented as scripts instead.

---

## 9. Dashboards & Themes

**Dashboards** (both YAML mode, registered in `configuration.yaml`):
- **Homio** (`dashboard-homio`) — `dashboards/homio/homio.yaml` + shared templates in `dashboards/templates/` (button cards: room, light, thermostat, nav, clock, etc.)
- **Material Design 3** (`dashboard-md3`) — `dashboards/md3/md3.yaml` + sensors (lights, weather, forecast, entity counts, groups)

**Storage-mode dashboards** also exist in `.storage`: main Lovelace, Kiosk, Map.

**Themes** (`themes/`): `dark_modern`, `homio`, `material_you`, `md3`.

**Frontend module**: `layout-card-modified.js` loaded via `extra_module_url`.

**Blueprints**: `motion_light`, `notify_leaving_zone`, `inverted_binary_sensor`, `confirmable_notification`.

---

## 10. Matter / Thread Details

- **Server**: `python-matter-server:stable` container, host network, data at `/opt/matter-server`
- **HA connection**: `ws://localhost:5580/ws`, `use_addon: false`, `integration_created_addon: false`
- **apparmor=unconfined** — required in LXC for Matter's avahi/DBus access
- Thread integration present; operational dataset stored in the Matter server data dir
- Matter server container started 2026-03-01 (per shell history), running stable since

---

## 11. Networking Notes

- **Known "issue"**: `ping 10.10.0.1` (gateway) from inside CT 105 fails 100% — this is **expected**, caused by Docker's default `FORWARD DROP` policy inside the container. Not a real network problem.
- HA (VLAN 10) talks to IoT devices on **VLAN 30** and mobiles on **VLAN 40** via the OPNsense gateway `10.10.0.1` — pass rules exist on all VLAN interfaces.
- Proxmox host reachable at `10.10.0.253`.

---

## 12. Restore Procedure (quick reference)

1. Create LXC on Proxmox using `ct105-lxc.conf` params (unprivileged, nesting=1, keyctl=1, VLAN 10, static IP 10.10.10.150/24).
2. Inside CT: install Docker.
3. Restore config: extract `ha-opt-backup-20260930.tar.gz` → `/opt/` (creates `/opt/homeassistant` and `/opt/matter-server`).
4. Start containers with the `docker run` commands in §3.
5. HA should come up at `http://10.10.10.150:8123`.

---

## 13. Backup Contents Map

```
/root/homeassistant-config/
├── home-assistant-setup.md      ← this document
├── ct105-lxc.conf               ← Proxmox LXC config
├── docker-containers.txt        ← docker run commands
├── ha-opt-backup-20260930.tar.gz← tarball of /opt (61 MB, DBs & logs excluded)
├── homeassistant/               ← extracted /opt/homeassistant (config, .storage, custom_components, dashboards, themes, …)
└── matter-server/               ← extracted /opt/matter-server (Matter fabric data)
```

Everything is also zipped at `/root/homeassistant-config-2026-09-30.zip`.
