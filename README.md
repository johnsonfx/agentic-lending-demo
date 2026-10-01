# Agentic credit lending — demo

An end-to-end agentic lending journey: a chat front end, an orchestration
agent driven by Claude, and a tool layer standing in for the credit bureau,
the policy document store and the payment rail.

The point of the demo is not the chatbot. It is the agent trace — the panel
showing every tool call, its arguments, its response and its latency. That is
what makes an LLM-driven credit decision defensible.

> This project is a demonstration. It is not a lending product, it does not
> implement a real credit policy, and it must not be used to make or support
> real credit decisions.

> This is a partial publication. Some source files are not published so a clone will not build
> or run as it stands.

---


Both agents' prompts, the wait-time copy, and both governing policy
documents live outside source control in Word documents. Each carry the numbers that actually drive
decisions (e.g., DSR ceiling, bureau conditions, fraud thresholds, ...) alongside
the prose explaining them — edit either directly, no code changes needed,
and restart the server to pick up changes. A malformed or missing parameter
fails the server at startup with a clear error rather than silently running
with a wrong number. A SQLite database is created at `data/app.db` on first
run — no setup step needed.

For a deeper look than this file goes into, see
[`docs/architecture.md`](docs/architecture.md) (what talks to what, and why
the boundaries are drawn where they are — with
[`architecture.svg`](docs/architecture.svg) and
[`sequence.svg`](docs/sequence.svg) as the exported diagrams),
[`docs/performance.md`](docs/performance.md) (measured latency, and where
the time actually goes), and [`docs/key-learnings.md`](docs/key-learnings.md)
(a running, non-technical record of the decisions behind the build and why).

Four fixture applicants are offered as one-tap chips in the chat:

| ID number | File | Outcome |
|---|---|---|
| `1234567` | Clean, good credit score | Approves, prices at 6.5%, disburses |
| `7654321` | Poor credit history | Declined |
| `2468135` | Good file, heavily geared | Approves at a reduced principal — DSR binds |
| `9911223` | Thin file + fraud signals | Never reaches an offer |

---

## Architecture

```
  Browser — thin UI, no tool logic, no state of its own
  ┌────────────────────────────────────────────────────┐
  │  Chat.tsx    Trace.tsx    PolicyView.tsx           │   presentation only
  ├────────────────────────────────────────────────────┤
  │  App.tsx — sends messages, renders the SSE stream  │
  │  agentStream.ts — the SSE reader                   │
  └───────────────────┬────────────────────────────────┘
                      │ POST /api/applications/:id/messages  (SSE)
                      │ GET  /api/applications/:id           (rehydrate)
  ┌───────────────────▼────────────────────────────────┐
  │  server/index.ts — the orchestrator, :8787         │
  │  holds the API key, routes only                    │
  ├────────────────────────────────────────────────────┤
  │  agent/applicationAgent.ts — the customer agent    │
  │  agent/prompt.ts — conduct, loaded from config/    │
  │  agent/mcpClient.ts — MCP client to mcp-server     │
  └───────────────────┬────────────────────────────────┘
                      │ MCP over local HTTP (:8788)
                      │ (not publicly exposed — see below)
  ┌───────────────────▼────────────────────────────────┐
  │  mcp-server/index.ts — the ONE tool server, :8788  │
  │  fastmcp; authenticate() + canAccess gate who sees │
  │  what — see "Staff portal" below                  │
  ├────────────────────────────────────────────────────┤
  │  agent/tools.ts — customer registry (open)         │   the control surface
  │  agent/staffTools.ts — staff-only (canAccess)      │
  │  domain/policy.ts  customers.ts  fraud.ts          │   swap for real systems
  │  applications.ts — SQLite-backed application record│
  └───────────────────┬────────────────────────────────┘
                      ▼  api.anthropic.com  (orchestrator + fraud reviewer)

  Staff portal — a second client of the same tool server, no code shared
  ┌────────────────────────────────────────────────────┐
  │  staff/ (:5174, React) → staff-server/ (:8791)      │
  │  session + OIDC login ⇄ Keycloak (:8080, docker)    │
  │  → mcp-server, Bearer <access_token>                │
  └────────────────────────────────────────────────────┘
```

Everything that used to run in the browser — the orchestration loop, every
tool, every domain calculation — now runs server-side, split across two
processes rather than one. The browser only ever sees chat messages and the
trace, streamed over Server-Sent Events; it never touches the Anthropic API
key, the bureau data, or the policy logic directly. Application state is a
SQLite row (`data/app.db`), not a `useRef`, so a refresh — or a second
client, like a future back-office reviewer — reconnects to the same record
instead of losing it.

