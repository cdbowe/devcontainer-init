# devcontainer-init

Scan a codebase and generate a `.devcontainer/` setup with the right SDKs, bind mounts, and setup scripts. No more copying Dockerfiles between projects.

## Quick Start

```bash
npx devcontainer-init
```

Or clone and run directly:

```bash
git clone https://github.com/cdbowe/devcontainer-init.git
cd devcontainer-init
npm install
npm run dev -- --path /path/to/your/project
```

## What It Does

1. Scans your project for marker files (`*.sln`, `package.json`, `Cargo.toml`, etc.)
2. Detects which SDKs and runtimes your project needs
3. Generates a complete `.devcontainer/` directory:

```
.devcontainer/
├── Dockerfile              # Debian base + detected SDK layers
├── devcontainer.json       # Workspace config, mounts, VS Code extensions
└── scripts/
    ├── post-create.sh      # One-time setup (dependency install)
    └── post-start.sh       # Per-session setup (git config)
```

## Supported Stacks

| Stack | Marker Files | SDK Installed | Version Detection |
|-------|-------------|---------------|-------------------|
| .NET | `*.sln`, `*.csproj` | dotnet-install.sh | `TargetFramework` in .csproj |
| Node.js | `package.json` | nodesource | `engines.node` in package.json |
| Python | `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile` | python3 + pip | — |
| Rust | `Cargo.toml` | rustup | — |
| Go | `go.mod` | golang | `go` directive in go.mod |
| Ruby | `Gemfile` | ruby-full | — |
| Java | `pom.xml`, `build.gradle`, `build.gradle.kts` | openjdk-21 | — |

Multiple stacks in the same project are supported (e.g., .NET backend + Node.js frontend).

## CLI Options

```
Usage: devcontainer-init [options]

Options:
  -p, --path <dir>          Path to the project root (default: ".")
  -n, --name <name>         Override the project name
  -t, --template <names...> Apply templates (e.g., --template claude-code)
  --timezone <tz>           IANA timezone for the container (default: detected from the host)
  --minimal                 Install only the minimal claude-code-tools set (settings + statusline)
                            instead of the full toolkit
  --dry-run                 Show what would be generated without writing files
  --force                   Overwrite existing .devcontainer directory, and replace the project
                            settings.local.json at post-create
  --no-interactive          Skip the wizard and use defaults
  -V, --version             Output the version number
  -h, --help                Display help
```

### Interactive Wizard

By default, `devcontainer-init` runs an interactive wizard that:
1. Shows detected stacks and lets you confirm
2. Prompts for project name
3. Prompts for the container timezone, preselecting the one detected from the host
4. Lets you select templates to apply (e.g., Claude Code)
5. Runs each selected template's own prompts (version pickers, integrations)
6. Shows a summary and asks for confirmation before writing files

Template prompts run *before* the final confirmation, so the summary reflects everything you chose and nothing is written until you confirm.

Use `--no-interactive` with `--template` for CI/scripted usage:

```bash
devcontainer-init --template claude-code --no-interactive
```

### Timezone

Containers no longer hard-code UTC. The wizard offers a dropdown showing each zone's
IANA name, its tzdata abbreviation, and its current UTC offset:

```
? Container timezone: (Use arrow keys)
❯ America/New_York (EDT, -04:00) — detected from /etc/localtime
  UTC (UTC, +00:00)
  America/Los_Angeles (PDT, -07:00)
  ...
  Pick from the full IANA list...
```

The shortlist covers the common offsets; `Pick from the full IANA list...` opens all
~420 zones, where you can type to jump (e.g. typing `Pacific/Chat` lands on
`Pacific/Chatham`).

**Host detection.** The default is guessed in order from `$TZ`, `/etc/timezone`, the
`/etc/localtime` symlink, and finally the JS runtime's resolved zone, falling back to
UTC. The selected line reports which source it came from. Note this reads the machine
`devcontainer-init` runs on — if you run it from inside a container, you'll see that
container's zone (usually UTC) rather than the Docker host's. Use `--timezone` to set
it explicitly:

```bash
devcontainer-init --timezone Asia/Kolkata --no-interactive
```

Abbreviations come from tzdata, so they're the real ones (`EDT`, `IST`, `CEST`) rather
than fixed-width labels. Zones that have no letter abbreviation use tzdata's numeric
form (`Asia/Dubai (+04, +04:00)`), and zones observing DST show their *current*
abbreviation and offset. On hosts without tzdata the abbreviation falls back to a
`UTC±HH:MM` label.

