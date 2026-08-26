#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mount_dir="${script_dir}/data/alldebrid"
user_domain="gui/$(id -u)"

# Le pipeline direct AllDebrid ne dépend plus du montage NFS ni de Vortex.
# Garder l'ancien superviseur arrêté évite les blocages de Docker Desktop.
launchctl bootout "${user_domain}/org.weflix.media-supervisor" 2>/dev/null || true
if mount | grep -Fq " on ${mount_dir} "; then
  diskutil unmount force "${mount_dir}" >/dev/null
fi

cd "${script_dir}"
docker compose up -d --build "$@"
