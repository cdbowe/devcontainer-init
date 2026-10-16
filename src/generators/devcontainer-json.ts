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
  /** Omitted from the JSON when no template contributed one. */
  initializeCommand?: string;
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
  // A template may mount a path the scan also picked up as a root entry — e.g.
  // the worktree `main/` folder, once it exists on the host and a later run
  // rescans. Docker rejects two mounts on the same target, so keep the first.
  const dedupedMounts = dedupeByTarget(mounts);

  // Host-side setup, joined into the single string devcontainer.json allows.
  const initializeCommands = [
    ...collectHostDirs(templateAdditions).map(ensureHostDir),
    ...(templateAdditions?.initializeCommands ?? []),
  ];
  const initializeCommand =
    initializeCommands.length > 0 ? initializeCommands.join(" && ") : undefined;

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
    mounts: dedupedMounts,
    initializeCommand,
    postCreateCommand:
      "sudo chmod +x .devcontainer/scripts/*.sh && bash .devcontainer/scripts/post-create.sh",
    postStartCommand:
      "sudo chmod +x .devcontainer/scripts/*.sh && bash .devcontainer/scripts/post-start.sh",
  };

  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Scratch/handoff folder every generated container gets, bound to a host folder
 * of the same name so its contents survive rebuilds and are reachable from the
 * host.
 */
export const CLAUDE_FILES_DIR = "claude_files";

/**
 * Workspace-relative folders that must exist on the HOST before the container
 * is created: `docker run --mount type=bind` errors on a missing source instead
 * of creating it. The CLI creates these at generation time; ensureHostDir below
 * re-creates them at container-create time for clones and deleted folders.
 */
export function collectHostDirs(
  templateAdditions?: TemplateAdditions
): string[] {
  return [
    ...new Set([CLAUDE_FILES_DIR, ...(templateAdditions?.hostDirs ?? [])]),
  ];
}

/**
 * `initializeCommand` runs in the host's own shell — `cmd.exe /c` on Windows,
 * `sh -c` elsewhere — so `mkdir -p` is out: cmd.exe reads `-p` as another
 * directory to create, then rejects the path that follows. What survives both
 * shells, in order:
 *
 *   1. absolute `mkdir`, correct whatever the shell's cwd is. Plain `mkdir`
 *      needs no `-p` here — the parent is always the workspace folder — but
 *      fails when the directory already exists, and cmd.exe may reject the
 *      forward slash this path is joined with;
 *   2. the same `mkdir` relative to the cwd, which the devcontainer CLI sets to
 *      the local workspace folder, covering that cmd.exe case;
 *   3. `cd .`, the no-op that succeeds in both shells, so an already-created
 *      folder can't fail container creation. `|| true` would not do: `true` is
 *      not a cmd.exe builtin, so it would fail there instead.
 */
function ensureHostDir(dir: string): string {
  return `(mkdir "\${localWorkspaceFolder}/${dir}" || mkdir ${dir} || cd .)`;
}

function dedupeByTarget(mounts: string[]): string[] {
  const seen = new Set<string>();
  return mounts.filter((mount) => {
    const target = mount
      .split(",")
      .find((part) => part.startsWith("target="));
    if (!target) return true;
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

function buildMountEntries(scan: ScanResult): string[] {
  const mounts: string[] = [];

  mounts.push(
    "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"
  );
  mounts.push(
    "source=${localWorkspaceFolder}/.devcontainer,target=${containerWorkspaceFolder}/.devcontainer,type=bind,consistency=cached"
  );
  mounts.push(
    `source=\${localWorkspaceFolder}/${CLAUDE_FILES_DIR},target=\${containerWorkspaceFolder}/${CLAUDE_FILES_DIR},type=bind,consistency=cached`
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
