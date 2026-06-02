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
  -p, --path <dir>   Path to the project root (default: ".")
  -n, --name <name>  Override the project name
  --dry-run          Show what would be generated without writing files
  --force            Overwrite existing .devcontainer directory
  -V, --version      Output the version number
  -h, --help         Display help
```

## How It Works

### Stack Detection

The scanner walks your project tree (up to 3 levels deep) looking for marker files. It skips known package/build directories (`node_modules`, `bin`, `obj`, `dist`, `vendor`, `target`, `__pycache__`, `.venv`, etc.) to keep scanning fast.

When version-specific markers exist (like `TargetFramework` in a `.csproj` or `engines.node` in `package.json`), those versions are used in the generated Dockerfile.

### Bind Mounts

Each root-level file and directory gets its own bind mount entry in `devcontainer.json`. This gives you explicit control over what's shared between host and container, and makes it possible to add a `sync` command later that can detect drift between the two.

Directories in the exclude list (`node_modules`, `.git`, `bin`, `obj`, etc.) are automatically omitted from mounts.

### Docker-in-Docker

If `Dockerfile`, `docker-compose.yml`, or `compose.yaml` is detected in your project, the `docker-outside-of-docker` devcontainer feature is automatically included.

## Pairing with Claude Code

This tool generates generic devcontainer setups, but it's designed to work well with [claude-code-devcontainer](https://github.com/cdbowe/claude-code-devcontainer) and [claude-code-tools](https://github.com/cdbowe/claude-code-tools). After generating your base devcontainer, you can layer in Claude Code components using the mount patterns from those repos.

## Roadmap

- [ ] `devcontainer-init sync` — Compare host vs container file structure, report diffs, prompt before applying
- [ ] Interactive mode — prompt for project name, timezone, additional features
- [ ] Template system — layer opinionated tooling on top of base generation (see below)
- [ ] Monorepo workspace detection (npm/pnpm/yarn workspaces)

### Template System (NOT IMPLEMENTED, PLANNED)

The base `devcontainer-init` output is intentionally generic — it detects your project's tech stack and nothing more. A template system would let users layer additional tooling on top without bloating the core generator.

```bash
# Generate base devcontainer + apply a template
devcontainer-init --template claude-code

# Apply a template to an existing devcontainer
devcontainer-init apply-template claude-code
```

Templates would add Dockerfile steps, mounts, VS Code extensions, and setup scripts for a specific developer workflow. Examples:

| Template | What It Adds |
|----------|-------------|
| `claude-code` | Claude Code CLI, MCP server setup, component mounts |
| `copilot-cli` | GitHub Copilot CLI |
| `codex` | OpenAI Codex CLI |
| `antigravity` | Google Antigravity CLI (successor to Gemini CLI) |
| `opencode` | OpenCode — open-source, model-agnostic coding agent |
| `ollama` | Ollama CLI harness pointed at a remote Ollama URL (default), with opt-in local runtime |
| `aider` | Aider AI pair programming CLI |
| `goose` | Goose — Linux Foundation backed, model-agnostic coding agent |

Templates could be built-in or loaded from external repos/directories, keeping the core tool focused on project detection while supporting opinionated setups as opt-in layers.

#### Ollama Template

By default, the `ollama` template installs a CLI harness configured to talk to a remote Ollama instance via URL (e.g., a server on your home network or a cloud VM). This avoids the heavy RAM/CPU cost of running inference inside the devcontainer. Users can opt into bundling the full Ollama runtime locally if they have the resources:

```bash
# Default: CLI harness pointing to remote Ollama server
devcontainer-init --template ollama

# Opt-in: run Ollama runtime locally inside the container
devcontainer-init --template ollama --ollama-local
```

## License

MIT
