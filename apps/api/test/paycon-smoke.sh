#!/usr/bin/env bash
# 🇹🇭 PAY_CON swap smoke — verifies that vendor_bill_lines.wht_payer_mode flows
# through the v1.0 RD-Prep emitter and emits the correct RD `cert_tax_payer`
# code per the form-specific 2/3 swap.
#
# Prereqs:
#   - API up on localhost:3001
#   - Postgres reachable with $POSTGRES_PASSWORD
#   - $PASSWORD set (admin smoke user password)
set -euo pipefail

: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
: "${PASSWORD:?set PASSWORD (admin login password)}"

PSQL="env PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U admin -d odoo -tA"

# 1. Ensure smoke admin exists
HASH=$(node -e "
const argon2 = require('/Users/admin/Downloads/ff/node_modules/argon2');
argon2.hash(process.argv[1], { type: argon2.argon2id }).then(h => process.stdout.write(h));
" "$PASSWORD")
$PSQL -c "
DELETE FROM custom.refresh_tokens WHERE user_id IN (SELECT id FROM custom.users WHERE email='paycon-smoke@example.com');
DELETE FROM custom.users WHERE email='paycon-smoke@example.com';
INSERT INTO custom.users (email, password_hash, name, role, is_active)
  VALUES ('paycon-smoke@example.com', '$HASH', 'PayCon Smoke', 'admin', true);" >/dev/null

TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"paycon-smoke@example.com\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("accessToken",""))')

[ -n "$TOKEN" ] || { echo "FAIL: login"; exit 1; }

# 2. Seed two suppliers + two bills with mixed wht_payer_mode
$PSQL <<'SQL' >/dev/null
DELETE FROM custom.vendor_bill_lines WHERE vendor_bill_id IN
  (SELECT id FROM custom.vendor_bills WHERE notes='paycon-smoke');
DELETE FROM custom.vendor_bills WHERE notes='paycon-smoke';
DELETE FROM custom.partners WHERE name LIKE 'PayCon%';

INSERT INTO custom.partners (name, legal_name, is_supplier, tin, branch_code, vat_registered, address)
VALUES
  ('PayCon Co., Ltd.', 'บริษัท เพย์คอน จำกัด', true, '0000000000001', '00000', true,
   '{"line1":"99 ถนนสุขุมวิท","district":"คลองเตย","province":"กรุงเทพ","postalCode":"10110"}'),
  ('PayCon Freelance', 'นาย เพย์ คอน', true, '1000000000009', '00000', false,
   '{"line1":"12 ซอยลาดพร้าว","district":"จตุจักร","province":"กรุงเทพ","postalCode":"10900"}');

WITH juristic AS (SELECT id FROM custom.partners WHERE name='PayCon Co., Ltd.'),
     citizen  AS (SELECT id FROM custom.partners WHERE name='PayCon Freelance'),
b1 AS (
  INSERT INTO custom.vendor_bills (
    internal_number, supplier_id, bill_date, currency,
    subtotal_cents, vat_cents, wht_cents, total_cents,
    status, posted_at, posted_by, paid_at, paid_by, paid_cents, wht_paid_cents, notes)
  SELECT 'VB-PAYCON-J', id, '2026-05-15', 'THB',
         200000, 14000, 14000, 200000,
         'paid', now(), 'smoke', '2026-05-15 10:00+07', 'smoke', 200000, 14000, 'paycon-smoke'
  FROM juristic RETURNING id),
b2 AS (
  INSERT INTO custom.vendor_bills (
    internal_number, supplier_id, bill_date, currency,
    subtotal_cents, vat_cents, wht_cents, total_cents,
    status, posted_at, posted_by, paid_at, paid_by, paid_cents, wht_paid_cents, notes)
  SELECT 'VB-PAYCON-C', id, '2026-05-15', 'THB',
         200000, 14000, 14000, 200000,
         'paid', now(), 'smoke', '2026-05-15 10:00+07', 'smoke', 200000, 14000, 'paycon-smoke'
  FROM citizen RETURNING id)
INSERT INTO custom.vendor_bill_lines
  (vendor_bill_id, line_no, description, qty, unit_price_cents, net_cents,
   vat_category, vat_mode, vat_cents, wht_category, wht_rate_bp, wht_cents, wht_payer_mode)
SELECT b1.id, 1, 'rent',     1, 100000, 100000, 'standard', 'exclusive', 7000, 'rent',     500, 5000, 'paid_one_time'      FROM b1
UNION ALL SELECT b1.id, 2, 'ads',      1, 100000, 100000, 'standard', 'exclusive', 7000, 'ads',      200, 2000, 'paid_continuously'  FROM b1
UNION ALL SELECT b2.id, 1, 'services', 1, 100000, 100000, 'standard', 'exclusive', 7000, 'services', 300, 3000, 'paid_one_time'      FROM b2
UNION ALL SELECT b2.id, 2, 'services2',1, 100000, 100000, 'standard', 'exclusive', 7000, 'services', 300, 3000, 'paid_continuously'  FROM b2;
SQL

# 3. Pull both forms and assert PAY_CON codes
PND53=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/pnd/PND53/rd-upload-v1?year=2026&month=5")
PND3=$(curl  -s -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/pnd/PND3/rd-upload-v1?year=2026&month=5")

PASS=0; FAIL=0
check() {
  local desc=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $desc → $actual"
    PASS=$((PASS+1))
  else
    echo "  ❌ $desc → expected '$expected' got '$actual'"
    FAIL=$((FAIL+1))
  fi
}

# Last field of each row is PAY_CON (after rfind '|')
last_field() { echo "$1" | awk -F'|' '{print $NF}'; }

# PND.53 row order: by category alphabetic, so ads < rent
ads_row=$(echo "$PND53"  | grep '|ค่าโฆษณา|' | head -1)
rent_row=$(echo "$PND53" | grep '|ค่าเช่า|'  | head -1)
echo "PND.53 (juristic):"
check "ads × paid_continuously"  "$(last_field "$ads_row"  | tr -d '\r')" "3"
check "rent × paid_one_time"     "$(last_field "$rent_row" | tr -d '\r')" "2"

# PND.3 has 2 services rows — sort key by payer mode: paid_continuously < paid_one_time
svc_cont_row=$(echo "$PND3" | grep '|ค่าบริการ' | sed -n '1p')
svc_once_row=$(echo "$PND3" | grep '|ค่าบริการ' | sed -n '2p')
echo "PND.3 (citizen):"
check "services × paid_continuously" "$(last_field "$svc_cont_row" | tr -d '\r')" "2"
check "services × paid_one_time"     "$(last_field "$svc_once_row" | tr -d '\r')" "3"

# Cleanup
$PSQL <<'SQL' >/dev/null
DELETE FROM custom.vendor_bill_lines WHERE vendor_bill_id IN
  (SELECT id FROM custom.vendor_bills WHERE notes='paycon-smoke');
DELETE FROM custom.vendor_bills WHERE notes='paycon-smoke';
DELETE FROM custom.partners WHERE name LIKE 'PayCon%';
DELETE FROM custom.refresh_tokens WHERE user_id IN (SELECT id FROM custom.users WHERE email='paycon-smoke@example.com');
DELETE FROM custom.users WHERE email='paycon-smoke@example.com';
SQL

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
