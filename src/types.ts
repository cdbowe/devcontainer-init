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

/** Choices that shape the generated files but aren't discovered by scanning. */
export interface GenerationSettings {
  /** IANA timezone id baked into the container, e.g. "America/New_York". */
  timezone: string;
}

export const DEFAULT_SETTINGS: GenerationSettings = {
  timezone: "UTC",
};

export interface StackDetector {
  name: string;
  detect(rootPath: string): Promise<DetectedStack | null>;
}
