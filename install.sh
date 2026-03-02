#!/bin/bash
# Installeer alle dependencies vanuit WSL
# Gebruik: bash install.sh (in WSL terminal)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "📦 Finance App installatie vanuit: $SCRIPT_DIR"

echo ""
echo "=== Backend dependencies installeren ==="
cd "$SCRIPT_DIR/backend"
npm install
echo "✅ Backend klaar"

echo ""
echo "=== Frontend dependencies installeren ==="
cd "$SCRIPT_DIR/frontend"
npm install
echo "✅ Frontend klaar"

echo ""
echo "🎉 Klaar! Start de app met:"
echo "  Terminal 1:  cd backend && npm run dev"
echo "  Terminal 2:  cd frontend && ng serve"
echo "  Browser:     http://localhost:4200"
