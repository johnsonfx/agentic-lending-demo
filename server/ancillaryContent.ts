import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Loads the "things to show while the customer waits" copy from
 * config/ancillary.md — same business-editable, gitignored treatment as the
 * prompts and the policy documents.
 *
 * Two deliberate differences from the policy loaders, both because this copy
 * is cosmetic rather than decisioning:
 *
 * - **It fails soft.** A missing policy document must stop the server, because
 *   running with the wrong DSR ceiling means lending on the wrong terms.
 *   Missing wait-time copy means a plainer wait, so it warns and returns
 *   nothing rather than refusing to boot.
 * - **It parses forgivingly.** `INTRO:` sets the framing line; every line
 *   starting with `- ` is a block; everything else is ignored. That lets
 *   whoever maintains the file write headings and notes around the content
 *   without breaking it — a parser that rejects a business editor's own
 *   annotations is one they will work around rather than with.
 */

const CONTENT_PATH = path.resolve(process.cwd(), "config/ancillary.md");

const DEFAULT_INTRO = "While we process your application — did you know?";

export interface AncillaryContent {
  /** Framing line shown above every block, so the content reads as a note
   *  from the app rather than as a non-sequitur from the agent. */
  intro: string;
  blocks: string[];
}

let cached: AncillaryContent | null = null;

export async function getAncillaryContent(): Promise<AncillaryContent> {
  if (cached !== null) return cached;

  let raw: string;
  try {
    raw = await readFile(CONTENT_PATH, "utf8");
  } catch (e) {
    console.warn(
      `ancillary content unavailable (${(e as Error).message}) — ` +
        "long waits will show the typing indicator alone."
    );
    cached = { intro: DEFAULT_INTRO, blocks: [] };
    return cached;
  }

  const lines = raw.split("\n").map((line) => line.trim());

  const introLine = lines.find((line) => line.startsWith("INTRO:"));
  cached = {
    intro: introLine?.slice("INTRO:".length).trim() || DEFAULT_INTRO,
    blocks: lines
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter(Boolean),
  };

  return cached;
}
