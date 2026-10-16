#!/bin/bash
set -e

echo "Running post-create setup..."
echo "  WORKSPACE_DIR: ${WORKSPACE_DIR}"

###########################################
# Git Safe Directory
###########################################

if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "${WORKSPACE_DIR}"; then
  git config --global --add safe.directory "${WORKSPACE_DIR}" 2>/dev/null || true
fi

###########################################
# Project Dependencies
###########################################

if [ -f "package.json" ]; then
  echo "Running: npm install..."
  npm install
fi


echo ""
echo "Post-create setup complete!"
