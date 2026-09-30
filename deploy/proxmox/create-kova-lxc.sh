#!/usr/bin/env bash
# Create a Proxmox LXC for Kova and install it natively (no Docker). Run on the Proxmox host as root.
#
#   bash create-kova-lxc.sh --ctid 106 --ip 10.10.10.151/24 --gw 10.10.10.1
#   bash create-kova-lxc.sh --dry-run            # print the pct commands, change nothing
#
# Defaults mirror the Home Assistant container (CT 105): unprivileged Debian 12,
# nesting=1,keyctl=1, onboot=1, 2 cores, 2 GB RAM, 512 MB swap, bridge vmbr0 on
# VLAN 10. IPv6 (SLAAC) is on because Matter needs it. Running it again with
# the same --ctid and --hostname reuses the container and re-runs the installer.
set -euo pipefail

CTID=""
HOSTNAME_=kova
BRIDGE=vmbr0
VLAN=10
IP=dhcp
GW=""
IP6=auto
DNS=""
CORES=2
MEMORY=2048
SWAP=512
DISK=8
STORAGE=""
TSTORAGE=local
TAGS=kova
SSH_KEY=""
REPO=https://github.com/clickbitau/kova.git
BRANCH=main
SOURCE=""
PORT=8140
NO_TOKEN=0
DRY=0

usage() {
  cat <<EOF
Usage: create-kova-lxc.sh [options]

Container
  --ctid N             container id (default: next free id)
  --hostname NAME      (default $HOSTNAME_)
  --bridge BR          (default $BRIDGE)
  --vlan TAG|none      VLAN tag (default $VLAN)
  --ip CIDR|dhcp       e.g. 10.10.10.151/24 (default $IP)
  --gw ADDR            gateway, required with a static --ip
  --ip6 auto|dhcp|CIDR|none   (default $IP6; Matter needs IPv6)
  --dns ADDR           nameserver (default: the host's)
  --cores N            (default $CORES)
  --memory MB          (default $MEMORY)
  --swap MB            (default $SWAP)
  --disk GB            root disk size (default $DISK)
  --storage NAME       storage for the root disk (default: zfs-storage, local-zfs or local-lvm, whichever exists)
  --template-storage NAME   where the Debian template lives (default $TSTORAGE)
  --tags LIST          (default $TAGS)
  --ssh-key FILE       authorised key for root in the container

Kova
  --repo URL           git repository (default $REPO)
  --branch NAME        (default $BRANCH)
  --source DIR         push this local checkout into the container instead of cloning
  --port N             web/API port (default $PORT)
  --no-token           don't generate an API token

  --dry-run            print the commands instead of running them
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ctid) CTID="${2:?}"; shift 2 ;;
    --hostname) HOSTNAME_="${2:?}"; shift 2 ;;
    --bridge) BRIDGE="${2:?}"; shift 2 ;;
    --vlan) VLAN="${2:?}"; shift 2 ;;
    --ip) IP="${2:?}"; shift 2 ;;
    --gw) GW="${2:?}"; shift 2 ;;
    --ip6) IP6="${2:?}"; shift 2 ;;
    --dns) DNS="${2:?}"; shift 2 ;;
    --cores) CORES="${2:?}"; shift 2 ;;
    --memory) MEMORY="${2:?}"; shift 2 ;;
    --swap) SWAP="${2:?}"; shift 2 ;;
    --disk) DISK="${2:?}"; shift 2 ;;
    --storage) STORAGE="${2:?}"; shift 2 ;;
    --template-storage) TSTORAGE="${2:?}"; shift 2 ;;
    --tags) TAGS="${2:?}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --source) SOURCE="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --no-token) NO_TOKEN=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -t 1 ]]; then B=$'\033[1;36m' Y=$'\033[1;33m' R=$'\033[1;31m' N=$'\033[0m'; else B='' Y='' R='' N=''; fi
log() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
warn() { printf '%sNote:%s %s\n' "$Y" "$N" "$*" >&2; }
die() { printf '%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
show() {
  local out="" a
  for a in "$@"; do
    if [[ -z "$a" || "$a" =~ [^A-Za-z0-9_./:=,@%+-] ]]; then out+=" '${a//\'/\'\\\'\'}'"; else out+=" $a"; fi
  done
  printf '+%s\n' "$out"
}
run() { if [[ $DRY == 1 ]]; then show "$@"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------- validation --
num() { [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a number (got '$2')"; }
num --cores "$CORES"; num --memory "$MEMORY"; num --swap "$SWAP"; num --disk "$DISK"; num --port "$PORT"
[[ -z "$CTID" ]] || num --ctid "$CTID"
[[ "$VLAN" == none ]] || num --vlan "$VLAN"
[[ "$HOSTNAME_" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]] || die "--hostname must be a plain host name"
if [[ "$IP" != dhcp ]]; then
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || die "--ip must be dhcp or an address with a prefix, e.g. 10.10.10.151/24"
  [[ -n "$GW" ]] || die "--gw is required with a static --ip"
fi
[[ -z "$SSH_KEY" || -r "$SSH_KEY" ]] || die "Can't read --ssh-key $SSH_KEY"
[[ -z "$SOURCE" || ( -f "$SOURCE/package.json" && -d "$SOURCE/hub" ) ]] || die "--source $SOURCE isn't a Kova checkout"

if [[ $DRY == 0 ]]; then
  [[ $EUID -eq 0 ]] || die "Run as root on the Proxmox host"
  for t in pct pveam pvesm; do have "$t" || die "$t not found: run this on the Proxmox host (or use --dry-run)"; done
elif ! have pct; then
  warn "Dry run away from Proxmox: ids, storage and template names below are placeholders."
fi

# --------------------------------------------------------------- defaults --
if [[ -z "$CTID" ]]; then
  if have pvesh; then CTID=$(pvesh get /cluster/nextid); else CTID=200; fi
fi
if [[ -z "$STORAGE" ]]; then
  if have pvesm; then
    avail=$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' || true)
    for s in zfs-storage local-zfs local-lvm; do
      if grep -qx "$s" <<<"$avail"; then STORAGE=$s; break; fi
    done
    [[ -n "$STORAGE" ]] || STORAGE=$(head -n1 <<<"$avail")
    [[ -n "$STORAGE" ]] || die "No active storage for container disks; pass --storage"
  else
    STORAGE=local-lvm
  fi
fi

net0="name=eth0,bridge=$BRIDGE,type=veth,ip=$IP"
[[ -n "$GW" ]] && net0+=",gw=$GW"
[[ "$IP6" != none ]] && net0+=",ip6=$IP6"
[[ "$VLAN" != none ]] && net0+=",tag=$VLAN"

# ------------------------------------------------------------- container --
exists=0
if [[ $DRY == 0 ]] && pct status "$CTID" >/dev/null 2>&1; then
  current=$(pct config "$CTID" | awk '/^hostname:/ {print $2}')
  [[ "$current" == "$HOSTNAME_" ]] || die "CT $CTID already exists and is '$current', not '$HOSTNAME_'. Pick another --ctid."
  log "CT $CTID ($HOSTNAME_) already exists; reusing it"
  exists=1
fi

if [[ $exists == 0 ]]; then
  log "Finding the Debian 12 template"
  TEMPLATE=""
  if [[ $DRY == 0 ]]; then
    TEMPLATE=$(pveam list "$TSTORAGE" 2>/dev/null | awk '{print $1}' | sed -n 's|.*vztmpl/\(debian-12-standard_[^ ]*\)|\1|p' | sort -V | tail -n1 || true)
    if [[ -z "$TEMPLATE" ]]; then
      run pveam update
      TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep '^debian-12-standard_' | sort -V | tail -n1 || true)
      [[ -n "$TEMPLATE" ]] || die "No debian-12-standard template available from pveam"
      run pveam download "$TSTORAGE" "$TEMPLATE"
    fi
  else
    TEMPLATE=debian-12-standard_12.7-1_amd64.tar.zst
    run pveam update
    run pveam download "$TSTORAGE" "$TEMPLATE"
  fi

  log "Creating CT $CTID ($HOSTNAME_) on $STORAGE"
  # shellcheck disable=SC2054  # the commas in nesting=1,keyctl=1 are part of the value
  args=(
    "$CTID" "$TSTORAGE:vztmpl/$TEMPLATE"
    --hostname "$HOSTNAME_"
    --unprivileged 1
    --features nesting=1,keyctl=1
    --onboot 1
    --ostype debian
    --arch amd64
    --cores "$CORES"
    --memory "$MEMORY"
    --swap "$SWAP"
    --rootfs "$STORAGE:$DISK"
    --net0 "$net0"
    --tags "$TAGS"
    --description "Kova smart home hub. Web UI on port $PORT. Data in /var/lib/kova, settings in /etc/kova/kova.env."
  )
  [[ -n "$DNS" ]] && args+=(--nameserver "$DNS")
  [[ -n "$SSH_KEY" ]] && args+=(--ssh-public-keys "$SSH_KEY")
  run pct create "${args[@]}"
fi

if [[ $DRY == 1 ]] || [[ "$(pct status "$CTID" | awk '{print $2}')" != running ]]; then
  log "Starting CT $CTID"
  run pct start "$CTID"
fi

in_ct() { run pct exec "$CTID" -- env LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive "$@"; }

log "Waiting for the container's network"
if [[ $DRY == 1 ]]; then
  show pct exec "$CTID" -- getent hosts deb.debian.org
else
  ok=0
  for _ in $(seq 1 60); do
    if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [[ $ok == 1 ]] || die "CT $CTID has no working network/DNS after 2 minutes (check --bridge, --vlan, --ip, --gw, --dns)"
fi

# ------------------------------------------------------------------ Kova --
log "Getting the code into /opt/kova"
if [[ -n "$SOURCE" ]]; then
  if [[ $DRY == 1 ]]; then tarball=/tmp/kova-src.tar.gz; else tarball=$(mktemp /tmp/kova-src.XXXXXX.tar.gz); fi
  run tar -C "$SOURCE" --exclude=./node_modules --exclude=./hub/node_modules --exclude=./data --exclude=./hub/data --exclude=./.git --exclude=./.claude --exclude=./homeassistant --exclude=./home-assistant-setup.md --exclude=./ct105-lxc.conf --exclude=./docker-containers.txt -czf "$tarball" .
  run pct push "$CTID" "$tarball" /root/kova-src.tar.gz
  in_ct bash -c 'install -d -m 0755 /opt/kova && tar -C /opt/kova -xzf /root/kova-src.tar.gz && rm -f /root/kova-src.tar.gz'
  run rm -f "$tarball"
else
  in_ct bash -c "apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null && { [ -f /opt/kova/package.json ] || git clone --branch '$BRANCH' '$REPO' /opt/kova; }"
fi

log "Running the installer inside CT $CTID"
inst=(bash /opt/kova/deploy/install.sh --dir /opt/kova --data /var/lib/kova --port "$PORT")
[[ $NO_TOKEN == 1 ]] && inst+=(--no-token)
in_ct "${inst[@]}"

# ------------------------------------------------------------------- done --
if [[ $DRY == 1 ]]; then
  addr=${IP%/*}; [[ "$IP" == dhcp ]] && addr="<CT IP>"
  echo
  if [[ $NO_TOKEN == 1 ]]; then echo "Dry run finished. Kova would be at http://$addr:$PORT/"
  else echo "Dry run finished. Kova would be at http://$addr:$PORT/?token=<from /etc/kova/kova.env>"; fi
  exit 0
fi

addr=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
tok=$(pct exec "$CTID" -- sed -n 's/^KOVA_TOKEN=//p' /etc/kova/kova.env | tail -n1 || true)
port=$(pct exec "$CTID" -- sed -n 's/^KOVA_PORT=//p' /etc/kova/kova.env | tail -n1 || true)
url="http://$addr:${port:-$PORT}/"
[[ -n "$tok" ]] && url+="?token=$tok"
cat <<EOF

CT $CTID ($HOSTNAME_) is running Kova.
  Open:   $url
  Shell:  pct enter $CTID
  Logs:   pct exec $CTID -- journalctl -u kova -f
  Update: pct exec $CTID -- bash /opt/kova/deploy/update.sh

Firewall (if the Proxmox firewall is on for this CT, or between VLANs), allow in:
  ${port:-$PORT}/tcp web · 51826/tcp Apple Home · 5540/udp Matter · 5353/udp mDNS · 1900/udp SSDP
EOF
