import type { Template, TemplateAdditions } from "./types.js";
import { claudeCodeTemplate } from "./claude-code.js";

const templateRegistry = new Map<string, Template>();

function register(template: Template): void {
  templateRegistry.set(template.name, template);
}

export function getTemplate(name: string): Template | undefined {
  return templateRegistry.get(name);
}

export function listTemplates(): Template[] {
  return [...templateRegistry.values()];
}

export function mergeTemplateAdditions(
  additions: TemplateAdditions[]
): TemplateAdditions {
  const merged: TemplateAdditions = {
    dockerfileSteps: [],
    mounts: [],
    extensions: [],
    envVars: {},
    postCreateSteps: [],
    postStartSteps: [],
    features: {},
  };

  for (const a of additions) {
    merged.dockerfileSteps.push(...a.dockerfileSteps);
    merged.mounts.push(...a.mounts);
    merged.extensions.push(...a.extensions);
    Object.assign(merged.envVars, a.envVars);
    merged.postCreateSteps.push(...a.postCreateSteps);
    merged.postStartSteps.push(...a.postStartSteps);
    Object.assign(merged.features, a.features);
  }

  return merged;
}

// Register templates here

register(claudeCodeTemplate);

export type { Template, TemplateAdditions };
