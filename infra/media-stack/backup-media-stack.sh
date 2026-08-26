#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
timestamp="$(date +%Y-%m-%d_%H-%M-%S)"
backup_dir="${script_dir}/config/backups/${timestamp}"

set -a
source "${script_dir}/.env"
set +a
mkdir -p "${backup_dir}"

# Radarr/Sonarr réalisent eux-mêmes une sauvegarde SQLite cohérente.
curl --max-time 20 -fsS -X POST -H "X-Api-Key: ${RADARR_API_KEY}" -H 'Content-Type: application/json' \
  --data '{"name":"Backup"}' http://127.0.0.1:7878/api/v3/command >/dev/null
curl --max-time 20 -fsS -X POST -H "X-Api-Key: ${SONARR_API_KEY}" -H 'Content-Type: application/json' \
  --data '{"name":"Backup"}' http://127.0.0.1:8989/api/v3/command >/dev/null

for database in \
  "jellyfin:data/jellyfin.db" \
  "seerr:db/db.sqlite3" \
  "vortex:torrents.db" \
  "bazarr:db/bazarr.db" \
  "prowlarr:prowlarr.db"; do
  service="${database%%:*}"
  relative_path="${database#*:}"
  source_path="${script_dir}/config/${service}/${relative_path}"
  if [[ -f "${source_path}" ]]; then
    sqlite3 "${source_path}" ".timeout 10000" ".backup '${backup_dir}/${service}.db'"
  fi
done

cp "${script_dir}/config/seerr/settings.json" "${backup_dir}/seerr-settings.json"
echo "Sauvegarde créée : ${backup_dir}"

