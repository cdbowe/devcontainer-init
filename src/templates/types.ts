export interface TemplateAdditions {
  dockerfileSteps: string[];
  mounts: string[];
  extensions: string[];
  envVars: Record<string, string>;
  postCreateSteps: string[];
  postStartSteps: string[];
  features: Record<string, Record<string, unknown>>;
}

export interface TemplateConfigureOptions {
  interactive: boolean;
  /** Absolute path to the project root being scanned (host-side). */
  projectPath: string;
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
