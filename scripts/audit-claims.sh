#!/usr/bin/env bash
# Honest-claims register (distribution design §2.4): these strings may not
# appear in published surfaces until the features exist. Lines carrying an
# audit-claims-allow marker are exempt (e.g. roadmap "planned" items).
#
# Surfaces: site/src README.md LICENSING.md packages/{sdk-ts,sdk-py,mcp,n8n-nodes-gatewerk}/README.md
#
# Pattern notes:
#   - Dollar amounts use -P (Perl regex) with word boundaries so $49 and $149
#     do not trigger the $39 or $99 patterns, and $390/$399 are also safe.
#     Proof: $49  → no substring \$39 or \$99; $149 → no substring either.
#   - "priority support" / "dedicated support" / "elevated limits" are exact
#     phrase matches; "Priority webhook delivery" (pricing tier copy) does NOT
#     match because "priority" alone is not a banned phrase.
#   - "parallel approval" is banned; "parallel review" or other variants are fine.
set -uo pipefail
cd "$(dirname "$0")/.."

SURFACES=(
  site/src
  README.md
  LICENSING.md
  packages/sdk-ts/README.md
  packages/sdk-py/README.md
  packages/mcp/README.md
  packages/n8n-nodes-gatewerk/README.md
)

fail=0

run_check() {
  local label="$1"
  local use_perl="$2"
  shift 2
  local pattern="$1"

  local hits
  if [ "$use_perl" = "1" ]; then
    hits=$(grep -rniP -- "$pattern" "${SURFACES[@]}" 2>/dev/null | grep -v "audit-claims-allow" || true)
  else
    hits=$(grep -rniE -- "$pattern" "${SURFACES[@]}" 2>/dev/null | grep -v "audit-claims-allow" || true)
  fi

  if [ -n "$hits" ]; then
    echo "CLAIM VIOLATION [$label]:"
    echo "$hits"
    fail=1
  fi
}

# Feature gates — exact phrase matches (ERE, case-insensitive)
# SSO uses word boundaries (\b via Perl) so "crossOrigin" does not false-positive.
run_check "SSO"               1 '\bSSO\b'
run_check "SAML"              0 'SAML'
run_check "semantic search"   0 'semantic search'
run_check "auto-disable"      0 'auto-disable'
run_check "auto_disabled"     0 'auto_disabled'
run_check "N-of-M"            0 'N-of-M'
run_check "parallel approval" 0 'parallel approval'
run_check "seat enforcement"  0 'seat enforcement'
run_check "seats are enforced" 0 'seats are enforced'

# Stale pricing — Perl word boundaries prevent $390/$399 false positives and
# ensure $49 and $149 (current valid prices) are not caught by \$39 or \$99.
# Verified safe: grep -P '\$39(?![0-9])' <<< '$49'  → no match
#                grep -P '\$39(?![0-9])' <<< '$149' → no match
#                grep -P '\$39(?![0-9])' <<< '$390' → no match (9 IS a digit)
#                grep -P '\$99(?![0-9])' <<< '$149' → no match
#                grep -P '\$12\/mo'      <<< '$120/mo' → no match
run_check "\$12/mo"  1 '\$12/mo'
run_check "\$39"     1 '(?<![0-9])\$39(?![0-9])'
run_check "\$99"     1 '(?<![0-9])\$99(?![0-9])'

# Proven violation strings (from prior plan reviews)
run_check "elevated limits"    0 'elevated limits'
run_check "priority support"   0 'priority support'
run_check "dedicated support"  0 'dedicated support'

[ "$fail" -eq 0 ] && echo "audit-claims: clean"
exit $fail
