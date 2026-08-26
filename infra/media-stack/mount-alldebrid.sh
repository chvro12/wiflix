#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mount_dir="${script_dir}/data/alldebrid"
config_file="${RCLONE_CONFIG:-${script_dir}/rclone-alldebrid.conf}"

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone est absent. Sur macOS : brew install rclone macfuse" >&2
  exit 1
fi

if [[ ! -f "${config_file}" ]]; then
  echo "Configuration absente : ${config_file}" >&2
  echo "Exécutez d'abord ./configure-rclone.sh." >&2
  exit 1
fi

mkdir -p "${mount_dir}"

# Évite plusieurs serveurs NFS concurrents si le service et une commande
# manuelle démarrent au même moment.
if mount | grep -Fq " on ${mount_dir} "; then
  echo "AllDebrid est déjà monté sur ${mount_dir}."
  exit 0
fi

mount_command=mount
if [[ "$(uname -s)" == "Darwin" ]]; then
  # La formule Homebrew n'inclut plus le sous-programme FUSE `mount`.
  mount_command=nfsmount
fi

exec rclone "${mount_command}" AllDebrid:magnets "${mount_dir}" \
  --config "${config_file}" \
  --dir-cache-time 30m \
  --multi-thread-streams 4 \
  --cutoff-mode cautious \
  --vfs-cache-mode minimal \
  --network-mode \
  --buffer-size 128M \
  --vfs-read-chunk-size 64M \
  --vfs-read-chunk-size-limit 512M \
  --contimeout 15s \
  --timeout 2m \
  --read-only
