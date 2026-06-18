import { execSync } from "node:child_process";
import inquirer from "inquirer";
import chalk from "chalk";
import type { Template, TemplateAdditions, TemplateConfigureOptions } from "./types.js";

interface ClaudeCodeDistTags {
  stable: string;
  latest: string;
  next?: string;
}

function fetchDistTags(): ClaudeCodeDistTags | null {
  try {
    const output = execSync(
      "npm view @anthropic-ai/claude-code dist-tags --json",
      { encoding: "utf-8", timeout: 10000 }
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function fetchAllVersions(): string[] {
  try {
    const output = execSync(
      "npm view @anthropic-ai/claude-code versions --json",
      { encoding: "utf-8", timeout: 10000 }
    );
    const versions: string[] = JSON.parse(output);
    return versions.reverse();
  } catch {
    return [];
  }
}

export const claudeCodeTemplate: Template = {
  name: "claude-code",
  description: "Claude Code CLI with shared credential volume",

  async configure({ interactive }: TemplateConfigureOptions): Promise<TemplateAdditions> {
    console.log(chalk.dim("\nFetching Claude Code versions from npm..."));
    const distTags = fetchDistTags();

    let version = "stable";

    if (distTags) {
      if (interactive) {
        const choices = [
          {
            name: `stable (${distTags.stable}) — recommended`,
            value: distTags.stable,
          },
          {
            name: `latest (${distTags.latest})`,
            value: distTags.latest,
          },
          {
            name: "Pick a specific version...",
            value: "__pick__",
          },
        ];

        const { selectedVersion } = await inquirer.prompt<{
          selectedVersion: string;
        }>([
          {
            type: "list",
            name: "selectedVersion",
            message: "Claude Code version:",
            choices,
            default: distTags.stable,
          },
        ]);

        if (selectedVersion === "__pick__") {
          console.log(chalk.dim("Fetching all versions..."));
          const allVersions = fetchAllVersions();

          if (allVersions.length > 0) {
            const { pickedVersion } = await inquirer.prompt<{
              pickedVersion: string;
            }>([
              {
                type: "list",
                name: "pickedVersion",
                message: "Select version:",
                choices: allVersions.map((v) => ({
                  name: v,
                  value: v,
                })),
                loop: false,
              },
            ]);
            version = pickedVersion;
          } else {
            console.log(
              chalk.yellow("Could not fetch version list. Using stable.")
            );
            version = distTags.stable;
          }
        } else {
          version = selectedVersion;
        }
      } else {
        version = distTags.stable;
      }
    } else {
      console.log(
        chalk.yellow(
          "Could not fetch versions from npm. Defaulting to stable channel."
        )
      );
    }

    console.log(chalk.green(`  Using Claude Code ${version}\n`));

    return {
      dockerfileSteps: [
        `
######################
# Claude Code CLI
######################

USER \${USERNAME}
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${version}`,
      ],
      mounts: [
        "source=claude-code-home,target=/home/node/.claude,type=volume",
      ],
      extensions: ["Anthropic.claude-code"],
      envVars: {
        CLAUDE_CONFIG_DIR: "/home/node/.claude",
      },
      postCreateSteps: [],
      postStartSteps: [],
      features: {},
    };
  },
};
