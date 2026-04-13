#!/bin/bash
# Notion OAuth setup for NanoClaw
# Usage:
#   ./scripts/notion-oauth.sh setup    — register client, generate auth URL
#   ./scripts/notion-oauth.sh exchange <code>  — exchange auth code for tokens
#   ./scripts/notion-oauth.sh refresh  — refresh expired access token
#   ./scripts/notion-oauth.sh status   — show current token status

set -euo pipefail

OAUTH_FILE="${NANOCLAW_OAUTH_FILE:-/root/nanoclaw/data/notion-oauth.json}"
CALLBACK_URL="https://ark.nikitin.me/global/notion-auth-callback.html"
MCP_BASE="https://mcp.notion.com"

mkdir -p "$(dirname "$OAUTH_FILE")"

# Generate random string for PKCE
random_string() {
  openssl rand -base64 48 | tr -d '=+/' | head -c 64
}

# Base64url encode
base64url() {
  openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
}

cmd_setup() {
  echo "=== Notion OAuth Setup ==="

  # Step 1: Dynamic client registration
  echo "Registering OAuth client..."
  REG_RESPONSE=$(curl -s -X POST "${MCP_BASE}/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"client_name\": \"NanoClaw Agent\",
      \"redirect_uris\": [\"${CALLBACK_URL}\"],
      \"grant_types\": [\"authorization_code\", \"refresh_token\"],
      \"response_types\": [\"code\"],
      \"token_endpoint_auth_method\": \"none\"
    }")

  CLIENT_ID=$(echo "$REG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])" 2>/dev/null)
  if [ -z "$CLIENT_ID" ]; then
    echo "ERROR: Client registration failed"
    echo "$REG_RESPONSE"
    exit 1
  fi
  echo "Client ID: ${CLIENT_ID}"

  # Step 2: Generate PKCE
  CODE_VERIFIER=$(random_string)
  CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | base64url)

  # Step 3: Save state
  python3 -c "
import json
data = {
  'client_id': '${CLIENT_ID}',
  'code_verifier': '${CODE_VERIFIER}',
  'redirect_uri': '${CALLBACK_URL}',
  'status': 'pending'
}
with open('${OAUTH_FILE}', 'w') as f:
    json.dump(data, f, indent=2)
