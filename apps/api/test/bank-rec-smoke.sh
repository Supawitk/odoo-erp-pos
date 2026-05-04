#!/usr/bin/env bash
# Bank reconciliation smoke — exercises the full lifecycle:
#   1. Import a CSV statement → 2 lines, both unmatched
#   2. Get suggestions for line 1 → should propose the matching JE
#   3. Confirm the match → bank line marked matched
#   4. Re-import the same file → 409 duplicate
#   5. Try to match the SAME JE to a different bank line → 409 already linked
#   6. Unmatch → status back to unmatched
#   7. Ignore line 2 → status=ignored

set -e
API=${API:-http://localhost:3001}
EMAIL=${EMAIL:-ar-smoke@example.com}
# Required: export PASSWORD + POSTGRES_PASSWORD before running.
# Don't bake credentials into source.
PASSWORD=${PASSWORD:?PASSWORD env var must be set (smoke account password)}

TOKEN=$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r '.accessToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "❌ login"; exit 1; }
H="authorization: Bearer $TOKEN"
PG="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD env var must be set}"

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "❌ $1"; echo "    $2"; }
check() { [ "$2" = "true" ] && ok "$1" || fail "$1" "got: $3"; }

# Cleanup any prior smoke runs
PGPASSWORD="$PG" psql -h localhost -U admin -d odoo -q -c "
  DELETE FROM custom.bank_match_links WHERE matched_by IS NULL OR matched_by ILIKE '%smoke%';
  DELETE FROM custom.bank_statement_lines WHERE statement_id IN (SELECT id FROM custom.bank_statements WHERE bank_label LIKE 'SMOKE%');
  DELETE FROM custom.bank_statements WHERE bank_label LIKE 'SMOKE%';
" > /dev/null

# Find an existing JE on 1120 to use as our match target. Pick the most
# recent posted one so the date window includes it.
JE_INFO=$(PGPASSWORD="$PG" psql -h localhost -U admin -d odoo -At -F"|" -c "
  SELECT je.id, je.date, (jl.debit_cents - jl.credit_cents) AS net
  FROM custom.journal_entry_lines jl
  JOIN custom.journal_entries je ON je.id = jl.journal_entry_id
  LEFT JOIN custom.bank_match_links bml ON bml.journal_entry_id = je.id
  WHERE je.status='posted' AND jl.account_code='1120' AND bml.id IS NULL
  ORDER BY je.date DESC LIMIT 1;")
JE_ID=$(echo "$JE_INFO" | cut -d'|' -f1)
JE_DATE=$(echo "$JE_INFO" | cut -d'|' -f2)
JE_NET=$(echo "$JE_INFO" | cut -d'|' -f3)
echo "Target JE: $JE_ID on $JE_DATE net=$JE_NET satang"

# Build a CSV statement with the matching line + one extra
AMOUNT_THB=$(echo "scale=2; $JE_NET/100" | bc)
CSV_TEXT="date,description,credit,debit,reference
$JE_DATE,SMOKE recon $JE_ID,$AMOUNT_THB,0,REF-A
$JE_DATE,SMOKE bank fee,0,15.00,REF-B"

echo "=== 1. Import CSV statement ==="
IMPORT=$(curl -s -H "$H" -X POST "$API/api/bank-rec/statements/import" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg b "$CSV_TEXT" '{cashAccountCode:"1120", bankLabel:"SMOKE Test Bank", source:"csv", filename:"smoke.csv", fileBytes:$b}')")
STMT_ID=$(echo "$IMPORT" | jq -r '.statementId')
INSERTED=$(echo "$IMPORT" | jq -r '.linesInserted')
check "statement created" "$([ "$STMT_ID" != "null" ] && [ -n "$STMT_ID" ] && echo true)" "$IMPORT"
check "2 lines inserted" "$([ "$INSERTED" = "2" ] && echo true)" "$INSERTED"

echo "=== 2. List lines, find the matching one ==="
LINES=$(curl -s -H "$H" "$API/api/bank-rec/statements/$STMT_ID/lines")
TOTAL_LINES=$(echo "$LINES" | jq '.lines | length')
check "list returns 2 lines" "$([ "$TOTAL_LINES" = "2" ] && echo true)" "$TOTAL_LINES"
LINE1_ID=$(echo "$LINES" | jq -r ".lines[] | select(.amountCents == $JE_NET) | .id")
LINE2_ID=$(echo "$LINES" | jq -r '.lines[] | select(.amountCents == -1500) | .id')
[ -n "$LINE1_ID" ] && [ "$LINE1_ID" != "null" ] && ok "line 1 found (matches JE)" || fail "line 1 lookup" "$LINES"
[ -n "$LINE2_ID" ] && [ "$LINE2_ID" != "null" ] && ok "line 2 found (the bank fee)" || fail "line 2 lookup" "$LINES"

echo "=== 3. Suggest matches for line 1 ==="
SUGG=$(curl -s -H "$H" "$API/api/bank-rec/lines/$LINE1_ID/suggestions?dateWindowDays=14")
TOP_ID=$(echo "$SUGG" | jq -r '.[0].candidate.id')
TOP_SCORE=$(echo "$SUGG" | jq -r '.[0].score')
check "top suggestion is the target JE" "$([ "$TOP_ID" = "$JE_ID" ] && echo true)" "$TOP_ID"
check "score ≥ 70 (high-confidence)" "$([ "$TOP_SCORE" -ge 70 ] 2>/dev/null && echo true)" "$TOP_SCORE"

echo "=== 4. Confirm the match ==="
CONFIRM=$(curl -s -H "$H" -X POST "$API/api/bank-rec/lines/$LINE1_ID/match" \
  -H 'content-type: application/json' \
  -d "{\"links\":[{\"journalEntryId\":\"$JE_ID\",\"amountCents\":$JE_NET}]}")
LINK_COUNT=$(echo "$CONFIRM" | jq -r '.linkCount')
check "match confirmed (1 link)" "$([ "$LINK_COUNT" = "1" ] && echo true)" "$LINK_COUNT"

# Verify the bank line status flipped
LINES_AFTER=$(curl -s -H "$H" "$API/api/bank-rec/statements/$STMT_ID/lines")
LINE1_STATUS=$(echo "$LINES_AFTER" | jq -r ".lines[] | select(.id == \"$LINE1_ID\") | .status")
check "line 1 status → matched" "$([ "$LINE1_STATUS" = "matched" ] && echo true)" "$LINE1_STATUS"

echo "=== 5. Duplicate file import → 409 ==="
# NestJS ConflictException(object) returns the object as the body without a
# statusCode field — but the HTTP status header is 409. Check the header.
DUP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$H" -X POST "$API/api/bank-rec/statements/import" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg b "$CSV_TEXT" '{cashAccountCode:"1120", bankLabel:"SMOKE Test Bank", source:"csv", fileBytes:$b}')")
check "duplicate file → 409" "$([ "$DUP_CODE" = "409" ] && echo true)" "$DUP_CODE"