The tool server is its own process specifically so a future second client
can connect to the exact same underwriting logic without importing this
app's code — it's not exposed publicly, though: the orchestrator reaches it
over plain local HTTP as an MCP client (`agent/mcpClient.ts`), the same
shape as the Vite↔orchestrator split. Anthropic's own `mcp_servers` API
parameter was considered and rejected for this — it requires the MCP server
to be reachable over public HTTPS, since it's Anthropic's infrastructure
connecting to it directly, which doesn't fit a lending backend.

### The loop

One customer message can produce many machine steps. Each pass, the model
returns a native tool-use response — content blocks that are `text` and/or
`tool_use`. `agent/applicationAgent.ts` runs any `tool_use` blocks (serially — see the
file's header for why not in parallel), feeds the results back as
`tool_result` blocks, and calls again. `MAX_STEPS = 10` is the circuit
breaker — an agent that cannot settle in ten rounds is stuck, and a stuck
agent that keeps calling is an unbounded bill.

Text alongside a `tool_use` block is never customer-facing — it becomes the
trace's `REASON` entry instead. The turn that finally has nothing left to
call is the one that reaches the customer, but even that reply is never
relayed on the model's first attempt: in testing, that first draft reliably
bled reasoning into it anyway ("The fraud check has passed. Could you tell
me your income?"), because free text has no structural wall between
"internal note" and "customer reply" the way a JSON contract's separate
fields would. So there's a second, narrowly-scoped call whose only job is
producing the clean message — the same "escalate only the case that needs
it" shape `run_fraud_check` already uses for its own ambiguous verdicts,
applied here to every reply rather than a rare case.

There is no state machine and no branching on intent anywhere in this codebase.
The sequence emerges from the tool preconditions plus the model's plan.

### Where the controls live

This is the part worth arguing about in a design review.

**Sequence is enforced in the tools, not the prompt.** `assess_affordability`
returns `NO_POLICY` if `read_policy_document` has not run. `validate_bank_account`
returns `NOT_ACCEPTED` if no acceptance is on file. `disburse_funds` requires
both. A rule a model can be talked out of is not a control; a precondition in a
handler is.

**Every customer-facing number originates in a tool response.** The model is
never asked to compute a DSR, quote a rate, or mint a reference. It relays.
If you want to test this, break `instalmentFor` and watch the wrong number
propagate to the chat unchallenged — the agent has no independent view of it.

**The tool manifest is generated, not hand-maintained.** Native tool-use gets
its tool list from `agent/mcpClient.ts`'s `getToolSchemas()`, which asks the
MCP server what it has — adding a tool to `mcp-server/index.ts`'s registry is
enough; nothing in the orchestrator needs to change to expose it. What's left
of the system prompt is genuinely just conduct now, no mechanical scaffolding
to hand-maintain — and that conduct prose lives in `config/system-prompt.md`,
gitignored, since that's sensitive business behavior, not something that
belongs in a public repo.

---

## Staff portal

A second, human client of the same tool server — a queue for the referrals `run_policy_checks` and `generate_offer` hold instead of answering (a score just under the floor, or an offer over `referralPrincipalThreshold`), plus a general view of every application. The customer never waits on this beyond their own next message: there's no other contact channel, so resolution is delivered whenever they next write in.

Run it:

```bash
docker compose up -d        # Keycloak, dev mode, no TLS — see docker-compose.yml
npm run dev:staff            # staff web on :5174, staff api on :8791
```

Needs the main `npm run dev` (or at least `mcp-server`) already running. Sign in as the seeded dev user — `officer1` / `password123`, defined in `keycloak/realm-export.json` and imported automatically on first boot. None of this — the realm, the client secret, the admin password — is fit to be anything but local and disposable.

One MCP server, two audiences: `mcp-server/index.ts` classifies every connection with `authenticate()` (no bearer token → the customer orchestrator, unchanged; a verified staff JWT → `role: "staff"`) and `agent/staffTools.ts`'s three tools are the only ones gated by it (`canAccess: (auth) => auth.role === "staff"`) — a customer-agent connection never sees they exist. `resolve_referral` takes the reviewer's identity from that verified token, never from its arguments.

---

## React Native port

`Chat.tsx` is the only file with meaningful web coupling. The port is mechanical:

- `div` / `span` → `View` / `Text`, `input` → `TextInput`
- `.msgs` → `FlatList` with `inverted`
- `styles.css` → `StyleSheet.create`, keeping the same token names
- `agentStream.ts`'s `fetch` + manual SSE reader works as-is in React Native;
  point it at your deployed backend
- `agent/` and `domain/` never move to the client at all now — they're
  server-only, so there's nothing there to port

The tab layout already collapses to a single pane under 900px, so the customer
view is the mobile view.
