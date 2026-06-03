import inquirer from "inquirer";
import chalk from "chalk";
import type { ScanResult } from "./types.js";
import { listTemplates, type Template } from "./templates/index.js";

export interface WizardResult {
  projectName: string;
  templates: Template[];
  confirmed: boolean;
}

export async function runWizard(scan: ScanResult): Promise<WizardResult> {
  console.log(chalk.bold("\ndevcontainer-init setup wizard\n"));

  if (scan.stacks.length > 0) {
    console.log(chalk.green("Detected stacks:"));
    for (const stack of scan.stacks) {
      console.log(
        `  ${chalk.bold(stack.name)} (${stack.version ?? "latest"}) — found ${stack.markerFile}`
      );
    }
  } else {
    console.log(chalk.yellow("No recognized tech stacks detected."));
    console.log("A minimal Debian-based devcontainer will be generated.");
  }
  console.log();

  const { projectName } = await inquirer.prompt<{ projectName: string }>([
    {
      type: "input",
      name: "projectName",
      message: "Project name:",
      default: scan.projectName,
    },
  ]);

  const availableTemplates = listTemplates();
  let selectedTemplates: Template[] = [];

  if (availableTemplates.length > 0) {
    const { templateNames } = await inquirer.prompt<{
      templateNames: string[];
    }>([
      {
        type: "checkbox",
        name: "templateNames",
        message: "Select templates to apply:",
        choices: availableTemplates.map((t) => ({
          name: `${t.name} — ${t.description}`,
          value: t.name,
        })),
      },
    ]);

    selectedTemplates = templateNames
      .map((name) => availableTemplates.find((t) => t.name === name)!)
      .filter(Boolean);
  }

  console.log(chalk.bold("\nSummary:"));
  console.log(`  Project: ${chalk.cyan(projectName)}`);
  console.log(
    `  Stacks: ${scan.stacks.length > 0 ? scan.stacks.map((s) => s.name).join(", ") : "none (minimal Debian)"}`
  );
  console.log(
    `  Templates: ${selectedTemplates.length > 0 ? selectedTemplates.map((t) => t.name).join(", ") : "none"}`
  );
  console.log(
    `  Root entries: ${scan.rootEntries.length} items`
  );
  console.log();

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: "confirm",
      name: "confirmed",
      message: "Generate .devcontainer/?",
      default: true,
    },
  ]);

  return { projectName, templates: selectedTemplates, confirmed };
}
