import React, { useCallback, useEffect, useState } from "react";

/* ---- shapes returned by staff-server's /api routes ---------------------
 * Mirrors server/domain/types.ts. Duplicated rather than imported — this is
 * a separate vite root from the customer client, and the two independent
 * roots make a cross-root import more trouble than the duplication; worth
 * reconsidering only if a third client ever needs the same shapes. */

interface ApplicationSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  customerName: string | null;
  referralStatus: "PENDING" | "RESOLVED" | null;
  referralReason: "NEAR_THRESHOLD_DECLINE" | "HIGH_PRINCIPAL" | null;
  outcome: string;
}

interface ChatMsg {
  role: "agent" | "customer" | "system";
  text: string;
}

interface TraceEntry {
  id: string;
  kind: "thought" | "tool" | "error";
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  done: boolean;
  result?: unknown;
  ms?: number;
}

interface ReferralRecord {
  status: "PENDING" | "RESOLVED";
  reason: "NEAR_THRESHOLD_DECLINE" | "HIGH_PRINCIPAL";
  detail: string;
  pendingResult: unknown;
  raisedAt: string;
  reviewerId: string | null;
  reviewerName: string | null;
  decision: "UPHOLD" | "OVERTURN" | null;
  notes: string | null;
  resolvedAt: string | null;
}

interface Facility {
  type: string;
  issuer: string;
  limit: number;
  outstanding: number;
  monthlyCommitment: number;
  status: string;
  unsecured: boolean;
}

interface DefaultRecord {
  date: string;
  issuer: string;
  amount: number;
  status: string;
}

interface BureauReport {
  name: string;
  preferredName: string;
  age: number;
  employment: string;
  employmentMonths: number;
  score: number;
  scoreBand: string;
  facilities: Facility[];
  defaults: DefaultRecord[];
  hardEnquiries6m: number;
  oldestAccountYears: number;
  totalCommitment: number;
  unsecuredOutstanding: number;
}

interface FraudSignal {
  signal: string;
  detail: string;
}

interface FraudResult {
  decision: "PASS" | "REVIEW" | "FLAG";
  signals: FraudSignal[];
  reviewed?: boolean;
  rationale?: string;
}

interface Affordability {
  income: number;
  currentDSR: number;
  headroom: number;
  maxPrincipal: number;
  rate: number | null;
  band?: string;
}

interface PolicyCheck {
  rule: string;
  pass: boolean;
  observed: string;
}

interface Offer {
  principal: number;
  tenor_months: number;
  rate_pa: number | null;
  band?: string;
  monthly_instalment: number;
  total_repayable: number;
  total_interest: number;
  processing_fee: number;
  net_proceeds: number;
  projected_dsr: string;
  capped_to_policy_maximum: boolean;
  offer_ref: string;
  valid_until: string;
}

interface BankInfo {
  bank: string;
  masked: string;
  name: string;
}

interface Receipt {
  status: string;
  reference: string;
  principal: number;
  processing_fee: number;
  amount_credited: number;
  beneficiary: string;
  value_date: string;
  first_repayment_due: string;
}

interface ApplicationState {
  customerId: string | null;
  bureau: BureauReport | null;
  fraudPassed: boolean;
  fraudDecision: FraudResult | null;
  incomePassed: boolean;
  incomeDecision: FraudResult | null;
  policyRead: boolean;
  affordability: Affordability | null;
  checksPassed: boolean;
  offer: Offer | null;
  accepted: boolean;
  bank: BankInfo | null;
  receipt: Receipt | null;
  referral: ReferralRecord | null;
}

interface ApplicationDetail {
  id: string;
  state: ApplicationState;
  msgs: ChatMsg[];
  trace: TraceEntry[];
}

/** Wraps fetch: a 401 means the session is gone (never logged in, or the
 *  refresh token itself expired) — send the browser to sign in rather than
 *  rendering a broken screen. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (res.status === 401) {
    window.location.href = "/auth/login";
    throw new Error("redirecting to sign-in");
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

const REASON_LABEL: Record<string, string> = {
  NEAR_THRESHOLD_DECLINE: "Score near threshold",
  HIGH_PRINCIPAL: "High principal",
};

const sgd = (n: number) => `S$${n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The latest result for a given tool name, scanning trace in order — the
 *  only place a run_policy_checks' per-rule breakdown exists for an
 *  application that was never referred (state only keeps the boolean
 *  `checksPassed`, not which rules passed). "Latest" matters on a resumed
 *  referral, where the same tool genuinely runs twice. */
