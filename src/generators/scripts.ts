import type { ScanResult } from "../types.js";
import type { TemplateAdditions } from "../templates/types.js";

export function generatePostCreate(
  scan: ScanResult,
  templateAdditions?: TemplateAdditions
): string {
  const installSteps = scan.stacks
    .flatMap((s) => s.postCreateSteps)
    .map((step) => `echo "Running: ${step}..."\n${step}`)
    .join("\n\n");

  const templateSteps = templateAdditions?.postCreateSteps
    .map((step) => `echo "Running: ${step}..."\n${step}`)
    .join("\n\n");

  return `#!/bin/bash
set -e

echo "Running post-create setup..."
echo "  WORKSPACE_DIR: \${WORKSPACE_DIR}"

###########################################
# Git Safe Directory
###########################################

git config --global --add safe.directory "\${WORKSPACE_DIR}" 2>/dev/null || true

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

${installSteps || "echo \"No project dependencies to install.\""}
${templateSteps ? `\n###########################################\n# Template Setup\n###########################################\n\n${templateSteps}` : ""}

echo ""
echo "Post-create setup complete!"
`;
}

export function generatePostStart(
  _scan: ScanResult,
  templateAdditions?: TemplateAdditions
): string {
  const templateSteps = templateAdditions?.postStartSteps
    .map((step) => `echo "Running: ${step}..."\n${step}`)
    .join("\n\n");

  return `#!/bin/bash
set -e

echo "Running post-start setup..."

###########################################
# Git Safe Directory
###########################################

git config --global --add safe.directory "\${WORKSPACE_DIR}" 2>/dev/null || true
${templateSteps ? `\n###########################################\n# Template Setup\n###########################################\n\n${templateSteps}` : ""}

echo "Post-start setup complete!"
`;
}
