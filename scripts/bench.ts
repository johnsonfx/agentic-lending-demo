/**
 * Latency benchmark. Drives complete application journeys through the real
 * HTTP API — no mocks, no internal shortcuts — and records what a customer
 * would actually experience.
 *
 * The headline metric is time-to-reply: how long from sending a message to
 * the first customer-visible message coming back. Everything else exists to
 * explain that number, in particular the split between time spent inside
 * tools (this app's own code) and time spent waiting on the model.
 *
 *   npm run bench            # default 5 passes over the 4 fixtures
 *   BENCH_PASSES=2 npm run bench
 *
 * Requires the stack to already be running (npm run dev).
 */

import { performance } from "node:perf_hooks";

const API = process.env.BENCH_API || "http://localhost:8787";
const PASSES = Number(process.env.BENCH_PASSES || 5);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || 4);

/** One scripted journey per fixture. The opening "" is how the browser draws
 *  out the greeting, so it is a real turn a customer waits through. */
const JOURNEYS: Array<{ id: string; label: string; turns: string[] }> = [
  { id: "1234567", label: "clean approve", turns: ["", "1234567", "My gross monthly income is 8500.", "I would like 30000 over 36 months."] },
  { id: "2468135", label: "DSR-capped approve", turns: ["", "2468135", "My gross monthly income is 8500.", "I would like 30000 over 36 months."] },
  { id: "7654321", label: "policy decline", turns: ["", "7654321", "My gross monthly income is 8500."] },
  { id: "9911223", label: "fraud flag", turns: ["", "9911223"] },
];

interface TurnSample {
  fixture: string;
  label: string;
  turnIndex: number;
  /** ms from request start to the first customer-visible *token*. This is
   *  what the customer perceives as the wait, now that the reply streams. */
  msToFirstToken: number;
  /** ms from request start to the complete customer-visible message. */
  msToReply: number;
  /** ms from request start until the stream closed. */
  msToDone: number;
  toolCalls: number;
  /** Summed self-reported duration of every tool call in the turn. */
  toolMs: number;
  /** Whether the wait ran long enough to surface wait-time content. */
  showedAmbient: boolean;
}

async function runTurn(appId: string, text: string, meta: { fixture: string; label: string; turnIndex: number }): Promise<TurnSample> {
  const t0 = performance.now();
  const res = await fetch(`${API}/api/applications/${appId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) throw new Error(`turn failed: ${res.status}`);

  let msToFirstToken = NaN;
  let msToReply = NaN;
  let toolCalls = 0;
  let toolMs = 0;
  let showedAmbient = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);

      if (event === "sayDelta" && Number.isNaN(msToFirstToken)) msToFirstToken = performance.now() - t0;
      else if (event === "say") {
        if (Number.isNaN(msToReply)) msToReply = performance.now() - t0;
        // A turn with no deltas (an error path) still counts its reply as the
        // first thing the customer saw.
        if (Number.isNaN(msToFirstToken)) msToFirstToken = msToReply;
      }
      else if (event === "waiting") showedAmbient = true;
      else if (event === "toolEnd") {
        toolCalls += 1;
        toolMs += typeof parsed.ms === "number" ? parsed.ms : 0;
      }
    }
  }

  return { ...meta, msToFirstToken, msToReply, msToDone: performance.now() - t0, toolCalls, toolMs, showedAmbient };
}

async function runJourney(j: (typeof JOURNEYS)[number]): Promise<TurnSample[]> {
  const created = await fetch(`${API}/api/applications`, { method: "POST" }).then((r) => r.json());
  const samples: TurnSample[] = [];
  for (const [turnIndex, text] of j.turns.entries()) {
    samples.push(await runTurn(created.applicationId, text, { fixture: j.id, label: j.label, turnIndex }));
  }
  return samples;
}

/** Nearest-rank percentile — no interpolation, so every reported figure is a
 *  value that was actually observed. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
};

const s1 = (n: number) => (n / 1000).toFixed(1);

async function main() {
  const queue = Array.from({ length: PASSES }, () => JOURNEYS).flat();
  const all: TurnSample[] = [];
  let next = 0;

  const worker = async () => {
    while (next < queue.length) {
      const j = queue[next++];
      try {
        all.push(...(await runJourney(j)));
      } catch (e) {
        console.error(`  journey ${j.id} failed: ${(e as Error).message}`);
      }
    }
  };

  console.error(`running ${queue.length} journeys at concurrency ${CONCURRENCY}...`);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wall = performance.now() - t0;

  const replied = all.filter((s) => !Number.isNaN(s.msToReply));
  const reply = stats(replied.map((s) => s.msToReply));
  const firstToken = stats(replied.map((s) => s.msToFirstToken));
  const tool = stats(all.filter((s) => s.toolCalls > 0).map((s) => s.toolMs));
  const overThreshold = replied.filter((s) => s.msToReply > 7000).length;
  const toolShare = (all.reduce((a, s) => a + s.toolMs, 0) / all.reduce((a, s) => a + s.msToDone, 0)) * 100;

  const out = {
    generatedAt: new Date().toISOString(),
    config: { passes: PASSES, concurrency: CONCURRENCY, api: API },
    wallClockSeconds: +(wall / 1000).toFixed(1),
    turns: all.length,
    timeToFirstTokenMs: firstToken,
    timeToReplyMs: reply,
    toolTimePerTurnMs: tool,
    pctTurnsOverAmbientThreshold: +((overThreshold / replied.length) * 100).toFixed(1),
    pctOfTurnTimeInsideTools: +toolShare.toFixed(2),
    byFixture: Object.fromEntries(
      JOURNEYS.map((j) => {
        const rows = replied.filter((s) => s.fixture === j.id);
        return [j.id, { label: j.label, ...stats(rows.map((s) => s.msToReply)) }];
      })
    ),
    samples: all,
  };

  console.error(
    `\n  turns ${all.length}` +
      `\n  first token  p50 ${s1(firstToken.p50)}s  p95 ${s1(firstToken.p95)}s` +
      `\n  full reply   p50 ${s1(reply.p50)}s  p95 ${s1(reply.p95)}s  max ${s1(reply.max)}s` +
      `\n  tool time is ${toolShare.toFixed(1)}% of turn time  ·  ${out.pctTurnsOverAmbientThreshold}% of turns over 7s\n`
  );
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
