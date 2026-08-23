import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The orchestrator's connection to mcp-server/ — a plain local MCP client,
 * not Anthropic's `mcp_servers` API parameter. That parameter requires a
 * publicly-reachable HTTPS server (Anthropic's own infrastructure connects
 * to it directly); this is a lending backend, so the MCP server stays
 * un-exposed, and the orchestrator talks to it itself over local HTTP —
 * the same shape as today's Vite↔Express split, one more hop.
 *
 * `mcpTools()` from the Anthropic SDK isn't used here — it produces
 * `BetaRunnableTool`s built for `toolRunner()`, which bundles execution
 * into the tool definition. This app hand-rolls the loop instead (see
 * applicationAgent.ts), so tool schemas are mapped to plain Anthropic `Tool`
 * objects
 * directly — MCP's `inputSchema` is already JSON Schema, so the mapping is
 * a field rename, not real conversion work.
 */

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:8788/mcp";

let client: Client | null = null;
let cachedSchemas: Anthropic.Tool[] | null = null;

/** `npm run dev` starts every process at once — nothing guarantees the MCP
 *  server is already accepting connections before the orchestrator's first
 *  attempt. Retry with backoff rather than requiring a manually-ordered
 *  startup; a few seconds of patience here beats a flaky `npm run dev`. A
 *  fresh transport each attempt — `connect()` calls `start()` internally,
 *  and a transport can't be started twice. */
async function connectWithRetry(attempts = 5): Promise<Client> {
  for (let i = 0; i < attempts; i++) {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
    const c = new Client({ name: "agentic-lending-orchestrator", version: "0.1.0" });
    try {
      await c.connect(transport);
      return c;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

async function getClient(): Promise<Client> {
  if (client) return client;
  client = await connectWithRetry();
  return client;
}

/**
 * Anthropic's native `tools` array, derived from the MCP server's tool
 * list. Fetched once and cached — tool descriptions don't change at
 * runtime. `application_id` is stripped from every schema here: the model
 * never sees or supplies it, the same way it never saw the raw `state`
 * object under the old JSON-step contract. See callTool below for where
 * it's injected back in.
 */
export async function getToolSchemas(): Promise<Anthropic.Tool[]> {
  if (cachedSchemas) return cachedSchemas;

  const c = await getClient();
  const { tools } = await c.listTools();

  cachedSchemas = tools.map((t) => {
    const schema = t.inputSchema as { type: "object"; properties?: Record<string, unknown>; required?: string[] };
    const { application_id: _omit, ...restProps } = schema.properties ?? {};
    return {
      name: t.name,
      description: t.description ?? "",
      input_schema: {
        type: "object" as const,
        properties: restProps,
        required: (schema.required ?? []).filter((k) => k !== "application_id"),
      },
    };
  });
  return cachedSchemas;
}

/** Calls a tool by name, injecting `applicationId` — never model-supplied. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  applicationId: string
): Promise<{ result: unknown; isError: boolean }> {
  const c = await getClient();
  const res = await c.callTool({ name, arguments: { ...args, application_id: applicationId } });

  const content = res.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((b) => b.type === "text");
  const result = textBlock?.text ? JSON.parse(textBlock.text) : null;
  return { result, isError: !!res.isError };
}
