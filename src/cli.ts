#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { scanProject } from "./scanner.js";
import {
  generateDockerfile,
  generateDevcontainerJson,
  generatePostCreate,
  generatePostStart,
} from "./generators/index.js";
import {
  getTemplate,
  mergeTemplateAdditions,
  type TemplateAdditions,
} from "./templates/index.js";
import { runWizard } from "./wizard.js";

const program = new Command();

program
  .name("devcontainer-init")
  .description(
    "Scan a codebase and generate a .devcontainer setup with the right SDKs and bind mounts"
  )
  .version("0.1.0")
  .option("-p, --path <dir>", "path to the project root", ".")
  .option("-n, --name <name>", "override the project name")
  .option(
    "-t, --template <names...>",
    "apply templates (e.g., --template claude-code)"
  )
  .option("--dry-run", "show what would be generated without writing files", false)
  .option("--force", "overwrite existing .devcontainer directory", false)
  .option("--no-interactive", "skip the wizard and use defaults")
  .action(async (options) => {
    const rootPath = resolve(options.path);
    const scan = await scanProject(rootPath);

    if (options.name) {
      scan.projectName = options.name;
    }

    let templateAdditions: TemplateAdditions | undefined;

    if (options.template) {
      // Non-interactive: templates specified via CLI flag
      const additions: TemplateAdditions[] = [];
      for (const name of options.template) {
        const template = getTemplate(name);
        if (!template) {
          console.log(chalk.red(`Unknown template: ${name}`));
          process.exit(1);
        }
        additions.push(await template.configure({ interactive: options.interactive !== false }));
      }
      if (additions.length > 0) {
        templateAdditions = mergeTemplateAdditions(additions);
      }

      printScanSummary(scan);
    } else if (options.interactive !== false) {
      // Interactive wizard
      const wizardResult = await runWizard(scan);
      scan.projectName = wizardResult.projectName;

      if (!wizardResult.confirmed) {
        console.log(chalk.yellow("Aborted."));
        process.exit(0);
      }

      if (wizardResult.selectedStacks.length > 0) {
        scan.stacks.push(...wizardResult.selectedStacks);
      }

      if (wizardResult.templates.length > 0) {
        const additions: TemplateAdditions[] = [];
        for (const template of wizardResult.templates) {
          additions.push(await template.configure({ interactive: true }));
        }
        templateAdditions = mergeTemplateAdditions(additions);
      }
    } else {
      // Non-interactive, no templates
      printScanSummary(scan);
    }

    const dockerfile = generateDockerfile(scan, templateAdditions);
    const devcontainerJson = generateDevcontainerJson(scan, templateAdditions);
    const postCreate = generatePostCreate(scan, templateAdditions);
    const postStart = generatePostStart(scan, templateAdditions);

    if (options.dryRun) {
      console.log(chalk.bold.cyan("=== .devcontainer/Dockerfile ===\n"));
      console.log(dockerfile);
      console.log(chalk.bold.cyan("=== .devcontainer/devcontainer.json ===\n"));
      console.log(devcontainerJson);
      console.log(chalk.bold.cyan("=== .devcontainer/scripts/post-create.sh ===\n"));
      console.log(postCreate);
      console.log(chalk.bold.cyan("=== .devcontainer/scripts/post-start.sh ===\n"));
      console.log(postStart);
      return;
    }

    const devcontainerDir = join(rootPath, ".devcontainer");
    const scriptsDir = join(devcontainerDir, "scripts");

    if (!options.force) {
      try {
        await access(devcontainerDir);
        console.log(
          chalk.red(
            `${devcontainerDir} already exists. Use --force to overwrite.`
          )
        );
        process.exit(1);
      } catch {
        // doesn't exist, proceed
      }
    }

    await mkdir(scriptsDir, { recursive: true });

    const files = [
      { path: join(devcontainerDir, "Dockerfile"), content: dockerfile },
      { path: join(devcontainerDir, "devcontainer.json"), content: devcontainerJson },
      { path: join(scriptsDir, "post-create.sh"), content: postCreate },
      { path: join(scriptsDir, "post-start.sh"), content: postStart },
    ];

    for (const file of files) {
      await writeFile(file.path, file.content, "utf-8");
      const rel = file.path.replace(rootPath + "/", "");
      console.log(chalk.green(`  Created ${rel}`));
    }

    console.log(chalk.bold.green("\nDone! .devcontainer/ is ready."));
    console.log(
      chalk.dim(
        "Open this folder in VS Code and use \"Reopen in Container\" to start.\n"
      )
    );
  });

function printScanSummary(scan: ReturnType<typeof scanProject> extends Promise<infer T> ? T : never): void {
  console.log(chalk.bold("\ndevcontainer-init"));
  console.log(chalk.dim(`Scanning ${scan.rootPath}...\n`));

  if (scan.stacks.length === 0) {
    console.log(chalk.yellow("No recognized tech stacks detected."));
    console.log("A minimal Debian-based devcontainer will be generated.\n");
  } else {
    console.log(chalk.green("Detected stacks:"));
    for (const stack of scan.stacks) {
      console.log(
        `  ${chalk.bold(stack.name)} (${stack.version ?? "latest"}) — found ${stack.markerFile}`
      );
    }
    console.log();
  }

  console.log(
    `Root entries: ${scan.rootEntries.length} items (${scan.rootEntries.filter((e) => e.type === "directory").length} dirs, ${scan.rootEntries.filter((e) => e.type === "file").length} files)`
  );
  if (scan.hasDocker) console.log(chalk.dim("Docker config detected — adding docker-outside-of-docker feature"));
  if (scan.hasGit) console.log(chalk.dim("Git repo detected"));
  console.log();
}

program.parse();
