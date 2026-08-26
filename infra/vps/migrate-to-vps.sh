#!/usr/bin/env bash
set -euo pipefail

VPS_HOST=${VPS_HOST:-78.138.45.49}
VPS_USER=${VPS_USER:-weflix}
SSH_KEY=${SSH_KEY:-/Users/mac/.ssh/weflix_vps_ed25519}
SSH=(ssh -i "$SSH_KEY")
RSYNC_SSH="ssh -i $SSH_KEY"
PROJECT_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STACK_ROOT="$PROJECT_ROOT/infra/media-stack"
BACKUP_ROOT="$PROJECT_ROOT/.vps-migration-backup"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$BACKUP_DIR"
docker compose -f "$STACK_ROOT/compose.yaml" ps >"$BACKUP_DIR/compose-status.txt"
rsync -a "$STACK_ROOT/config/" "$BACKUP_DIR/config/"

for volume in weflix-radarr-config weflix-sonarr-config weflix-comet-data; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker run --rm -v "$volume:/source:ro" -v "$BACKUP_DIR:/backup" alpine \
      tar -C /source -czf "/backup/${volume}.tar.gz" .
  fi
done

"${SSH[@]}" "$VPS_USER@$VPS_HOST" 'mkdir -p /opt/weflix/infra/media-stack'
rsync -az -e "$RSYNC_SSH" --delete \
  --exclude 'data/library/***' --exclude 'data/downloads/***' \
  "$STACK_ROOT/" "$VPS_USER@$VPS_HOST:/opt/weflix/infra/media-stack/"
rsync -az -e "$RSYNC_SSH" "$PROJECT_ROOT/.env.local" "$VPS_USER@$VPS_HOST:/opt/weflix/.env.local"
rsync -az -e "$RSYNC_SSH" "$BACKUP_DIR/" "$VPS_USER@$VPS_HOST:/opt/weflix/migration-backup/"

"${SSH[@]}" "$VPS_USER@$VPS_HOST" 'set -e; chmod 600 /opt/weflix/.env.local /opt/weflix/infra/media-stack/.env; sed -i "/^MEDIA_ORIGIN_PUBLIC_URL=/d;/^LIVE_TRANSCODE_CONCURRENCY=/d;/^ENABLE_BACKGROUND_1080P=/d" /opt/weflix/.env.local; printf "\nMEDIA_ORIGIN_PUBLIC_URL=https://origin.wiflix.site\nLIVE_TRANSCODE_CONCURRENCY=2\nENABLE_BACKGROUND_1080P=false\n" >>/opt/weflix/.env.local; for volume in weflix-radarr-config weflix-sonarr-config weflix-comet-data; do archive=/opt/weflix/migration-backup/${volume}.tar.gz; if [ -f "$archive" ]; then docker volume create "$volume" >/dev/null; docker run --rm -v "$volume:/target" -v /opt/weflix/migration-backup:/backup alpine sh -c "rm -rf /target/* && tar -C /target -xzf /backup/${volume}.tar.gz"; fi; done; cd /opt/weflix/infra/media-stack; docker compose --env-file .env build r2-importer; docker compose --env-file .env up -d'
echo "Pile copiée et démarrée. Le Mac reste intact pour permettre un retour arrière."
