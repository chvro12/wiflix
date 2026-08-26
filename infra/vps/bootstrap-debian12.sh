#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Ce script doit être exécuté en root." >&2
  exit 1
fi

DEPLOY_PUBLIC_KEY=${DEPLOY_PUBLIC_KEY:-}
if [[ -z ${DEPLOY_PUBLIC_KEY} ]]; then
  echo "DEPLOY_PUBLIC_KEY est requis afin de sécuriser SSH sans verrouiller le serveur." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg rsync ufw fail2ban unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

id -u weflix >/dev/null 2>&1 || useradd --create-home --shell /bin/bash weflix
usermod -aG docker weflix
install -d -m 0700 -o weflix -g weflix /home/weflix/.ssh
printf '%s\n' "$DEPLOY_PUBLIC_KEY" >/home/weflix/.ssh/authorized_keys
chown weflix:weflix /home/weflix/.ssh/authorized_keys
chmod 0600 /home/weflix/.ssh/authorized_keys
install -d -m 0750 -o weflix -g weflix /opt/weflix

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable
install -m 0644 "$(dirname "$0")/fail2ban-sshd.local" /etc/fail2ban/jail.d/weflix-sshd.local
systemctl enable --now docker fail2ban

cat >/etc/ssh/sshd_config.d/90-weflix.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh

echo "VPS prêt. Connectez-vous avec : ssh weflix@78.138.45.49"
