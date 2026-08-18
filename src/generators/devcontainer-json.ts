import { DEFAULT_SETTINGS, type GenerationSettings, type ScanResult } from "../types.js";
import type { TemplateAdditions } from "../templates/types.js";

interface DevcontainerConfig {
  name: string;
  workspaceFolder: string;
  workspaceMount: string;
  build: {
    dockerfile: string;
    args: Record<string, string>;
  };
  features: Record<string, Record<string, unknown>>;
  customizations: {
    vscode: {
      extensions: string[];
    };
  };
  remoteEnv: Record<string, string>;
  remoteUser: string;
  mounts: string[];
  postCreateCommand: string;
  postStartCommand: string;
}

export function generateDevcontainerJson(
  scan: ScanResult,
  templateAdditions?: TemplateAdditions,
  settings: GenerationSettings = DEFAULT_SETTINGS
): string {
  const extensions = new Set<string>();
  for (const stack of scan.stacks) {
    for (const ext of stack.extensions) {
      extensions.add(ext);
    }
  }

  const features: Record<string, Record<string, unknown>> = {};
  if (scan.hasDocker) {
    features["ghcr.io/devcontainers/features/docker-outside-of-docker:1"] = {
      moby: false,
      installDockerBuildx: false,
    };
  }

  if (templateAdditions) {
    for (const ext of templateAdditions.extensions) {
      extensions.add(ext);
    }
    Object.assign(features, templateAdditions.features);
  }

  const mounts = buildMountEntries(scan);
  if (templateAdditions) {
    mounts.push(...templateAdditions.mounts);
  }

  const remoteEnv: Record<string, string> = {
    LOCAL_WORKSPACE_FOLDER: "${localWorkspaceFolder}",
    WORKSPACE_DIR: `/workspaces/${scan.projectName}`,
    // Mirrors the image's ENV TZ so VS Code-spawned processes agree with the
    // shell, and so changing it here doesn't require a rebuild to take effect.
    TZ: settings.timezone,
  };
  if (templateAdditions) {
    Object.assign(remoteEnv, templateAdditions.envVars);
  }

  const config: DevcontainerConfig = {
    name: scan.projectName,
    workspaceFolder: `/workspaces/${scan.projectName}`,
    workspaceMount: "",
    build: {
      dockerfile: "Dockerfile",
      args: {
        WORKSPACE_DIR: `/workspaces/${scan.projectName}`,
        TZ: settings.timezone,
      },
    },
    features,
    customizations: {
      vscode: {
        extensions: [...extensions],
      },
    },
    remoteEnv,
    remoteUser: "node",
    mounts,
    postCreateCommand:
      "sudo chmod +x .devcontainer/scripts/*.sh && bash .devcontainer/scripts/post-create.sh",
    postStartCommand:
      "sudo chmod +x .devcontainer/scripts/*.sh && bash .devcontainer/scripts/post-start.sh",
  };

  return JSON.stringify(config, null, 2) + "\n";
}

function buildMountEntries(scan: ScanResult): string[] {
  const mounts: string[] = [];

  mounts.push(
    "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"
  );
  mounts.push(
    "source=${localWorkspaceFolder}/.devcontainer,target=${containerWorkspaceFolder}/.devcontainer,type=bind,consistency=cached"
  );

  for (const entry of scan.rootEntries) {
    if (entry.name === ".devcontainer") continue;
    if (entry.name === ".git") continue;

    const source = `\${localWorkspaceFolder}/${entry.relativePath}`;
    const target = `\${containerWorkspaceFolder}/${entry.relativePath}`;
    mounts.push(`source=${source},target=${target},type=bind,consistency=cached`);
  }

  return mounts;
}
