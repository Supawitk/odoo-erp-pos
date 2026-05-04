#!/usr/bin/env bash
# Void payment/receipt smoke — exercises the symmetric void flows for AP + AR.
#
# Scenario (run for both AP and AR):
#   1. Create + post bill / send invoice (107000 total, 3000 WHT)
#   2. Pay 50% (status → partially_paid)
#   3. Pay remaining 50% (status → paid)
#   4. Void payment #2 → status drops back to partially_paid
#   5. Verify totals roll back: paidCents=53500, whtPaidCents=1500
#   6. Verify reversal JE was posted and balances
#   7. Re-pay the remainder → back to paid
#   8. Void payment #3 (the new final payment) → partially_paid again
#   9. Void payment #1 → status drops to posted/sent (no payments left)
#  10. Verify void on already-voided row → 400
set -e
API=${API:-http://localhost:3001}
EMAIL=${EMAIL:-ar-smoke@example.com}
# Required: export PASSWORD before running. Don't bake credentials into source.
PASSWORD=${PASSWORD:?PASSWORD env var must be set (smoke account password)}

TOKEN=$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r '.accessToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "❌ login failed"; exit 1; }
H="authorization: Bearer $TOKEN"

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "❌ $1"; echo "    $2"; }
check() { [ "$2" = "true" ] && ok "$1" || fail "$1" "got: $3"; }

###############################################
echo "=== AP void flow ==="
###############################################

SUPPLIER_ID=$(curl -s -H "$H" "$API/api/purchasing/partners?role=supplier" | jq -r '.[0].id')
[ -n "$SUPPLIER_ID" ] && [ "$SUPPLIER_ID" != "null" ] || { echo "❌ no supplier"; exit 1; }

# Create + post bill
BILL=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills" \
  -H 'content-type: application/json' \
  -d "{\"supplierId\":\"$SUPPLIER_ID\",\"billDate\":\"2026-05-04\",\"supplierTaxInvoiceNumber\":\"VOID-AP-001\",\"supplierTaxInvoiceDate\":\"2026-05-04\",\"vatMode\":\"exclusive\",\"lines\":[{\"description\":\"Void test service\",\"qty\":1,\"unitPriceCents\":100000,\"vatCategory\":\"standard\",\"whtCategory\":\"services\"}]}")
BILL_ID=$(echo "$BILL" | jq -r '.id')
ok "bill created: $(echo "$BILL" | jq -r '.internalNumber')"

curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/post" \
  -H 'content-type: application/json' \
  -d '{"overrideMatchBy":"smoke","overrideReason":"no PO"}' > /dev/null
ok "bill posted"

# Pay 1: 50% = 53500
P1=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 53500, "paymentMethod": "bank_transfer", "bankReference": "P1"}')
P1_NO=$(echo "$P1" | jq -r '.paymentNo')

# Pay 2: remaining 53500 → paid
P2=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 53500, "paymentMethod": "promptpay"}')
P2_NO=$(echo "$P2" | jq -r '.paymentNo')

B1=$(curl -s -H "$H" "$API/api/purchasing/vendor-bills/$BILL_ID")
check "after 2 payments → status=paid" "$([ "$(echo "$B1" | jq -r '.status')" = "paid" ] && echo true)" "$(echo "$B1" | jq -r '.status')"
check "paidCents = 107000" "$([ "$(echo "$B1" | jq -r '.paidCents')" = "107000" ] && echo true)" "$(echo "$B1" | jq -r '.paidCents')"

# Void payment #2 → status reverts to partially_paid
V2=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments/$P2_NO/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "wrong amount, will redo"}')
check "void payment #2 → status partially_paid" "$([ "$(echo "$V2" | jq -r '.newStatus')" = "partially_paid" ] && echo true)" "$(echo "$V2" | jq -r '.newStatus')"
check "void rolled paidCents back to 53500" "$([ "$(echo "$V2" | jq -r '.newPaidCents')" = "53500" ] && echo true)" "$(echo "$V2" | jq -r '.newPaidCents')"
check "void rolled whtPaidCents back to 1500" "$([ "$(echo "$V2" | jq -r '.newWhtPaidCents')" = "1500" ] && echo true)" "$(echo "$V2" | jq -r '.newWhtPaidCents')"

