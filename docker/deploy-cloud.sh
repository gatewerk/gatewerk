#!/usr/bin/env bash
set -euo pipefail

# Cloud deploy script — runs migrations locally against Supabase,
# rsyncs source to VPS, rebuilds containers. One-command deploy.
#
# Prerequisites:
# - .env.cloud in docker/ with all env vars (DATABASE_URL pointing to Supabase)
#   plus the deploy target: CLOUD_VPS_HOST, CLOUD_VPS_PATH, CLOUD_SSH_KEY
# - SSH access to the Cloud VPS
# - Bun installed locally for migration runner

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${SCRIPT_DIR}/.env.cloud"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Create it with all required env vars."
  exit 1
fi

# Deploy target: environment first, then .env.cloud, which is gitignored.
# Deliberately no defaults. A hardcoded host and key path is a disclosure once
# this repo is public, and a default target is also how a stray run lands on
# the wrong machine. Fail loudly instead.
# `|| true` is load-bearing: grep exits 1 on no match, and under `set -e` plus
# pipefail that aborts the script before the checks below can name what is
# missing. The failure has to reach the `:?` lines to be useful.
env_value() {
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'" || true
}
VPS_HOST="${CLOUD_VPS_HOST:-$(env_value CLOUD_VPS_HOST)}"
VPS_PATH="${CLOUD_VPS_PATH:-$(env_value CLOUD_VPS_PATH)}"
SSH_KEY="${CLOUD_SSH_KEY:-$(env_value CLOUD_SSH_KEY)}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"

: "${VPS_HOST:?CLOUD_VPS_HOST is unset. Add it to docker/.env.cloud, e.g. user@host}"
: "${VPS_PATH:?CLOUD_VPS_PATH is unset. Add it to docker/.env.cloud, e.g. /opt/your-app}"
: "${SSH_KEY:?CLOUD_SSH_KEY is unset. Add it to docker/.env.cloud, e.g. ~/.ssh/your_key}"

# The commercial layer lives in the private ./ee submodule. This script rsyncs a
# WORKING TREE, so whatever is on this machine is what the VPS builds from — and
# a checkout without --recurse-submodules leaves ./ee an existing but empty
# directory. Both cloud Dockerfiles refuse to build in that state, but they
# refuse on the VPS, after the rsync has already replaced the deployed source
# with a copy that has no auth, billing or webhook layer in it. Stop here
# instead, before anything leaves this machine.
if [ ! -f "$PROJECT_ROOT/ee/api/bootstrap.ts" ] || [ ! -f "$PROJECT_ROOT/ee/web-next/env.ts" ]; then
  echo "ERROR: ./ee is empty or incomplete — the Cloud layer is missing."
  echo "       Nothing has been synced. Run:"
  echo "         git submodule update --init --recursive"
  exit 1
fi

# Warn when this machine's env file has drifted from the one the VPS actually
# runs on.
#
# There are deliberately two copies. The rsync below excludes docker/.env.cloud
# so a deploy can never overwrite the server's secrets with whatever is on a
# laptop — that is correct and stays. The cost is that the two silently
# diverge, and the local copy then looks like a backup while not being one: a
# var missing locally (e.g. SMTP_FROM, RESEND_WEBHOOK_SECRET,
# EMAIL_CONTACT_ADDRESS) means restoring the server from it would disable
# Resend and bounce suppression with nothing erroring, and reading the local
# file to check email status gives the wrong answer — only the VPS is
# authoritative.
#
# Names and set/empty state only. No values are read, compared or printed.
# Non-fatal: drift does not break a deploy, because the VPS env is never
# overwritten. It is reported so a human sees it at the one moment they are
# certainly paying attention to this stack.
echo "=== Checking env drift between this machine and the VPS ==="
env_shape() { grep -E '^[A-Z_]+=' "$1" | while IFS='=' read -r k v; do
  if [ -n "$v" ]; then echo "$k SET"; else echo "$k EMPTY"; fi; done | sort; }

LOCAL_SHAPE="$(env_shape "$ENV_FILE")"
if REMOTE_SHAPE="$(ssh -o ConnectTimeout=15 -i "$SSH_KEY" "$VPS_HOST" \
      "grep -E '^[A-Z_]+=' $VPS_PATH/docker/.env.cloud | while IFS='=' read -r k v; do if [ -n \"\$v\" ]; then echo \"\$k SET\"; else echo \"\$k EMPTY\"; fi; done | sort" 2>/dev/null)"; then
  DRIFT="$(diff <(echo "$LOCAL_SHAPE") <(echo "$REMOTE_SHAPE") || true)"
  if [ -n "$DRIFT" ]; then
    echo "WARNING: docker/.env.cloud differs from the VPS copy."
    echo "         '<' is this machine, '>' is the VPS. The VPS is authoritative."
    echo "$DRIFT" | sed 's/^/         /'
    echo "         Deploy continues — the VPS env is never overwritten by this script."
    echo "         Reconcile before treating the local file as a backup."
  else
    echo "Env shape matches the VPS."
  fi
else
  echo "WARNING: could not read the VPS env file to compare. Continuing."
fi
echo ""

# Load env vars for migration
set -a
source "$ENV_FILE"
set +a

echo "=== Step 1/3: Running migrations against Supabase ==="
cd "$PROJECT_ROOT"
bun run packages/db/scripts/migrate.ts
echo "Migrations complete."

echo ""
echo "=== Step 2/3: Syncing source to Cloud VPS ==="
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude docker/.env.cloud \
  --exclude docker/.env.production \
  -e "ssh -i $SSH_KEY" \
  "$PROJECT_ROOT/" "$VPS_HOST:$VPS_PATH/"
echo "Sync complete."

echo ""
echo "=== Step 3/3: Building and starting containers ==="
# Optional service names scope the rebuild: `./deploy-cloud.sh gatewerk-web-next`
# rebuilds only that service. With no arguments every service rebuilds — a
# web-next-only change does not need api and web rebuilt on the VPS.
SERVICES="$*"
ssh -i "$SSH_KEY" "$VPS_HOST" \
  "cd $VPS_PATH && docker compose -f docker/docker-compose.cloud.yml --env-file docker/.env.cloud up -d --build $SERVICES"
echo ""

echo "=== Deploy complete ==="
echo "API: https://api.gatewerk.com"
echo "Web: https://app.gatewerk.com"

echo ""
echo "Checking health..."
sleep 5
ssh -i "$SSH_KEY" "$VPS_HOST" \
  "curl -sf http://localhost:3100/health && echo ' API OK' || echo ' API FAILED'"
