import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import type { WorkspaceMode } from "../types.js";
import type {
  GeneratedFile,
  Template,
  TemplateAdditions,
  TemplateConfigureOptions,
} from "./types.js";

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
export const DEFAULT_TOOLS_REPO = "https://github.com/cdbowe/claude-code-tools.git";

// The toolkit's /prd command set shells out to python3 for the topological sort
// and wave splitting in prd-plan.sh and prd-unblock-compile.sh. Not present on
// debian:*-slim. Scoped to the tools integration rather than the base package
// list so containers generated without the toolkit stay slim.
const TOOLS_PYTHON_STEP = `
######################
# claude-code-tools runtime deps
######################

RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 \\
  && apt-get clean && rm -rf /var/lib/apt/lists/*`;

interface ToolsIntegration {
  dockerfileSteps: string[];
  mounts: string[];
  envVars: Record<string, string>;
  hostDirs: string[];
  postCreateSteps: string[];
  gitignoreEntries: string[];
}

/**
 * Bind-mode toolkit install. Nothing can be bind-mounted, so post-create
 * shallow-clones the toolkit into a temp dir, runs its own install.sh, and
 * deletes the clone. install.sh copies (cp -R), so nothing links back to it.
 *
 * Scopes differ from isolated mode on purpose:
 * - User scope (the shared claude-code-home volume) gets the minimal set —
 *   settings + statusline — on every create. Copying commands/ there too would
 *   shadow each repo's own project-level commands in every container.
 * - Project scope (the real repo's .claude/) gets the full toolkit unless
 *   --minimal, but only while `.claude/settings.json` doesn't exist. After the
 *   first copy it's committed repo content, and a rebuild must not overwrite
 *   tracked files. --force drops that guard and re-copies on every create.
 */
