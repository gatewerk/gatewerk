#!/usr/bin/env bash
# quickstart.sh — git clone → ./scripts/quickstart.sh → first review in under 5 minutes.
# Generates a .env with random secrets, then starts all services.
#
# By default this PULLS the published multi-arch images from ghcr.io, which is
# what makes the five-minute claim true. It used to pass --build unconditionally,
# so the published images were never exercised and every first run paid for a
# full compile. Pass --build to opt back into compiling from this checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required: https://docs.docker.com/get-docker/"
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required to generate secrets."
  exit 1
}

if [ ! -f .env ]; then
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "HMAC_SECRET=$(openssl rand -hex 32)"
    echo "OTP_HMAC_SECRET=$(openssl rand -hex 32)"
    echo "TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
  } > .env
  echo "Generated .env with random secrets."
fi

if [ "${1:-}" = "--build" ]; then
  echo "Building images from this checkout."
  docker compose up -d --build
else
  echo "Pulling published images from ghcr.io."
  # A pull can fail for reasons the operator can fix (offline, rate limited,
  # registry unreachable). Compiling locally is always available as a fallback,
  # so say so rather than dying with a bare registry error.
  if ! docker compose up -d; then
    echo ""
    echo "Could not start from the published images."
    echo "To compile from this checkout instead, run: ./scripts/quickstart.sh --build"
    exit 1
  fi
fi

printf "Waiting for the API to become healthy"
API_CONTAINER="$(docker compose ps -q gatewerk-api)"
WAIT_ITERS=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_CONTAINER" 2>/dev/null)" = "healthy" ]; do
  printf "."; sleep 2
  WAIT_ITERS=$((WAIT_ITERS + 1))
  # container id can appear late on slow machines
  [ -n "$API_CONTAINER" ] || API_CONTAINER="$(docker compose ps -q gatewerk-api)"
  if [ "$WAIT_ITERS" -ge 60 ]; then
    echo ""
    echo "The API did not become healthy in time. Inspect: docker compose logs gatewerk-api"
    exit 1
  fi
done
echo ""

curl -sf http://localhost:3100/health >/dev/null 2>&1 || echo "Warning: the API container is healthy but http://localhost:3100 is not answering — another process may be using port 3100."

echo "Gatewerk is running."
echo "  Dashboard: http://localhost:8880   login: admin@gatewerk.local / admin123"
echo "  API:       http://localhost:3100"
echo "Change the admin password after first login."
