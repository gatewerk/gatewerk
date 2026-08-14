/**
 * Public entry point for the n8n-nodes-gatewerk package.
 *
 * The verified-registry submission pipeline expects an index re-exporting every
 * node + credential class so static analysis can walk the package without
 * scraping the n8n.nodes array in package.json.
 *
 * package.json's `n8n.nodes` array is still the authoritative manifest for the
 * n8n runtime — n8n loads compiled .js files directly, not via this index.
 * Update both when adding a node.
 */

export { Gatewerk } from './nodes/Gatewerk/Gatewerk.node';
export { GatewerkTrigger } from './nodes/Gatewerk/GatewerkTrigger.node';

export { GatewerkApi } from './credentials/GatewerkApi.credentials';
