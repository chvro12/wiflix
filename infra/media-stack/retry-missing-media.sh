#!/bin/zsh
set -euo pipefail

stack_dir="${0:A:h}"
set -a
source "$stack_dir/.env"
set +a

start_search() {
  local label="$1"
  local base_url="$2"
  local api_key="$3"
  local command_name="$4"
  local active
  active=$(curl -fsS --max-time 20 -H "X-Api-Key: $api_key" "$base_url/api/v3/command" \
    | jq --arg name "$command_name" '[.[] | select(.name == $name and (.status == "queued" or .status == "started"))] | length')
  if [[ "$active" -gt 0 ]]; then
    print -r -- "$label : recherche déjà active."
    return
  fi
  curl -fsS --max-time 20 -X POST \
    -H "X-Api-Key: $api_key" \
    -H 'Content-Type: application/json' \
    --data "{\"name\":\"$command_name\"}" \
    "$base_url/api/v3/command" >/dev/null
  print -r -- "$label : recherche des médias manquants démarrée."
}

start_search "Radarr" "http://127.0.0.1:7878" "$RADARR_API_KEY" "MissingMoviesSearch"
start_search "Sonarr" "http://127.0.0.1:8989" "$SONARR_API_KEY" "MissingEpisodeSearch"
