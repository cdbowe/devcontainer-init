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
npm run dev -- /path/to/your/project
```

## What It Does

1. Scans your project for marker files (`*.sln`, `package.json`, `Cargo.toml`, etc.)
2. Detects which SDKs and runtimes your project needs
3. Generates a complete `.devcontainer/` directory:

```
.devcontainer/
├── Dockerfile              # Debian base + detected SDK layers
├── devcontainer.json       # Workspace config, mounts, VS Code extensions
├── .env.example            # Only with --github-mcp: PAT template
└── scripts/
    ├── post-create.sh      # One-time setup (dependency install)
    └── post-start.sh       # Per-session setup (git config, MCP registration)
```

## Supported Stacks

| Stack | Marker Files | SDK Installed | Version Detection |
|-------|-------------|---------------|-------------------|
| .NET | `*.sln`, `*.csproj` | dotnet-install.sh | `TargetFramework` in .csproj |
| Node.js | `package.json` | nodesource | `engines.node` in package.json |
| Python | `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile` | python3 + pip | — |
| Rust | `Cargo.toml` | rustup | — |
| Go (Golang) | `go.mod` | go.dev tarball (multi-arch) | `go` directive in go.mod |
| Ruby | `Gemfile` | ruby-full | — |
| Java | `pom.xml`, `build.gradle`, `build.gradle.kts` | openjdk-21 | — |

Multiple stacks in the same project are supported (e.g., .NET backend + Node.js frontend).

## CLI Options

```
Usage: devcontainer-init [options] [path]

Arguments:
  path                      Path to the project root (default: current directory)

