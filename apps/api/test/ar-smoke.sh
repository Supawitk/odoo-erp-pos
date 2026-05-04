#!/usr/bin/env bash
# AR module live smoke — exercises the full credit-sale lifecycle:
#   create draft → send (post AR) → partial receipt 30% → partial 30% → final 40% → AR aging
# Verifies: VAT engine, WHT split, journal balance, paid_cents reconciliation,
# state machine, AR aging buckets.

set -e
API=${API:-http://localhost:3001}
CUSTOMER_ID=${CUSTOMER_ID:-48caec2b-0d10-4d0c-ba32-919f9173cf4e}
EMAIL=${EMAIL:-ar-smoke@example.com}
# Required: export PASSWORD before running. Don't bake credentials into source.
PASSWORD=${PASSWORD:?PASSWORD env var must be set (smoke account password)}

echo "=== Auth: login as $EMAIL ==="
TOKEN=$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r '.accessToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "❌ login failed"; exit 1; }
AUTH=("-H" "authorization: Bearer $TOKEN")

# helpers
PASS=0
FAIL=0
ok() { PASS=$((PASS+1)); echo "✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "❌ $1"; echo "    $2"; }
check() { local name="$1" cond="$2" got="$3"; if [ "$cond" = "true" ]; then ok "$name"; else fail "$name" "got: $got"; fi; }

echo "=== Setup: customer $CUSTOMER_ID ==="
CUST=$(curl -s "${AUTH[@]}" "$API/api/purchasing/partners/$CUSTOMER_ID" 2>/dev/null || echo '{}')
echo "$CUST" | jq -r '.name // "(none)"'

echo "=== Cleanup prior smoke runs (delete invoices for this customer) ==="
PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD env var must be set}" psql -h localhost -U admin -d odoo -q -c "
  DELETE FROM custom.invoice_receipts
   WHERE sales_invoice_id IN (SELECT id FROM custom.sales_invoices WHERE customer_id = '$CUSTOMER_ID');
  DELETE FROM custom.sales_invoice_lines
   WHERE sales_invoice_id IN (SELECT id FROM custom.sales_invoices WHERE customer_id = '$CUSTOMER_ID');
  DELETE FROM custom.sales_invoices WHERE customer_id = '$CUSTOMER_ID';
  DELETE FROM custom.document_sequences WHERE document_type IN ('SI','RC');
" > /dev/null

echo
echo "=== 1. Create draft invoice ==="
# 100 net @ 7% VAT = 107 gross. WHT = services 3% on 100 = 3
INV_CREATE=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices" \
  -H 'content-type: application/json' \
  -d "{
    \"customerId\": \"$CUSTOMER_ID\",
    \"customerReference\": \"PO-AR-SMOKE-001\",
    \"invoiceDate\": \"2026-05-04\",
    \"paymentTermsDays\": 30,
    \"vatMode\": \"exclusive\",
    \"lines\": [
      {\"description\": \"Consulting services — May\", \"qty\": 1, \"unitPriceCents\": 10000, \"vatCategory\": \"standard\", \"whtCategory\": \"services\"}
    ]
  }")
INV_ID=$(echo "$INV_CREATE" | jq -r '.id')
INV_NUMBER=$(echo "$INV_CREATE" | jq -r '.internalNumber')
INV_TOTAL=$(echo "$INV_CREATE" | jq -r '.totalCents')
INV_VAT=$(echo "$INV_CREATE" | jq -r '.vatCents')
INV_WHT=$(echo "$INV_CREATE" | jq -r '.whtCents')
INV_STATUS=$(echo "$INV_CREATE" | jq -r '.status')

[ "$INV_ID" != "null" ] && [ -n "$INV_ID" ] && ok "draft created: $INV_NUMBER" || fail "create" "$INV_CREATE"
check "total = 10700 (100 + 7% VAT)" "$([ "$INV_TOTAL" = "10700" ] && echo true)" "$INV_TOTAL"
check "VAT = 700 (7% of 10000)" "$([ "$INV_VAT" = "700" ] && echo true)" "$INV_VAT"
check "WHT = 300 (3% of 10000)" "$([ "$INV_WHT" = "300" ] && echo true)" "$INV_WHT"
check "status = draft" "$([ "$INV_STATUS" = "draft" ] && echo true)" "$INV_STATUS"

echo
echo "=== 2. Send (post AR journal) ==="
SEND=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV_ID/send" -H 'content-type: application/json' -d '{}')
SEND_STATUS=$(echo "$SEND" | jq -r '.status')
JE_ID=$(echo "$SEND" | jq -r '.journalEntryId')
check "status → sent" "$([ "$SEND_STATUS" = "sent" ] && echo true)" "$SEND_STATUS"
[ "$JE_ID" != "null" ] && ok "journal entry id $JE_ID" || fail "no JE" "$SEND"

# Verify the JE balances
JE=$(curl -s "${AUTH[@]}" "$API/api/accounting/journal-entries/$JE_ID")
JE_DEBIT=$(echo "$JE" | jq '[.lines[].debitCents] | add')
JE_CREDIT=$(echo "$JE" | jq '[.lines[].creditCents] | add')
check "JE debits == credits ($JE_DEBIT)" "$([ "$JE_DEBIT" = "$JE_CREDIT" ] && [ "$JE_DEBIT" = "10700" ] && echo true)" "Dr=$JE_DEBIT Cr=$JE_CREDIT"

# Verify the JE has the right accounts
HAS_AR=$(echo "$JE" | jq '[.lines[] | select(.accountCode == "1141")] | length')
HAS_REV=$(echo "$JE" | jq '[.lines[] | select(.accountCode == "4120")] | length')
HAS_VAT=$(echo "$JE" | jq '[.lines[] | select(.accountCode == "2201")] | length')
check "JE Dr 1141 AR present" "$([ "$HAS_AR" = "1" ] && echo true)" "$HAS_AR"
check "JE Cr 4120 Service revenue present" "$([ "$HAS_REV" = "1" ] && echo true)" "$HAS_REV"
check "JE Cr 2201 Output VAT present" "$([ "$HAS_VAT" = "1" ] && echo true)" "$HAS_VAT"

echo
echo "=== 3. Partial receipt #1 — 30% of 10700 = 3210 ==="
R1=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV_ID/receipts" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 3210, "paymentMethod": "bank_transfer", "bankReference": "TX-MAY01"}')
R1_NO=$(echo "$R1" | jq -r '.receiptNo')
R1_WHT=$(echo "$R1" | jq -r '.allocation.whtCents')
R1_CASH=$(echo "$R1" | jq -r '.allocation.cashCents')
R1_FINAL=$(echo "$R1" | jq -r '.allocation.isFinal')
check "receipt #$R1_NO" "$([ "$R1_NO" = "1" ] && echo true)" "$R1_NO"
# floor(3210 * 300 / 10700) = 90
check "receipt 1 WHT = 90" "$([ "$R1_WHT" = "90" ] && echo true)" "$R1_WHT"
check "receipt 1 cash = 3120" "$([ "$R1_CASH" = "3120" ] && echo true)" "$R1_CASH"
check "receipt 1 NOT final" "$([ "$R1_FINAL" = "false" ] && echo true)" "$R1_FINAL"

INV_AFTER1=$(curl -s "${AUTH[@]}" "$API/api/sales/invoices/$INV_ID")
S1=$(echo "$INV_AFTER1" | jq -r '.status')
PAID1=$(echo "$INV_AFTER1" | jq -r '.paidCents')
WHT1=$(echo "$INV_AFTER1" | jq -r '.whtReceivedCents')
REM1=$(echo "$INV_AFTER1" | jq -r '.remainingCents')
check "status → partially_paid" "$([ "$S1" = "partially_paid" ] && echo true)" "$S1"
check "paidCents = 3210" "$([ "$PAID1" = "3210" ] && echo true)" "$PAID1"
check "whtReceivedCents = 90" "$([ "$WHT1" = "90" ] && echo true)" "$WHT1"
check "remainingCents = 7490" "$([ "$REM1" = "7490" ] && echo true)" "$REM1"

echo
echo "=== 4. Partial receipt #2 — another 3210 with 35¢ bank charge ==="
R2=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV_ID/receipts" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 3210, "bankChargeCents": 35, "paymentMethod": "promptpay"}')
R2_WHT=$(echo "$R2" | jq -r '.allocation.whtCents')
R2_CASH=$(echo "$R2" | jq -r '.allocation.cashCents')
R2_BC=$(echo "$R2" | jq -r '.allocation.bankChargeCents')
check "receipt 2 WHT = 90" "$([ "$R2_WHT" = "90" ] && echo true)" "$R2_WHT"
check "receipt 2 bank charge = 35" "$([ "$R2_BC" = "35" ] && echo true)" "$R2_BC"
# cash = 3210 - 90 - 35 = 3085
check "receipt 2 cash = 3085" "$([ "$R2_CASH" = "3085" ] && echo true)" "$R2_CASH"

echo
echo "=== 5. Final receipt — remaining 4280 (40%) ==="
R3=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV_ID/receipts" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 4280, "paymentMethod": "cheque", "bankReference": "CHQ-1234"}')
R3_WHT=$(echo "$R3" | jq -r '.allocation.whtCents')
R3_CASH=$(echo "$R3" | jq -r '.allocation.cashCents')
R3_FINAL=$(echo "$R3" | jq -r '.allocation.isFinal')
# remainder pickup: 300 - 90 - 90 = 120
check "receipt 3 WHT (remainder) = 120" "$([ "$R3_WHT" = "120" ] && echo true)" "$R3_WHT"
check "receipt 3 cash = 4160" "$([ "$R3_CASH" = "4160" ] && echo true)" "$R3_CASH"
check "receipt 3 IS final" "$([ "$R3_FINAL" = "true" ] && echo true)" "$R3_FINAL"

INV_DONE=$(curl -s "${AUTH[@]}" "$API/api/sales/invoices/$INV_ID")
SD=$(echo "$INV_DONE" | jq -r '.status')
PAIDD=$(echo "$INV_DONE" | jq -r '.paidCents')
WHTD=$(echo "$INV_DONE" | jq -r '.whtReceivedCents')
REMD=$(echo "$INV_DONE" | jq -r '.remainingCents')
check "status → paid" "$([ "$SD" = "paid" ] && echo true)" "$SD"
check "paidCents = 10700 (matches total)" "$([ "$PAIDD" = "10700" ] && echo true)" "$PAIDD"
check "whtReceivedCents = 300 (matches expected)" "$([ "$WHTD" = "300" ] && echo true)" "$WHTD"
check "remainingCents = 0" "$([ "$REMD" = "0" ] && echo true)" "$REMD"

echo
echo "=== 6. Reconcile receipts list ==="
RECEIPTS=$(curl -s "${AUTH[@]}" "$API/api/sales/invoices/$INV_ID/receipts")
COUNT=$(echo "$RECEIPTS" | jq 'length')
SUM_AMT=$(echo "$RECEIPTS" | jq '[.[].amountCents] | add')
SUM_WHT=$(echo "$RECEIPTS" | jq '[.[].whtCents] | add')
SUM_CASH=$(echo "$RECEIPTS" | jq '[.[].cashCents] | add')
SUM_BC=$(echo "$RECEIPTS" | jq '[.[].bankChargeCents] | add')
check "3 receipts in list" "$([ "$COUNT" = "3" ] && echo true)" "$COUNT"
check "Σ amounts = 10700" "$([ "$SUM_AMT" = "10700" ] && echo true)" "$SUM_AMT"
check "Σ WHT = 300" "$([ "$SUM_WHT" = "300" ] && echo true)" "$SUM_WHT"
check "Σ cash = 10365 (10700 - 300 WHT - 35 bank charge)" "$([ "$SUM_CASH" = "10365" ] && echo true)" "$SUM_CASH"
check "Σ bank charges = 35" "$([ "$SUM_BC" = "35" ] && echo true)" "$SUM_BC"

echo
echo "=== 7. Verify each receipt JE balances ==="
for r in $(echo "$RECEIPTS" | jq -r '.[].journalEntryId'); do
  JE=$(curl -s "${AUTH[@]}" "$API/api/accounting/journal-entries/$r")
  D=$(echo "$JE" | jq '[.lines[].debitCents] | add')
  C=$(echo "$JE" | jq '[.lines[].creditCents] | add')
  check "JE $r balanced (Dr=Cr=$D)" "$([ "$D" = "$C" ] && echo true)" "Dr=$D Cr=$C"
done

echo
echo "=== 8. Overpayment rejected ==="
OP=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV_ID/receipts" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 1}')
OP_STATUS=$(echo "$OP" | jq -r '.statusCode')
check "1¢ on fully-paid invoice → 400" "$([ "$OP_STATUS" = "400" ] && echo true)" "$OP_STATUS"

echo
echo "=== 9. AR aging — fully-paid invoice excluded ==="
AGING=$(curl -s "${AUTH[@]}" "$API/api/sales/ar-aging")
GRAND=$(echo "$AGING" | jq -r '.grandTotalCents')
COUNT=$(echo "$AGING" | jq -r '.customers | length')
echo "  grand outstanding = $GRAND, $COUNT customers with balance"

# Create a 2nd invoice that stays partially paid to test aging
INV2=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices" \
  -H 'content-type: application/json' \
  -d "{
    \"customerId\": \"$CUSTOMER_ID\",
    \"invoiceDate\": \"2026-05-04\",
    \"paymentTermsDays\": 30,
    \"lines\": [
      {\"description\": \"Half-paid widgets\", \"qty\": 5, \"unitPriceCents\": 20000, \"vatCategory\": \"standard\"}
    ]
  }")
INV2_ID=$(echo "$INV2" | jq -r '.id')
INV2_NUMBER=$(echo "$INV2" | jq -r '.internalNumber')
curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV2_ID/send" -H 'content-type: application/json' -d '{}' > /dev/null
# 5*20000 = 100000 net + 7000 VAT = 107000. Pay 50000 (partial).
curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV2_ID/receipts" -H 'content-type: application/json' \
  -d '{"amountCents": 50000, "paymentMethod": "bank_transfer"}' > /dev/null

AGING2=$(curl -s "${AUTH[@]}" "$API/api/sales/ar-aging")
GRAND2=$(echo "$AGING2" | jq -r '.grandTotalCents')
CURRENT_BUCKET=$(echo "$AGING2" | jq -r '.bucketTotals.current')
check "AR aging picked up the 57000 remaining (=107000-50000)" "$([ "$GRAND2" = "57000" ] && echo true)" "$GRAND2"
check "all 57000 in 'current' bucket (not yet due)" "$([ "$CURRENT_BUCKET" = "57000" ] && echo true)" "$CURRENT_BUCKET"

# Check overdue: invoice date 2026-05-04 + 30d terms → due 2026-06-03.
# asOf 2026-07-15 → 42 days overdue → d31_60 bucket.
AGING3=$(curl -s "${AUTH[@]}" "$API/api/sales/ar-aging?asOf=2026-07-15")
D31=$(echo "$AGING3" | jq -r '.bucketTotals.d31_60')
check "as-of 2026-07-15 → 57000 in d31_60 bucket" "$([ "$D31" = "57000" ] && echo true)" "$D31"

echo
echo "=== 10. Cleanup — cancel the 2nd invoice ==="
CANCEL=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV2_ID/cancel" \
  -H 'content-type: application/json' \
  -d '{"reason": "smoke test cleanup"}')
CANCEL_STATUS=$(echo "$CANCEL" | jq -r '.statusCode')
# Should fail because it's partially_paid
check "partially-paid invoice can NOT be cancelled" "$([ "$CANCEL_STATUS" = "400" ] && echo true)" "$CANCEL_STATUS"

# Cancel a fresh draft instead
INV3=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices" \
  -H 'content-type: application/json' \
  -d "{
    \"customerId\": \"$CUSTOMER_ID\",
    \"invoiceDate\": \"2026-05-04\",
    \"lines\": [{\"description\": \"to cancel\", \"qty\": 1, \"unitPriceCents\": 1000, \"vatCategory\": \"standard\"}]
  }")
INV3_ID=$(echo "$INV3" | jq -r '.id')
CANCEL3=$(curl -s "${AUTH[@]}" -X POST "$API/api/sales/invoices/$INV3_ID/cancel" \
  -H 'content-type: application/json' \
  -d '{"reason": "smoke cleanup of draft"}')
CANCEL3_STATUS=$(echo "$CANCEL3" | jq -r '.status')
check "draft can be cancelled" "$([ "$CANCEL3_STATUS" = "cancelled" ] && echo true)" "$CANCEL3_STATUS"

echo
echo "================================"
echo "RESULT: $PASS passed, $FAIL failed"
echo "================================"
[ $FAIL -eq 0 ] && exit 0 || exit 1