function latestToolResult<T>(trace: TraceEntry[], name: string): T | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const t = trace[i];
    if (t.kind === "tool" && t.name === name && t.done && t.result != null) return t.result as T;
  }
  return null;
}

export default function App() {
  const [authed, setAuthed] = useState<null | boolean>(null);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    fetch("/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setAuthed(!!d.authenticated);
        setUsername(d.username ?? null);
      })
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="staff shell"><p className="dim">Loading…</p></div>;
  if (!authed) {
    return (
      <div className="staff shell centered">
        <div className="signin">
          <h1>Staff portal</h1>
          <p className="dim">Sign in with your staff account to review referred applications.</p>
          <a className="btn primary" href="/auth/login">Sign in</a>
        </div>
      </div>
    );
  }

  return <Dashboard username={username} />;
}

function Dashboard({ username }: { username: string | null }) {
  const [rows, setRows] = useState<ApplicationSummary[]>([]);
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "RESOLVED">("PENDING");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api<ApplicationSummary[]>(`/api/applications?status=${filter}`)
      .then(setRows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(load, [load]);

  return (
    <div className="staff shell">
      <header className="topbar">
        <h1>Staff portal</h1>
        <div className="who">
          <span className="dim">{username}</span>
          <a href="/auth/logout" className="btn ghost">Sign out</a>
        </div>
      </header>

      <div className="body">
        <aside className="listpane">
          <div className="tabs">
            {(["PENDING", "RESOLVED", "ALL"] as const).map((f) => (
              <button key={f} className={f === filter ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "PENDING" ? "Queue" : f === "RESOLVED" ? "Resolved" : "All"}
              </button>
            ))}
          </div>

          {loading && <p className="dim pad">Loading…</p>}
          {!loading && rows.length === 0 && <p className="dim pad">Nothing here.</p>}

          <ul className="rows">
            {rows.map((r) => (
              <li
                key={r.id}
                className={(r.id === selected ? "on " : "") + (r.referralStatus === "PENDING" ? "pending" : "")}
                onClick={() => setSelected(r.id)}
              >
                <div className="row-top">
                  <span className="name">{r.customerName ?? "Unknown"}</span>
                  {r.referralStatus === "PENDING" && <span className="pill pending">Pending</span>}
                </div>
                <div className="row-bottom">
                  <span className="outcome">{r.outcome.replaceAll("_", " ").toLowerCase()}</span>
                  {r.referralReason && <span className="reason">{REASON_LABEL[r.referralReason]}</span>}
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="detailpane">
          {selected ? (
            <Detail id={selected} onResolved={load} />
          ) : (
            <p className="dim centered-msg">Select an application to review.</p>
          )}
        </main>
      </div>
    </div>
  );
}

/* ---- status tracker ----------------------------------------------------
 * One horizontal read of where an application has gotten to, derived
 * entirely from booleans/nullables already on `state` — no new backend
 * data. A pending referral interrupts whichever step raised it, rather
 * than showing as "not reached yet", since that's what's actually true. */

type StepStatus = "done" | "fail" | "pending" | "todo";

function StatusTracker({ state }: { state: ApplicationState }) {
  const referralBlocksPolicy = state.referral?.status === "PENDING" && state.referral.reason === "NEAR_THRESHOLD_DECLINE";
  const referralBlocksOffer = state.referral?.status === "PENDING" && state.referral.reason === "HIGH_PRINCIPAL";

  const steps: { label: string; status: StepStatus }[] = [
    { label: "Identity", status: state.customerId ? "done" : "todo" },
    { label: "Bureau", status: state.bureau ? "done" : "todo" },
    {
      label: "Fraud check",
      status: !state.fraudDecision ? "todo" : state.fraudDecision.decision === "FLAG" ? "fail" : "done",
    },
    {
      label: "Income check",
      status: !state.incomeDecision ? "todo" : state.incomeDecision.decision === "FLAG" ? "fail" : "done",
    },
    {
      label: "Policy checks",
      status: referralBlocksPolicy ? "pending" : !state.affordability ? "todo" : state.checksPassed ? "done" : "fail",
    },
    {
      label: "Offer",
      status: referralBlocksOffer ? "pending" : state.offer ? "done" : state.checksPassed ? "todo" : "todo",
    },
    { label: "Accepted", status: state.accepted ? "done" : "todo" },
    { label: "Bank validated", status: state.bank ? "done" : "todo" },
    { label: "Disbursed", status: state.receipt ? "done" : "todo" },
  ];

  return (
    <div className="tracker">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          <div className={"step " + s.status}>
            <span className="dot" />
            <span className="steplabel">{s.label}</span>
          </div>
          {i < steps.length - 1 && <span className="connector" />}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ---- why the model decided what it decided ------------------------------
 * Curated from the same data the agent itself relayed or acted on — never
 * anything the agent said in the chat, since what reaches the customer is
 * deliberately generic (see docs/key-learnings.md's non-disclosure
 * sections). Staff see the real reason here; the applicant never does. */

function FraudBlock({ title, result }: { title: string; result: FraudResult | null }) {
  if (!result) return null;
  const cls = result.decision === "PASS" ? "ok" : result.decision === "FLAG" ? "bad" : "warn";
  return (
    <div className="rationale-block">
      <div className="rationale-head">
        <span className="rtitle">{title}</span>
        <span className={"tag " + cls}>{result.decision}</span>
        {result.reviewed && <span className="tag ai">AI-reviewed</span>}
      </div>
      {result.signals.length > 0 && (
        <ul className="signals">
          {result.signals.map((s, i) => (
            <li key={i}>
              <code>{s.signal}</code> — {s.detail}
            </li>
          ))}
        </ul>
      )}
      {result.rationale && <p className="rationale-text">{result.rationale}</p>}
    </div>
  );
}

function DecisionRationale({ state, trace }: { state: ApplicationState; trace: TraceEntry[] }) {
  const policyResult = latestToolResult<{ decision: string; checks: PolicyCheck[]; failed_rules: string[] }>(
    trace,
    "run_policy_checks"
  );

  return (
    <section className="rationale">
      <h2>Why</h2>
      <FraudBlock title="Fraud check" result={state.fraudDecision} />
      <FraudBlock title="Income check" result={state.incomeDecision} />

      {policyResult && (
        <div className="rationale-block">
          <div className="rationale-head">
            <span className="rtitle">Policy checks</span>
            <span className={"tag " + (policyResult.decision === "PROCEED" ? "ok" : "bad")}>{policyResult.decision}</span>
          </div>
          <table className="checks">
            <tbody>
              {policyResult.checks.map((c) => (
                <tr key={c.rule} className={c.pass ? "ok" : "bad"}>
                  <td className="rule">{c.pass ? "✓" : "✗"} {c.rule}</td>
                  <td className="observed">{c.observed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.offer && (
        <div className="rationale-block">
          <div className="rationale-head">
            <span className="rtitle">Offer</span>
            <span className="tag ok">{state.offer.capped_to_policy_maximum ? "CAPPED" : "AS REQUESTED"}</span>
          </div>
          <p className="rationale-text">
            {sgd(state.offer.principal)} over {state.offer.tenor_months}m at {state.offer.rate_pa}% p.a.
            {" — "}projected DSR {state.offer.projected_dsr}
            {state.offer.capped_to_policy_maximum && " (capped to the applicant's maximum principal)"}
          </p>
        </div>
      )}

      {!state.fraudDecision && !state.incomeDecision && !policyResult && !state.offer && (
        <p className="dim">No decision has been reached yet.</p>
      )}
    </section>
  );
}

/* ---- applicant details: bureau + affordability -------------------------- */

function ApplicantDetails({ state }: { state: ApplicationState }) {
  const b = state.bureau;
  const a = state.affordability;
  if (!b && !a) return null;

  return (
    <section className="applicant">
      <h2>Applicant</h2>
      <div className="grid">
        {b && (
          <>
            <div className="field"><span className="k">Name</span><span className="v">{b.name}</span></div>
            <div className="field"><span className="k">Age</span><span className="v">{b.age}</span></div>
            <div className="field"><span className="k">Employment</span><span className="v">{b.employment}</span></div>
            <div className="field"><span className="k">Bureau score</span><span className="v">{b.score} ({b.scoreBand})</span></div>
            <div className="field"><span className="k">Hard enquiries (6m)</span><span className="v">{b.hardEnquiries6m}</span></div>
            <div className="field"><span className="k">Oldest account</span><span className="v">{b.oldestAccountYears}y</span></div>
            <div className="field"><span className="k">Total commitments</span><span className="v">{sgd(b.totalCommitment)}/mo</span></div>
            <div className="field"><span className="k">Unsecured outstanding</span><span className="v">{sgd(b.unsecuredOutstanding)}</span></div>
          </>
        )}
        {a && (
          <>
            <div className="field"><span className="k">Declared income</span><span className="v">{sgd(a.income)}/mo</span></div>
            <div className="field"><span className="k">Current DSR</span><span className="v">{(a.currentDSR * 100).toFixed(1)}%</span></div>
            <div className="field"><span className="k">DSR headroom</span><span className="v">{sgd(a.headroom)}/mo</span></div>
            <div className="field"><span className="k">Max principal</span><span className="v">{sgd(a.maxPrincipal)}</span></div>
          </>
        )}
      </div>

      {b && b.facilities.length > 0 && (
        <table className="facilities">
          <thead>
            <tr><th>Facility</th><th>Issuer</th><th>Limit</th><th>Outstanding</th><th>Status</th></tr>
          </thead>
          <tbody>
            {b.facilities.map((f, i) => (
              <tr key={i}>
                <td>{f.type}</td>
                <td>{f.issuer}</td>
                <td>{sgd(f.limit)}</td>
                <td>{sgd(f.outstanding)}</td>
                <td className={f.status === "Current" ? "ok" : "bad"}>{f.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {b && b.defaults.length > 0 && (
        <div className="defaults">
          {b.defaults.map((d, i) => (
            <p key={i} className="default-line">
              {d.status} — {d.issuer}, {sgd(d.amount)}, {d.date}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function Detail({ id, onResolved }: { id: string; onResolved: () => void }) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => {
    setDetail(null);
    setNotes("");
    setErr(null);
    setShowTrace(false);
    api<ApplicationDetail>(`/api/applications/${id}`).then(setDetail).catch((e) => setErr(String(e)));
  }, [id]);

  const resolve = async (decision: "UPHOLD" | "OVERTURN") => {
    setSubmitting(true);
    setErr(null);
    try {
      await api(`/api/applications/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision, notes: notes || undefined }),
      });
      onResolved();
      const refreshed = await api<ApplicationDetail>(`/api/applications/${id}`);
      setDetail(refreshed);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (err) return <p className="err">{err}</p>;
  if (!detail) return <p className="dim">Loading…</p>;

  const referral = detail.state.referral;

  return (
    <div className="detail">
      <StatusTracker state={detail.state} />
      <DecisionRationale state={detail.state} trace={detail.trace} />
      <ApplicantDetails state={detail.state} />

      <section className="transcript">
        <h2>Conversation</h2>
        <div className="msgs">
          {detail.msgs.map((m, i) => (
            <div key={i} className={"b " + (m.role === "agent" ? "a" : m.role === "customer" ? "u" : "s")}>
              {m.text}
            </div>
          ))}
        </div>
      </section>

      <section className="tracepane">
        <button className="tracetoggle" onClick={() => setShowTrace((s) => !s)}>
          {showTrace ? "▾" : "▸"} Raw trace ({detail.trace.length})
        </button>
        {showTrace && (
          <div className="trace">
            {detail.trace.map((t) => (
              <div key={t.id} className={"trow " + t.kind}>
                <span className="tk">{t.kind === "tool" ? t.name : t.kind.toUpperCase()}</span>
                {t.text && <span className="tt">{t.text}</span>}
                {t.ms != null && <span className="tm">{t.ms}ms</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {referral && (
        <section className="referral">
          <h2>Referral — {REASON_LABEL[referral.reason]}</h2>
          <p className="detailline">{referral.detail}</p>

          {referral.status === "PENDING" ? (
            <div className="review">
              <textarea
                placeholder="Notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={submitting}
              />
              <div className="actions">
                <button className="btn primary" disabled={submitting} onClick={() => resolve("UPHOLD")}>
                  Uphold
                </button>
                <button className="btn danger" disabled={submitting} onClick={() => resolve("OVERTURN")}>
                  Overturn
                </button>
              </div>
            </div>
          ) : (
            <div className="resolved">
              <p>
                <strong>{referral.decision}</strong> by {referral.reviewerName} on{" "}
                {referral.resolvedAt && new Date(referral.resolvedAt).toLocaleString()}
              </p>
              {referral.notes && <p className="notes">{referral.notes}</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