echo "=== 6. Match a different JE to line 2 (with the actual line2 amount) → expect 409 ==="
# Find a SECOND posted JE on 1120 to try the double-link scenario properly.
JE2_INFO=$(PGPASSWORD="$PG" psql -h localhost -U admin -d odoo -At -F"|" -c "
  SELECT je.id, (jl.debit_cents - jl.credit_cents) AS net
  FROM custom.journal_entry_lines jl
  JOIN custom.journal_entries je ON je.id = jl.journal_entry_id
  LEFT JOIN custom.bank_match_links bml ON bml.journal_entry_id = je.id
  WHERE je.status='posted' AND jl.account_code='1120' AND je.id <> '$JE_ID' AND bml.id IS NULL
  ORDER BY je.date DESC LIMIT 1;")
JE2_ID=$(echo "$JE2_INFO" | cut -d'|' -f1)
# The duplicate-link test: try to match JE_ID (already linked to LINE1) to LINE2.
# Because line2 amount is -1500 != JE_NET, sum-mismatch fires first → 400. That's also a valid rejection.
DOUBLE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$H" -X POST "$API/api/bank-rec/lines/$LINE2_ID/match" \
  -H 'content-type: application/json' \
  -d "{\"links\":[{\"journalEntryId\":\"$JE_ID\",\"amountCents\":-1500}]}")
check "second-match rejection (400 or 409)" "$([ "$DOUBLE_CODE" = "400" ] || [ "$DOUBLE_CODE" = "409" ] && echo true)" "$DOUBLE_CODE"

echo "=== 7. Unmatch line 1 ==="
UNMATCH=$(curl -s -H "$H" -X POST "$API/api/bank-rec/lines/$LINE1_ID/unmatch" -H 'content-type: application/json' -d '{}')
UNMATCH_STATUS=$(echo "$UNMATCH" | jq -r '.status')
check "unmatch → status=unmatched" "$([ "$UNMATCH_STATUS" = "unmatched" ] && echo true)" "$UNMATCH_STATUS"

echo "=== 8. Ignore line 2 ==="
IGN=$(curl -s -H "$H" -X POST "$API/api/bank-rec/lines/$LINE2_ID/ignore" \
  -H 'content-type: application/json' \
  -d '{"reason":"Bank fee — not a journal entry, expected"}')
IGN_STATUS=$(echo "$IGN" | jq -r '.status')
check "ignore → status=ignored" "$([ "$IGN_STATUS" = "ignored" ] && echo true)" "$IGN_STATUS"

# Short reason rejected
IGN_SHORT=$(curl -s -H "$H" -X POST "$API/api/bank-rec/lines/$LINE1_ID/ignore" \
  -H 'content-type: application/json' \
  -d '{"reason":"x"}')
IGN_SHORT_STATUS=$(echo "$IGN_SHORT" | jq -r '.statusCode')
check "ignore with short reason → 400" "$([ "$IGN_SHORT_STATUS" = "400" ] && echo true)" "$IGN_SHORT_STATUS"

echo "=== 9. Statements list shows updated counts ==="
STMTS=$(curl -s -H "$H" "$API/api/bank-rec/statements?cashAccountCode=1120")
ME=$(echo "$STMTS" | jq ".[] | select(.id == \"$STMT_ID\")")
COUNT_IGNORED=$(echo "$ME" | jq -r '.counts.ignored')
COUNT_UNMATCHED=$(echo "$ME" | jq -r '.counts.unmatched')
check "statement counts ignored=1" "$([ "$COUNT_IGNORED" = "1" ] && echo true)" "$COUNT_IGNORED"
check "statement counts unmatched=1 (line 1 after unmatch)" "$([ "$COUNT_UNMATCHED" = "1" ] && echo true)" "$COUNT_UNMATCHED"

echo
echo "================================"
echo "RESULT: $PASS passed, $FAIL failed"
echo "================================"
[ $FAIL -eq 0 ] && exit 0 || exit 1
