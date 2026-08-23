/**
 * The customer-facing agent: one loan application, start to finish, built on
 * Anthropic's native tool-use.
 *
 *      model call ──▶ content blocks (text and/or tool_use)
 *                        │
 *                        ├─ no tool_use? → draft reply, see below
 *                        └─ tool_use present → text alongside the call goes
 *                             to the trace only; run each tool serially,
 *                             feed the results back, go round again
 *
 * The turn-ending reply is never relayed on the model's first attempt. Free
 * text has no structural wall between "internal note" and "customer reply",
 * and that first draft reliably bleeds reasoning into what the customer sees
 * — "The fraud check has passed. Could you tell me your income?" — even with
 * an explicit rule and a worked example in the conduct prompt. So a second,
 * narrowly-scoped call produces the message that actually gets sent: the
 * same "escalate only the case that needs it" shape run_fraud_check uses for
 * its ambiguous verdicts, applied to every reply.
 *
 * MAX_STEPS is the circuit breaker — a stuck agent that keeps calling is an
 * unbounded bill.
 *
 * Tool calls run serially even though native tool-use permits several per
 * turn: these tools have real sequencing preconditions (assess_affordability
 * needs read_policy_document to have run), so running them concurrently
 * risks racing two dependent calls. Worth revisiting only for a tool set
 * that is genuinely parallel-safe.
 */

import Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL, type ChatMessage } from "./modelClient.js";
import { buildSystemPrompt, SESSION_START } from "./prompt.js";
import { getToolSchemas, callTool } from "./mcpClient.js";

const MAX_STEPS = 10;

/** Only genuinely long waits get anything. A turn that resolves inside seven
 *  seconds shows the typing dots and nothing else. */
const AMBIENT_MARKS_MS = [7000, 15000];

/**
 * Wait-time content is ephemeral UI, not chat.
 *
 * These lines stream as `waiting` events: never appended to the transcript,
 * never persisted, cleared the instant a real reply arrives. That is the
 * whole design. Sent as chat messages they read as the bank speaking — an
 * unprompted "give me a second" ahead of the greeting, a stray fact left
 * sitting above a rejection. Beside the typing indicator instead, nothing
 * survives the wait it was covering. The dots alone carry "still here", so
 * there is no acknowledgement line.
 *
 * The copy is pre-approved (config/ancillary.md), never model-generated.
 * Generating it would put unreviewed claims about the bank's own products in
 * front of a customer with no tool behind them — what this app refuses to do
 * with a score or a rate — and a model call costs the very seconds it would
 * be covering.
 *
 * It is non-credit and outcome-neutral, which is what lets it run on a plain
 * clock with no gate on where the application has reached. Content that
 * varied with journey state would make the drip itself a signal: "I was
 * shown something, so my file went to review." Elapsed time is not a secret;
 * the customer is watching the same clock.
 */
function armAmbient(
  emit: Emit,
  ancillary: readonly string[],
  alreadySaid: readonly string[]
): { cancel: () => void } {
  // Anything this customer has already been shown, on any earlier turn of
  // this application, is out — a repeated "fun fact" is worse than silence.
  const blocks = ancillary.filter((b) => !alreadySaid.includes(b));

  const timers = AMBIENT_MARKS_MS.map((ms) =>
    setTimeout(() => {
      const [line] = blocks.splice(Math.floor(Math.random() * blocks.length), 1);
      if (line) emit.waiting(line);
    }, ms)
  );

  return { cancel: () => timers.forEach(clearTimeout) };
}

/**
 * The second call **rewrites the draft**; it does not decide afresh what to
 * say. That distinction is load-bearing.
 *
 * The draft is dropped from `history` before this call, so an author-style
 * instruction leaves the second call re-deriving the reply from tool results
 * alone — and any decision the draft reached that isn't visible in tool state
 * is simply lost. That is not hypothetical: asked to disburse with a bank
 * name and account number but no account name, the model correctly declined
 * to call `validate_bank_account` (which requires all three) and put "I still
 * need the name on the account" in its draft. Nothing in the tool results
 * recorded that, so the reply came back as "Disbursing the funds now" — an
 * action that had not happened, while the question that would have unblocked
 * it went only to the trace. The customer waited on a disbursement that was
 * never coming.
 *
 * Handing the draft over keeps the substance and strips only the disclosure,
 * which is also a far narrower task than composing from scratch — the model
 * is transforming a sentence rather than re-deciding a step.
 */
function cleanReplyInstruction(draft: string): string {
  const rules =
    "Warm and personal, using their name if you know it, in your own natural voice. " +
    "Never mention a check, a rule, a tool, or what just happened, and never say an action " +
    "is done or under way unless a tool in this conversation has already confirmed it. " +
    "Output the message and nothing else.";

  if (!draft) return `[SYSTEM] Write the exact message to send to the customer right now. ${rules}`;

  return (
    "[SYSTEM] Below is your own draft of what to say next. Send that message, rewritten so it " +
    "contains nothing but the message itself. Keep exactly what you decided to say or ask — the " +
    "same question, the same information, the same decision — and change only the wording. " +
    `${rules}\n\nDRAFT:\n${draft}`
  );
}

