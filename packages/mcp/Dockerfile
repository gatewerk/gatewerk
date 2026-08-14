# Runs the published @gatewerk/mcp MCP server (stdio).
#
# Built for hosting platforms (e.g. Glama) that wrap stdio servers in a
# streamable HTTP endpoint. Installs the PUBLISHED npm package, same
# philosophy as the mcpb bundle: what runs is exactly what npm serves.
# Keep the pinned version in lockstep with the npm release.
#
# Required at runtime: GATEWERK_URL and GATEWERK_API_KEY (the user's own
# Gatewerk instance and key). Optional: GATEWERK_REVIEWER.

FROM node:24-alpine
RUN npm install -g @gatewerk/mcp@1.1.4
ENV NODE_ENV=production
CMD ["gatewerk-mcp"]
