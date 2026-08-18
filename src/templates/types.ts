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
}

export interface Template {
  name: string;
  description: string;
  configure(options: TemplateConfigureOptions): Promise<TemplateAdditions>;
}
