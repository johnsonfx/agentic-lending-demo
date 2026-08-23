/**
 * Exports the system diagram in docs/architecture.md to docs/architecture.svg.
 *
 *   npm run diagram
 *
 * The mermaid block inside the markdown stays the single source of truth —
 * this only renders it, so the two can never drift. Re-run after editing the
 * diagram.
 *
 * Two notes on how it renders:
 *
 * - `htmlLabels` is forced off. Mermaid's default puts node labels inside
 *   <foreignObject>, which browsers render but most other SVG consumers
 *   (GitHub's sanitiser, image editors, anything rasterising the file) drop
 *   silently — you get a diagram of empty boxes. With it off, labels are
 *   ordinary <text>, and the file travels.
 * - Puppeteer has no bundled Chromium in this project, so it is pointed at an
 *   already-installed browser. Override with PUPPETEER_EXECUTABLE_PATH if
 *   yours lives elsewhere.
 */

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const SOURCE = "docs/architecture.md";
const OUT = "docs/architecture.svg";

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error(
    "No browser found to render with. Install Chrome, or set " +
      "PUPPETEER_EXECUTABLE_PATH to an existing Chrome/Chromium binary."
  );
  process.exit(1);
}

const md = readFileSync(SOURCE, "utf8");
const match = md.match(/```mermaid\n([\s\S]*?)```/);
if (!match) {
  console.error(`No mermaid block found in ${SOURCE}.`);
  process.exit(1);
}

const definition = match[1].replace(/"htmlLabels":\s*true/g, '"htmlLabels": false');

const dir = mkdtempSync(path.join(tmpdir(), "diagram-"));
const input = path.join(dir, "diagram.mmd");
const puppeteerConfig = path.join(dir, "puppeteer.json");
const mermaidConfig = path.join(dir, "mermaid.json");
writeFileSync(input, definition);
writeFileSync(puppeteerConfig, JSON.stringify({ executablePath: chrome }));
// Rewriting the init directive alone isn't enough — the CLI's own defaults
// re-enable htmlLabels, so it has to be turned off here as well.
writeFileSync(mermaidConfig, JSON.stringify({ htmlLabels: false, flowchart: { htmlLabels: false } }));

execFileSync(
  "npx",
  [
    "-y", "@mermaid-js/mermaid-cli@11",
    "-i", input, "-o", OUT,
    "-b", "white",
    "-p", puppeteerConfig,
    "-c", mermaidConfig,
  ],
  { stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" } }
);

const rendered = readFileSync(OUT, "utf8");
const stragglers = (rendered.match(/<foreignObject/g) || []).length;
if (stragglers > 0) {
  console.error(
    `warning: ${stragglers} <foreignObject> labels remain — the file will show ` +
      "empty boxes outside a browser."
  );
}

console.log(`wrote ${OUT}`);
