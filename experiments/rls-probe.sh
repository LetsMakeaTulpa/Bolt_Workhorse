#!/usr/bin/env bash
# Probes what the anon role may write, without changing any data: every request is crafted to
# fail on a CHECK/UNIQUE constraint (400/409) when the grant exists, or be refused (401/403)
# when it does not. Run: set -a && . ./.env && set +a && bash experiments/rls-probe.sh
set -uo pipefail
: "${VITE_SUPABASE_URL:?}" "${VITE_SUPABASE_ANON_KEY:?}"

API="$VITE_SUPABASE_URL/rest/v1"
H=(-H "apikey: $VITE_SUPABASE_ANON_KEY" -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" -H "Content-Type: application/json")

# probe <verb> <table> <json-body> <query-suffix>
probe() {
  local verb="$1" table="$2" body="$3" query="${4:-}"
  local out status code verdict
  out=$(curl -s -m 20 -o /tmp/rls_body.txt -w "%{http_code}" -X "$verb" "${H[@]}" \
    ${body:+-d "$body"} "$API/$table?$query")
  status="$out"
  code=$(python3 -c "import json;print(json.load(open('/tmp/rls_body.txt')).get('code',''))" 2>/dev/null || echo "")
  case "$status" in
    400|409|422) verdict="ALLOWED (reached the table, rejected by a constraint)" ;;
    401|403)     verdict="DENIED" ;;
    200|201|204) verdict="ALLOWED (no error!)" ;;
    *)           verdict="unexpected" ;;
  esac
  printf '%-18s %-6s -> %s %s  %s\n' "$table" "$verb" "$status" "${code:+[$code]}" "$verdict"
}

EXISTING_ID=$(curl -s -m 20 "${H[@]}" "$API/conversations?select=id&limit=1" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")

echo "== anon write probes =="
probe POST   conversations      "{\"id\":\"${EXISTING_ID:-00000000-0000-0000-0000-000000000000}\",\"title\":\"probe\"}"
probe PATCH  conversations      '{"title":"probe"}' "id=eq.${EXISTING_ID:-00000000-0000-0000-0000-000000000000}"
probe DELETE conversations      '' "id=eq.${EXISTING_ID:-00000000-0000-0000-0000-000000000000}"
probe POST   messages           "{\"conversation_id\":\"${EXISTING_ID:-00000000-0000-0000-0000-000000000000}\",\"role\":\"bogus\",\"content\":\"x\"}"
probe PATCH  messages           '{"content":"probe"}' "id=eq.00000000-0000-0000-0000-000000000000"
probe DELETE messages           '' "id=eq.00000000-0000-0000-0000-000000000000"
probe POST   findings           '{"query":"probe","status":"bogus"}'
probe POST   sources            '{"extraction_status":"bogus"}'
probe POST   activity_logs      '{"activity_type":"bogus"}'
probe POST   evidence           '{"claim":"probe","evidence_type":"bogus"}'
probe POST   research_projects  '{"name":"probe","status":"bogus"}'
probe POST   research_presets   '{"name":"general","category":"x"}'
probe POST   search_settings    '{"max_results_per_engine":"not-an-int"}'
probe POST   app_config         '{"id":2,"featherless_api_key":"probe"}'
