#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ONDC Connector — VPS Deployment Script
# Run this ON THE VPS after first-time setup is complete
# Usage: bash deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

APP_DIR="/var/www/ondc-connector"
DASHBOARD_DIR="$APP_DIR/dashboard"

echo "──────────────────────────────────────"
echo " ONDC Connector — Deploy"
echo "──────────────────────────────────────"

cd $APP_DIR

# 1. Pull latest code
echo "[1/5] Pulling latest code..."
git pull origin main

# 2. Install backend dependencies
echo "[2/5] Installing backend dependencies..."
npm install --production

# 3. Build dashboard
echo "[3/5] Building dashboard..."
cd $DASHBOARD_DIR
npm install
npm run build
cd $APP_DIR

# 4. Restart backend with PM2
echo "[4/5] Restarting backend..."
pm2 restart ondc-connector || pm2 start ecosystem.config.js

# 5. Reload Nginx
echo "[5/5] Reloading Nginx..."
nginx -t && systemctl reload nginx

echo ""
echo "✓ Deployment complete!"
echo "  Backend:   https://ondc.cottkart.com/health"
echo "  Dashboard: https://ondc.cottkart.com"
echo ""
pm2 status
