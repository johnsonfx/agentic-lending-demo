import { callModel } from "./modelClient.js";
import { getFraudReviewPrompt } from "../fraudReviewPromptContent.js";
import type { FraudSignal } from "../domain/types.js";

/**
 * A second agent for fraud review. It cannot approve or decline a loan, only
 * rule on the fraud question in front of it. That narrowness is the
 * control: unlike the orchestration agent, it has no other context to be
 * argued around by. 
 */

export interface FraudReviewResult {
  decision: "CLEAR" | "FLAG";
  rationale: string;
}

export async function runFraudReview(signals: FraudSignal[]): Promise<FraudReviewResult> {
  const system = await getFraudReviewPrompt();
  const text = await callModel({
    system,
    messages: [{ role: "user", content: `SIGNALS:\n${JSON.stringify(signals, null, 2)}` }],
  });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Fraud review did not return JSON.");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (parsed.decision !== "CLEAR" && parsed.decision !== "FLAG")
    throw new Error(`Fraud review returned an unrecognised decision: ${parsed.decision}`);
  return parsed;
}