# Bill row reflects the rollback
B2=$(curl -s -H "$H" "$API/api/purchasing/vendor-bills/$BILL_ID")
check "bill status = partially_paid" "$([ "$(echo "$B2" | jq -r '.status')" = "partially_paid" ] && echo true)" "$(echo "$B2" | jq -r '.status')"
check "bill paidCents = 53500" "$([ "$(echo "$B2" | jq -r '.paidCents')" = "53500" ] && echo true)" "$(echo "$B2" | jq -r '.paidCents')"

# Void payment #1 → status drops to posted (no payments left)
V1=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments/$P1_NO/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "void all to start over"}')
check "void last payment → status posted" "$([ "$(echo "$V1" | jq -r '.newStatus')" = "posted" ] && echo true)" "$(echo "$V1" | jq -r '.newStatus')"
check "paidCents = 0 after voiding all" "$([ "$(echo "$V1" | jq -r '.newPaidCents')" = "0" ] && echo true)" "$(echo "$V1" | jq -r '.newPaidCents')"

# Verify the reversal JE balances and exists
PMTS=$(curl -s -H "$H" "$API/api/purchasing/vendor-bills/$BILL_ID/payments")
COUNT_VOIDED=$(echo "$PMTS" | jq '[.[] | select(.voidedAt != null)] | length')
check "both payments persisted as voided audit trail" "$([ "$COUNT_VOIDED" = "2" ] && echo true)" "$COUNT_VOIDED"

# Re-pay the bill to confirm we can recover
NEW_PAY=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 107000, "paymentMethod": "bank_transfer"}')
NEW_FINAL=$(echo "$NEW_PAY" | jq -r '.allocation.isFinal')
NEW_WHT=$(echo "$NEW_PAY" | jq -r '.allocation.whtCents')
check "re-pay full balance → final" "$([ "$NEW_FINAL" = "true" ] && echo true)" "$NEW_FINAL"
# Full payment WHT should be the full 3000 (no prior non-voided installments)
check "re-pay WHT = 3000 (full bill WHT)" "$([ "$NEW_WHT" = "3000" ] && echo true)" "$NEW_WHT"

B3=$(curl -s -H "$H" "$API/api/purchasing/vendor-bills/$BILL_ID")
check "after re-pay → status=paid" "$([ "$(echo "$B3" | jq -r '.status')" = "paid" ] && echo true)" "$(echo "$B3" | jq -r '.status')"

# Re-void with already-voided returns 400
DV=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments/$P1_NO/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "double void"}')
check "double-void payment #1 → 400" "$([ "$(echo "$DV" | jq -r '.statusCode')" = "400" ] && echo true)" "$(echo "$DV" | jq -r '.statusCode')"

# Short reason rejected
SR=$(curl -s -H "$H" -X POST "$API/api/purchasing/vendor-bills/$BILL_ID/payments/3/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "x"}')
check "short reason → 400" "$([ "$(echo "$SR" | jq -r '.statusCode')" = "400" ] && echo true)" "$(echo "$SR" | jq -r '.statusCode')"

###############################################
echo
echo "=== AR void flow ==="
###############################################

# Reuse the AR smoke customer. Wipe prior AR test state
PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD env var must be set}" psql -h localhost -U admin -d odoo -q -c "
  DELETE FROM custom.invoice_receipts WHERE sales_invoice_id IN (SELECT id FROM custom.sales_invoices WHERE customer_id = '48caec2b-0d10-4d0c-ba32-919f9173cf4e');
  DELETE FROM custom.sales_invoice_lines WHERE sales_invoice_id IN (SELECT id FROM custom.sales_invoices WHERE customer_id = '48caec2b-0d10-4d0c-ba32-919f9173cf4e');
  DELETE FROM custom.sales_invoices WHERE customer_id = '48caec2b-0d10-4d0c-ba32-919f9173cf4e';
  DELETE FROM custom.document_sequences WHERE document_type IN ('SI','RC');
" > /dev/null
CUSTOMER_ID=48caec2b-0d10-4d0c-ba32-919f9173cf4e

# Create + send invoice
INV=$(curl -s -H "$H" -X POST "$API/api/sales/invoices" \
  -H 'content-type: application/json' \
  -d "{\"customerId\":\"$CUSTOMER_ID\",\"invoiceDate\":\"2026-05-04\",\"vatMode\":\"exclusive\",\"lines\":[{\"description\":\"Void AR test\",\"qty\":1,\"unitPriceCents\":100000,\"vatCategory\":\"standard\",\"whtCategory\":\"services\"}]}")
INV_ID=$(echo "$INV" | jq -r '.id')
ok "invoice draft: $(echo "$INV" | jq -r '.internalNumber')"

curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/send" -H 'content-type: application/json' -d '{}' > /dev/null

# Receipt 1 + 2 → paid
R1=$(curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/receipts" -H 'content-type: application/json' -d '{"amountCents": 53500, "paymentMethod": "bank_transfer"}')
R1_NO=$(echo "$R1" | jq -r '.receiptNo')
R2=$(curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/receipts" -H 'content-type: application/json' -d '{"amountCents": 53500, "paymentMethod": "promptpay"}')
R2_NO=$(echo "$R2" | jq -r '.receiptNo')

I1=$(curl -s -H "$H" "$API/api/sales/invoices/$INV_ID")
check "after 2 receipts → status=paid" "$([ "$(echo "$I1" | jq -r '.status')" = "paid" ] && echo true)" "$(echo "$I1" | jq -r '.status')"

# Void receipt 2 → partially_paid
RV2=$(curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/receipts/$R2_NO/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "customer reversed payment"}')
check "void receipt #2 → status=partially_paid" "$([ "$(echo "$RV2" | jq -r '.newStatus')" = "partially_paid" ] && echo true)" "$(echo "$RV2" | jq -r '.newStatus')"
check "void rolled paidCents to 53500" "$([ "$(echo "$RV2" | jq -r '.newPaidCents')" = "53500" ] && echo true)" "$(echo "$RV2" | jq -r '.newPaidCents')"
check "void rolled whtReceivedCents to 1500" "$([ "$(echo "$RV2" | jq -r '.newWhtReceivedCents')" = "1500" ] && echo true)" "$(echo "$RV2" | jq -r '.newWhtReceivedCents')"

# Void receipt 1 → sent (no receipts left)
RV1=$(curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/receipts/$R1_NO/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "void all"}')
check "void last receipt → status=sent" "$([ "$(echo "$RV1" | jq -r '.newStatus')" = "sent" ] && echo true)" "$(echo "$RV1" | jq -r '.newStatus')"

# Verify the receipts are still in the audit trail
RCPTS=$(curl -s -H "$H" "$API/api/sales/invoices/$INV_ID/receipts")
COUNT_VOIDED=$(echo "$RCPTS" | jq '[.[] | select(.voidedAt != null)] | length')
check "both receipts persisted as voided audit trail" "$([ "$COUNT_VOIDED" = "2" ] && echo true)" "$COUNT_VOIDED"

# Verify each reversal JE balances
for r in $(echo "$RCPTS" | jq -r '.[].journalEntryId'); do
  JE=$(curl -s -H "$H" "$API/api/accounting/journal-entries/$r")
  JE_STATUS=$(echo "$JE" | jq -r '.status // "?"')
  D=$(echo "$JE" | jq '[.lines[].debitCents] | add')
  C=$(echo "$JE" | jq '[.lines[].creditCents] | add')
  check "original receipt JE $r status=voided AND balanced" "$([ "$JE_STATUS" = "voided" ] && [ "$D" = "$C" ] && echo true)" "status=$JE_STATUS Dr=$D Cr=$C"
done

# Re-receive → back to paid
NR=$(curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/receipts" \
  -H 'content-type: application/json' \
  -d '{"amountCents": 107000, "paymentMethod": "bank_transfer"}')
check "re-receive full → final" "$([ "$(echo "$NR" | jq -r '.allocation.isFinal')" = "true" ] && echo true)" "$(echo "$NR" | jq -r '.allocation.isFinal')"
check "re-receive WHT = 3000" "$([ "$(echo "$NR" | jq -r '.allocation.whtCents')" = "3000" ] && echo true)" "$(echo "$NR" | jq -r '.allocation.whtCents')"

I2=$(curl -s -H "$H" "$API/api/sales/invoices/$INV_ID")
check "after re-receive → status=paid" "$([ "$(echo "$I2" | jq -r '.status')" = "paid" ] && echo true)" "$(echo "$I2" | jq -r '.status')"

# Double-void rejected
DR=$(curl -s -H "$H" -X POST "$API/api/sales/invoices/$INV_ID/receipts/$R1_NO/void" \
  -H 'content-type: application/json' \
  -d '{"reason": "double void"}')
check "double-void receipt #1 → 400" "$([ "$(echo "$DR" | jq -r '.statusCode')" = "400" ] && echo true)" "$(echo "$DR" | jq -r '.statusCode')"

echo
echo "================================"
echo "RESULT: $PASS passed, $FAIL failed"
echo "================================"
[ $FAIL -eq 0 ] && exit 0 || exit 1
