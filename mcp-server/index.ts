/**
 * The MCP server. Publishes the tool registry from server/agent/tools.ts
 * over Streamable HTTP on its own port — a real, independently-addressable
 * service, not just a code module, so a future second client (the
 * back-office portal) can connect to the exact same underwriting logic the
 * customer chat uses, without importing this app's code directly.
 *
 * Not exposed publicly — the orchestrator (server/index.ts) is the only
 * client today, connecting over plain local HTTP via
 * server/agent/mcpClient.ts. See that file's header for why this isn't
 * wired through Anthropic's `mcp_servers` API parameter instead.
 */

import "dotenv/config";

// fastmcp's tool-execution wrapper calls AbortSignal.any(), added in Node
// 20.3. On Node >= 20.3 this block is inert and the native implementation is
// used; it exists only so the server still runs on older runtimes. See the
// "engines" field in package.json.
//
// The listeners are removed as soon as any source signal fires. Without that,
// a per-call composite built over a long-lived session signal leaves a
// listener behind on every tool call, and Node starts warning about a leak
// after ten. The native version leans on garbage collection for this, which a
// ponyfill can't reproduce — so signals we attach to also get their listener
// ceiling raised, since one live listener per in-flight call is legitimate.
if (typeof AbortSignal.any !== "function") {
  const { setMaxListeners } = await import("node:events");

  AbortSignal.any = (signals: AbortSignal[]): AbortSignal => {
    const controller = new AbortController();
    const detach: Array<() => void> = [];

    const settle = (reason: unknown) => {
      for (const off of detach) off();
      detach.length = 0;
      controller.abort(reason);
    };

    for (const signal of signals) {
      if (signal.aborted) {
        settle((signal as { reason?: unknown }).reason);
        return controller.signal;
      }
      const onAbort = () => settle((signal as { reason?: unknown }).reason);
      setMaxListeners(64, signal);
      signal.addEventListener("abort", onAbort, { once: true });
      detach.push(() => signal.removeEventListener("abort", onAbort));
    }

    return controller.signal;
  };
}

import { FastMCP } from "fastmcp";
import { z } from "zod";
import { TOOLS } from "../server/agent/tools.js";
import { getPolicyConfig } from "../server/policyDocument.js";
import { getFraudPolicyConfig } from "../server/fraudPolicyDocument.js";
import { getFraudReviewPrompt } from "../server/fraudReviewPromptContent.js";

const PORT = Number(process.env.MCP_PORT || 8788);

/** Every tool takes application_id — it's how a call finds the right DB row. */
const withApplicationId = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ application_id: z.string(), ...shape });

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  get_credit_score: withApplicationId({ customer_id: z.string() }),
  get_bureau_report: withApplicationId({}),
  run_fraud_check: withApplicationId({}),
  read_policy_document: withApplicationId({}),
  assess_affordability: withApplicationId({ monthly_income: z.number() }),
  run_income_check: withApplicationId({}),
  run_policy_checks: withApplicationId({}),
  generate_offer: withApplicationId({ amount: z.number(), tenor_months: z.number() }),
  record_acceptance: withApplicationId({ accepted: z.boolean() }),
  validate_bank_account: withApplicationId({ bank: z.string(), account_number: z.string(), account_name: z.string() }),
  disburse_funds: withApplicationId({}),
};

const server = new FastMCP({ name: "agentic-lending-underwriting", version: "0.1.0" });

for (const [name, tool] of Object.entries(TOOLS)) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error(`mcp-server: no zod schema registered for tool "${name}"`);

  server.addTool({
    name,
    description: tool.description,
    parameters: schema,
    execute: async (args) => JSON.stringify(await tool.handler(args as Record<string, unknown>)),
  });
}

Promise.all([getPolicyConfig(), getFraudPolicyConfig(), getFraudReviewPrompt()])
  .then(() => {
    server.start({ transportType: "httpStream", httpStream: { port: PORT } });
    console.log(`mcp server on http://localhost:${PORT}/mcp`);
  })
  .catch((e) => {
    console.error("Fatal: could not start mcp-server —", (e as Error).message);
    process.exit(1);
  });
