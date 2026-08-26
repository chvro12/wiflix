#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
config_file="${script_dir}/rclone-alldebrid.conf"
env_file="${script_dir}/.env"

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone est absent. Sur macOS : brew install rclone macfuse" >&2
  exit 1
fi

api_key="${ALLDEBRID_RCLONE_API_KEY:-}"
if [[ -z "${api_key}" && -f "${env_file}" ]]; then
  api_key="$(sed -n 's/^ALLDEBRID_RCLONE_API_KEY=//p' "${env_file}" | tail -n 1)"
fi

if [[ -z "${api_key}" ]]; then
  read -r -s -p "Clé API AllDebrid dédiée : " api_key
  echo
fi

if [[ -z "${api_key}" ]]; then
  echo "La clé API ne peut pas être vide." >&2
  exit 1
fi

rclone config create AllDebrid webdav \
  url https://webdav.debrid.it/ \
  vendor other \
  user "${api_key}" \
  pass eeeee \
  --config "${config_file}" >/dev/null

chmod 600 "${config_file}"
unset api_key
echo "Configuration créée : ${config_file}"
