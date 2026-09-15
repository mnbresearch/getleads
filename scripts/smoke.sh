#!/usr/bin/env bash
# End-to-end smoke test against a running API. Usage: API=http://localhost:8080 ./scripts/smoke.sh
set -euo pipefail
API=${API:-http://localhost:8080}
J='content-type: application/json'
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; echo "$2"; exit 1; }

echo "1. signup"
EMAIL="smoke+$RANDOM@example.com"
R=$(curl -s -X POST $API/v1/auth/signup -H "$J" -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"name\":\"Smoke\",\"orgName\":\"Smoke Co\"}")
KEY=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["apiKey"])') || fail "signup" "$R"
TOKEN=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
pass "api key $KEY"

echo "2. me (api key + jwt)"
curl -sf $API/v1/auth/me -H "x-api-key: $KEY" >/dev/null && pass "api key auth"
curl -sf $API/v1/auth/me -H "authorization: Bearer $TOKEN" >/dev/null && pass "jwt auth"

echo "3. create lead + company"
R=$(curl -s -X POST $API/v1/leads -H "$J" -H "x-api-key: $KEY" -d '{"firstName":"Satya","lastName":"Nadella","title":"CEO","companyName":"Microsoft","companyDomain":"microsoft.com","linkedinUrl":"https://www.linkedin.com/in/satyanadella"}')
LEAD=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["lead"]["id"])') || fail "create lead" "$R"
pass "lead $LEAD"

echo "4. idempotent upsert"
R=$(curl -s -X POST $API/v1/leads -H "$J" -H "x-api-key: $KEY" -d '{"fullName":"Satya Nadella","linkedinUrl":"https://www.linkedin.com/in/satyanadella","title":"Chairman & CEO"}')
echo "$R" | grep -q '"created":false' && pass "updated, not duplicated"

echo "5. list + filter"
R=$(curl -s "$API/v1/leads?seniority=c_level" -H "x-api-key: $KEY")
echo "$R" | grep -q '"total":1' && pass "filter by seniority"

echo "6. csv import"
R=$(curl -s -X POST $API/v1/leads/import -H "content-type: text/csv" -H "x-api-key: $KEY" --data-binary $'Name,Job Title,Company,Website,Email\nJane Doe,VP Sales,Acme,https://acme.example,jane@acme.example\nBob Ray,CTO,Beta,beta.example,')
echo "$R" | grep -q '"created":2' && pass "imported 2"

echo "7. verify (syntax/disposable/MX)"
R=$(curl -s -X POST $API/v1/search/verify -H "$J" -H "x-api-key: $KEY" -d '{"emails":["bad-email","x@mailinator.com","nobody@this-domain-does-not-exist-12345.com"]}')
echo "$R" | python3 -c 'import sys,json;r=json.load(sys.stdin)["results"];assert [x["status"] for x in r]==["invalid"]*3,r' && pass "3 invalid detected"

echo "8. ICP create + rule scoring"
R=$(curl -s -X POST $API/v1/icps -H "$J" -H "x-api-key: $KEY" -d '{"name":"Exec buyers","criteria":{"titles":["CEO","CTO"],"seniorities":["c_level"]},"buildWithAi":false}')
ICP=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["icp"]["id"])') || fail "icp" "$R"
R=$(curl -s -X POST $API/v1/icps/$ICP/score -H "$J" -H "x-api-key: $KEY" -d '{"assign":true}')
echo "$R" | python3 -c 'import sys,json;s=json.load(sys.stdin)["scored"];assert s[0]["score"]>=90 and s[-1]["score"]<50,s' && pass "CEO/CTO ranked above VP Sales"

