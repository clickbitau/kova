#!/usr/bin/env bash
# Install Kova natively on Debian 12 / Ubuntu 22.04+ (a VM, a bare machine, or an LXC).
# Run as root. Safe to run again: it only does what's missing, then restarts the service.
#
#   bash deploy/install.sh                      # from a checkout (uses it in place if it's at --dir)
#   curl -fsSL https://raw.githubusercontent.com/clickbitau/kova/main/deploy/install.sh | bash
#   bash deploy/install.sh --airplay --tailscale   # with the AirPlay bridge and remote access
#
# What it does: installs Node 22 (NodeSource), git and a C toolchain (hap-controller builds a native Bluetooth module), gets the code into /opt/kova,
# runs `npm ci`, creates a `kova` system user, keeps data in /var/lib/kova, writes
# /etc/kova/kova.env (with a random API token), installs and starts kova.service,
# waits for /api/health and prints the URL. Optional extras: --airplay (AirConnect's aircast,
# so Cast speakers show up in AirPlay) and --tailscale (Kova on your tailnet, with HTTPS).
set -euo pipefail

KOVA_DIR=/opt/kova
DATA_DIR=/var/lib/kova
REPO=https://github.com/clickbitau/kova.git
BRANCH=main
PORT=8140
SOURCE=""
TOKEN=1
DRY=0
AIRPLAY=0
TAILSCALE=0
AIRCONNECT_DIR=/opt/airconnect
ENV_FILE=/etc/kova/kova.env
UNIT=/etc/systemd/system/kova.service

usage() {
  cat <<EOF
Usage: install.sh [options]

  --dir DIR        where the code goes (default $KOVA_DIR)
  --data DIR       where Kova keeps its database, pairings and backups (default $DATA_DIR)
  --repo URL       git repository to clone (default $REPO)
  --branch NAME    branch or tag (default $BRANCH)
  --source DIR     copy the code from this local checkout instead of cloning
  --port N         web/API port (default $PORT; only used when creating $ENV_FILE)
  --no-token       don't generate KOVA_TOKEN (anyone on the network can use the API)
  --airplay        install AirConnect's aircast in $AIRCONNECT_DIR (Cast speakers in AirPlay);
                   turn it on in Kova under Integrations → AirPlay to Cast
  --tailscale      install Tailscale, join your tailnet (prints a sign-in link) and serve
                   Kova over HTTPS at https://<machine>.<tailnet>.ts.net (tailnet only)
  --dry-run        print what would run, change nothing
  -h, --help       this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) KOVA_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --data) DATA_DIR="${2:?--data needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --source) SOURCE="${2:?--source needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --no-token) TOKEN=0; shift ;;
    --airplay) AIRPLAY=1; shift ;;
    --tailscale) TAILSCALE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -t 1 ]]; then B=$'\033[1;36m' R=$'\033[1;31m' N=$'\033[0m'; else B='' R='' N=''; fi
log() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
die() { printf '%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# Print a command in copy-pasteable form.
show() {
  local out="" a
  for a in "$@"; do
    if [[ -z "$a" || "$a" =~ [^A-Za-z0-9_./:=,@%+-] ]]; then out+=" '${a//\'/\'\\\'\'}'"; else out+=" $a"; fi
  done
  printf '+%s\n' "$out"
}
run() { if [[ $DRY == 1 ]]; then show "$@"; else "$@"; fi; }
# For pipelines and redirections.
run_sh() { if [[ $DRY == 1 ]]; then show bash -c "$1"; else bash -c "$1"; fi; }

[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ "$KOVA_DIR" == /* && "$DATA_DIR" == /* ]] || die "--dir and --data must be absolute paths"
if [[ $DRY == 0 ]]; then
  [[ $EUID -eq 0 ]] || die "Run as root (sudo bash deploy/install.sh)"
  command -v apt-get >/dev/null || die "This installer needs Debian or Ubuntu (apt-get). See docs/install.md for Docker."
  command -v systemctl >/dev/null || die "systemd is required"
fi

# ---------------------------------------------------------------- packages --
log "Installing base packages"
run apt-get update -qq
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg git build-essential python3

# -------------------------------------------------------------------- node --
# Kova needs Node 22.13 or later on the 22 line (node:sqlite).
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a===22 && b>=13 ? 0 : 1)' 2>/dev/null
}
if [[ $DRY == 0 ]] && node_ok; then
  log "Node $(node -v) already installed"
else
  log "Installing Node 22 from NodeSource"
  run install -d -m 0755 /etc/apt/keyrings
  run_sh "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
  run_sh "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  if [[ $DRY == 0 ]]; then node_ok || die "Node 22.13+ didn't install (got $(node -v 2>/dev/null || echo none))"; fi
fi
NODE_BIN=$(command -v node 2>/dev/null || echo /usr/bin/node)

# -------------------------------------------------------------------- user --
if id kova >/dev/null 2>&1; then
  log "User kova exists"
else
  log "Creating system user kova"
  run useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin kova
fi

# -------------------------------------------------------------------- code --
if [[ -n "$SOURCE" ]]; then
  [[ -f "$SOURCE/package.json" && -d "$SOURCE/hub" ]] || die "--source $SOURCE isn't a Kova checkout"
  if [[ "$(cd "$SOURCE" && pwd -P)" != "$(cd "$KOVA_DIR" 2>/dev/null && pwd -P || true)" ]]; then
    log "Copying the code from $SOURCE to $KOVA_DIR"
    run install -d -m 0755 "$KOVA_DIR"
    run_sh "tar -C '$SOURCE' --exclude=./node_modules --exclude=./hub/node_modules --exclude=./data --exclude=./hub/data --exclude=./.claude --exclude=./homeassistant --exclude=./home-assistant-setup.md --exclude=./ct105-lxc.conf --exclude=./docker-containers.txt -cf - . | tar -C '$KOVA_DIR' -xf -"
  fi
elif [[ -f "$KOVA_DIR/package.json" && -d "$KOVA_DIR/hub" ]]; then
  log "Code already in $KOVA_DIR (use deploy/update.sh to update it)"
else
  log "Cloning $REPO ($BRANCH) into $KOVA_DIR"
  run git clone --branch "$BRANCH" "$REPO" "$KOVA_DIR"
fi
# The service can read the code but not change it.
run chown -R root:root "$KOVA_DIR"

log "Installing dependencies (npm ci)"
run_sh "cd '$KOVA_DIR' && npm ci --omit=dev -w hub --include-workspace-root --no-audit --no-fund"

# -------------------------------------------------------------------- data --
log "Data folder $DATA_DIR"
run install -d -o kova -g kova -m 0700 "$DATA_DIR"
run chown -R kova:kova "$DATA_DIR"

# ---------------------------------------------------------------- settings --
if [[ -f "$ENV_FILE" ]]; then
  log "Keeping existing $ENV_FILE"
else
  log "Writing $ENV_FILE"
  token_line="# KOVA_TOKEN="
  if [[ $TOKEN == 1 ]]; then
    if [[ $DRY == 1 ]]; then tok="<random>"; else tok=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n'); fi
    token_line="KOVA_TOKEN=$tok"
  fi
  run install -d -m 0750 -o root -g kova "$(dirname "$ENV_FILE")"
  env_body="# Kova settings (see README.md). Apply with: systemctl restart kova
KOVA_PORT=$PORT
# Every API call needs this token. Open the UI once with ?token=<token> and it remembers it.
$token_line
# Publish an Apple Home bridge (51826/tcp) / run the Matter controller (5540/udp, needs IPv6):
# KOVA_HOMEKIT=1
# KOVA_MATTER=1
# Nightly backup time in the home's timezone (\"off\" to disable), and how many to keep:
# KOVA_BACKUP_TIME=03:10
# KOVA_BACKUP_KEEP=14
"
  if [[ $DRY == 1 ]]; then
    show tee "$ENV_FILE"; printf '%s' "$env_body" | sed 's/^/    /'
  else
    ( umask 027; printf '%s' "$env_body" > "$ENV_FILE" )
  fi
  run chown root:kova "$ENV_FILE"
  run chmod 0640 "$ENV_FILE"
fi

# ----------------------------------------------------------------- service --
log "Installing $UNIT"
src_unit="$KOVA_DIR/deploy/systemd/kova.service"
[[ $DRY == 1 || -f "$src_unit" ]] || die "$src_unit is missing"
# The running Kova is $KOVA_DIR/current: "." (this checkout) until the first release is installed.
[[ -e "$KOVA_DIR/current" ]] || run ln -s . "$KOVA_DIR/current"
run_sh "sed -e 's|^WorkingDirectory=.*|WorkingDirectory=$KOVA_DIR/current/hub|' \
  -e 's|^ExecStart=[^ ]*|ExecStart=$NODE_BIN|' \
  -e 's|^Environment=KOVA_DATA=.*|Environment=KOVA_DATA=$DATA_DIR|' \
  -e 's|^ReadWritePaths=.*|ReadWritePaths=$DATA_DIR|' \
  -e 's|^EnvironmentFile=.*|EnvironmentFile=-$ENV_FILE|' \
  '$src_unit' > '$UNIT'"
run systemctl daemon-reload
run systemctl enable kova.service
run systemctl restart kova.service

log "Installing the updater (Update button, and a look for a newer Kova every 6 hours)"
run bash "$KOVA_DIR/deploy/install-updater.sh" "$KOVA_DIR" "$DATA_DIR"

# ------------------------------------------------------------------- check --
port=$PORT
tok=""
if [[ $DRY == 0 && -r "$ENV_FILE" ]]; then
  port=$(sed -n 's/^KOVA_PORT=//p' "$ENV_FILE" | tail -1); port=${port:-8140}
  tok=$(sed -n 's/^KOVA_TOKEN=//p' "$ENV_FILE" | tail -1)
fi
if [[ $DRY == 0 ]]; then
  log "Waiting for Kova to answer on port $port"
  ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [[ $ok == 0 ]]; then
    journalctl -u kova --no-pager -n 40 || true
    die "Kova didn't come up. See: journalctl -u kova -e"
  fi
fi

# ----------------------------------------------------------------- airplay --
# AirConnect's aircast (MIT): Kova runs it so Cast speakers and groups appear in AirPlay. A static
# build from the latest release, for this machine's architecture.
if [[ $AIRPLAY == 1 ]]; then
  case "$(uname -m)" in x86_64) ac=x86_64 ;; aarch64|arm64) ac=aarch64 ;; armv7l|armv6l) ac=arm ;; *) die "No AirConnect build for $(uname -m)" ;; esac
  bin="$AIRCONNECT_DIR/aircast-linux-$ac-static"
  if [[ $DRY == 0 && -x "$bin" ]]; then
    log "AirConnect already in $AIRCONNECT_DIR"
  else
    log "Installing AirConnect's aircast into $AIRCONNECT_DIR"
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip
    run_sh "set -e; t=\$(mktemp -d); u=\$(curl -fsSL https://api.github.com/repos/philippe44/AirConnect/releases/latest | grep -o 'https://[^\"]*AirConnect-[0-9.]*\\.zip' | head -1); curl -fsSL \"\$u\" -o \"\$t/ac.zip\"; unzip -q -o \"\$t/ac.zip\" 'aircast-linux-$ac-static' -d \"\$t\"; install -d -m 0755 '$AIRCONNECT_DIR'; install -m 0755 \"\$t/aircast-linux-$ac-static\" '$bin'; rm -rf \"\$t\""
  fi
  AIRPLAY_NOTE="AirPlay:  turn it on in Integrations → AirPlay to Cast (program: $bin). Leave out speakers with AirPlay of their own."
fi

# --------------------------------------------------------------- tailscale --
# Kova on your tailnet. Containers without /dev/net/tun (an unprivileged LXC) run Tailscale in
# userspace mode, which is all reaching Kova and `tailscale serve` need.
if [[ $TAILSCALE == 1 ]]; then
  if [[ $DRY == 1 ]] || ! command -v tailscale >/dev/null; then
    log "Installing Tailscale"
    distro=$(. /etc/os-release; echo "${ID:-debian}"); codename=$(. /etc/os-release; echo "${VERSION_CODENAME:-bookworm}")
    run_sh "curl -fsSL https://pkgs.tailscale.com/stable/$distro/$codename.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg && curl -fsSL https://pkgs.tailscale.com/stable/$distro/$codename.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list"
    run apt-get update -qq
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tailscale
  fi
  if [[ ! -e /dev/net/tun ]]; then
    log "No /dev/net/tun: Tailscale runs in userspace mode"
    run_sh "grep -q userspace-networking /etc/default/tailscaled || sed -i 's/^FLAGS=\"\"\$/FLAGS=\"--tun=userspace-networking\"/' /etc/default/tailscaled"
  fi
  run systemctl enable tailscaled
  run systemctl restart tailscaled
  if [[ $DRY == 0 ]] && ! tailscale status >/dev/null 2>&1; then
    log "Joining your tailnet: open the link Tailscale prints; this carries on once you've signed in"
    tailscale up --hostname="$(hostname)" --accept-dns=false
  fi
  # HTTPS for Kova on the tailnet (needs HTTPS certificates and Serve enabled in the tailnet).
  if [[ $DRY == 1 ]]; then
    show tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
  elif timeout 60 tailscale serve --bg --https=443 "http://127.0.0.1:$port" >/tmp/kova-serve.log 2>&1; then
    tsname=$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)
    TAILSCALE_NOTE="Remote:   https://$tsname/ (tailnet only). Set it as Kova's public address under Integrations → Notifications."
  else
    TAILSCALE_NOTE="Remote:   Serve isn't enabled on your tailnet yet: $(grep -o 'https://login.tailscale.com[^ ]*' /tmp/kova-serve.log | head -1). Then run: tailscale serve --bg --https=443 http://127.0.0.1:$port"
  fi
fi

ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
ip=${ip:-<this machine>}
url="http://$ip:$port/"
[[ -n "$tok" ]] && url="$url?token=$tok"
if [[ $DRY == 1 ]]; then echo; echo "Dry run finished; nothing was changed."; exit 0; fi
cat <<EOF

Kova is running.
  Open:     $url
  Status:   systemctl status kova   ·   logs: journalctl -u kova -f
  Settings: $ENV_FILE   ·   data: $DATA_DIR   ·   code: $KOVA_DIR

It starts with a demo home. To bring in your Home Assistant rooms and devices, see
docs/install.md ("Importing from Home Assistant").
EOF
[[ -n "${AIRPLAY_NOTE:-}" ]] && echo "  $AIRPLAY_NOTE"
[[ -n "${TAILSCALE_NOTE:-}" ]] && echo "  $TAILSCALE_NOTE"
exit 0
