#!/usr/bin/env bash
# 🇹🇭 PND.50 / PND.51 XLSX worksheet — live smoke against the running API.
#
# Asserts both endpoints return real, signed XLSX files (zip header), the
# expected sheet names, and the right counts (PND.50 → 5 sheets, PND.51 → 4).
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
DELETE FROM custom.refresh_tokens WHERE user_id IN (SELECT id FROM custom.users WHERE email='pnd50-smoke@example.com');
DELETE FROM custom.users WHERE email='pnd50-smoke@example.com';
INSERT INTO custom.users (email, password_hash, name, role, is_active)
  VALUES ('pnd50-smoke@example.com', '$HASH', 'PND50 Smoke', 'admin', true);" >/dev/null

TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"pnd50-smoke@example.com\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("accessToken",""))')
[ -n "$TOKEN" ] || { echo "FAIL: login"; exit 1; }

PASS=0; FAIL=0
check() {
  local desc=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then echo "  ✅ $desc → $actual"; PASS=$((PASS+1))
  else echo "  ❌ $desc → expected '$expected' got '$actual'"; FAIL=$((FAIL+1)); fi
}
check_truthy() {
  local desc=$1; local cond=$2
  if [ "$cond" -eq 1 ] 2>/dev/null || [ "$cond" = "true" ]; then echo "  ✅ $desc"; PASS=$((PASS+1))
  else echo "  ❌ $desc"; FAIL=$((FAIL+1)); fi
}

YEAR=2026
echo "── PND.50 (full year) ──"
curl -sS -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/cit/preview.xlsx?fiscalYear=$YEAR" -o /tmp/pnd50-smoke.xlsx
[ -s /tmp/pnd50-smoke.xlsx ] && PASS=$((PASS+1)) && echo "  ✅ XLSX downloaded ($(stat -f%z /tmp/pnd50-smoke.xlsx 2>/dev/null || stat -c%s /tmp/pnd50-smoke.xlsx) bytes)" || { FAIL=$((FAIL+1)); echo "  ❌ no XLSX"; }
SHEETS=$(unzip -p /tmp/pnd50-smoke.xlsx xl/workbook.xml 2>/dev/null | grep -oE 'name="[^"]+"' | tr '\n' ',')
SHEET_COUNT=$(echo "$SHEETS" | tr ',' '\n' | grep -c "^name=")
check "sheet count" "$SHEET_COUNT" "5"
[[ "$SHEETS" == *"สรุป (ภ.ง.ด.50)"* ]] && { echo "  ✅ summary sheet"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ no summary"; }
[[ "$SHEETS" == *"รายละเอียด §65 ตรี"* ]] && { echo "  ✅ §65 ter sheet"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ no §65 ter"; }
[[ "$SHEETS" == *"เครดิตภาษี (Credits)"* ]] && { echo "  ✅ credits sheet (PND.50 only)"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ no credits"; }

# Check the typo fix is in place
TYPO_CHECK=$(unzip -p /tmp/pnd50-smoke.xlsx xl/sharedStrings.xml 2>/dev/null | grep -c "เครึ่งปี" || true)
[ "${TYPO_CHECK:-0}" = "0" ] && { echo "  ✅ no 'เครึ่งปี' typo (PND.50 should not mention half-year)"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ found typo เครึ่งปี"; }

echo
echo "── PND.51 (half-year) ──"
curl -sS -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/cit/preview.xlsx?fiscalYear=$YEAR&halfYear=true" -o /tmp/pnd51-smoke.xlsx
[ -s /tmp/pnd51-smoke.xlsx ] && PASS=$((PASS+1)) && echo "  ✅ XLSX downloaded ($(stat -f%z /tmp/pnd51-smoke.xlsx 2>/dev/null || stat -c%s /tmp/pnd51-smoke.xlsx) bytes)" || { FAIL=$((FAIL+1)); echo "  ❌ no XLSX"; }
SHEETS51=$(unzip -p /tmp/pnd51-smoke.xlsx xl/workbook.xml 2>/dev/null | grep -oE 'name="[^"]+"' | tr '\n' ',')
SHEET_COUNT51=$(echo "$SHEETS51" | tr ',' '\n' | grep -c "^name=")
check "sheet count" "$SHEET_COUNT51" "4"
[[ "$SHEETS51" == *"สรุป (ภ.ง.ด.51)"* ]] && { echo "  ✅ summary sheet (51)"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ no PND.51 summary"; }
[[ "$SHEETS51" != *"เครดิตภาษี (Credits)"* ]] && { echo "  ✅ no Credits sheet (correctly omitted on PND.51)"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ Credits sheet should be omitted"; }

# Half-year wording check (annualised + ครึ่งปี — without typo)
PND51_STRINGS=$(unzip -p /tmp/pnd51-smoke.xlsx xl/sharedStrings.xml 2>/dev/null)
echo "$PND51_STRINGS" | grep -q "Annualised revenue (H1×2)" && { echo "  ✅ annualised label"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ no annualised"; }
HAS_GOOD=$(echo "$PND51_STRINGS" | grep -c "ครึ่งปี" || true)
HAS_TYPO=$(echo "$PND51_STRINGS" | grep -c "เครึ่งปี" || true)
[ "${HAS_GOOD:-0}" -ge 1 ] && [ "${HAS_TYPO:-0}" = "0" ] && { echo "  ✅ ครึ่งปี (no typo)"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ typo or missing wording (good=$HAS_GOOD typo=$HAS_TYPO)"; }

echo
echo "── Filename header ──"
HEADERS=$(curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/reports/cit/preview.xlsx?fiscalYear=$YEAR" | tr -d '\r')
echo "$HEADERS" | grep -i "Content-Disposition" | grep -q "PND50_$YEAR" && { echo "  ✅ filename pattern PND50_<fy>_..."; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ filename missing PND50_$YEAR"; }
echo "$HEADERS" | grep -iq "spreadsheetml.sheet" && { echo "  ✅ XLSX content-type"; PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); echo "  ❌ wrong content-type"; }

# Cleanup
$PSQL -c "
DELETE FROM custom.refresh_tokens WHERE user_id IN (SELECT id FROM custom.users WHERE email='pnd50-smoke@example.com');
DELETE FROM custom.users WHERE email='pnd50-smoke@example.com';" >/dev/null

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
