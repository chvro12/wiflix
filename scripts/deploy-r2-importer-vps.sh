#!/usr/bin/env bash
set -euo pipefail

VPS_HOST=${VPS_HOST:-78.138.45.49}
VPS_USER=${VPS_USER:-weflix}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/weflix_vps_ed25519}
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK_ROOT="$PROJECT_ROOT/infra/media-stack"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no)
RSYNC=(rsync -az -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no")

echo "→ Sync infra/media-stack vers le VPS"
"${RSYNC[@]}" --exclude 'data/library/***' --exclude 'data/downloads/***' \
  "$STACK_ROOT/" "$VPS_USER@$VPS_HOST:/opt/weflix/infra/media-stack/"

echo "→ Rebuild et redémarrage r2-importer"
"${SSH[@]}" "$VPS_USER@$VPS_HOST" 'set -e
  cd /opt/weflix/infra/media-stack
  docker compose --env-file .env build r2-importer
  docker compose --env-file .env up -d --no-deps r2-importer
  sleep 8
  curl -fsS http://127.0.0.1:8788/health | python3 -m json.tool | head -40
'

echo "→ Relance des erreurs (si endpoint disponible)"
ORIGIN_TOKEN=$("${SSH[@]}" "$VPS_USER@$VPS_HOST" 'set -a; source /opt/weflix/infra/media-stack/.env 2>/dev/null || true; source /opt/weflix/.env.local 2>/dev/null || true; set +a; printf "%s" "${MEDIA_ORIGIN_TOKEN:-${R2_IMPORTER_PASSWORD:-}}"' || true)
if [[ -n "${ORIGIN_TOKEN}" ]]; then
  curl -fsS --max-time 20 -X POST \
    -H "Authorization: Bearer ${ORIGIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data '{"includePreload":true,"force":true}' \
    https://origin.wiflix.site/maintenance/retry-errors || echo "Relance distante ignorée (endpoint pas encore actif)."
fi

echo "OK — r2-importer redéployé."