export interface Emit {
  /** The finished message. Persisted to the transcript and rehydrated on
   *  refresh — the deltas below are presentation only. */
  say: (text: string) => void;
  /** One chunk of the final reply as it is generated, for progressive
   *  rendering. Never persisted; `say` always follows with the whole text. */
  sayDelta: (chunk: string) => void;
  /** Transient "still working" content. Streamed to the open connection and
   *  deliberately NOT recorded in the transcript — it exists only for as long
   *  as the customer is waiting, and leaves nothing behind. */
  waiting: (text: string) => void;
  thought: (text: string) => void;
  toolStart: (name: string, args: Record<string, unknown>) => string;
  toolEnd: (id: string, result: unknown, ms: number) => void;
  error: (message: string) => void;
}

export async function runApplicationAgent({
  applicationId, history, conduct, emit, ancillary = [], alreadySaid = [],
}: {
  applicationId: string;
  history: ChatMessage[];
  conduct: string;
  emit: Emit;
  /** Wait-time content blocks; see armAmbient. Empty means a silent wait. */
  ancillary?: readonly string[];
  /** Everything the agent has already said on this application, so a block
   *  is never shown to the same customer twice. */
  alreadySaid?: readonly string[];
}): Promise<void> {
  const system = buildSystemPrompt(conduct);
  const tools = await getToolSchemas();

  // Armed once for the whole turn, cancelled as soon as there is a real
  // reply — so a turn that resolves quickly shows nothing at all.
  const ambient = armAmbient(emit, ancillary, alreadySaid);
  const cancelAmbient = () => ambient.cancel();

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create({ model: MODEL, max_tokens: 1000, system, messages: history, tools });
      } catch (e) {
        emit.error((e as Error).message);
        return;
      }

      history.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );

      if (toolUses.length === 0) {
        const draft = textBlocks.map((b) => b.text).join("").trim();
        if (draft) emit.thought(draft);
        history.pop(); // drop the draft turn — the clean reply below replaces it

        // Stand the drip down *before* composing the reply, not after: no
        // tool calls are left, so the answer is one model call away. A line
        // that fires inside that window lands moments ahead of the thing the
        // customer was actually waiting for, which reads worse than silence.
        cancelAmbient();

        // Streamed, unlike every other call in this file. The customer reads
        // from the first token — a few hundred milliseconds — instead of
        // waiting the two-odd seconds it takes to compose the whole message.
        //
        // Only this call may be streamed, and only because of the two-call
        // split above: its output is customer-facing by construction, so
        // there is nothing to inspect before it goes on screen. The draft
        // call must never be — its whole purpose is to be discarded. The
        // tradeoff is that once a token is out it cannot be taken back, so a
        // future belt-and-braces check on the finished text (a refusal on
        // anything containing a tool name, say) would mean buffering again.
        let cleanResponse: Anthropic.Message;
        try {
          const stream = anthropic.messages.stream({
            model: MODEL,
            max_tokens: 300,
            system,
            messages: [
              ...history,
              { role: "user", content: cleanReplyInstruction(draft) },
            ],
          });
          stream.on("text", (chunk) => emit.sayDelta(chunk));
          cleanResponse = await stream.finalMessage();
        } catch (e) {
          // Anything already on screen is abandoned rather than left standing
          // as a truncated message — see the client's `error` handling.
          emit.error((e as Error).message);
          return;
        }

        const text = cleanResponse.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (text) {
          // The deltas were presentation; this is the transcript. `say` is
          // still what gets persisted and what a refresh rehydrates from.
          emit.say(text);
          history.push({ role: "assistant", content: text });
        }
        return;
      }

      // Text alongside a tool call is never customer-facing, but it is
      // exactly the reasoning the trace wants — so it becomes the REASON
      // entry rather than reaching the chat.
      for (const t of textBlocks) {
        const text = t.text.trim();
        if (text) emit.thought(text);
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const id = emit.toolStart(toolUse.name, toolUse.input as Record<string, unknown>);
        const t0 = performance.now();

        let outcome: { result: unknown; isError: boolean };
        try {
          outcome = await callTool(toolUse.name, toolUse.input as Record<string, unknown>, applicationId);
        } catch (e) {
          outcome = { result: { error: "TOOL_CALL_FAILED", detail: (e as Error).message }, isError: true };
        }

        emit.toolEnd(id, outcome.result, Math.round(performance.now() - t0));
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(outcome.result),
          is_error: outcome.isError,
        });
      }

      // All results from one turn go back in a single user message — never
      // split across multiple, per Anthropic's guidance for multi-tool turns.
      history.push({ role: "user", content: toolResults });
    }

    emit.error(`Stopped after ${MAX_STEPS} steps without settling.`);
  } finally {
    // Backstop for every early return above (model errors, tool failures) —
    // a pending timer must never fire into a turn that's already over.
    cancelAmbient();
  }
}

export { SESSION_START };
