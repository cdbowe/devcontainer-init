import inquirer from "inquirer";
import chalk from "chalk";
import type { DetectedStack, ScanResult } from "./types.js";
import {
  listTemplates,
  mergeTemplateAdditions,
  type Template,
  type TemplateAdditions,
} from "./templates/index.js";
import { stackChoices } from "./scanner.js";
import {
  commonTimezones,
  describeTimezone,
  describeTimezones,
  detectHostTimezone,
  formatTimezone,
  listTimezones,
} from "./timezones.js";

export interface WizardResult {
  projectName: string;
  timezone: string;
  selectedStacks: DetectedStack[];
  templates: Template[];
  /** Configured additions for the selected templates, or undefined if none. */
  templateAdditions?: TemplateAdditions;
  confirmed: boolean;
}

const PICK_FROM_FULL_LIST = "__all__";

/**
 * Two-step picker, mirroring the claude-code template's version prompt: a short
 * list of likely answers with the detected host zone preselected, plus an
 * escape hatch into the full IANA list.
 */
async function promptTimezone(): Promise<string> {
  const detected = detectHostTimezone();

  const shortlist = [
    detected.id,
    ...commonTimezones().filter((id) => id !== detected.id),
  ];
  const described = describeTimezones(shortlist);

  const choices = described.map((info, index) => ({
    name:
      index === 0
        ? `${formatTimezone(info)} — detected from ${detected.source}`
        : formatTimezone(info),
    value: info.id,
  }));
  choices.push({
    name: "Pick from the full IANA list...",
    value: PICK_FROM_FULL_LIST,
  });

  if (detected.source === "fallback") {
    console.log(
      chalk.dim(
        "  Could not detect a host timezone — defaulting to UTC.\n" +
          "  Note: when devcontainer-init runs inside a container, this reads the\n" +
          "  container's timezone rather than the Docker host's."
      )
    );
  }

  const { timezone } = await inquirer.prompt<{ timezone: string }>([
    {
      type: "list",
      name: "timezone",
      message: "Container timezone:",
      choices,
      default: detected.id,
      loop: false,
    },
  ]);

  if (timezone !== PICK_FROM_FULL_LIST) return timezone;

  console.log(chalk.dim("Type to jump to a zone; arrow keys to scroll."));
  const allZones = describeTimezones(listTimezones());

  const { pickedTimezone } = await inquirer.prompt<{ pickedTimezone: string }>([
    {
      type: "list",
      name: "pickedTimezone",
      message: "Select timezone:",
      choices: allZones.map((info) => ({
        name: formatTimezone(info),
        value: info.id,
      })),
      default: detected.id,
      loop: false,
      pageSize: 15,
    },
  ]);

  return pickedTimezone;
}

export interface WizardOptions {
  /** Set by --timezone; when present the timezone prompt is skipped. */
  timezone?: string;
  /** Set by --minimal; passed through to template configuration. */
  minimalTools?: boolean;
  /** Set by --force; passed through to template configuration. */
  forceTools?: boolean;
}

export async function runWizard(
  scan: ScanResult,
  options: WizardOptions = {}
): Promise<WizardResult> {
  console.log(chalk.bold("\ndevcontainer-init setup wizard\n"));

  let selectedStacks: DetectedStack[] = [];

  if (scan.stacks.length > 0) {
    console.log(chalk.green("Detected stacks:"));
    for (const stack of scan.stacks) {
      console.log(
        `  ${chalk.bold(stack.name)} (${stack.version ?? "latest"}) — found ${stack.markerFile}`
      );
    }
  } else {
    console.log(chalk.yellow("No recognized tech stacks detected."));
    console.log("Select the stacks you want to include:\n");

    const { chosenStacks } = await inquirer.prompt<{ chosenStacks: string[] }>([
      {
        type: "checkbox",
        name: "chosenStacks",
        message: "Tech stacks:",
        choices: stackChoices.map((s) => ({
          name: s.label,
          value: s.name,
        })),
      },
    ]);

    selectedStacks = chosenStacks
      .map((name) => stackChoices.find((s) => s.name === name)?.defaultStack)
      .filter((s): s is DetectedStack => s !== undefined);

    if (selectedStacks.length === 0) {
      console.log(chalk.dim("\nNo stacks selected — a minimal Debian container will be generated."));
    }
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

  const timezone = options.timezone ?? (await promptTimezone());

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

  // Configure templates before the summary so their prompts come first and the
  // final confirmation is genuinely the last question asked.
  let templateAdditions: TemplateAdditions | undefined;
  if (selectedTemplates.length > 0) {
    const additions: TemplateAdditions[] = [];
    for (const template of selectedTemplates) {
      additions.push(
        await template.configure({
          interactive: true,
          projectPath: scan.rootPath,
          minimalTools: options.minimalTools,
          forceTools: options.forceTools,
        })
      );
    }
    templateAdditions = mergeTemplateAdditions(additions);
  }

  const allStacks = [...scan.stacks, ...selectedStacks];

  console.log(chalk.bold("\nSummary:"));
  console.log(`  Project: ${chalk.cyan(projectName)}`);
  console.log(
    `  Timezone: ${chalk.cyan(formatTimezone(describeTimezone(timezone)))}`
  );
  console.log(
    `  Stacks: ${allStacks.length > 0 ? allStacks.map((s) => s.name).join(", ") : "none (minimal Debian)"}`
  );
  console.log(
    `  Templates: ${selectedTemplates.length > 0 ? selectedTemplates.map((t) => t.name).join(", ") : "none"}`
  );
  if (templateAdditions && templateAdditions.postCreateSteps.length > 0) {
    console.log(
      `  Post-create steps: ${chalk.cyan(String(templateAdditions.postCreateSteps.length))}`
    );
  }
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

  return {
    projectName,
    timezone,
    selectedStacks,
    templates: selectedTemplates,
    templateAdditions,
    confirmed,
  };
}
