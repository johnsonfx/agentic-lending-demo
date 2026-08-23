import React, { useState, useRef, useEffect } from "react";
import type { TraceEntry } from "../../server/domain/types.js";

/**
 * The audit surface. Every model thought, every tool call with its arguments,
 * response and latency, in the order they happened. This is the part of the
 * demo that answers "but can you show me why it said that".
 */

interface StepDef {
  n: string;
  label: string;
  tools: string[];
}

const STEPS: StepDef[] = [
  { n: "01", label: "Credit score", tools: ["get_credit_score"] },
  { n: "02", label: "Bureau data", tools: ["get_bureau_report"] },
  { n: "03", label: "Fraud check", tools: ["run_fraud_check"] },
  { n: "04", label: "Policy & DSR", tools: ["read_policy_document", "assess_affordability", "run_income_check"] },
  { n: "05", label: "Bureau checks", tools: ["run_policy_checks"] },
  { n: "06", label: "Offer", tools: ["generate_offer"] },
  { n: "07", label: "Acceptance & account", tools: ["record_acceptance", "validate_bank_account"] },
  { n: "08", label: "Disbursement", tools: ["disburse_funds"] },
];

const failed = (r: any) => r && (r.error || r.valid === false || r.decision === "DECLINE" || r.decision === "FLAG");

interface TraceProps {
  active: boolean;
  entries: TraceEntry[];
}

export default function Trace({ active, entries }: TraceProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [entries]);

  const fired = entries.filter((e) => e.kind === "tool").map((e) => e.name);
  const stateOf = (s: StepDef) =>
    s.tools.every((t) => fired.includes(t)) ? "done"
      : s.tools.some((t) => fired.includes(t)) ? "run" : "idle";

  return (
    <section className="pane trace" data-on={active ? 1 : 0}>
      <div className="spine">
        {STEPS.map((s) => (
          <div key={s.n} className="st" data-s={stateOf(s)}>
            <b>{s.n}</b><em>{s.label}</em>
          </div>
        ))}
      </div>

      <div className="rows">
        {entries.length === 0 && (
          <div className="empty">
            Every tool the agent invokes is recorded here with its arguments, its
            response and its latency. Nothing reaches the customer that did not
            come from one of these calls.
          </div>
        )}

        {entries.map((e) => {
          if (e.kind === "thought")
            return (
              <div className="row" key={e.id}>
                <div className="top"><span className="tag k">REASON</span></div>
                <div className="th">{e.text}</div>
              </div>
            );

          if (e.kind === "error")
            return (
              <div className="row" key={e.id}>
                <div className="top"><span className="tag no">ERROR</span><span className="nm">{e.text}</span></div>
              </div>
            );

          const bad = failed(e.result);
          return (
            <div className="row" key={e.id}>
              <div className="top">
                <span className={"tag " + (!e.done ? "t" : bad ? "no" : "ok")}>
                  {!e.done ? "CALL" : bad ? "FAIL" : "OK"}
                </span>
                <span className="nm">{e.name}</span>
                <span className="ms">{e.done ? e.ms + "ms" : "…"}</span>
              </div>

              {e.args && Object.keys(e.args).length > 0 && <pre className="args">{JSON.stringify(e.args)}</pre>}

              {e.done && (
                <>
                  <button className="exp" onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}>
                    {open[e.id] ? "▾ hide response" : "▸ response"}
                  </button>
                  {open[e.id] && <pre>{JSON.stringify(e.result, null, 1)}</pre>}
                </>
              )}
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </section>
  );
}
