/**
 * Parses the "key: value" machine-readable parameter block that business-
 * edited Word documents carry alongside their prose (see policy.docx and
 * fraud-policy.docx). Deliberately strict: every required field is looked
 * up by exact name, and a missing or malformed one throws rather than
 * silently falling back — these numbers drive real lending decisions, so a
 * business-user typo should fail the server at startup, not quietly ship a
 * wrong threshold.
 */

export type ParamMap = Record<string, string>;

const LINE = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/;

export function parseParamBlock(text: string): ParamMap {
  const params: ParamMap = {};
  for (const rawLine of text.split("\n")) {
    const m = rawLine.trim().match(LINE);
    if (m) params[m[1]] = m[2].trim();
  }
  return params;
}

export function requireString(params: ParamMap, key: string, docName: string): string {
  const raw = params[key];
  if (raw === undefined) throw new Error(`${docName}: missing required parameter "${key}"`);
  return raw;
}

export function requireNumber(params: ParamMap, key: string, docName: string): number {
  const raw = requireString(params, key, docName);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${docName}: parameter "${key}" is not a valid number ("${raw}")`);
  return n;
}

export function requireNumberList(params: ParamMap, key: string, docName: string): number[] {
  const raw = requireString(params, key, docName);
  const nums = raw.split(",").map((s) => Number(s.trim()));
  if (nums.some((n) => !Number.isFinite(n)))
    throw new Error(`${docName}: parameter "${key}" contains a non-numeric value ("${raw}")`);
  return nums;
}

/** Strips the machine-readable block from text meant for a human/agent to read. */
export function stripParamBlock(text: string): string {
  return text.split(/MACHINE-READABLE PARAMETERS/i)[0].trim();
}
