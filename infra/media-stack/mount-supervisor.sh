#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mount_dir="${script_dir}/data/alldebrid"
mount_pid=""
next_allowed=0

set -a
source "${script_dir}/.env"
set +a

is_mounted() { mount | grep -Fq " on ${mount_dir} "; }

stop_mount() {
  if is_mounted; then diskutil unmount force "${mount_dir}" >/dev/null 2>&1 || true; fi
  if [[ -n "${mount_pid}" ]]; then kill "${mount_pid}" >/dev/null 2>&1 || true; fi
  mount_pid=""
}
trap stop_mount EXIT INT TERM

# Un montage permanent bloque Docker Desktop. Ce superviseur l'active seulement
# pendant une fenêtre d'import, puis laisse Jellyfin/R2 lire via HTTP.
launchctl bootout "gui/$(id -u)/org.weflix.rclone-alldebrid" 2>/dev/null || true
stop_mount

while true; do
  pending=0
  for service in "7878:${RADARR_API_KEY}:Movie" "8989:${SONARR_API_KEY}:Series"; do
    port="${service%%:*}"
    remainder="${service#*:}"
    api_key="${remainder%%:*}"
    media_type="${remainder##*:}"
    count="$(curl --max-time 8 -fsS -H "X-Api-Key: ${api_key}" \
      "http://127.0.0.1:${port}/api/v3/queue?pageSize=200&includeUnknown${media_type}Items=true" \
      2>/dev/null | jq '[.records[] | select(.status == "downloading" or .status == "warning" or .status == "completed")] | length' 2>/dev/null || echo 0)"
    pending=$((pending + count))
  done

  now="$(date +%s)"
  if (( pending > 0 && now >= next_allowed )); then
    echo "$(date -Iseconds) Téléchargement/import détecté (${pending}), montage AllDebrid temporaire."
    "${script_dir}/mount-alldebrid.sh" >>/tmp/weflix-alldebrid-supervisor.log 2>&1 &
    mount_pid="$!"
    for _ in {1..20}; do is_mounted && break; sleep 1; done
    if is_mounted; then
      curl --max-time 15 -fsS -X POST -H "X-Api-Key: ${RADARR_API_KEY}" -H 'Content-Type: application/json' \
        --data '{"name":"RefreshMonitoredDownloads"}' http://127.0.0.1:7878/api/v3/command >/dev/null 2>&1 || true
      curl --max-time 15 -fsS -X POST -H "X-Api-Key: ${SONARR_API_KEY}" -H 'Content-Type: application/json' \
        --data '{"name":"RefreshMonitoredDownloads"}' http://127.0.0.1:8989/api/v3/command >/dev/null 2>&1 || true
      sleep 75
    fi
    stop_mount
    next_allowed=$(( $(date +%s) + 180 ))
    echo "$(date -Iseconds) Fenêtre d'import terminée, lecture HTTP rétablie."
  fi
  sleep 3
done
