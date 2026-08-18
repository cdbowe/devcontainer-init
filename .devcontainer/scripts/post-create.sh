#!/bin/bash
set -e

echo "Running post-create setup..."
echo "  WORKSPACE_DIR: ${WORKSPACE_DIR}"

###########################################
# Git Safe Directory
###########################################

git config --global --add safe.directory "${WORKSPACE_DIR}" 2>/dev/null || true

###########################################
# Docker Socket
###########################################

if [ -S /var/run/docker.sock ]; then
  sudo chgrp docker /var/run/docker.sock 2>/dev/null || true
  sudo chmod g+rw /var/run/docker.sock 2>/dev/null || true
fi

###########################################
# Project Dependencies
###########################################

if [ -f "package.json" ]; then
  echo "Running: npm install..."
  npm install
fi

###########################################
# Template Setup
###########################################

echo "Running: if [ -x /opt/claude-code-tools/install.sh ]; then bash /opt/claude-code-tools/install.sh --dir "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi..."
if [ -x /opt/claude-code-tools/install.sh ]; then bash /opt/claude-code-tools/install.sh --dir "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi

echo "Running: if [ -x /opt/claude-code-tools/install.sh ]; then bash /opt/claude-code-tools/install.sh --dir "${WORKSPACE_DIR}/.claude" --with-local; fi..."
if [ -x /opt/claude-code-tools/install.sh ]; then bash /opt/claude-code-tools/install.sh --dir "${WORKSPACE_DIR}/.claude" --with-local; fi

echo ""
echo "Post-create setup complete!"
