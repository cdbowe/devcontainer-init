import type { ScanResult } from "../types.js";

interface DevcontainerConfig {
  name: string;
  workspaceFolder: string;
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

export function generateDevcontainerJson(scan: ScanResult): string {
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

  const mounts = buildMountEntries(scan);

  const config: DevcontainerConfig = {
    name: scan.projectName,
    workspaceFolder: `/workspaces/${scan.projectName}`,
    build: {
      dockerfile: "Dockerfile",
      args: {
        WORKSPACE_DIR: `/workspaces/${scan.projectName}`,
      },
    },
    features,
    customizations: {
      vscode: {
        extensions: [...extensions],
      },
    },
    remoteEnv: {
      LOCAL_WORKSPACE_FOLDER: "${localWorkspaceFolder}",
      WORKSPACE_DIR: `/workspaces/${scan.projectName}`,
    },
    remoteUser: "dev",
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

  for (const entry of scan.rootEntries) {
    if (entry.name === ".devcontainer") continue;
    if (entry.name === ".git") continue;

    const source = `\${localWorkspaceFolder}/${entry.relativePath}`;
    const target = `\${containerWorkspaceFolder}/${entry.relativePath}`;
    mounts.push(`source=${source},target=${target},type=bind,consistency=cached`);
  }

  return mounts;
}
