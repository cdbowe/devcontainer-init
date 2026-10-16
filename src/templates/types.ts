import type { WorkspaceMode } from "../types.js";

export interface TemplateAdditions {
  dockerfileSteps: string[];
  mounts: string[];
  extensions: string[];
  envVars: Record<string, string>;
  /**
   * Workspace-relative folders a template's bind mounts need on the HOST, e.g.
   * `main`. `docker run --mount type=bind` fails outright on a missing source
   * rather than creating it, so these are created at generation time and again
   * by the generated initializeCommand. Prefer these over a mkdir in
   * initializeCommands: the host shell is cmd.exe on Windows.
   */
  hostDirs: string[];
  /**
   * Other commands run on the HOST before the container is created. Must work
   * in both `sh` and `cmd.exe` — see ensureHostDir in the devcontainer.json
   * generator for what that rules out.
   */
  initializeCommands: string[];
  postCreateSteps: string[];
  postStartSteps: string[];
  features: Record<string, Record<string, unknown>>;
  /**
   * Lines to append to the project's root `.gitignore` (created if missing).
   * Lines already present are skipped.
   */
  gitignoreEntries: string[];
}

export interface TemplateConfigureOptions {
  interactive: boolean;
  /** Absolute path to the project root being scanned (host-side). */
  projectPath: string;
  workspaceMode: WorkspaceMode;
  /**
   * Set by --minimal. Templates that install an external toolkit should install
   * only its minimal set. Defaults to false: full toolkit.
   */
  minimalTools?: boolean;
  /**
   * Set by --force. Templates that install an external toolkit may overwrite
   * machine-local files it would otherwise preserve. Defaults to false.
   */
  forceTools?: boolean;
}

export interface Template {
  name: string;
  description: string;
  configure(options: TemplateConfigureOptions): Promise<TemplateAdditions>;
}
