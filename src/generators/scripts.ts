import { basename } from "node:path";
import type { DetectedStack, ScanResult } from "../types.js";
import type { TemplateAdditions } from "../templates/types.js";

const STACK_GUARD_FILES: Record<string, string> = {
  node: "package.json",
  dotnet: "*.csproj",
  python: "requirements.txt",
  rust: "Cargo.toml",
  go: "go.mod",
  ruby: "Gemfile",
  java: "pom.xml",
};

function guardCondition(stack: DetectedStack): string {
  const guard = stack.markerFile ? basename(stack.markerFile) : STACK_GUARD_FILES[stack.name];
  if (!guard) return "";
  if (guard.includes("*")) {
    return `ls ${guard} 1>/dev/null 2>&1`;
  }
  return `[ -f "${guard}" ]`;
}

/**
 * Steps are echoed before they run. A multi-line step would spill into the echo
 * and mangle it, so label those by their first line instead.
 */
function stepLabel(step: string): string {
  const [first] = step.split("\n");
  return step.includes("\n") ? `${first} ...` : step;
}

export function generatePostCreate(
  scan: ScanResult,
  templateAdditions?: TemplateAdditions
): string {
  const installSteps = scan.stacks
    .filter((s) => s.postCreateSteps.length > 0)
    .map((s) => {
      const steps = s.postCreateSteps
        .map((step) => `  echo "Running: ${step}..."\n  ${step}`)
        .join("\n\n");
      const condition = guardCondition(s);
      if (!condition) return steps.replace(/^  /gm, "");
      return `if ${condition}; then\n${steps}\nfi`;
    })
    .join("\n\n");

  const templateSteps = templateAdditions?.postCreateSteps
    .map((step) => `echo "Running: ${stepLabel(step)}..."\n${step}`)
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
