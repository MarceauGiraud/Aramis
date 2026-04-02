#!/bin/bash
set -euo pipefail

# =============================================================================
# Aramis Deployment Script for DigitalOcean Droplet
# =============================================================================
#
# Usage:
#   1. Create a droplet: Ubuntu 22.04 x86_64, 4vCPU/8GB RAM ($48/mo)
#   2. SSH into the droplet
#   3. Run: curl -sSL <this-script-url> | bash
#   OR clone the repo and run: bash scripts/deploy.sh
# =============================================================================

echo "=== Aramis Bot Worker Deployment ==="

# --- Step 1: Install Docker if not present ---
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    echo "Docker installed."
else
    echo "Docker already installed."
fi

# --- Step 2: Check for .env.prod ---
if [ ! -f .env.prod ]; then
    echo ""
    echo "ERROR: .env.prod not found!"
    echo "Copy .env.prod.example to .env.prod and fill in your values:"
    echo "  cp .env.prod.example .env.prod"
    echo "  nano .env.prod"
    echo ""
    exit 1
fi

# --- Step 3: Build and start ---
echo "Building and starting services..."
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Services running:"
docker compose -f docker-compose.prod.yml ps
echo ""
echo "View logs:  docker compose -f docker-compose.prod.yml logs -f bot-worker"
echo "Stop:       docker compose -f docker-compose.prod.yml down"
echo "Scale:      docker compose -f docker-compose.prod.yml up -d --scale bot-worker=3"
echo ""
