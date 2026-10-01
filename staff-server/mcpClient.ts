import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:8788/mcp";

/**
 * One connection per call, unlike the customer orchestrator's cached
 * singleton (server/agent/mcpClient.ts). That one connection is shared for
 * the whole process because it's always the same identity — no auth at all.
 * Here the bearer token is whichever staff member is making this particular
 * request, refreshed periodically and different per person, so there is
 * nothing safe to cache a connection under. A fresh transport per call just
 * carries this request's own session token.
 */
async function withClient<T>(accessToken: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "agentic-lending-staff-portal", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function unwrap(res: ToolCallResult): unknown {
  const textBlock = res.content.find((b) => b.type === "text");
  const parsed = textBlock?.text ? JSON.parse(textBlock.text) : null;
  if (res.isError) {
    const e = parsed as { error?: string; detail?: string } | null;
    throw new Error(e?.detail ?? e?.error ?? "MCP tool call failed.");
  }
  return parsed;
}

export async function listApplications(
  accessToken: string,
  status?: "PENDING" | "RESOLVED" | "ALL"
): Promise<unknown> {
  return withClient(accessToken, async (c) => {
    const res = await c.callTool({ name: "list_applications", arguments: status ? { status } : {} });
    return unwrap(res as ToolCallResult);
  });
}

export async function getApplicationDetail(accessToken: string, applicationId: string): Promise<unknown> {
  return withClient(accessToken, async (c) => {
    const res = await c.callTool({ name: "get_application_detail", arguments: { application_id: applicationId } });
    return unwrap(res as ToolCallResult);
  });
}

export async function resolveReferral(
  accessToken: string,
  applicationId: string,
  decision: "UPHOLD" | "OVERTURN",
  notes: string | null
): Promise<unknown> {
  return withClient(accessToken, async (c) => {
    const res = await c.callTool({
      name: "resolve_referral",
      arguments: { application_id: applicationId, decision, ...(notes ? { notes } : {}) },
    });
    return unwrap(res as ToolCallResult);
  });
}