async function configureToolsCopy(
  interactive: boolean,
  minimalTools: boolean,
  forceTools: boolean,
  toolsRepo: string | undefined
): Promise<ToolsIntegration> {
  // Claude Code itself writes both of these into the real repo's .claude/;
  // neither belongs in version control, toolkit or not.
  const gitignoreEntries = [".claude/settings.local.json", ".claude/worktrees/"];

  let repo = toolsRepo;
  if (repo === undefined && interactive) {
    const { enable } = await inquirer.prompt<{ enable: boolean }>([
      {
        type: "confirm",
        name: "enable",
        message:
          "Copy claude-code-tools into the container (cloned from GitHub at container create)?",
        default: false,
      },
    ]);
    if (enable) {
      const { url } = await inquirer.prompt<{ url: string }>([
        {
          type: "input",
          name: "url",
          message: "claude-code-tools git URL:",
          default: DEFAULT_TOOLS_REPO,
        },
      ]);
      repo = url.trim() || DEFAULT_TOOLS_REPO;
    }
  }

  const none: ToolsIntegration = {
    dockerfileSteps: [],
    mounts: [],
    envVars: {},
    hostDirs: [],
    postCreateSteps: [],
    gitignoreEntries,
  };
  if (repo === undefined) return none;

  // Embedded in a double-quoted bash string below; refuse anything that could
  // break out of it rather than trying to escape it.
  if (!/^[^\s"'`$\\]+$/.test(repo)) {
    console.log(chalk.red(`Invalid claude-code-tools repo URL: ${repo}`));
    process.exit(1);
  }

  const projectModeFlag = minimalTools ? "--minimal" : "--all";
  const projectFlags = forceTools ? "--with-local --force" : "--with-local";
  const projectInstall = `bash "$CCT_SRC/install.sh" ${projectModeFlag} --dir "\${WORKSPACE_DIR}/.claude" ${projectFlags}`;

  const projectStep = forceTools
    ? `  # --force: re-copy over the committed project .claude/ on every create.
  ${projectInstall}`
    : `  # Seed once. After that .claude/ is committed repo content; a rebuild must
  # not overwrite tracked files. Regenerate with --force to re-copy every create.
  if [ ! -e "\${WORKSPACE_DIR}/.claude/settings.json" ]; then
    ${projectInstall}
  else
    echo "  .claude/settings.json exists; leaving the project's committed .claude/ alone."
  fi`;

  return {
    dockerfileSteps: minimalTools ? [] : [TOOLS_PYTHON_STEP],
    mounts: [],
    envVars: {},
    hostDirs: [],
    gitignoreEntries,
    postCreateSteps: [
      `# claude-code-tools: clone, install, discard the clone.
CCT_SRC="$(mktemp -d)"
if git clone -q --depth 1 "${repo}" "$CCT_SRC"; then
  # User scope: settings + statusline only, so no commands shadow the repo's own.
  bash "$CCT_SRC/install.sh" --minimal --dir "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
${projectStep}
else
  echo "  WARNING: could not clone ${repo}; skipping claude-code-tools install."
fi
rm -rf "$CCT_SRC"`,
    ],
  };
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
 *
 * Isolated mode binds the checkout read-only, plus `.claude/` and a
 * host-backed `main/` folder that post-create turns into a sandbox git repo —
 * the toolkit's worktree scripts expect that layout.
 *
 * Bind mode can't bind anything (the mounts array is reserved for named
 * volumes), so it clones the toolkit instead: see configureToolsCopy.
 */
async function configureToolsIntegration(
  interactive: boolean,
  projectPath: string,
  workspaceMode: WorkspaceMode,
  minimalTools: boolean,
  forceTools: boolean,
  toolsRepo: string | undefined
): Promise<ToolsIntegration> {
  const empty: ToolsIntegration = {
    dockerfileSteps: [],
    mounts: [],
    envVars: {},
    hostDirs: [],
    postCreateSteps: [],
    gitignoreEntries: [],
  };

  // Bind mode: the only mounts are named volumes, and `.claude/` is plain
  // committed repo content — nothing is linked or installed from a host
  // checkout. The toolkit's worktree scripts also assume the isolated layout.
  if (workspaceMode === "bind") {
    return configureToolsCopy(interactive, minimalTools, forceTools, toolsRepo);
  }

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

  // The sandbox `main/` repo needs the full toolkit: --minimal doesn't ship
  // the worktree scripts that use it.
  const sandboxMain = !minimalTools;

  const modeFlag = minimalTools ? "--minimal" : "--all";
  // --force only has meaning alongside --with-local: install.sh consults it
  // solely when deciding whether to replace an existing settings.local.json.
  // Adding it to the user-scope step would be a no-op that reads as one.
  const localFlags = forceTools ? "--with-local --force" : "--with-local";

  return {
    dockerfileSteps: [TOOLS_PYTHON_STEP],
    mounts: [
      `source=${mountSource},target=${CONTAINER_TOOLS_DIR},type=bind,readonly`,
      // Surface project-scoped config as a real .claude/ at the workspace root.
      "source=${localWorkspaceFolder}/.claude,target=${containerWorkspaceFolder}/.claude,type=bind,consistency=cached",
      // Back the worktree main checkout with a host folder, so the repo the
      // post-create step initializes survives container rebuilds and is
      // editable from the host. Paired with the initializeCommand below.
      ...(sandboxMain
        ? [
            "source=${localWorkspaceFolder}/main,target=${containerWorkspaceFolder}/main,type=bind,consistency=cached",
          ]
        : []),
    ],
    // Created on the host before the container is created. `docker run --mount
    // type=bind` errors on a missing source rather than creating it, so
    // without this the main/ mount above breaks startup on a fresh clone.
    hostDirs: sandboxMain ? ["main"] : [],
    // Only the full toolkit ships the worktree scripts that read this. Their
    // own default is "${WORKTREE_MAIN_DIR:-${WORKSPACE_DIR}/main}", so this
    // sets the same value explicitly — it makes the location visible and
    // editable in devcontainer.json rather than buried in a shell default.
    //
    // Uses ${containerWorkspaceFolder} rather than ${WORKSPACE_DIR}: remoteEnv
    // values can't reference another remoteEnv key, and WORKSPACE_DIR is only
    // a Dockerfile ARG, so it isn't in containerEnv either. Both resolve to
    // /workspaces/<project>.
    envVars: sandboxMain
      ? { WORKTREE_MAIN_DIR: "${containerWorkspaceFolder}/main" }
      : {},
    gitignoreEntries: [],
    postCreateSteps: [
      // Create and initialize the worktree main dir here rather than in the
      // Dockerfile: this runs after the bind mounts are layered onto the
      // workspace root, so the directory is guaranteed visible, and it runs as
      // remoteUser, so it ends up owned by the right user without a chown.
      // Repeats the scripts' own fallback so an edited WORKTREE_MAIN_DIR in
      // devcontainer.json is honored.
      ...(!sandboxMain
        ? []
        : [
            `MAIN_DIR="\${WORKTREE_MAIN_DIR:-\${WORKSPACE_DIR}/main}"
mkdir -p "$MAIN_DIR"
# Must precede init to have any effect on the initial branch name.
git config --global init.defaultBranch main
if [ ! -e "$MAIN_DIR/.git" ]; then
  git -C "$MAIN_DIR" init -q
  # Dev Containers normally copies the host ~/.gitconfig in, but not always
  # (headless \`devcontainer up\`, or the feature turned off). Without an
  # identity the commit below fails, and set -e would abort the rest of
  # post-create — including the install.sh steps.
  if ! git -C "$MAIN_DIR" var GIT_AUTHOR_IDENT >/dev/null 2>&1; then
    git -C "$MAIN_DIR" config user.name "devcontainer"
    git -C "$MAIN_DIR" config user.email "devcontainer@localhost"
  fi
  git -C "$MAIN_DIR" commit -q --allow-empty -m "initial commit"
  # Redundant on git >= 2.28 given init.defaultBranch above; kept for older git,
  # and guarded so it can't fail the script when the branch is already main.
  if git -C "$MAIN_DIR" show-ref -q --verify refs/heads/master; then
    git -C "$MAIN_DIR" branch -m master main
  fi
fi`,
          ]),
      // User scope (shared volume = $CLAUDE_CONFIG_DIR): settings + statusline,
      // so the statusline works from any directory and persists across rebuilds.
      `if [ -x ${CONTAINER_TOOLS_DIR}/install.sh ]; then bash ${CONTAINER_TOOLS_DIR}/install.sh ${modeFlag} --dir "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi`,
      // Project scope (workspace .claude/): same, plus seed settings.local.json.
      `if [ -x ${CONTAINER_TOOLS_DIR}/install.sh ]; then bash ${CONTAINER_TOOLS_DIR}/install.sh ${modeFlag} --dir "\${WORKSPACE_DIR}/.claude" ${localFlags}; fi`,
    ],
  };
}


const ENV_FILE = ".devcontainer/.env";
const ENV_EXAMPLE_FILE = ".devcontainer/.env.example";

interface GithubMcpIntegration {
  postStartSteps: string[];
  files: GeneratedFile[];
  gitignoreEntries: string[];
}

/**
 * Optionally register GitHub's hosted MCP server with Claude Code, read-only
 * and scoped to pull requests + repos, so Claude can read real history and PR
 * review comments without `gh` or `git push` being reachable.
 *
 * The PAT is read from a gitignored `.devcontainer/.env` at every container
 * start, so rotating it is "edit the file, restart". Registration is at local
 * scope: the `claude-code-home` volume is shared across devcontainers, and a
 * user-scope entry would leak one repo's PAT into every other container.
 */
async function configureGithubMcp(
  interactive: boolean,
  githubMcpFlag: boolean
): Promise<GithubMcpIntegration> {
  const empty: GithubMcpIntegration = {
    postStartSteps: [],
    files: [],
    gitignoreEntries: [],
  };

  let enable = githubMcpFlag;
  if (!enable && interactive) {
    ({ enable } = await inquirer.prompt<{ enable: boolean }>([
      {
        type: "confirm",
        name: "enable",
        message:
          "Register the GitHub MCP server (read-only) with Claude Code? Needs a PAT in .devcontainer/.env",
        default: false,
      },
    ]));
  }
  if (!enable) return empty;

  return {
    postStartSteps: [GITHUB_MCP_POST_START_STEP],
    files: [{ path: ENV_EXAMPLE_FILE, content: ENV_EXAMPLE_CONTENT }],
    gitignoreEntries: [ENV_FILE],
  };
}

const ENV_EXAMPLE_CONTENT = `# Copy to ${ENV_FILE} (gitignored). Read by post-start.sh to register the
# read-only GitHub MCP server with Claude Code.
#
# Preferred: fine-grained PAT, resource owner = the repo's org/user, repository
# access = this repo only.
#   Permissions: Metadata Read | Contents Read | Pull requests Read
# Fallback (org disallows fine-grained PATs): classic PAT, scope \`repo\` only
# (+ \`read:org\` if org lookups fail). Short expiration. If the org uses SAML
# SSO: token > Configure SSO > Authorize.
GITHUB_PAT=
`;

// Runs from post-start.sh under `set -e`: every failure path is a warning,
// never an abort, so a missing PAT can't take the rest of startup down.
// Single-quoted bash strings: the tr argument strips CR (Windows editors),
// both quote styles and spaces from the value.
const GITHUB_MCP_POST_START_STEP = `# GitHub MCP server (read-only)
register_github_mcp() {
  local env_file="\${WORKSPACE_DIR}/${ENV_FILE}"
  local pat=""

  if [ -f "$env_file" ]; then
    pat="$(grep -E '^GITHUB_PAT=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '\\r"'"'"' ')"
  fi
  if [ -z "$pat" ]; then
    echo "  GITHUB_PAT not set in $env_file (copy ${ENV_EXAMPLE_FILE}). Skipping GitHub MCP."
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
    cd "\${WORKSPACE_DIR}"
    claude mcp remove github -s local >/dev/null 2>&1 || true
    claude mcp add-json github -s local "$config" >/dev/null
  ); then
    echo "  GitHub MCP server registered (read-only: pull_requests, repos)."
  else
    echo "  WARNING: 'claude mcp add-json github' failed. Check the PAT in $env_file."
  fi
}
register_github_mcp`;

export const claudeCodeTemplate: Template = {
  name: "claude-code",
  description: "Claude Code CLI with shared credential volume",

  async configure({
    interactive,
    projectPath,
    workspaceMode,
    minimalTools = false,
    forceTools = false,
    githubMcp = false,
    toolsRepo,
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
      workspaceMode,
      minimalTools,
      forceTools,
      toolsRepo
    );
    if (tools.postCreateSteps.length > 0) {
      console.log(
        chalk.green(
          `  Wiring in claude-code-tools install step (${minimalTools ? "minimal: settings + statusline" : "full toolkit: + agents, commands, hooks"}${workspaceMode === "bind" ? "; cloned at container create" : ""})`
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

    const mcp = await configureGithubMcp(interactive, githubMcp);
    if (mcp.postStartSteps.length > 0) {
      console.log(
        chalk.green(
          `  Wiring in GitHub MCP registration (read-only; PAT from ${ENV_FILE})\n`
        )
      );
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
      hostDirs: tools.hostDirs,
      initializeCommands: [],
      postCreateSteps: tools.postCreateSteps,
      postStartSteps: mcp.postStartSteps,
      features: {},
      files: mcp.files,
      gitignoreEntries: [...tools.gitignoreEntries, ...mcp.gitignoreEntries],
    };
  },
};
