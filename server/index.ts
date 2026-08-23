/**
 * The backend. Holds the Anthropic API key, runs the orchestration loop and
 * every tool it calls, and is the sole reader/writer of application state —
 * the browser only ever sees chat messages and the trace, streamed over SSE.
 */

import express from "express";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createApplication, getApplication, saveApplicationChat } from "./applications.js";
import { runApplicationAgent, SESSION_START, type Emit } from "./agent/applicationAgent.js";
import { getToolSchemas } from "./agent/mcpClient.js";
import { getConductPrompt } from "./systemPromptContent.js";
import { getAncillaryContent } from "./ancillaryContent.js";
import { getPolicyDocument } from "./policyDocument.js";
import { CUSTOMERS } from "./domain/customers.js";
import type { ChatMsg, TraceEntry } from "./domain/types.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;

app.post("/api/applications", async (_req, res) => {
  try {
    const applicationId = await createApplication();
    res.json({ applicationId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "create_failed", detail: String((e as Error).message) });
  }
});

app.get("/api/applications/:id", async (req, res) => {
  const record = await getApplication(req.params.id);
  if (!record) return res.status(404).json({ error: "not_found" });
  res.json({ msgs: record.msgs, trace: record.trace });
});

app.get("/api/fixtures", (_req, res) => {
  // Demo-only convenience: the one-tap chips in the chat. Never expose
  // more than id + first name — the actual bureau data stays server-side.
  res.json(Object.entries(CUSTOMERS).map(([id, c]) => ({ id, name: c.name.split(" ")[0] })));
});

app.get("/api/policy", async (_req, res) => {
  try {
    res.json(await getPolicyDocument());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "policy_unavailable", detail: String((e as Error).message) });
  }
});

app.post("/api/applications/:id/messages", async (req, res) => {
  const record = await getApplication(req.params.id);
  if (!record) return res.status(404).json({ error: "not_found" });

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const { msgs, trace, history } = record;

  // A first turn carrying text must keep BOTH the session marker and what
  // the customer said — dropping either leaves the agent answering someone
  // it cannot see. One user turn rather than two, since the Messages API
  // expects roles to alternate.
  if (text) {
    const customerMsg: ChatMsg = { role: "customer", text };
    msgs.push(customerMsg);
  }
  if (history.length === 0) {
    history.push({ role: "user", content: text ? `${SESSION_START}\n\n${text}` : SESSION_START });
  } else if (text) {
    history.push({ role: "user", content: text });
  }

  const ancillary = await getAncillaryContent();

  const emit: Emit = {
    say: (t) => {
      const m: ChatMsg = { role: "agent", text: t };
      msgs.push(m);
      send("say", m);
    },
    // Progressive rendering only; the transcript is written by `say` when
    // the message is complete, so a delta never lands in msgs.
    sayDelta: (chunk) => send("sayDelta", { text: chunk }),
    // Streamed but never pushed to msgs — this is the whole point. Wait-time
    // content lives only on the open connection, so it can't be scrolled back
    // to, can't survive a refresh, and can't end up sitting in the transcript
    // above a decision it has nothing to do with.
    waiting: (t) => send("waiting", { intro: ancillary.intro, text: t }),
    thought: (t) => {
      const e: TraceEntry = { id: randomUUID(), kind: "thought", text: t, done: true };
      trace.push(e);
      send("thought", e);
    },
    toolStart: (name, args) => {
      const id = randomUUID();
      const e: TraceEntry = { id, kind: "tool", name, args, done: false };
      trace.push(e);
      send("toolStart", e);
      return id;
    },
    toolEnd: (id, result, ms) => {
      const idx = trace.findIndex((e) => e.id === id);
      if (idx !== -1) trace[idx] = { ...trace[idx], done: true, result, ms };
      send("toolEnd", { id, result, ms });
    },
    error: (message) => {
      const sysMsg: ChatMsg = { role: "system", text: "The agent could not complete this step. Send your message again to retry." };
      msgs.push(sysMsg);
      const e: TraceEntry = { id: randomUUID(), kind: "error", text: message, done: true };
      trace.push(e);
      send("error", { msg: sysMsg, trace: e });
    },
  };

  try {
    const conduct = await getConductPrompt();
    // Used to avoid repeating a wait-time block. Derived from the transcript
    // rather than tracked separately: survives a refresh, nothing to persist.
    const alreadySaid = msgs.filter((m) => m.role === "agent").map((m) => m.text);
    await runApplicationAgent({
      applicationId: req.params.id,
      history,
      conduct,
      emit,
      // Nothing on the opening turn: the customer hasn't asked for anything
      // yet, so there is no wait to fill — only the app introducing itself.
      ancillary: text ? ancillary.blocks : [],
      alreadySaid,
    });
  } catch (e) {
    console.error(e);
    emit.error((e as Error).message);
  } finally {
    await saveApplicationChat(req.params.id, { history, msgs, trace });
    send("done", {});
    res.end();
  }
});

// Fail fast: a business-edited document that's missing or malformed, or an
// unreachable MCP server, should stop the orchestrator at boot, not surface
// as a confusing error mid-conversation for the first customer to reach it.
// getAncillaryContent is in here to surface a missing content file in the boot
// log, not to gate the boot on it — it fails soft by design, since duller
// waits are not a reason to refuse to lend.
Promise.all([getPolicyDocument(), getConductPrompt(), getToolSchemas(), getAncillaryContent()])
  .then(() => {
    app.listen(PORT, () => console.log(`agent service on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error("Fatal: could not start orchestrator —", (e as Error).message);
    process.exit(1);
  });
