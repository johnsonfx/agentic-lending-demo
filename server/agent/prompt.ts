/**
 * Under the old JSON-step contract this file generated a mechanical TOOLS
 * list and RESPONSE FORMAT section from the tool registry. Native tool-use
 * carries both structurally now — the `tools` array on the API call (see
 * mcpClient.ts's getToolSchemas) *is* the tool manifest, and the response
 * contract is the API's own `tool_use`/`text` content blocks, not something
 * this app has to describe in prose. What's left is exactly the part that
 * was always business content, not plumbing: see ../systemPromptContent.ts
 * for where it's loaded from (config/system-prompt.md, gitignored).
 */
export function buildSystemPrompt(conduct: string): string {
  return conduct;
}

export const SESSION_START =
  "[SESSION START] The customer has opened the chat. Greet them briefly and begin.";
