#!/bin/bash
set -e

echo "Running post-start setup..."

###########################################
# Git Safe Directory
###########################################

if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "${WORKSPACE_DIR}"; then
  git config --global --add safe.directory "${WORKSPACE_DIR}" 2>/dev/null || true
fi

###########################################
# Template Setup
###########################################

echo "Running: # GitHub MCP server (read-only) ......"
# GitHub MCP server (read-only)
register_github_mcp() {
  local env_file="${WORKSPACE_DIR}/.devcontainer/.env"
  local pat=""

  if [ -f "$env_file" ]; then
    pat="$(grep -E '^GITHUB_PAT=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ')"
  fi
  if [ -z "$pat" ]; then
    echo "  GITHUB_PAT not set in $env_file (copy .devcontainer/.env.example). Skipping GitHub MCP."
    return 0
  fi
  if ! command -v claude >/dev/null 2>&1; then
    echo "  claude CLI not on PATH. Skipping GitHub MCP."
    return 0
  fi

  local config
  config="$(jq -cn --arg pat "$pat" '{
    type: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: {
      Authorization: ("Bearer " + $pat),
      "X-MCP-Toolsets": "pull_requests,repos",
      "X-MCP-Readonly": "true"
    }
  }')"

  # Local scope keeps the server (and PAT) tied to this project path. Remove
  # first so a rotated PAT replaces the old entry instead of erroring on it.
  if (
    cd "${WORKSPACE_DIR}"
    claude mcp remove github -s local >/dev/null 2>&1 || true
    claude mcp add-json github -s local "$config" >/dev/null
  ); then
    echo "  GitHub MCP server registered (read-only: pull_requests, repos)."
  else
    echo "  WARNING: 'claude mcp add-json github' failed. Check the PAT in $env_file."
  fi
}
register_github_mcp

echo "Post-start setup complete!"
