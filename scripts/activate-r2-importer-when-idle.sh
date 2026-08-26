#!/usr/bin/env bash
set -euo pipefail

stack_dir="${WEFLIX_STACK_DIR:-/opt/weflix/infra/media-stack}"
cd "$stack_dir"

set -a
# shellcheck disable=SC1091
. ./.env
project_env="${WEFLIX_PROJECT_ENV:-/opt/weflix/.env.local}"
if [[ -f "$project_env" ]]; then
  # shellcheck disable=SC1090
  . "$project_env"
fi
set +a

origin_token="${MEDIA_ORIGIN_TOKEN:-${R2_IMPORTER_PASSWORD:-}}"
idle_samples=0

for _attempt in $(seq 1 5760); do
  metrics="$(curl -fsS --max-time 5 \
    -H "Authorization: Bearer ${origin_token}" \
    http://127.0.0.1:8788/metrics 2>/dev/null || true)"
  read -r interactive canary_active < <(python3 -c '
import json, sys
data = json.load(sys.stdin)
canaries = set(data.get("r2", {}).get("canaries", []))
active = data.get("r2", {}).get("active", [])
print(data.get("live", {}).get("interactive", 999), int(any(job.get("lookupPath") in canaries for job in active)))
' <<<"$metrics" 2>/dev/null || echo "999 1")

  if [[ "$interactive" == "0" && "$canary_active" == "0" ]]; then
    idle_samples=$((idle_samples + 1))
  else
    idle_samples=0
  fi

  if (( idle_samples >= 3 )); then
    docker compose up -d --no-deps r2-importer
    echo "$(date -Is) Nouvelle version R2 activée après trois contrôles sans spectateur."
    exit 0
  fi

  sleep 15
done

echo "$(date -Is) Activation différée : aucune fenêtre sans spectateur pendant vingt-quatre heures."
exit 1