Options:
  -n, --name <name>         Override the project name
  -t, --template <names...> Apply templates (e.g., --template claude-code)
  --timezone <tz>           IANA timezone for the container (default: detected from the host)
  --isolated                Disable the default workspace mount and bind each root entry
                            individually, keeping .git on the host (the previous default)
  --docker-feature <mode>   Install a Docker feature: none (default), outside
                            (docker-outside-of-docker: host daemon) or inside (docker-in-docker)
  --minimal                 Install only the minimal claude-code-tools set (settings + statusline)
                            instead of the full toolkit (--isolated only)
  --github-mcp              With the claude-code template: register GitHub's read-only MCP
                            server at container start, PAT from .devcontainer/.env
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
4. Prompts for the workspace mount: bind the whole folder (default) or isolated — see [Workspace Mount](#workspace-mount)
5. Prompts for Docker support: none (default), docker-outside-of-docker or docker-in-docker — see [Docker](#docker)
6. Lets you select templates to apply (e.g., Claude Code)
7. Runs each selected template's own prompts (version pickers, integrations)
8. Shows a summary and asks for confirmation before writing files

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
| `claude-code` | Claude Code CLI (version picker), shared `claude-code-home` volume, VS Code extension, optional read-only [GitHub MCP server](#github-mcp-server), optional [claude-code-tools](https://github.com/cdbowe/claude-code-tools) install (`--isolated` only) |

Use `--template` to apply directly, or select from the wizard's template picker.

### GitHub MCP Server

The `claude-code` template can register GitHub's hosted MCP server with Claude Code, **read-only** and limited to the `pull_requests` and `repos` toolsets, so Claude can read real history and PR review comments without `gh` or `git push` being reachable. Opt in with `--github-mcp` or answer the wizard prompt.

When enabled, the template adds:

- **`.devcontainer/.env.example`** (committed) describing the PAT to create. Copy it to `.devcontainer/.env` and fill in `GITHUB_PAT=`. Preferred: a fine-grained PAT scoped to the one repo with Metadata, Contents and Pull requests read access.
- **`.devcontainer/.env`** appended to the project `.gitignore`.
- A **post-start step** that reads the PAT and runs `claude mcp add-json github -s local`. It runs on every container start, so rotating the PAT is "edit `.env`, restart". Without a PAT it prints a notice and skips; it never fails startup.

Local scope matters: the `claude-code-home` volume is shared by every container generated with this template, and a user-scope entry would leak one repo's PAT into all of them.

Note for Claude itself: a `Read(**/.env*)` deny rule in `settings.json` also blocks reading `.env.example`. That is intended; the generator writes the file, not Claude.

### claude-code-tools Integration (`--isolated` only)

In **isolated** mode the `claude-code` template can wire in a local [claude-code-tools](https://github.com/cdbowe/claude-code-tools) checkout so your `settings.json`, `settings.local.json`, and statusline work in the new container out of the box. In the default **bind** mode this integration is skipped entirely: `.claude/` is plain committed repo content, `mounts` holds only named volumes, and the toolkit's worktree scripts assume the isolated `main/` layout anyway. Copy the components a repo needs into its `.claude/` instead.

When enabled, the template adds:

- A **read-only bind mount** of your host checkout at `/opt/claude-code-tools`.
- **`python3`** in the image — the toolkit's `/prd` command set shells out to it. Only added when the checkout is wired in, so plain containers stay slim.
- A **`WORKTREE_MAIN_DIR` remoteEnv** entry, set to `${containerWorkspaceFolder}/main` — the location the toolkit's worktree scripts treat as the main checkout. Full toolkit only; `--minimal` doesn't ship those scripts. The scripts already default to the same path (`${WORKTREE_MAIN_DIR:-${WORKSPACE_DIR}/main}`), so this changes no behavior — it makes the location visible and editable in `devcontainer.json` instead of buried in a shell default.
- A **bind mount of `main/`** (`${localWorkspaceFolder}/main` → `${containerWorkspaceFolder}/main`), so the worktree main checkout lives on the host and survives container rebuilds. The folder is declared as a `hostDir`, so it's created on the host before the mount is resolved — see [Workspace Mount](#workspace-mount).
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

### Workspace Mount

| | `bind` (default) | `--isolated` |
|---|---|---|
| `workspaceMount` | Omitted: Dev Containers binds the whole host folder to `/workspaces/<name>` (spelled out only when `--name` differs from the folder name) | `""` |
| What the container sees | Everything, including the real `.git` | Only explicitly mounted root entries; `.git` stays on the host |
| `mounts` array | Named volumes only (e.g. `claude-code-home`) | `.devcontainer/`, `claude_files/`, one bind per root entry, plus template binds |
| `initializeCommand` | None | Creates bind sources on the host |
| New files after generation | Just appear | Need a new mount entry (or re-run with `--force`) |
| Git identity / history | Host's, via the mounted repo and VS Code's forwarded `.gitconfig` | Container-local sandbox repo (claude-code template) |
| `.gitignore` additions | `claude_files/`, `.claude/settings.local.json`, `.claude/worktrees/` (claude-code template), `.devcontainer/.env` (`--github-mcp`) | Only `.devcontainer/.env` (`--github-mcp`) |

**Bind mode** is the simple one: the container works on the same checkout the host does, so Claude Code reads real history, Claude Code's built-in worktrees (`.claude/worktrees/`) work, and there is no host-path plumbing to maintain. Guard against unwanted git writes with a project `settings.json` deny list rather than by hiding the repo.

**Isolated mode** is the previous default, kept as an opt-in for the cases that need it. Each root-level file and directory gets its own explicit bind mount entry in `devcontainer.json`, along with the `.devcontainer/` folder itself. **Only explicitly mounted files and folders are visible inside the container.** Directories in the exclude list (`node_modules`, `.git`, `bin`, `obj`, etc.) are automatically omitted.

Both modes create a **`claude_files/`** scratch/handoff folder at the project root. In isolated mode it is bound into the container individually; in bind mode it is just a gitignored folder in the workspace.

In isolated mode, bind-mount sources have to exist before the container is created — `docker run --mount type=bind` fails on a missing source rather than creating it. Host folders the generated config needs (`claude_files/`, plus `main/` from the `claude-code` template) are therefore created twice over:

- **At generation time**, by `devcontainer-init` itself.
- **At container-create time**, by the generated **`initializeCommand`** — the only hook that runs on the host before creation — which covers fresh clones and folders deleted later.

`initializeCommand` runs in the host's own shell: `cmd.exe /c` on Windows, `sh -c` elsewhere. So it can't use `mkdir -p` (cmd.exe reads `-p` as another folder to create, then rejects the path). Instead each folder gets `(mkdir "<absolute>" || mkdir <relative> || cd .)`: the absolute form is right whatever the shell's cwd is, the relative retry covers cmd.exe rejecting the `/` the absolute path is joined with, and `cd .` is the only no-op that succeeds in both shells (`|| true` fails on cmd.exe, where `true` isn't a builtin). A side effect worth knowing: once the folders exist, every container create logs a harmless `already exists` / `File exists` line per folder. Suppressing it would need `2>/dev/null` or `2>nul`, and neither is portable.

Templates declare these folders as `hostDirs` rather than writing their own `mkdir`.

### Docker

Nothing Docker-related is installed unless you ask. Pick one of three with `--docker-feature` or the wizard prompt (which preselects `outside` when a `Dockerfile` or compose file is detected in the project):

| Mode | Feature | What you get |
|------|---------|--------------|
| `none` (default) | — | No docker CLI in the container |
| `outside` | `docker-outside-of-docker:1` | docker CLI talking to the **host** daemon. Containers it starts are siblings, visible on the host. No privileged mode |
| `inside` | `docker-in-docker:2` | A full daemon **inside** the container. Isolated from the host's Docker, but runs privileged and keeps its own image cache |

The two features both claim `/var/run/docker.sock`, so they are mutually exclusive. The feature handles the socket mount and permissions itself; the generated config no longer binds `/var/run/docker.sock` by hand.

### Gotchas on a Windows host (bind mode)

| Issue | Fix |
|-------|-----|
| Every file shows modified inside the container after a rebuild | Host has `core.autocrlf=true`, container unset. In the container: `git config core.autocrlf true` (repo-level, shared with host) then `git update-index -q --refresh`. Don't set `false` |
| `.sh` checked out with CRLF → `$'\r': command not found` | Add `*.sh text eol=lf` to `.gitattributes` |
| Executable bit lost | `chmod` may be ineffective on the bind mount; the generated commands already use `bash <script>` |
| Slow `git status` | Bind-mount I/O; the first run rehashes the whole index |

## Pairing with Claude Code

This tool generates generic devcontainer setups, but it's designed to work well with [claude-code-devcontainer](https://github.com/cdbowe/claude-code-devcontainer) and [claude-code-tools](https://github.com/cdbowe/claude-code-tools). In bind mode, commit the `.claude/` components a repo needs directly; in isolated mode, layer them in using the mount patterns from those repos.

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
