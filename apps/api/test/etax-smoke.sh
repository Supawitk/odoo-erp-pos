#!/usr/bin/env bash
# 🇹🇭 Phase 4B e-Tax invoice smoke test against the LIVE running API.
#
# Pre-reqs:
#   - API running on :3001
#   - Postgres + Redis up
#   - Org seeded with countryMode=TH + vatRegistered=true
#   - At least one paid TX or ABB order exists in custom.pos_orders

set -euo pipefail

API="${API:-http://localhost:3001}"
PGPASS="${POSTGRES_PASSWORD:-erp_app_dev_pw_change_me}"
PGUSER="${POSTGRES_USER:-erp_app}"

PASS=0
FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=== Phase 4B e-Tax invoice smoke ==="

# 1. Create an admin user + login for token.
EMAIL="etax-smoke-$(date +%s)@example.com"
PASSWORD="EtaxSmokePass!1"
echo
echo "1. Creating admin user $EMAIL ..."
REG=$(curl -s -X POST "$API/api/auth/register" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Etax Smoke\"}")
ADMIN_USER_ID=$(echo "$REG" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$ADMIN_USER_ID" ]; then
  fail "failed to register: $REG"; exit 1
fi
PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "UPDATE custom.users SET role='admin' WHERE id='$ADMIN_USER_ID';" >/dev/null
pass "registered + promoted to admin"

LOGIN=$(curl -s -X POST "$API/api/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] && pass "got admin token" || { fail "no token: $LOGIN"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# 2. Find or create a paid TX order to operate on.
echo
echo "2. Looking for an existing paid TX order ..."
ORDER_ID=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "
  SELECT id FROM custom.pos_orders
  WHERE status='paid' AND document_type='TX' AND buyer_tin IS NOT NULL
  ORDER BY created_at DESC LIMIT 1;" | head -1 | tr -d ' ')

if [ -z "$ORDER_ID" ]; then
  echo "  No TX order found. Creating one for the smoke ..."
  SESSION_ID=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "
    INSERT INTO custom.pos_sessions (user_id, opening_balance_cents, status)
    VALUES ('$ADMIN_USER_ID', 0, 'open') RETURNING id;" | head -1 | tr -d ' ')
  ORDER_ID=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "
    INSERT INTO custom.pos_orders (
      session_id, order_lines, subtotal_cents, tax_cents, discount_cents,
      total_cents, currency, payment_method, payment_details, status,
      offline_id, document_type, document_number, buyer_name, buyer_tin,
      buyer_branch, buyer_address, vat_breakdown
    ) VALUES (
      '$SESSION_ID',
      '[{\"productId\":\"smoke-1\",\"name\":\"Smoke Item\",\"qty\":1,\"unitPriceCents\":10000,\"discountCents\":0,\"vatCategory\":\"standard\",\"netCents\":10000,\"vatCents\":700,\"grossCents\":10700}]'::jsonb,
      10000, 700, 0, 10700, 'THB', 'cash',
      '{\"tenderedCents\":10700,\"changeCents\":0}'::jsonb, 'paid',
      'etax-smoke-$(date +%s)', 'TX', 'TX9999-SMK$(date +%s | tail -c 4)',
      'Smoke Buyer Co', '0107537000254', '00000', 'Test Address',
      '{\"taxableNetCents\":10000,\"zeroRatedNetCents\":0,\"exemptNetCents\":0,\"vatCents\":700,\"grossCents\":10700}'::jsonb
    ) RETURNING id;" | head -1 | tr -d ' ')
  pass "created test TX order $ORDER_ID"
else
  pass "found existing TX order $ORDER_ID"
fi

# 3. Preview XML
echo
echo "3. GET /api/etax/orders/$ORDER_ID/preview ..."
PREVIEW=$(curl -s "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/preview")
ETDA_CODE=$(echo "$PREVIEW" | sed -n 's/.*"etdaCode":"\([^"]*\)".*/\1/p' | head -1)
HASH=$(echo "$PREVIEW" | sed -n 's/.*"xmlHash":"\([^"]*\)".*/\1/p' | head -1)
[ "$ETDA_CODE" = "T01" ] && pass "etdaCode=T01" || fail "expected T01, got $ETDA_CODE"
[ -n "$HASH" ] && pass "xmlHash present (${HASH:0:16}...)" || fail "no xmlHash"

VALID=$(echo "$PREVIEW" | grep -o '"valid":true' || true)
[ -n "$VALID" ] && pass "TIER 1 validation passed" || fail "TIER 1 validation failed: $(echo "$PREVIEW" | head -c 500)"

# 4. Preview as raw XML
echo
echo "4. GET /api/etax/orders/$ORDER_ID/preview.xml ..."
XML=$(curl -s "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/preview.xml")
echo "$XML" | grep -q "<rsm:CrossIndustryInvoice" && pass "rsm root element present" || fail "missing rsm root"
echo "$XML" | grep -q "<ram:TypeCode>T01</ram:TypeCode>" && pass "TypeCode=T01 in XML" || fail "no T01 in XML"
# Real order may have a different buyer TIN; just confirm SOME TIN is present in BuyerTradeParty.
echo "$XML" | grep -A5 "BuyerTradeParty" | grep -q '<ram:ID schemeID="TXID">[0-9]\{13\}</ram:ID>' && pass "buyer TIN in XML" || fail "buyer TIN missing"

# 5. Submit via Leceipt (mock)
echo
echo "5. POST /api/etax/orders/$ORDER_ID/submit?provider=leceipt ..."
SUBMIT=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/submit?provider=leceipt")
echo "  response: $SUBMIT" | head -c 400; echo
echo "$SUBMIT" | grep -q '"status":"acknowledged"' && pass "Leceipt acked" || fail "not acked: $SUBMIT"
echo "$SUBMIT" | grep -q '"providerReference":"LECEIPT-MOCK-' && pass "provider ref" || fail "no provider ref"
echo "$SUBMIT" | grep -q '"rdReference":"RD-MOCK-' && pass "RD ref" || fail "no RD ref"

# 6. Idempotency
echo
echo "6. POST /api/etax/orders/$ORDER_ID/submit?provider=leceipt (replay) ..."
SUBMIT2=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/submit?provider=leceipt")
SUB_ID_1=$(echo "$SUBMIT" | sed -n 's/.*"submissionId":"\([^"]*\)".*/\1/p')
SUB_ID_2=$(echo "$SUBMIT2" | sed -n 's/.*"submissionId":"\([^"]*\)".*/\1/p')
[ "$SUB_ID_1" = "$SUB_ID_2" ] && pass "idempotent (same submissionId)" || fail "different submissionIds: $SUB_ID_1 vs $SUB_ID_2"

# 7. INET parallel submission
echo
echo "7. POST /api/etax/orders/$ORDER_ID/submit?provider=inet ..."
INET=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/submit?provider=inet")
echo "$INET" | grep -q '"providerReference":"INET-MOCK-' && pass "INET also acked" || fail "INET failed: $INET"

# 8. Status query
echo
echo "8. GET /api/etax/orders/$ORDER_ID/status ..."
STATUS=$(curl -s "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/status")
LECEIPT_COUNT=$(echo "$STATUS" | grep -o '"provider":"leceipt"' | wc -l | tr -d ' ')
INET_COUNT=$(echo "$STATUS" | grep -o '"provider":"inet"' | wc -l | tr -d ' ')
[ "$LECEIPT_COUNT" = "1" ] && pass "1 leceipt row" || fail "expected 1 leceipt row, got $LECEIPT_COUNT"
[ "$INET_COUNT" = "1" ] && pass "1 inet row" || fail "expected 1 inet row, got $INET_COUNT"

# 9. Unknown provider rejected
echo
echo "9. Unknown provider rejected ..."
BAD=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/submit?provider=evilcorp")
echo "$BAD" | grep -q "unknown provider" && pass "unknown provider rejected" || fail "unknown provider not rejected: $BAD"

# 10. Auth required
echo
echo "10. Auth required on /preview ..."
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/etax/orders/$ORDER_ID/preview")
[ "$NOAUTH" = "401" ] && pass "401 without token" || fail "expected 401, got $NOAUTH"

# Cleanup auth (don't leak admins)
PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -c "
  DELETE FROM custom.refresh_tokens WHERE user_id='$ADMIN_USER_ID';
  DELETE FROM custom.users WHERE id='$ADMIN_USER_ID';" >/dev/null

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" = "0" ] && exit 0 || exit 1
