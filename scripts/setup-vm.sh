#!/usr/bin/env bash
# scripts/setup-vm.sh
# First-time bootstrap for the GCP VM that runs session-service.
# Idempotent. Run as the deploy user (with passwordless sudo).
#
# Subsequent deploys are fully automated by .github/workflows/deploy.yml.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/vinaykumargudi/session-service/main/scripts/setup-vm.sh | bash
#   # or locally:
#   APP_DIR=/opt/session-service ./scripts/setup-vm.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/session-service}"
SA_KEY_DIR="/etc/session-service"

echo "==> Bootstrapping session-service VM (APP_DIR=$APP_DIR, user=$(whoami))"

# 1. System packages: Node.js 20.x, git, curl
if ! command -v node >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "==> Installing Node.js 20.x + git + curl"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get update
  sudo apt-get install -y nodejs git curl
else
  echo "==> Node.js $(node --version) and git already installed"
  command -v curl >/dev/null 2>&1 || sudo apt-get install -y curl
fi

# 2. pm2 globally
if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2 globally"
  sudo npm install -g pm2
else
  echo "==> pm2 $(pm2 --version) already installed"
fi

# 3. Persistent directory for the GCP service account key
sudo mkdir -p "$SA_KEY_DIR"
sudo chown "$(whoami)":"$(whoami)" "$SA_KEY_DIR"
sudo chmod 750 "$SA_KEY_DIR"

# 4. App directory (will be cloned by the first deploy workflow run)
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo chown "$(whoami)":"$(whoami)" "$(dirname "$APP_DIR")"

# 5. Enable pm2 on boot (systemd)
if command -v pm2 >/dev/null 2>&1; then
  echo "==> Configuring pm2 startup (systemd)"
  pm2 startup systemd -u "$(whoami)" --hp "$HOME" | tail -1 | sudo bash || true
fi

echo
echo "==> Bootstrap complete."
echo "    Next:"
echo "      - Configure GitHub secrets/vars (see README → CI/CD)."
echo "      - Push to main — the workflow will clone $APP_DIR and deploy."
