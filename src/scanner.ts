import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { Dirent } from "node:fs";
import type { RootEntry, ScanResult, DetectedStack, StackDetector } from "./types.js";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "bin",
  "obj",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  ".gradle",
  ".mvn",
  "coverage",
  ".terraform",
  ".angular",
]);

const MAX_DEPTH = 3;

async function findMarkerFiles(
  dir: string,
  patterns: string[],
  depth = 0
): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];

  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.isFile() && patterns.some((p) => matchPattern(entry.name, p))) {
      found.push(join(dir, entry.name));
    }
    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name) && depth < MAX_DEPTH) {
      const nested = await findMarkerFiles(join(dir, entry.name), patterns, depth + 1);
      found.push(...nested);
    }
  }
  return found;
}

function matchPattern(filename: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern;
}

async function tryReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const detectors: StackDetector[] = [
  {
    name: "dotnet",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, ["*.sln", "*.csproj"]);
      if (markers.length === 0) return null;

      let version = "8.0";
      for (const m of markers) {
        if (m.endsWith(".csproj")) {
          try {
            const content = await readFile(m, "utf-8");
            const match = content.match(/<TargetFramework>net(\d+\.\d+)/);
            if (match) {
              version = match[1];
              break;
            }
          } catch { /* skip */ }
        }
      }

      return {
        name: "dotnet",
        sdk: `dotnet/sdk:${version}`,
        version,
        markerFile: markers[0],
        extensions: ["ms-dotnettools.csharp"],
        postCreateSteps: ["dotnet restore"],
      };
    },
  },
  {
    name: "node",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, ["package.json"]);
      if (markers.length === 0) return null;

      let version = "20";
      const pkg = await tryReadJson(markers[0]);
      if (pkg?.engines && typeof pkg.engines === "object") {
        const engines = pkg.engines as Record<string, string>;
        if (engines.node) {
          const match = engines.node.match(/(\d+)/);
          if (match) version = match[1];
        }
      }

      const hasTypescript = await findMarkerFiles(rootPath, ["tsconfig.json"]);
      const extensions = ["dbaeumer.vscode-eslint"];
      if (hasTypescript.length > 0) extensions.push("ms-vscode.vscode-typescript-next");

      return {
        name: "node",
        sdk: `node:${version}`,
        version,
        markerFile: markers[0],
        extensions,
        postCreateSteps: ["npm install"],
      };
    },
  },
  {
    name: "python",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, [
        "requirements.txt",
        "pyproject.toml",
        "setup.py",
        "Pipfile",
      ]);
      if (markers.length === 0) return null;

      const hasPyproject = markers.some((m) => m.endsWith("pyproject.toml"));

      return {
        name: "python",
        sdk: "python:3",
        markerFile: markers[0],
        extensions: ["ms-python.python"],
        postCreateSteps: hasPyproject
          ? ["pip install -e ."]
          : ["pip install -r requirements.txt"],
      };
    },
  },
  {
    name: "rust",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, ["Cargo.toml"]);
      if (markers.length === 0) return null;

      return {
        name: "rust",
        sdk: "rust",
        markerFile: markers[0],
        extensions: ["rust-lang.rust-analyzer"],
        postCreateSteps: ["cargo build"],
      };
    },
  },
  {
    name: "go",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, ["go.mod"]);
      if (markers.length === 0) return null;

      let version = "1.22";
      try {
        const content = await readFile(markers[0], "utf-8");
        const match = content.match(/^go\s+(\d+\.\d+)/m);
        if (match) version = match[1];
      } catch { /* skip */ }

      return {
        name: "go",
        sdk: `go:${version}`,
        version,
        markerFile: markers[0],
        extensions: ["golang.go"],
        postCreateSteps: ["go mod download"],
      };
    },
  },
  {
    name: "ruby",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, ["Gemfile"]);
      if (markers.length === 0) return null;

      return {
        name: "ruby",
        sdk: "ruby:3",
        markerFile: markers[0],
        extensions: ["shopify.ruby-lsp"],
        postCreateSteps: ["bundle install"],
      };
    },
  },
  {
    name: "java",
    async detect(rootPath) {
      const markers = await findMarkerFiles(rootPath, [
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
      ]);
      if (markers.length === 0) return null;

      const isGradle = markers.some(
        (m) => m.endsWith(".gradle") || m.endsWith(".gradle.kts")
      );

      return {
        name: "java",
        sdk: "java:21",
        markerFile: markers[0],
        extensions: ["vscjava.vscode-java-pack"],
        postCreateSteps: isGradle ? ["./gradlew build"] : ["mvn install"],
      };
    },
  },
];

export async function scanProject(rootPath: string): Promise<ScanResult> {
  const entries = await readdir(rootPath, { withFileTypes: true }) as unknown as Dirent[];
  const projectName = basename(rootPath);

  const rootEntries: RootEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;

    rootEntries.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      relativePath: entry.name,
    });
  }

  const stacks: DetectedStack[] = [];
  for (const detector of detectors) {
    const result = await detector.detect(rootPath);
    if (result) stacks.push(result);
  }

  const hasDocker = entries.some(
    (e) =>
      e.name === "Dockerfile" ||
      e.name === "docker-compose.yml" ||
      e.name === "docker-compose.yaml" ||
      e.name === "compose.yml" ||
      e.name === "compose.yaml"
  );

  const hasGit = entries.some((e) => e.name === ".git");

  return { rootPath, projectName, stacks, rootEntries, hasDocker, hasGit };
}
