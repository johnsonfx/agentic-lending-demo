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

import type { IncomingMessage } from "node:http";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { TOOLS } from "../server/agent/tools.js";
import { STAFF_TOOLS } from "../server/agent/staffTools.js";
import { getPolicyConfig } from "../server/policyDocument.js";
import { getFraudPolicyConfig } from "../server/fraudPolicyDocument.js";
import { getFraudReviewPrompt } from "../server/fraudReviewPromptContent.js";

const PORT = Number(process.env.MCP_PORT || 8788);

/**
 * The one MCP server has two audiences now: the customer orchestrator
 * (unauthenticated today, and staying that way — see `authenticate` below)
 * and the staff portal (a real bearer token, verified against Keycloak).
 * `canAccess` on each staff tool (further down) is what actually keeps a
 * customer-agent connection from ever seeing or calling them; `authenticate`
 * is just where the auth object it checks comes from.
 */
interface Auth {
  [key: string]: unknown; // FastMCP's FastMCPSessionAuth constraint
  role: "customer-agent" | "staff";
  sub?: string;
  username?: string;
}

const KEYCLOAK_URL = process.env.KEYCLOAK_URL || "http://localhost:8080";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "agentic-lending";
const ISSUER = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
// Lazy — fetches Keycloak's public keys on first verify, not at import time,
// so this file loads (and the customer path works) with no Keycloak running
// at all. Only a staff connection ever touches this.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));

/**
 * No `Authorization` header at all → the customer orchestrator, exactly
 * today's connection, exactly today's access (every customer tool, no
 * staff tool — see `canAccess` below). A header that's present but doesn't
 * verify — malformed, expired, wrong issuer, missing the `staff` realm
 * role — returns `null`, which FastMCP turns into a 401 rather than a
 * session. It must never fall back to `customer-agent` on a bad token: that
 * would let a broken or forged staff credential quietly downgrade into
 * customer-only access instead of being rejected outright.
 */
async function authenticate(request: IncomingMessage): Promise<Auth | null> {
  const header = request.headers.authorization;
  if (!header) return { role: "customer-agent" };

  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;

  try {
    const { payload } = await jwtVerify(match[1], JWKS, { issuer: ISSUER });
    const roles = (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
    if (!roles.includes("staff")) return null;
    return {
      role: "staff",
      sub: payload.sub,
      username: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
    };
  } catch {
    return null;
  }
}

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

const server = new FastMCP<Auth>({ name: "agentic-lending-underwriting", version: "0.1.0", authenticate });

for (const [name, tool] of Object.entries(TOOLS)) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error(`mcp-server: no zod schema registered for tool "${name}"`);

  // No canAccess — unchanged from before authentication existed at all.
  // Both a customer-agent and a staff connection can reach these.
  server.addTool({
    name,
    description: tool.description,
    parameters: schema,
    execute: async (args, context) =>
      JSON.stringify(await tool.handler(args as Record<string, unknown>, { auth: context.session })),
  });
}

const STAFF_SCHEMAS: Record<string, z.ZodTypeAny> = {
  list_applications: z.object({ status: z.enum(["PENDING", "RESOLVED", "ALL"]).optional() }),
  get_application_detail: z.object({ application_id: z.string() }),
  resolve_referral: z.object({
    application_id: z.string(),
    decision: z.enum(["UPHOLD", "OVERTURN"]),
    notes: z.string().optional(),
  }),
};

for (const [name, tool] of Object.entries(STAFF_TOOLS)) {
  const schema = STAFF_SCHEMAS[name];
  if (!schema) throw new Error(`mcp-server: no zod schema registered for staff tool "${name}"`);

  server.addTool({
    name,
    description: tool.description,
    parameters: schema,
    // The actual boundary: filtered out of tools/list and tools/call alike
    // for any session whose auth object isn't role "staff" — see FastMCP's
    // #createSession, which builds each session's tool set from this before
    // the customer orchestrator (or anyone else) ever sees a tool name.
    canAccess: (auth) => auth.role === "staff",
    execute: async (args, context) =>
      JSON.stringify(await tool.handler(args as Record<string, unknown>, { auth: context.session })),
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
