import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The agent's identity, conduct rules, and style — the actual specification
 * of what it discloses and how it handles a rejection. Kept out of source
 * control (config/system-prompt.md is gitignored; config/system-prompt.example.md
 * ships as the runnable starter) since this is genuinely sensitive business
 * behavior, not something that belongs in a public repo.
 */

const PROMPT_PATH = path.resolve(process.cwd(), "config/system-prompt.md");

let cached: string | null = null;

export async function getConductPrompt(): Promise<string> {
  if (cached === null) {
    cached = (await readFile(PROMPT_PATH, "utf8")).trim();
  }
  return cached;
}