The choice lands in three places in the generated output:

- `ARG TZ=<zone>` in the `Dockerfile`, with `tzdata` installed and `/etc/localtime` +
  `/etc/timezone` configured so `date` and log timestamps are correct
- `build.args.TZ` in `devcontainer.json`, so you can change it and rebuild without
  editing the Dockerfile
- `remoteEnv.TZ`, so VS Code-spawned processes agree with the shell

## Templates

Templates layer additional tooling on top of the base devcontainer. Available templates:

| Template | What It Adds |
|----------|-------------|
| `claude-code` | Claude Code CLI (version picker), shared `claude-code-home` volume, VS Code extension, optional [claude-code-tools](https://github.com/cdbowe/claude-code-tools) install |

Use `--template` to apply directly, or select from the wizard's template picker.

### claude-code-tools Integration

The `claude-code` template can wire in a local [claude-code-tools](https://github.com/cdbowe/claude-code-tools) checkout so your `settings.json`, `settings.local.json`, and statusline work in the new container out of the box.

When enabled, the template adds:

- A **read-only bind mount** of your host checkout at `/opt/claude-code-tools`.
- **`python3`** in the image — the toolkit's `/prd` command set shells out to it. Only added when the checkout is wired in, so plain containers stay slim.
- A **`WORKTREE_MAIN_DIR` remoteEnv** entry, set to `${containerWorkspaceFolder}/main` — the location the toolkit's worktree scripts treat as the main checkout. Full toolkit only; `--minimal` doesn't ship those scripts. The scripts already default to the same path (`${WORKTREE_MAIN_DIR:-${WORKSPACE_DIR}/main}`), so this changes no behavior — it makes the location visible and editable in `devcontainer.json` instead of buried in a shell default.
- A **bind mount of `main/`** (`${localWorkspaceFolder}/main` → `${containerWorkspaceFolder}/main`), so the worktree main checkout lives on the host and survives container rebuilds, plus an **`initializeCommand`** that creates the host folder first. That ordering matters: `docker run --mount type=bind` fails on a missing source rather than creating it, and `initializeCommand` is the only hook that runs on the host before container creation.
- A **post-create step that creates and initializes that directory**: `mkdir -p`, then `git init` with an empty `initial commit` on `main`. It runs after the bind mounts are layered onto the workspace root and as `remoteUser`, so the directory is both visible and correctly owned. Editing `WORKTREE_MAIN_DIR` in `devcontainer.json` moves what gets created. The whole block is guarded on `$MAIN_DIR/.git` not existing, so rebuilds don't stack up extra commits.
- A **`.claude/` bind mount** at the workspace root, so project-scoped config is a real folder Claude Code picks up when run from the workspace.
- Two **post-create steps** that run the tools repo's own `install.sh`:
  - into `$CLAUDE_CONFIG_DIR` (the shared `claude-code-home` volume) — so the statusline resolves from any directory and persists across rebuilds;
  - into `$WORKSPACE_DIR/.claude` (with `--with-local`) — same, plus seeding `settings.local.json` from the checkout's copy when none exists.

Passing `--force` adds `install.sh --force` to that second step, so an existing `settings.local.json` is **replaced** with the checkout's copy instead of preserved. Note that this is baked into `post-create.sh`, which runs on every container *create* — including rebuilds — so a `--force`-generated setup re-seeds the project's `settings.local.json` from the checkout each time you rebuild, discarding local edits. Regenerate without `--force` once you're past the initial setup. The user-scope step doesn't pass `--force`, since `install.sh` only consults it alongside `--with-local`.

This behavior requires the `write_local` version of `install.sh` in `claude-code-tools`; older copies write an empty scaffold instead.

Both steps install the **full toolkit** by default (`--all`: `settings.json` + statusline, plus `agents/`, `commands/`, and `hooks/`). Pass `--minimal` to install only `settings.json` + statusline:

```bash
devcontainer-init --template claude-code --minimal
```

The install layout lives in `claude-code-tools` (its `install.sh` owns it); this template only mounts the checkout and invokes it. In the **interactive wizard** you're prompted for the checkout path (default: sibling `../claude-code-tools`). In **non-interactive** runs the integration is only added when a sibling `../claude-code-tools` exists, so scripted generation never emits a mount pointing at a missing folder.

Set `CLAUDE_CODE_TOOLS_DIR` to opt in explicitly and skip that check:

```bash
CLAUDE_CODE_TOOLS_DIR=../claude-code-tools devcontainer-init --template claude-code --no-interactive
```

#### Running devcontainer-init from inside a container

Mount paths are resolved **on the Docker host** when the generated project is opened, but the sibling-checkout probe runs against whatever filesystem `devcontainer-init` is executing on. If you run it from inside a devcontainer (including this repo's own, via `npm run dev`), the probe sees the container — so a checkout that exists on the host looks missing and the integration is skipped.

Prefer a **relative** path (`../claude-code-tools`): it's anchored to `${localWorkspaceFolder}` on the host at container-create time, so it's correct even when unverifiable locally. An **absolute** container path like `/workspaces/claude-code-tools` would be wrong on the host. Either answer the wizard prompt explicitly, or set `CLAUDE_CODE_TOOLS_DIR`.

Timezone detection has the same blind spot: from inside a container it reports the container's zone, not the host's. Pass `--timezone` or pick from the dropdown.

## How It Works

### Stack Detection

The scanner walks your project tree (up to 3 levels deep) looking for marker files. It skips known package/build directories (`node_modules`, `bin`, `obj`, `dist`, `vendor`, `target`, `__pycache__`, `.venv`, etc.) to keep scanning fast.

When version-specific markers exist (like `TargetFramework` in a `.csproj` or `engines.node` in `package.json`), those versions are used in the generated Dockerfile.

### Bind Mounts

The default VS Code workspace mount is disabled (`"workspaceMount": ""`). Instead, each root-level file and directory gets its own explicit bind mount entry in `devcontainer.json`, along with the `.devcontainer/` folder itself. This gives you precise control over what's shared between host and container, and makes it possible to add a `sync` command later that can detect drift between the two.

**Only explicitly mounted files and folders will be visible inside the container.** If you add new files or directories to your project after running `devcontainer-init`, you'll need to add corresponding mount entries to `devcontainer.json` (or re-run the tool with `--force`) for them to appear in the container.

Directories in the exclude list (`node_modules`, `.git`, `bin`, `obj`, etc.) are automatically omitted from mounts.

### Docker-in-Docker

If `Dockerfile`, `docker-compose.yml`, or `compose.yaml` is detected in your project, the `docker-outside-of-docker` devcontainer feature is automatically included.

## Pairing with Claude Code

This tool generates generic devcontainer setups, but it's designed to work well with [claude-code-devcontainer](https://github.com/cdbowe/claude-code-devcontainer) and [claude-code-tools](https://github.com/cdbowe/claude-code-tools). After generating your base devcontainer, you can layer in Claude Code components using the mount patterns from those repos.

## Roadmap

- [x] ~~Interactive wizard — project name, stack confirmation, template selection~~
- [x] ~~Template system — layer opinionated tooling on top of base generation~~
- [x] ~~Claude Code template — version picker, shared credential volume~~
- [ ] `devcontainer-init sync` — Compare host vs container file structure, report diffs, prompt before applying
- [ ] Monorepo workspace detection (npm/pnpm/yarn workspaces)
- [ ] Custom template loading from external repos/directories

### Planned Templates

| Template | What It Adds | Status |
|----------|-------------|--------|
| `claude-code` | Claude Code CLI, shared credential volume, VS Code extension | Implemented |
| `copilot-cli` | GitHub Copilot CLI | Planned |
| `codex` | OpenAI Codex CLI | Planned |
| `antigravity` | Google Antigravity CLI (successor to Gemini CLI) | Planned |
| `opencode` | OpenCode — open-source, model-agnostic coding agent | Planned |
| `ollama` | Ollama CLI harness pointed at a remote Ollama URL (default), with opt-in local runtime | Planned |
| `aider` | Aider AI pair programming CLI | Planned |
| `goose` | Goose — Linux Foundation backed, model-agnostic coding agent | Planned |

#### Ollama Template (Planned)

By default, the `ollama` template will install a CLI harness configured to talk to a remote Ollama instance via URL (e.g., a server on your home network or a cloud VM). This avoids the heavy RAM/CPU cost of running inference inside the devcontainer. Users can opt into bundling the full Ollama runtime locally if they have the resources:

```bash
# Default: CLI harness pointing to remote Ollama server
devcontainer-init --template ollama

# Opt-in: run Ollama runtime locally inside the container
devcontainer-init --template ollama --ollama-local
```

## License

MIT
