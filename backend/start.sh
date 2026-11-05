#!/bin/bash
set -e

CLOUDFLARED=~/.local/bin/cloudflared
ENV_FILE="$(dirname "$0")/.env"
LOG_FILE="/tmp/cloudflared-tunnel.log"

echo ""
echo "======================================"
echo "  Verification Bot - Startup Script"
echo "======================================"
echo ""

# ─── Kill any old instances ───────────────────────────────────────────────────
echo "[1/4] Stopping any existing tunnel & backend..."
pkill -f cloudflared 2>/dev/null || true
pkill -f "node dist/index" 2>/dev/null || true
pkill -f "ts-node" 2>/dev/null || true
sleep 1

# ─── Start cloudflared and capture the URL ────────────────────────────────────
echo "[2/4] Starting Cloudflare tunnel..."
rm -f "$LOG_FILE"
$CLOUDFLARED tunnel --url http://localhost:5000 > "$LOG_FILE" 2>&1 &
TUNNEL_PID=$!

# Wait for the URL to appear in the log (up to 30 seconds)
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo ""
  echo "❌ ERROR: Could not get tunnel URL. Check /tmp/cloudflared-tunnel.log"
  exit 1
fi

echo "   ✅ Tunnel URL: $TUNNEL_URL"

# ─── Update .env ──────────────────────────────────────────────────────────────
echo "[3/4] Updating .env with new tunnel URL..."
sed -i "s|MINIAPP_URL=.*|MINIAPP_URL=${TUNNEL_URL}/miniapp|" "$ENV_FILE"
echo "   ✅ MINIAPP_URL=${TUNNEL_URL}/miniapp"

# ─── Start backend ────────────────────────────────────────────────────────────
echo "[4/4] Starting backend server..."
echo ""
echo "======================================"
echo "  🚀 App running at: $TUNNEL_URL"
echo "  📱 Mini App at:    ${TUNNEL_URL}/miniapp"
echo "======================================"
echo ""

npm run dev