"

  # Step 4: Build auth URL
  AUTH_URL="${MCP_BASE}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${CALLBACK_URL}'))")&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256"

  # Step 5: Create callback page
  CALLBACK_DIR="/root/nanoclaw/groups/global/www"
  mkdir -p "$CALLBACK_DIR"
  cat > "${CALLBACK_DIR}/notion-auth-callback.html" << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Notion Authorization</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 80px auto; padding: 20px; text-align: center; }
    .code { font-family: monospace; font-size: 24px; background: #f0f0f0; padding: 16px 24px; border-radius: 8px; margin: 20px 0; user-select: all; cursor: pointer; word-break: break-all; }
    .success { color: #22c55e; font-size: 48px; }
    .hint { color: #666; margin-top: 16px; }
    button { background: #000; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 12px; }
    button:hover { background: #333; }
    .error { color: #ef4444; }
  </style>
</head>
<body>
  <div class="success">&#10003;</div>
  <h1>Authorization Successful</h1>
  <p>Copy this code and paste it in the Telegram chat:</p>
  <div class="code" id="code" onclick="copyCode()"></div>
  <button onclick="copyCode()">Copy Code</button>
  <p class="hint" id="hint">Click the code or button to copy</p>
  <script>
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    if (error) {
      document.querySelector('.success').textContent = '✗';
      document.querySelector('.success').classList.add('error');
      document.querySelector('h1').textContent = 'Authorization Failed';
      document.querySelector('p').textContent = error;
      document.getElementById('code').style.display = 'none';
      document.querySelector('button').style.display = 'none';
    } else if (code) {
      document.getElementById('code').textContent = code;
    } else {
      document.querySelector('h1').textContent = 'No code received';
      document.getElementById('code').style.display = 'none';
      document.querySelector('button').style.display = 'none';
    }
    function copyCode() {
      navigator.clipboard.writeText(code).then(() => {
        document.getElementById('hint').textContent = 'Copied! Paste it in the Telegram chat.';
        document.getElementById('hint').style.color = '#22c55e';
      });
    }
  </script>
</body>
</html>
HTMLEOF

  echo ""
  echo "=== Open this URL to authorize ==="
  echo "$AUTH_URL"
  echo ""
  echo "After authorization, you'll get a code. Run:"
  echo "  ./scripts/notion-oauth.sh exchange <CODE>"
}

cmd_exchange() {
  local CODE="$1"

  if [ ! -f "$OAUTH_FILE" ]; then
    echo "ERROR: No pending OAuth setup. Run 'setup' first."
    exit 1
  fi

  # Read saved state
  CLIENT_ID=$(python3 -c "import json; print(json.load(open('${OAUTH_FILE}'))['client_id'])")
  CODE_VERIFIER=$(python3 -c "import json; print(json.load(open('${OAUTH_FILE}'))['code_verifier'])")
  REDIRECT_URI=$(python3 -c "import json; print(json.load(open('${OAUTH_FILE}'))['redirect_uri'])")

  echo "Exchanging code for tokens..."
  TOKEN_RESPONSE=$(curl -s -X POST "${MCP_BASE}/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code&code=${CODE}&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}'))")&client_id=${CLIENT_ID}&code_verifier=${CODE_VERIFIER}")

  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  if [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: Token exchange failed"
    echo "$TOKEN_RESPONSE"
    exit 1
  fi

  REFRESH_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)
  EXPIRES_IN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_in', 3600))" 2>/dev/null)

  # Save tokens
  python3 -c "
import json, time
data = json.load(open('${OAUTH_FILE}'))
data['access_token'] = '${ACCESS_TOKEN}'
data['refresh_token'] = '${REFRESH_TOKEN}'
data['expires_at'] = int(time.time()) + ${EXPIRES_IN}
data['status'] = 'active'
with open('${OAUTH_FILE}', 'w') as f:
    json.dump(data, f, indent=2)
"

  echo "Notion OAuth configured successfully!"
  echo "Access token expires in ${EXPIRES_IN}s"
  [ -n "$REFRESH_TOKEN" ] && echo "Refresh token saved (auto-renewal supported)"
}

cmd_refresh() {
  if [ ! -f "$OAUTH_FILE" ]; then
    echo "ERROR: No OAuth config found."
    exit 1
  fi

  CLIENT_ID=$(python3 -c "import json; print(json.load(open('${OAUTH_FILE}'))['client_id'])")
  REFRESH_TOKEN=$(python3 -c "import json; print(json.load(open('${OAUTH_FILE}')).get('refresh_token',''))")

  if [ -z "$REFRESH_TOKEN" ]; then
    echo "ERROR: No refresh token available. Run 'setup' again."
    exit 1
  fi

  echo "Refreshing access token..."
  TOKEN_RESPONSE=$(curl -s -X POST "${MCP_BASE}/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}&client_id=${CLIENT_ID}")

  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  if [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: Token refresh failed"
    echo "$TOKEN_RESPONSE"
    exit 1
  fi

  NEW_REFRESH=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)
  EXPIRES_IN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_in', 3600))" 2>/dev/null)

  python3 -c "
import json, time
data = json.load(open('${OAUTH_FILE}'))
data['access_token'] = '${ACCESS_TOKEN}'
if '${NEW_REFRESH}': data['refresh_token'] = '${NEW_REFRESH}'
data['expires_at'] = int(time.time()) + ${EXPIRES_IN}
with open('${OAUTH_FILE}', 'w') as f:
    json.dump(data, f, indent=2)
"

  echo "Token refreshed. Expires in ${EXPIRES_IN}s"
}

cmd_status() {
  if [ ! -f "$OAUTH_FILE" ]; then
    echo "No Notion OAuth configured"
    exit 0
  fi

  python3 -c "
import json, time
d = json.load(open('${OAUTH_FILE}'))
print(f\"Status: {d.get('status', 'unknown')}\")
print(f\"Client ID: {d.get('client_id', 'none')}\")
if 'access_token' in d:
    exp = d.get('expires_at', 0)
    remaining = exp - int(time.time())
    if remaining > 0:
        print(f'Token: valid ({remaining}s remaining)')
    else:
        print(f'Token: EXPIRED ({-remaining}s ago)')
    print(f'Refresh token: {\"yes\" if d.get(\"refresh_token\") else \"no\"}')
"
}

case "${1:-}" in
  setup)    cmd_setup ;;
  exchange) cmd_exchange "${2:?Usage: notion-oauth.sh exchange <CODE>}" ;;
  refresh)  cmd_refresh ;;
  status)   cmd_status ;;
  *)        echo "Usage: $0 {setup|exchange <code>|refresh|status}" ;;
esac
