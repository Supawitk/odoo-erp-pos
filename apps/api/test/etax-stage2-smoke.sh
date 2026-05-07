#!/usr/bin/env bash
# 🇹🇭 Phase 4B Stage 2 — operator dashboard + relay smoke.
# Pre-reqs: API running on :3001 + at least one paid TX order with TIN.

set -uo pipefail
# Note: deliberately NOT set -e — many `grep -o | wc -l` chains legitimately
# return 0 matches (which is grep exit 1 + pipefail = script death).

API="${API:-http://localhost:3001}"
PGPASS="${POSTGRES_PASSWORD:-erp_app_dev_pw_change_me}"
PGUSER="${POSTGRES_USER:-erp_app}"

PASS=0
FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=== Phase 4B Stage 2 — operator dashboard + relay smoke ==="

# 1. Admin user
EMAIL="etax-stage2-$(date +%s)@example.com"
PASSWORD="EtaxStage2Pass!1"
echo
echo "1. Create + promote admin..."
REG=$(curl -s -X POST "$API/api/auth/register" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Stage 2\"}")
USER_ID=$(echo "$REG" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$USER_ID" ] && pass "registered" || { fail "register failed: $REG"; exit 1; }
PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "UPDATE custom.users SET role='admin' WHERE id='$USER_ID';" >/dev/null
LOGIN=$(curl -s -X POST "$API/api/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] && pass "got token" || { fail "no token: $LOGIN"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# 2. Stats endpoint
echo
echo "2. GET /api/etax/stats ..."
STATS=$(curl -s "${AUTH[@]}" "$API/api/etax/stats")
echo "$STATS" | grep -q '"pending"' && pass "stats has pending count" || fail "no pending: $STATS"
echo "$STATS" | grep -q '"acknowledged"' && pass "stats has acknowledged" || fail "no acknowledged"
echo "$STATS" | grep -q '"dlq"' && pass "stats has dlq" || fail "no dlq"

# 3. List submissions
echo
echo "3. GET /api/etax/submissions ..."
LIST=$(curl -s "${AUTH[@]}" "$API/api/etax/submissions?limit=5")
echo "$LIST" | grep -q '^\[' && pass "list returns array" || fail "not array: $(echo $LIST | head -c 200)"

# 4. Filter by status
echo
echo "4. GET /api/etax/submissions?status=acknowledged ..."
LIST_ACK=$(curl -s "${AUTH[@]}" "$API/api/etax/submissions?status=acknowledged&limit=10")
ACK_COUNT=$(echo "$LIST_ACK" | grep -o '"status":"acknowledged"' | wc -l | tr -d ' ')
NON_ACK=$(echo "$LIST_ACK" | grep -o '"status":"[^"]*"' | grep -v acknowledged | wc -l | tr -d ' ')
[ "$NON_ACK" = "0" ] && pass "filter returns only acknowledged ($ACK_COUNT rows)" || fail "filter leaked non-acknowledged ($NON_ACK rows)"

# 5. Filter by provider
LIST_LECEIPT=$(curl -s "${AUTH[@]}" "$API/api/etax/submissions?provider=leceipt&limit=10")
NON_LECEIPT=$(echo "$LIST_LECEIPT" | grep -o '"provider":"[^"]*"' | grep -v leceipt | wc -l | tr -d ' ')
[ "$NON_LECEIPT" = "0" ] && pass "filter by provider works" || fail "leaked non-leceipt"

# 6. Run relay manually — should return counts (no rows pending → 0/0/0/0)
echo
echo "6. POST /api/etax/relay/run ..."
RUN=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/relay/run?batchSize=10")
echo "$RUN" | grep -q '"attempted"' && pass "relay/run returns counts: $RUN" || fail "no counts: $RUN"

# 7. Submit a TX order to seed a row, then verify it appears in list
echo
echo "7. Submit a TX order via /submit ..."
ORDER_ID=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "
  SELECT id FROM custom.pos_orders
  WHERE status='paid' AND document_type='TX' AND buyer_tin IS NOT NULL
  ORDER BY created_at DESC LIMIT 1;" | head -1 | tr -d ' ')
SUB=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/orders/$ORDER_ID/submit?provider=leceipt")
SUB_ID=$(echo "$SUB" | sed -n 's/.*"submissionId":"\([^"]*\)".*/\1/p')
[ -n "$SUB_ID" ] && pass "submitted, got id $SUB_ID" || { fail "submit failed: $SUB"; exit 1; }

# 8. Force DLQ + verify
echo
echo "8. POST /api/etax/submissions/:id/dlq ..."
DLQ=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/submissions/$SUB_ID/dlq?reason=stage2-test")
echo "$DLQ" | grep -q '"ok":true' && pass "DLQ marked" || fail "dlq failed: $DLQ"
STATUS=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "SELECT status FROM custom.etax_submissions WHERE id='$SUB_ID';" | head -1 | tr -d ' ')
[ "$STATUS" = "dlq" ] && pass "DB status=dlq" || fail "expected dlq, got $STATUS"

# 9. Requeue + verify
echo
echo "9. POST /api/etax/submissions/:id/requeue ..."
RQ=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/submissions/$SUB_ID/requeue")
echo "$RQ" | grep -q '"ok":true' && pass "requeued" || fail "requeue failed: $RQ"
STATUS=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "SELECT status FROM custom.etax_submissions WHERE id='$SUB_ID';" | head -1 | tr -d ' ')
ATTEMPTS=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "SELECT attempts FROM custom.etax_submissions WHERE id='$SUB_ID';" | head -1 | tr -d ' ')
[ "$STATUS" = "pending" ] && pass "requeued status=pending" || fail "expected pending, got $STATUS"
[ "$ATTEMPTS" = "0" ] && pass "attempts reset to 0" || fail "expected 0, got $ATTEMPTS"

