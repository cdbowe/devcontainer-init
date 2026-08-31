import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import type { Template, TemplateAdditions, TemplateConfigureOptions } from "./types.js";

interface ClaudeCodeDistTags {
  stable: string;
  latest: string;
  next?: string;
}

function fetchDistTags(): ClaudeCodeDistTags | null {
  try {
    const output = execSync(
      "npm view @anthropic-ai/claude-code dist-tags --json",
      { encoding: "utf-8", timeout: 10000 }
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function fetchAllVersions(): string[] {
  try {
    const output = execSync(
      "npm view @anthropic-ai/claude-code versions --json",
      { encoding: "utf-8", timeout: 10000 }
    );
    const versions: string[] = JSON.parse(output);
    return versions.reverse();
  } catch {
    return [];
  }
}

const CONTAINER_TOOLS_DIR = "/opt/claude-code-tools";
const DEFAULT_TOOLS_SIBLING = "../claude-code-tools";

interface ToolsIntegration {
  dockerfileSteps: string[];
  mounts: string[];
  envVars: Record<string, string>;
  postCreateSteps: string[];
}

/**
 * Optionally wire in a local `claude-code-tools` checkout so its
 * settings.json / settings.local.json / statusline install into the new
 * container out of the box. The tools repo owns the install layout via its
 * own `install.sh`; devcontainer-init just mounts the checkout read-only and
 * invokes that installer at post-create time.
 *
 * We install the full toolkit (`--all`: agents/, commands/, hooks/ on top of
 * the minimal set) unless --minimal was passed. install.sh's own default is
 * minimal, so the mode flag is always explicit here rather than implied.
 *
 * --force propagates as install.sh's own --force, which replaces an existing
 * settings.local.json instead of keeping it.
 */
async function configureToolsIntegration(
  interactive: boolean,
  projectPath: string,
  minimalTools: boolean,
  forceTools: boolean
): Promise<ToolsIntegration> {
  const empty: ToolsIntegration = {
    dockerfileSteps: [],
    mounts: [],
    envVars: {},
    postCreateSteps: [],
  };

  // Explicit opt-in wins over filesystem probing. This matters when
  // devcontainer-init itself runs inside a container: the probe below sees the
  // container filesystem, not the host layout the mount is resolved against.
  const envPath = process.env.CLAUDE_CODE_TOOLS_DIR?.trim();

  // Resolve where a sibling checkout would live, for defaults. Only meaningful
  // when running on the host; may be a false negative from inside a container.
  const siblingPath = resolve(projectPath, DEFAULT_TOOLS_SIBLING);
  const siblingExists = existsSync(siblingPath);

  let hostPath: string | null = null;

  if (envPath) {
    hostPath = envPath;
  } else if (interactive) {
    const { enable } = await inquirer.prompt<{ enable: boolean }>([
      {
        type: "confirm",
        name: "enable",
        message:
          "Install settings + statusline from a local claude-code-tools checkout?",
        default: siblingExists,
      },
    ]);
    if (!enable) return empty;

    const { path } = await inquirer.prompt<{ path: string }>([
      {
        type: "input",
        name: "path",
        message:
          "Path to your claude-code-tools checkout (relative to the host workspace):",
        default: DEFAULT_TOOLS_SIBLING,
      },
    ]);
    hostPath = path.trim() || DEFAULT_TOOLS_SIBLING;
  } else {
    // Non-interactive: only wire it in when a sibling checkout is present,
    // so scripted runs never produce a mount pointing at a missing folder.
    // Set CLAUDE_CODE_TOOLS_DIR to opt in when the checkout isn't visible here.
    if (!siblingExists) return empty;
    hostPath = DEFAULT_TOOLS_SIBLING;
  }

  // The mount source is resolved on the HOST at container-create time, so a
  // path we can't see locally is not necessarily wrong — but it's worth a nudge.
  if (isAbsolute(hostPath) && !existsSync(hostPath)) {
    console.log(
      chalk.yellow(
        `  Note: ${hostPath} is not visible from here. It must be a valid path on the Docker host.`
      )
    );
  }

  // Express the bind-mount source. Absolute paths are used verbatim; relative
  // paths are anchored to the host workspace folder at container-create time.
  const mountSource = isAbsolute(hostPath)
    ? hostPath
    : `\${localWorkspaceFolder}/${hostPath}`;

  const modeFlag = minimalTools ? "--minimal" : "--all";
  // --force only has meaning alongside --with-local: install.sh consults it
  // solely when deciding whether to replace an existing settings.local.json.
  // Adding it to the user-scope step would be a no-op that reads as one.
  const localFlags = forceTools ? "--with-local --force" : "--with-local";

  return {
    dockerfileSteps: [
      `
######################
# claude-code-tools runtime deps
######################

# The toolkit's /prd command set shells out to python3 for the topological sort
# and wave splitting in prd-plan.sh and prd-unblock-compile.sh. Not present on
# debian:*-slim. Scoped to the tools integration rather than the base package
# list so containers generated without the checkout stay slim.
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 \\
  && apt-get clean && rm -rf /var/lib/apt/lists/*`,
    ],
    mounts: [
      `source=${mountSource},target=${CONTAINER_TOOLS_DIR},type=bind,readonly`,
      // Surface project-scoped config as a real .claude/ at the workspace root.
      "source=${localWorkspaceFolder}/.claude,target=${containerWorkspaceFolder}/.claude,type=bind,consistency=cached",
    ],
    // Only the full toolkit ships the worktree scripts that read this. Their
    // own default is "${WORKTREE_MAIN_DIR:-${WORKSPACE_DIR}/main}", so this
    // sets the same value explicitly — it makes the location visible and
    // editable in devcontainer.json rather than buried in a shell default.
    //
    // Uses ${containerWorkspaceFolder} rather than ${WORKSPACE_DIR}: remoteEnv
    // values can't reference another remoteEnv key, and WORKSPACE_DIR is only
    // a Dockerfile ARG, so it isn't in containerEnv either. Both resolve to
    // /workspaces/<project>.
    envVars: minimalTools
      ? {}
      : { WORKTREE_MAIN_DIR: "${containerWorkspaceFolder}/main" },
    postCreateSteps: [
      // User scope (shared volume = $CLAUDE_CONFIG_DIR): settings + statusline,
      // so the statusline works from any directory and persists across rebuilds.
      `if [ -x ${CONTAINER_TOOLS_DIR}/install.sh ]; then bash ${CONTAINER_TOOLS_DIR}/install.sh ${modeFlag} --dir "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi`,
      // Project scope (workspace .claude/): same, plus seed settings.local.json.
      `if [ -x ${CONTAINER_TOOLS_DIR}/install.sh ]; then bash ${CONTAINER_TOOLS_DIR}/install.sh ${modeFlag} --dir "\${WORKSPACE_DIR}/.claude" ${localFlags}; fi`,
    ],
  };
}

export const claudeCodeTemplate: Template = {
  name: "claude-code",
  description: "Claude Code CLI with shared credential volume",

  async configure({
    interactive,
    projectPath,
    minimalTools = false,
    forceTools = false,
  }: TemplateConfigureOptions): Promise<TemplateAdditions> {
    console.log(chalk.dim("\nFetching Claude Code versions from npm..."));
    const distTags = fetchDistTags();

    let version = "stable";

    if (distTags) {
      if (interactive) {
        const choices = [
          {
            name: `stable (${distTags.stable}) — recommended`,
            value: distTags.stable,
          },
          {
            name: `latest (${distTags.latest})`,
            value: distTags.latest,
          },
          {
            name: "Pick a specific version...",
            value: "__pick__",
          },
        ];

        const { selectedVersion } = await inquirer.prompt<{
          selectedVersion: string;
        }>([
          {
            type: "list",
            name: "selectedVersion",
            message: "Claude Code version:",
            choices,
            default: distTags.stable,
          },
        ]);

        if (selectedVersion === "__pick__") {
          console.log(chalk.dim("Fetching all versions..."));
          const allVersions = fetchAllVersions();

          if (allVersions.length > 0) {
            const { pickedVersion } = await inquirer.prompt<{
              pickedVersion: string;
            }>([
              {
                type: "list",
                name: "pickedVersion",
                message: "Select version:",
                choices: allVersions.map((v) => ({
                  name: v,
                  value: v,
                })),
                loop: false,
              },
            ]);
            version = pickedVersion;
          } else {
            console.log(
              chalk.yellow("Could not fetch version list. Using stable.")
            );
            version = distTags.stable;
          }
        } else {
          version = selectedVersion;
        }
      } else {
        version = distTags.stable;
      }
    } else {
      console.log(
        chalk.yellow(
          "Could not fetch versions from npm. Defaulting to stable channel."
        )
      );
    }

    console.log(chalk.green(`  Using Claude Code ${version}\n`));

    const tools = await configureToolsIntegration(
      interactive,
      projectPath,
      minimalTools,
      forceTools
    );
    if (tools.mounts.length > 0) {
      console.log(
        chalk.green(
          `  Wiring in claude-code-tools install step (${minimalTools ? "minimal: settings + statusline" : "full toolkit: + agents, commands, hooks"})`
        )
      );
      if (forceTools) {
        console.log(
          chalk.yellow(
            "  --force: post-create will replace the project settings.local.json on every container create"
          )
        );
      }
      console.log();
    }

    return {
      dockerfileSteps: [
        // Tools deps first: they apt-install as root, and the block below
        // switches to USER ${USERNAME} for the rest of the Dockerfile.
        ...tools.dockerfileSteps,
        `
######################
# Claude Code CLI
######################

USER \${USERNAME}
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${version}`,
      ],
      mounts: [
        "source=claude-code-home,target=/home/node/.claude,type=volume",
        ...tools.mounts,
      ],
      extensions: ["Anthropic.claude-code"],
      envVars: {
        CLAUDE_CONFIG_DIR: "/home/node/.claude",
        ...tools.envVars,
      },
      postCreateSteps: tools.postCreateSteps,
      postStartSteps: [],
      features: {},
    };
  },
};
