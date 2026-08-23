import React, { useState, useEffect, useCallback, useMemo } from "react";
import Chat from "./components/Chat.js";
import Trace from "./components/Trace.js";
import PolicyView from "./components/PolicyView.js";
import { streamAgentTurn } from "./agentStream.js";
import type { ChatMsg, TraceEntry } from "../server/domain/types.js";

/**
 * App owns three things and delegates everything else:
 *   applicationId — the server-side record this browser tab is talking to
 *   msgs/trace    — the two render streams, hydrated from SSE events
 *   policy        — fetched once, handed down to PolicyView as a prop
 *
 * Nothing here executes a tool or runs the agent loop any more — that's
 * server/index.ts's job. This is a thin client: send a message, render
 * whatever comes back over the stream.
 */

interface PolicyDoc {
  version: string;
  document: string;
}

interface Fixture {
  id: string;
  name: string;
}

export default function App() {
  const [tab, setTab] = useState("chat");
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [busy, setBusy] = useState(false);
  // Transient wait-time line shown beside the typing indicator. Never joins
  // msgs — it is cleared the moment the turn produces anything real.
  const [waiting, setWaiting] = useState<{ intro: string; text: string } | null>(null);
  // The reply as it arrives, token by token. Replaced wholesale by the real
  // message when `say` lands, so nothing here is ever the source of truth.
  const [streaming, setStreaming] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PolicyDoc | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);

  const runTurn = useCallback(async (appId: string, text: string | null) => {
    setBusy(true);
    setWaiting(null);
    setStreaming(null);
    try {
      await streamAgentTurn(appId, text, (event, data) => {
        switch (event) {
          case "sayDelta":
            setWaiting(null);
            setStreaming((s) => (s ?? "") + (data.text as string));
            break;
          case "say":
            setWaiting(null);
            setStreaming(null);
            setMsgs((m) => [...m, data as ChatMsg]);
            break;
          case "waiting":
            setWaiting({ intro: data.intro as string, text: data.text as string });
            break;
          case "thought":
          case "toolStart":
            setTrace((t) => [...t, data as TraceEntry]);
            break;
          case "toolEnd":
            setTrace((t) => t.map((e) => (e.id === data.id ? { ...e, done: true, result: data.result, ms: data.ms } : e)));
            break;
          case "error":
            setWaiting(null);
            // Drop any partial text rather than leaving a truncated message
            // standing as though it were complete.
            setStreaming(null);
            setMsgs((m) => [...m, data.msg as ChatMsg]);
            setTrace((t) => [...t, data.trace as TraceEntry]);
            break;
        }
      });
    } catch {
      setMsgs((m) => [...m, { role: "system", text: "The agent could not complete this step. Send your message again to retry." }]);
    } finally {
      setBusy(false);
      setWaiting(null);
      setStreaming(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [policyRes, fixturesRes] = await Promise.all([
        fetch("/api/policy").then((r) => r.json()),
        fetch("/api/fixtures").then((r) => r.json()),
      ]);
      if (cancelled) return;
      setPolicy(policyRes);
      setFixtures(fixturesRes);

      // A refresh mid-application reconnects to the same server-side record
      // instead of starting over — this is the actual point of the
      // migration, so it's worth preserving rather than always minting a
      // fresh id on mount.
      const existingId = sessionStorage.getItem("applicationId");
      if (existingId) {
        const record = await fetch(`/api/applications/${existingId}`).then((r) => (r.ok ? r.json() : null));
        if (!cancelled && record) {
          setApplicationId(existingId);
          setMsgs(record.msgs);
          setTrace(record.trace);
          return;
        }
        sessionStorage.removeItem("applicationId");
      }
      if (cancelled) return;

      const appRes = await fetch("/api/applications", { method: "POST" }).then((r) => r.json());
      if (cancelled) return;
      sessionStorage.setItem("applicationId", appRes.applicationId);
      setMsgs([{ role: "system", text: `Session opened · Policy ${policyRes.version}` }]);
      setApplicationId(appRes.applicationId);
      runTurn(appRes.applicationId, null);
    })();
    return () => {
      cancelled = true;
    };
  }, [runTurn]);

  const customerId = useMemo(() => {
    const entry = trace.find(
      (e) => e.kind === "tool" && e.name === "get_credit_score" && e.done && e.result && !(e.result as any).error
    );
    return entry ? ((entry.result as any).customer_id as string) : null;
  }, [trace]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy || !applicationId) return;
    setMsgs((m) => [...m, { role: "customer", text: t }]);
    runTurn(applicationId, t);
  };

  return (
    <div className="ald">
      <header className="ald-hd">
        <h1>Unsecured Personal Loan — Agentic Journey</h1>
        <span>ORCHESTRATION DEMO{policy ? ` · ${policy.version}` : ""}</span>
      </header>

      <nav className="tabs">
        {[["chat", "Customer"], ["trace", "Agent trace"], ["policy", "Policy"]].map(([k, label]) => (
          <button key={k} data-on={tab === k ? 1 : 0} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      <div className="body">
        <Chat active={tab === "chat"} msgs={msgs} busy={busy} waiting={waiting} streaming={streaming} onSend={send}
              fixtures={fixtures} showFixtures={!customerId && msgs.length <= 3} />
        <Trace active={tab === "trace"} entries={trace} />
        <PolicyView active={tab === "policy"} document={policy?.document ?? ""} />
      </div>
    </div>
  );
}