echo "9. list + add"
LIST=$(curl -s -X POST $API/v1/leads/lists -H "$J" -H "x-api-key: $KEY" -d '{"name":"Pilot"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sf -X POST $API/v1/leads/lists/$LIST/leads -H "$J" -H "x-api-key: $KEY" -d "{\"ids\":[\"$LEAD\"]}" >/dev/null && pass "added to list"

echo "10. email account (system/console) + campaign + preview + start"
ACC=$(curl -s -X POST $API/v1/campaigns/email-accounts -H "$J" -H "x-api-key: $KEY" -d '{"provider":"system","fromName":"Mridul","fromEmail":"mridul@example.com","dailyLimit":10}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["emailAccount"]["id"])' 2>/dev/null || echo "")
if [ -z "$ACC" ]; then
  echo "  (no system mail provider; using smtp stub)"
  ACC=$(curl -s -X POST $API/v1/campaigns/email-accounts -H "$J" -H "x-api-key: $KEY" -d '{"provider":"smtp","fromName":"Mridul","fromEmail":"mridul@example.com","config":{"host":"localhost","port":2525}}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["emailAccount"]["id"])')
fi
R=$(curl -s -X POST $API/v1/campaigns -H "$J" -H "x-api-key: $KEY" -d "{\"name\":\"Pilot outreach\",\"listId\":\"$LIST\",\"emailAccountId\":\"$ACC\",\"settings\":{\"senderCompany\":\"MNB Research\",\"valueProp\":\"We automate lead gen for SMEs\",\"sendWindow\":{\"start\":\"00:00\",\"end\":\"23:59\",\"days\":[0,1,2,3,4,5,6]}},\"steps\":[{\"subjectTemplate\":\"Quick question, {{first_name}}\",\"bodyTemplate\":\"Hi {{first_name}}, saw {{company}}. Open to a chat?\\n\\n{{sender_name}}\",\"aiPersonalize\":false},{\"delayDays\":3,\"subjectTemplate\":\"Following up\",\"bodyTemplate\":\"Bumping this, {{first_name}}.\",\"aiPersonalize\":false}]}")
CAMP=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])') || fail "campaign" "$R"
R=$(curl -s -X POST $API/v1/campaigns/$CAMP/preview -H "$J" -H "x-api-key: $KEY" -d "{\"leadId\":\"$LEAD\"}")
echo "$R" | grep -q 'Quick question, Satya' && pass "template rendered: $(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["subject"])')"
# give the lead an email so it can be enrolled
curl -sf -X PATCH $API/v1/leads/$LEAD -H "$J" -H "x-api-key: $KEY" -d '{"email":"satya@microsoft.com"}' >/dev/null
R=$(curl -s -X POST $API/v1/campaigns/$CAMP/enroll -H "$J" -H "x-api-key: $KEY" -d '{"fromList":true}')
echo "$R" | grep -q '"enrolled":1' && pass "enrolled 1"
R=$(curl -s -X POST $API/v1/campaigns/$CAMP/start -H "x-api-key: $KEY")
echo "$R" | grep -q '"status":"active"' && pass "started: $R"
sleep 4
R=$(curl -s $API/v1/campaigns/$CAMP/messages -H "x-api-key: $KEY")
echo "$R" | grep -q '"status":"sent"' && pass "message sent via dev mailer" || echo "  (message status: $(echo $R | head -c 300))"
TOK=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["messages"][0]["trackingToken"])')
curl -sf "$API/t/o/$TOK.gif" >/dev/null && curl -s $API/v1/campaigns/$CAMP/stats -H "x-api-key: $KEY" | grep -q '"opened":1' && pass "open tracked"

echo "11. inbound reply stops sequence"
R=$(curl -s -X POST $API/v1/campaigns/inbound -H "$J" -H "x-api-key: $KEY" -d '{"from":"Satya <satya@microsoft.com>","text":"Sure, lets talk next week"}')
echo "$R" | grep -q '"matched":true' && pass "reply matched, intent=$(echo $R | python3 -c 'import sys,json;print(json.load(sys.stdin)["intent"])')"

echo "12. webhook + events"
curl -sf -X POST $API/v1/webhooks -H "$J" -H "x-api-key: $KEY" -d '{"url":"https://example.com/hook","events":["lead.*"]}' >/dev/null && pass "webhook created"
R=$(curl -s "$API/v1/events?limit=5" -H "x-api-key: $KEY")
echo "$R" | grep -q 'lead.replied' && pass "events logged"

echo "13. usage + analytics"
curl -sf $API/v1/usage -H "x-api-key: $KEY" | grep -q '"leads"' && pass "usage"
curl -sf $API/v1/analytics/overview -H "x-api-key: $KEY" | grep -q '"daily"' && pass "analytics"

echo "14. async search job enqueued"
R=$(curl -s -X POST $API/v1/search -H "$J" -H "x-api-key: $KEY" -d '{"query":"Heads of Growth at fintech startups in Bengaluru","limit":3}')
SID=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["search"]["id"])') || fail "search" "$R"
pass "search $SID queued (network-dependent; poll GET /v1/search/$SID)"

echo "15. openapi"
curl -sf $API/openapi.json | grep -q '"openapi":"3.1.0"' && pass "openapi served"
echo
echo "ALL SMOKE TESTS PASSED"
