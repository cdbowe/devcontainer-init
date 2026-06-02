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

const program = new Command();

program
  .name("devcontainer-init")
  .description(
    "Scan a codebase and generate a .devcontainer setup with the right SDKs and bind mounts"
  )
  .version("0.1.0")
  .option("-p, --path <dir>", "path to the project root", ".")
  .option("-n, --name <name>", "override the project name")
  .option("--dry-run", "show what would be generated without writing files", false)
  .option("--force", "overwrite existing .devcontainer directory", false)
  .action(async (options) => {
    const rootPath = resolve(options.path);

    console.log(chalk.bold("\ndevcontainer-init"));
    console.log(chalk.dim(`Scanning ${rootPath}...\n`));

    const scan = await scanProject(rootPath);

    if (options.name) {
      scan.projectName = options.name;
    }

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

    const dockerfile = generateDockerfile(scan);
    const devcontainerJson = generateDevcontainerJson(scan);
    const postCreate = generatePostCreate(scan);
    const postStart = generatePostStart(scan);

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
    console.log(chalk.dim("Open this folder in VS Code and use \"Reopen in Container\" to start.\n"));
  });

program.parse();
