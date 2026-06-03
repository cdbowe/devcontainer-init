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

export interface StackDetector {
  name: string;
  detect(rootPath: string): Promise<DetectedStack | null>;
}
