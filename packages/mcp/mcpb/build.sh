#!/usr/bin/env bash
# Builds gatewerk.mcpb, the one-click install bundle for MCP clients
# (Claude Desktop, Smithery, and any bundle-aware client).
#
# The bundle wraps the PUBLISHED @gatewerk/mcp npm package, not the
# working tree, so the version inside always matches what npm serves.
# Keep manifest.json's two version fields in lockstep with the npm
# release before building.
#
# Usage: ./build.sh [output-dir]   (default output: this directory)

set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(jq -r .version manifest.json)"
PKG_VERSION="$(jq -r '.packages // empty | .[0].version // empty' ../server.json)"
if [ -n "$PKG_VERSION" ] && [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "manifest.json version ($VERSION) != server.json package version ($PKG_VERSION)" >&2
  exit 1
fi

OUT_DIR="${1:-.}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp manifest.json "$STAGE/"
mkdir -p "$STAGE/server"
npm install --prefix "$STAGE/server" --omit=dev --no-fund --no-audit \
  --loglevel=error "@gatewerk/mcp@$VERSION"

npx --yes @anthropic-ai/mcpb validate "$STAGE/manifest.json"
npx --yes @anthropic-ai/mcpb pack "$STAGE" "$OUT_DIR/gatewerk.mcpb"
echo "Built $OUT_DIR/gatewerk.mcpb (@gatewerk/mcp@$VERSION)"
