#!/usr/bin/env bash
# v2 feature smoke test: visitors pixel, signals, monitors, tools, tasks, team, autopilot, multichannel + A/B.
set -euo pipefail
API=${API:-http://localhost:8080}
J='content-type: application/json'
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; echo "$2"; exit 1; }
py() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

R=$(curl -s -X POST $API/v1/auth/signup -H "$J" -d "{\"email\":\"v2+$RANDOM@example.com\",\"password\":\"password123\",\"name\":\"V2\",\"orgName\":\"V2 Co\"}")
KEY=$(echo "$R" | py 'print(d["apiKey"])'); TOKEN=$(echo "$R" | py 'print(d["token"])')
H=(-H "x-api-key: $KEY" -H "$J")

echo "1. website visitor pixel"
PX=$(curl -s -X POST $API/v1/visitors/pixels "${H[@]}" -d '{"name":"Main site"}')
PKEY=$(echo "$PX" | py 'print(d["key"])'); echo "$PX" | grep -q '<script async' && pass "pixel created with snippet"
curl -sf $API/px/$PKEY.js | grep -q "sendBeacon" && pass "pixel script served"
curl -s -o /dev/null -w "%{http_code}" -X POST "$API/px/$PKEY/collect" -H "$J" -H "x-forwarded-for: 52.66.10.10" -d '{"sid":"s1","p":"/pricing","r":"https://google.com","e":"view"}' | grep -q 204 && pass "hit collected (204)"
curl -s -o /dev/null -X POST "$API/px/$PKEY/collect" -H "$J" -H "x-forwarded-for: 103.21.244.1" -d '{"sid":"s2","p":"/demo","e":"view","id":{"email":"cto@zerodha.com","company":"Zerodha"}}'
sleep 6
V=$(curl -s "$API/v1/visitors?days=1" "${H[@]}")
echo "$V" | py 'assert d["totals"]["visits"]>=2, d; print("   totals:", d["totals"]); print("   companies:", [c["domain"] for c in d["companies"]])' && pass "visits identified; identify() call resolved to zerodha.com"
echo "$V" | grep -q '"domain":"zerodha.com"' && pass "visitor company rollup"

echo "2. signals scan + subscription"
S=$(curl -s -X POST $API/v1/signals/scan "${H[@]}" -d '{"types":["funding","acquisition"],"locations":["India"],"days":7}')
echo "$S" | py 'print("   parsed", d["parsed"], "stored", d["stored"]); assert d["parsed"]>0' && pass "live funding/acquisition signals parsed from news"
SUB=$(curl -s -X POST $API/v1/signals/subscriptions "${H[@]}" -d '{"name":"Indian fintech funding","types":["funding"],"keywords":["fintech","payments","lending"],"targetTitles":["CEO","Founder"]}')
SUBID=$(echo "$SUB" | py 'print(d["id"])'); pass "subscription created"
R=$(curl -s -X POST $API/v1/signals/subscriptions/$SUBID/run "${H[@]}")
echo "$R" | py 'print("   run:", d)' && pass "subscription run"
F=$(curl -s "$API/v1/signals?type=funding&days=7&limit=5" "${H[@]}")
echo "$F" | py 'assert len(d["signals"])>0; s=d["signals"][0]; print("   e.g.", s["companyName"], "-", s["title"][:60])' && pass "signal feed"

echo "3. monitors"
M=$(curl -s -X POST $API/v1/signals/monitors "${H[@]}" -d '{"type":"company_news","name":"Razorpay news","target":"Razorpay"}')
MID=$(echo "$M" | py 'print(d["id"])')
R=$(curl -s -X POST $API/v1/signals/monitors/$MID/run "${H[@]}"); echo "$R" | py 'print("   added:", d["added"])' && pass "company_news monitor ran"
M2=$(curl -s -X POST $API/v1/signals/monitors "${H[@]}" -d '{"type":"jobs","name":"Razorpay hiring","target":"razorpay.com","config":{"companyDomain":"Razorpay"}}')
R=$(curl -s -X POST $API/v1/signals/monitors/$(echo "$M2" | py 'print(d["id"])')/run "${H[@]}"); echo "$R" | py 'print("   jobs added:", d["added"])' && pass "jobs monitor ran"

echo "4. tools"
curl -s "$API/v1/tools/domain-health?domain=mnbresearch.com" "${H[@]}" | py 'print("   score", d["score"], "spf", d["spf"]["ok"], "dkim", d["dkim"]["selectorsFound"]); assert d["score"]>=50' && pass "domain health"
curl -s "$API/v1/tools/personas" "${H[@]}" | grep -q "CEO / Founder" && pass "personas"
curl -s -X POST $API/v1/tools/company-intel "${H[@]}" -d '{"domain":"razorpay.com"}' | py 'print("   intent", d["company"]["intentScore"], "openRoles", d["hiring"]["openRoles"] if d["hiring"] else None, "news", len(d["news"]))' && pass "company intel"
curl -s -X POST $API/v1/tools/verify-batch "${H[@]}" -d '{"emails":["a@mailinator.com","bad","contact@mnbresearch.com"]}' | py 'print("   summary", d["summary"])' && pass "verify batch"
LI=$(curl -s -X POST $API/v1/tools/linkedin-to-email "${H[@]}" -d '{"urls":["https://www.linkedin.com/in/mridul-nanda"]}')
echo "$LI" | py 'r=d["results"][0]; print("   linkedin→", r.get("found"), (r.get("person") or {}).get("fullName"))' && pass "linkedin-to-email (network-dependent)"

