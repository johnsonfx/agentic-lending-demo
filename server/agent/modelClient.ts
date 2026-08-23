import Anthropic from "@anthropic-ai/sdk";

/**
 * The one Anthropic client every agent in this app shares. The application
 * agent uses it
 * directly for the native tool-use conversation; fraudReviewAgent.ts uses
 * the plain-text `callModel` helper below, since it never calls tools.
 */
export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODEL = process.env.AGENT_MODEL || "claude-sonnet-4-6";

export type ChatMessage = Anthropic.MessageParam;

/** Plain text in, plain text out — no tools. For the narrow fraud reviewer. */
export async function callModel({ system, messages }: { system: string; messages: ChatMessage[] }): Promise<string> {
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: 1000, system, messages });
  return res.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");
}
