#!/usr/bin/env bash
# 🇹🇭 PP.36 self-assessment VAT — live smoke against real Postgres + API.
#
# Pipeline tested:
#   3 vendors  →  3 paid bills  →  /api/reports/pp36  →  expected aggregates
#                                  /api/reports/pp36.csv
#                                  /api/reports/pp36.xlsx
#
# Asserts:
#   • Foreign vendors (no Thai TIN) are included
#   • Thai vendor (with valid 13-digit TIN) is excluded
#   • Bill currency × fx → THB conversion is exact
#   • 7% VAT computed correctly per row
#   • Totals + currency set + filingDueDate are reported
#   • CSV row count + delimiter integrity
#   • XLSX is non-empty + has both summary + detail sheets
set -euo pipefail

: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
: "${PASSWORD:?set PASSWORD (admin login password)}"

PSQL="env PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U admin -d odoo -tA"

# 1. Smoke admin
HASH=$(node -e "
const argon2 = require('/Users/admin/Downloads/ff/node_modules/argon2');
argon2.hash(process.argv[1], { type: argon2.argon2id }).then(h => process.stdout.write(h));
" "$PASSWORD")
$PSQL -c "
DELETE FROM custom.refresh_tokens WHERE user_id IN (SELECT id FROM custom.users WHERE email='pp36-smoke@example.com');
DELETE FROM custom.users WHERE email='pp36-smoke@example.com';
INSERT INTO custom.users (email, password_hash, name, role, is_active)
  VALUES ('pp36-smoke@example.com', '$HASH', 'PP36 Smoke', 'admin', true);" >/dev/null

TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"pp36-smoke@example.com\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("accessToken",""))')
[ -n "$TOKEN" ] || { echo "FAIL: login"; exit 1; }

# 2. Seed: 2 foreign vendors + 1 Thai vendor (control). All paid in June 2026.
$PSQL <<'SQL' >/dev/null
DELETE FROM custom.bill_payments WHERE notes='pp36-smoke';
DELETE FROM custom.vendor_bill_lines WHERE vendor_bill_id IN (SELECT id FROM custom.vendor_bills WHERE notes='pp36-smoke');
DELETE FROM custom.vendor_bills WHERE notes='pp36-smoke';
DELETE FROM custom.partners WHERE name LIKE 'PP36-%';

INSERT INTO custom.partners (name, legal_name, is_supplier, tin, vat_registered, address, default_currency)
VALUES
  ('PP36-Acme-Foreign-USD',    'Acme Cloud Inc.',  true, NULL,            false,
   '{"line1":"100 Market St","city":"San Francisco","state":"CA","zip":"94103","country":"US"}'::jsonb, 'USD'),
  ('PP36-Foreign-Royalty-EUR', 'Logo Studio GmbH', true, NULL,            false,
   '{"line1":"Hauptstr 1","city":"Berlin","zip":"10115","country":"DE"}'::jsonb, 'EUR'),
  ('PP36-Local-Thai',          'Acme Thailand Ltd', true, '0107537000254', true,
   '{"line1":"123 Sukhumvit","district":"Watthana","province":"Bangkok","postalCode":"10110"}'::jsonb, 'THB');

WITH v_usd AS (SELECT id FROM custom.partners WHERE name='PP36-Acme-Foreign-USD'),
     v_eur AS (SELECT id FROM custom.partners WHERE name='PP36-Foreign-Royalty-EUR'),
     v_thb AS (SELECT id FROM custom.partners WHERE name='PP36-Local-Thai'),
b_usd AS (
  INSERT INTO custom.vendor_bills
   (internal_number, supplier_id, bill_date, currency, fx_rate_to_thb,
    subtotal_cents, vat_cents, wht_cents, total_cents,
    status, posted_at, posted_by, paid_at, paid_by, paid_cents, wht_paid_cents, notes)
  SELECT 'VB-PP36-USD', v_usd.id, DATE '2026-06-01', 'USD', 35.000000,
         10000, 0, 0, 10000,
         'paid', now(), 'smoke', TIMESTAMPTZ '2026-06-15', 'smoke', 10000, 0, 'pp36-smoke'
  FROM v_usd RETURNING id),
b_eur AS (
  INSERT INTO custom.vendor_bills
   (internal_number, supplier_id, bill_date, currency, fx_rate_to_thb,
    subtotal_cents, vat_cents, wht_cents, total_cents,
    status, posted_at, posted_by, paid_at, paid_by, paid_cents, wht_paid_cents, notes)
  SELECT 'VB-PP36-EUR', v_eur.id, DATE '2026-06-05', 'EUR', 40.000000,
         5000, 0, 0, 5000,
         'paid', now(), 'smoke', TIMESTAMPTZ '2026-06-20', 'smoke', 5000, 0, 'pp36-smoke'
  FROM v_eur RETURNING id),
b_thb AS (
  INSERT INTO custom.vendor_bills
   (internal_number, supplier_id, bill_date, currency, fx_rate_to_thb,
    subtotal_cents, vat_cents, wht_cents, total_cents,
    status, posted_at, posted_by, paid_at, paid_by, paid_cents, wht_paid_cents, notes)
  SELECT 'VB-PP36-THB', v_thb.id, DATE '2026-06-10', 'THB', 1.0,
         100000, 7000, 3000, 107000,
         'paid', now(), 'smoke', TIMESTAMPTZ '2026-06-25', 'smoke', 107000, 3000, 'pp36-smoke'
  FROM v_thb RETURNING id)
INSERT INTO custom.bill_payments
   (vendor_bill_id, payment_no, payment_date, amount_cents, wht_cents,
    bank_charge_cents, cash_cents, cash_account_code, payment_method, notes)
SELECT b_usd.id, 1, DATE '2026-06-15', 10000, 0, 0, 10000, '1120', 'bank_transfer', 'pp36-smoke' FROM b_usd
UNION ALL SELECT b_eur.id, 1, DATE '2026-06-20',  5000, 0, 0,  5000, '1120', 'bank_transfer', 'pp36-smoke' FROM b_eur
UNION ALL SELECT b_thb.id, 1, DATE '2026-06-25',107000, 3000, 0,104000, '1120', 'bank_transfer', 'pp36-smoke' FROM b_thb;
SQL

# 3. Pull endpoints
PASS=0; FAIL=0
check() {
  local desc=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then echo "  ✅ $desc → $actual"; PASS=$((PASS+1))
  else echo "  ❌ $desc → expected '$expected' got '$actual'"; FAIL=$((FAIL+1)); fi
}

JSON=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/pp36?year=2026&month=6")
echo "── PP.36 JSON summary ──"
check "rate"               "$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["rate"])')"               "0.07"
check "row count"          "$(echo "$JSON" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["rows"]))')"          "2"
check "totals.paymentCount"   "$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["totals"]["paymentCount"])')"   "2"
check "totals.supplierCount"  "$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["totals"]["supplierCount"])')"  "2"
check "totals.baseThbCents"   "$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["totals"]["baseThbCents"])')"   "550000"
check "totals.vatThbCents"    "$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["totals"]["vatThbCents"])')"    "38500"
check "filingDueDate"      "$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["filingDueDate"])')"      "2026-07-15"
check "currencies set"     "$(echo "$JSON" | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin)["currencies"]))')" "EUR,USD"

# Per-row checks
USD_ROW=$(echo "$JSON" | python3 -c 'import sys,json; r=[x for x in json.load(sys.stdin)["rows"] if x["currency"]=="USD"][0]; print(r["amountThbCents"], r["vatThbCents"])')
check "USD row base+vat" "$USD_ROW" "350000 24500"

EUR_ROW=$(echo "$JSON" | python3 -c 'import sys,json; r=[x for x in json.load(sys.stdin)["rows"] if x["currency"]=="EUR"][0]; print(r["amountThbCents"], r["vatThbCents"])')
check "EUR row base+vat" "$EUR_ROW" "200000 14000"

# Negative control: Thai vendor must not appear
HAS_THB=$(echo "$JSON" | python3 -c 'import sys,json; print(any(x["supplierName"]=="PP36-Local-Thai" for x in json.load(sys.stdin)["rows"]))')
check "Thai vendor excluded" "$HAS_THB" "False"

echo
echo "── PP.36 CSV ──"
CSV=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/pp36.csv?year=2026&month=6")
HEADER=$(echo "$CSV" | sed -n '1p' | tr -d '\r')
ROW1=$(echo "$CSV"   | sed -n '2p' | tr -d '\r')
ROW2=$(echo "$CSV"   | sed -n '3p' | tr -d '\r')
check "header field count" "$(echo "$HEADER" | tr ',' '\n' | wc -l | tr -d ' ')" "12"
check "row1 field count"   "$(echo "$ROW1"   | tr ',' '\n' | wc -l | tr -d ' ')" "12"
check "row2 field count"   "$(echo "$ROW2"   | tr ',' '\n' | wc -l | tr -d ' ')" "12"
check "row1 vat (col 12)"  "$(echo "$ROW1" | awk -F, '{print $12}')" "245.00"
check "row2 vat (col 12)"  "$(echo "$ROW2" | awk -F, '{print $12}')" "140.00"

echo
echo "── PP.36 XLSX ──"
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/pp36.xlsx?year=2026&month=6" -o /tmp/pp36.xlsx
SIZE=$(stat -f%z /tmp/pp36.xlsx 2>/dev/null || stat -c%s /tmp/pp36.xlsx)
[ "$SIZE" -gt 4000 ] && { echo "  ✅ xlsx size > 4KB ($SIZE)"; PASS=$((PASS+1)); } || { echo "  ❌ xlsx tiny: $SIZE"; FAIL=$((FAIL+1)); }
# unzip and look for both sheet markers
SHEETS=$(unzip -p /tmp/pp36.xlsx xl/workbook.xml 2>/dev/null | grep -oE 'name="[^"]+"' | head -3 | tr '\n' ',')
echo "  sheets: $SHEETS"
[[ "$SHEETS" =~ "ภ.พ.36" ]] && { echo "  ✅ summary sheet present (Thai)"; PASS=$((PASS+1)); } || { echo "  ❌ summary sheet missing"; FAIL=$((FAIL+1)); }
[[ "$SHEETS" =~ "รายละเอียด" ]] && { echo "  ✅ detail sheet present (Thai)"; PASS=$((PASS+1)); } || { echo "  ❌ detail sheet missing"; FAIL=$((FAIL+1)); }

# Cleanup
$PSQL <<'SQL' >/dev/null
DELETE FROM custom.bill_payments WHERE notes='pp36-smoke';
DELETE FROM custom.vendor_bill_lines WHERE vendor_bill_id IN (SELECT id FROM custom.vendor_bills WHERE notes='pp36-smoke');
DELETE FROM custom.vendor_bills WHERE notes='pp36-smoke';
DELETE FROM custom.partners WHERE name LIKE 'PP36-%';
DELETE FROM custom.refresh_tokens WHERE user_id IN (SELECT id FROM custom.users WHERE email='pp36-smoke@example.com');
DELETE FROM custom.users WHERE email='pp36-smoke@example.com';
SQL

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
