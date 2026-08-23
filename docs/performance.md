# Latency QA

What a customer actually waits, measured end to end through the real HTTP API — no mocks, no internal shortcuts. Reproduce with `npm run bench` against a running stack.

*Measured 2026-08-23 · 65 turns across 20 journeys · `claude-sonnet-4-6` · concurrency 4 · single laptop, home network. Figures below are the post-streaming run.*

---

## Headline

| Metric | p50 | p95 | max |
|---|---|---|---|
| **Time to first token** (customer starts reading) | **10.1s** | **21.6s** | — |
| Time to complete reply | 10.6s | 22.8s | 24.2s |
| Turns exceeding 7s | 69.2% | | |

Since the reply streams, "time to first token" is the number that matches what a customer perceives; "time to complete reply" is when the last word lands.

This is slow, and the rest of this page is about where it goes — which turns out not to be where you would guess.

## Where the time goes

| Metric | Value |
|---|---|
| **Time inside this app's own tools** | **1.9% of turn time** |
| Tool execution per turn — p50 | 25ms |
| Tool execution per turn — p95 | ~2,500ms |
| Model round-trips per turn — median | 5 |
| Implied latency per model round-trip | ~2.4–2.7s |

**Essentially none of the latency is this codebase.** Bureau lookups, policy evaluation, DSR maths, offer generation and SQLite reads together account for under two percent of the wall clock, and a median turn spends 25 milliseconds inside them. Everything else is waiting on the Anthropic API.

The one tool that is genuinely slow is `run_fraud_check` when it escalates — that is the p95, and it is slow because it is itself a model call. Every other tool is single-digit or low-double-digit milliseconds.

So the lever is round-trips, not code.

## Round-trips per turn

A turn costs one model call per tool the agent uses, plus one to settle, plus one more to compose the customer-facing reply. Median: five calls. At roughly 2.4–2.7s each, that is the whole of the ten-second median.

| Turn | Tools used | First token | Complete | Streaming gain |
|---|---|---|---|---|
| 0 — greeting | 0.0 | 3.4s | 3.9s | 0.5s |
| 1 — identity, credit file, fraud check | 3.0 | 12.1s | 12.8s | 0.4s |
| 2 — policy, affordability, income check | 3.9 | 13.6s | 14.8s | 1.1s |
| 3 — offer | 1.1 | 7.1s | 9.1s | **1.8s** |

## Streaming: real, but smaller than predicted

An earlier revision of this document called streaming the final reply "the single biggest perceived-latency win available." **That was wrong, and the measurement is why it's worth recording.**

Streaming was implemented. It does not change total time — by design — but it moves when the customer starts reading:

| Streaming gain (complete − first token) | Value |
|---|---|
| p50 | 679ms |
| p90 | 1,745ms |
| p95 | 1,883ms |
| max | 2,282ms |

Roughly two thirds of a second at the median, not the two-and-a-half seconds predicted. The reasoning error was assuming the ~2.5s per model call was mostly *generation*, which streaming recovers. It isn't. It is mostly **time to first token** — prefill over a growing conversation, plus queueing — and streaming cannot touch that. A 126-character reply generates in about 600ms; the ten seconds in front of it is the part that matters, and it is untouched.

Where it does pay is exactly where you would want it to: the gain scales with message length, so the **offer** — the longest, most information-dense message in the journey, carrying principal, rate, tenor, instalment and total repayable — gains 1.8s, while a short follow-up question gains 0.4s. The customer starts reading the numbers they care about nearly two seconds sooner.

Worth keeping. Just not the headline fix.

## Worth doing next

Roughly in order of value per unit of effort:

1. **Attack time-to-first-token, not generation.** This is where the ten seconds actually is. The lever is fewer and cheaper round-trips: shorter conversation history sent per call, prompt caching on the system prompt and tool schemas (which are identical on every call and currently re-sent in full), and a smaller model for the mechanical steps.
2. **Skip the second call when there is nothing to disclose.** On a turn that used no tools and where no check has yet run, the draft cannot contain a leak. Worth ~2.5s off the greeting, which currently costs 3.4s to first token while calling nothing at all. The condition must be "no tool has ever run on this application", not "no tool ran this turn", or it reopens the leak on later conversational turns.
3. **Let the model batch independent tool calls.** Tools run serially because several have real sequencing preconditions. `get_credit_score` → `get_bureau_report` → `run_fraud_check` is a genuine chain, but it is worth confirming whether any pair is actually independent before accepting three sequential round-trips as fixed.
4. **Revisit the 7s ambient threshold.** It fires on 69% of turns, close to "always" — either that is correct, or the threshold should rise so the content stays a signal rather than furniture.

## What this says about the safety design

The two-call reply pattern — never trusting the model's first draft, because it bleeds reasoning into customer-facing text — **costs about 2.4–2.7 seconds on every turn**, roughly a quarter of the median wait. That is the price of the disclosure control, measured rather than assumed, and given what it prevents it is defensible.

It also, unexpectedly, made streaming *possible*. A single-call design could not safely stream: it would be pushing text to the screen that might contain a leak, with no chance to inspect it first. The two-call split guarantees one call whose entire output is customer-facing by construction. The expensive control paid for the optimisation.

## Caveats

- **n = 65.** A p95 over 65 samples is indicative, not tight.
- **Run-to-run variance is real.** The pre-streaming run measured a 11.4s p50 against this run's 10.6s; that difference is noise, not a streaming effect. Streaming does not change total time. Only the first-token figures should be read as an improvement.
- **Concurrency 4** on one laptop over a home network. Model latency dominates and varies with load, region and model choice; treat the shape as durable and the absolute numbers as this-machine-on-this-day.
- **`claude-sonnet-4-6`.** A different model moves every number here.
- Timings are wall-clock from the client's perspective — the right frame for a customer-experience metric, but inclusive of local HTTP and SSE overhead.