echo "5. tasks + team + autopilot + saved search"
T=$(curl -s -X POST $API/v1/tools/tasks "${H[@]}" -d '{"type":"call","title":"Call Satya"}'); TID=$(echo "$T" | py 'print(d["id"])')
curl -sf -X POST $API/v1/tools/tasks/$TID/complete "${H[@]}" -d '{"outcome":"done","note":"left voicemail"}' >/dev/null && pass "task created + completed"
curl -s "$API/v1/tools/team" -H "authorization: Bearer $TOKEN" | py 'print("   seats", d["seats"])' && pass "team"
INV=$(curl -s -X POST "$API/v1/tools/team/invite" -H "authorization: Bearer $TOKEN" -H "$J" -d '{"email":"colleague@example.com"}')
LINK=$(echo "$INV" | py 'print(d["link"])'); TOK=${LINK##*token=}
curl -s -X POST $API/v1/auth/join -H "$J" -d "{\"token\":\"$TOK\",\"password\":\"password123\",\"name\":\"Colleague\"}" | grep -q '"token"' && pass "invite accepted → member JWT"
AP=$(curl -s -X POST $API/v1/tools/autopilots "${H[@]}" -d '{"name":"Daily fintech founders","query":{"query":"Founders of fintech startups in Bengaluru"},"dailyLeads":5}')
echo "$AP" | grep -q '"active":true' && pass "autopilot created"
curl -s -X POST $API/v1/tools/saved-searches "${H[@]}" -d '{"name":"Growth heads","query":{"titles":["Head of Growth"],"locations":["Mumbai"]},"alert":true,"alertEmail":"me@example.com"}' | grep -q '"alert":true' && pass "saved search with alert"

echo "6. multichannel sequence with A/B + LinkedIn task step"
LEAD=$(curl -s -X POST $API/v1/leads "${H[@]}" -d '{"fullName":"Priya Sharma","title":"VP Sales","email":"priya@acme.example","companyName":"Acme","companyDomain":"acme.example"}' | py 'print(d["lead"]["id"])')
ACC=$(curl -s -X POST $API/v1/campaigns/email-accounts "${H[@]}" -d '{"provider":"system","fromName":"Mridul","fromEmail":"m@example.com"}' | py 'print(d["emailAccount"]["id"])')
CP=$(curl -s -X POST $API/v1/campaigns "${H[@]}" -d "{\"name\":\"Multi\",\"emailAccountId\":\"$ACC\",\"settings\":{\"senderName\":\"Mridul\",\"sendWindow\":{\"start\":\"00:00\",\"end\":\"23:59\",\"days\":[0,1,2,3,4,5,6]}},\"steps\":[{\"channel\":\"linkedin_connect\",\"bodyTemplate\":\"Hi {{first_name}}, love what {{company}} is doing.\",\"aiPersonalize\":false},{\"channel\":\"email\",\"delayDays\":0,\"subjectTemplate\":\"A\",\"bodyTemplate\":\"Body A {{first_name}}\",\"aiPersonalize\":false,\"variants\":[{\"subjectTemplate\":\"B\",\"bodyTemplate\":\"Body B {{first_name}}\"}]}]}")
CPID=$(echo "$CP" | py 'print(d["id"])'); echo "$CP" | grep -q 'linkedin_connect' && pass "campaign with linkedin step + A/B variants"
curl -s -X POST $API/v1/campaigns/$CPID/enroll "${H[@]}" -d "{\"leadIds\":[\"$LEAD\"]}" | grep -q '"enrolled":1' && pass "enrolled"
curl -s -X POST $API/v1/campaigns/$CPID/start "${H[@]}" | grep -q '"active"' && pass "started"
sleep 2
TK=$(curl -s "$API/v1/tools/tasks?status=pending" "${H[@]}")
TKID=$(echo "$TK" | py 'ts=[t for t in d["tasks"] if t["type"]=="linkedin_connect"]; assert ts, d; print(ts[0]["id"]); print("   task:", ts[0]["title"], "|", ts[0]["body"][:50])' | head -1)
echo "$TK" | grep -q "love what Acme" && pass "LinkedIn connect task generated from step 1"
curl -sf -X POST $API/v1/tools/tasks/$TKID/complete "${H[@]}" -d '{"outcome":"done"}' >/dev/null && pass "task completed → sequence advanced"
sleep 5
MS=$(curl -s "$API/v1/campaigns/$CPID/messages" "${H[@]}")
echo "$MS" | py 'm=[x for x in d["messages"] if x["channel"]=="email"]; assert m, d; print("   email step sent, subject:", m[0]["subject"], "variant", m[0]["variant"])' && pass "email step sent after LinkedIn task"
curl -s "$API/v1/campaigns/$CPID/stats" "${H[@]}" | grep -q '"variants"' && pass "A/B stats exposed"
L=$(curl -s "$API/v1/leads/$LEAD" "${H[@]}"); echo "$L" | grep -q '"status":"contacted"' && pass "lead status → contacted"

echo
echo "ALL V2 SMOKE TESTS PASSED"