# 10. Run relay → drains the requeued row → ack
echo
echo "10. POST /api/etax/relay/run after requeue ..."
RUN2=$(curl -s -X POST "${AUTH[@]}" "$API/api/etax/relay/run?batchSize=10")
echo "  result: $RUN2"
echo "$RUN2" | grep -qE '"succeeded":[1-9]' && pass "relay drained ≥1 row" || fail "relay didn't drain: $RUN2"
STATUS_NOW=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "SELECT status FROM custom.etax_submissions WHERE id='$SUB_ID';" | head -1 | tr -d ' ')
[ "$STATUS_NOW" = "acknowledged" ] && pass "row drained to acknowledged" || fail "expected acknowledged, got $STATUS_NOW"

# 11. Download stored XML
echo
echo "11. GET /api/etax/submissions/:id/xml ..."
XML=$(curl -s "${AUTH[@]}" "$API/api/etax/submissions/$SUB_ID/xml")
echo "$XML" | grep -q "<rsm:CrossIndustryInvoice" && pass "XML download has rsm root" || fail "no rsm root in download"
echo "$XML" | grep -q "<ram:TypeCode>T01</ram:TypeCode>" && pass "XML has T01 TypeCode" || fail "no T01"

# 12. Cashier rejected from /relay/run
echo
echo "12. Cashier role rejected on POST /relay/run ..."
EMAIL2="cashier-stage2-$(date +%s)@example.com"
curl -s -X POST "$API/api/auth/register" -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"CashierPass!1\",\"name\":\"Cashier\"}" >/dev/null
USER_ID2=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -tAc "SELECT id FROM custom.users WHERE email='$EMAIL2';" | head -1 | tr -d ' ')
TOKEN2=$(curl -s -X POST "$API/api/auth/login" -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"CashierPass!1\"}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
RUN3=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "authorization: Bearer $TOKEN2" "$API/api/etax/relay/run")
[ "$RUN3" = "403" ] && pass "cashier 403 on /relay/run" || fail "expected 403, got $RUN3"

# 13. No-auth rejected
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/etax/stats")
[ "$NOAUTH" = "401" ] && pass "no-token 401 on /stats" || fail "expected 401, got $NOAUTH"

# Cleanup test users
PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d odoo -c "
  DELETE FROM custom.refresh_tokens WHERE user_id IN ('$USER_ID', '$USER_ID2');
  DELETE FROM custom.users WHERE id IN ('$USER_ID', '$USER_ID2');" >/dev/null

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" = "0" ] && exit 0 || exit 1
