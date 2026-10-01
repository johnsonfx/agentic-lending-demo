/**
 * Exports every mermaid diagram in docs/architecture.md to its own SVG.
 *
 *   npm run diagram
 *
 * The mermaid blocks inside the markdown stay the single source of truth —
 * this only renders them, so the two can never drift. Re-run after editing
 * a diagram.
 *
 * Each block names its own output file with a `%% export: <filename>`
 * comment on its own line — mermaid treats `%%` lines as comments, so this
 * is invisible to the renderer and safe to put anywhere in the block. A
 * block with no such marker falls back to docs/architecture.svg, so the
 * original single-diagram file keeps working without one.
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
const DEFAULT_OUT = "docs/architecture.svg";

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
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length === 0) {
  console.error(`No mermaid block found in ${SOURCE}.`);
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "diagram-"));
const puppeteerConfig = path.join(dir, "puppeteer.json");
const mermaidConfig = path.join(dir, "mermaid.json");
writeFileSync(puppeteerConfig, JSON.stringify({ executablePath: chrome }));
// Rewriting the init directive alone isn't enough — the CLI's own defaults
// re-enable htmlLabels, so it has to be turned off here as well.
writeFileSync(mermaidConfig, JSON.stringify({ htmlLabels: false, flowchart: { htmlLabels: false } }));

for (const [i, raw] of blocks.entries()) {
  const exportMatch = raw.match(/^%%\s*export:\s*(\S+)\s*$/m);
  const out = exportMatch ? path.join("docs", exportMatch[1]) : i === 0 ? DEFAULT_OUT : `docs/diagram-${i + 1}.svg`;

  const definition = raw.replace(/"htmlLabels":\s*true/g, '"htmlLabels": false');
  const input = path.join(dir, `diagram-${i}.mmd`);
  writeFileSync(input, definition);

  execFileSync(
    "npx",
    [
      "-y", "@mermaid-js/mermaid-cli@11",
      "-i", input, "-o", out,
      "-b", "white",
      "-p", puppeteerConfig,
      "-c", mermaidConfig,
    ],
    { stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" } }
  );

  const rendered = readFileSync(out, "utf8");
  const stragglers = (rendered.match(/<foreignObject/g) || []).length;
  if (stragglers > 0) {
    console.error(
      `warning: ${out} has ${stragglers} <foreignObject> labels remaining — it will show ` +
        "empty boxes outside a browser."
    );
  }

  console.log(`wrote ${out}`);
}
