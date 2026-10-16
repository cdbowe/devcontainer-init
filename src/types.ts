export interface DetectedStack {
  name: string;
  sdk: string;
  version?: string;
  markerFile?: string;
  extensions: string[];
  postCreateSteps: string[];
}

export interface ScanResult {
  rootPath: string;
  projectName: string;
  stacks: DetectedStack[];
  rootEntries: RootEntry[];
  hasDocker: boolean;
  hasGit: boolean;
}

export interface RootEntry {
  name: string;
  type: "file" | "directory";
  relativePath: string;
}

export interface GeneratorOptions {
  path: string;
  name?: string;
  dryRun: boolean;
  force: boolean;
}

/**
 * How the project reaches the container.
 *
 * - `bind` (default): Dev Containers' own workspace mount — the whole host
 *   folder, `.git` included, at `/workspaces/<name>`. Nothing is hidden from
 *   the container and nothing has to be re-declared when files are added.
 * - `isolated`: the previous default. `workspaceMount` is disabled and each
 *   root entry gets its own bind, so `.git` and anything unlisted stay on the
 *   host. The claude-code template adds a container-local sandbox repo under
 *   `main/` in this mode.
 */
export type WorkspaceMode = "bind" | "isolated";

/**
 * Which Dev Containers Docker feature to install, if any. Mutually exclusive:
 * both features claim /var/run/docker.sock.
 *
 * - `none`: no docker CLI in the container.
 * - `outside`: docker-outside-of-docker — docker CLI talking to the HOST
 *   daemon over its socket. Containers it starts are siblings, visible on the
 *   host; needs no privileged mode.
 * - `inside`: docker-in-docker — a full daemon inside the container. Fully
 *   isolated from the host's Docker, but runs privileged and keeps its own
 *   image cache.
 */
export type DockerFeature = "none" | "outside" | "inside";

/** Choices that shape the generated files but aren't discovered by scanning. */
export interface GenerationSettings {
  /** IANA timezone id baked into the container, e.g. "America/New_York". */
  timezone: string;
  workspaceMode: WorkspaceMode;
  dockerFeature: DockerFeature;
}

export const DEFAULT_SETTINGS: GenerationSettings = {
  timezone: "UTC",
  workspaceMode: "bind",
  dockerFeature: "none",
};

export interface StackDetector {
  name: string;
  detect(rootPath: string): Promise<DetectedStack | null>;
}
