/**
 * The credit policy's shape and its pure math — no data lives here. Every
 * threshold (maxDSR, bureau conditions, pricing bands, ...) is now read
 * from config/policy.docx's machine-readable parameter block, business-
 * editable without an engineer — see ../policyDocument.ts for how it's
 * loaded, parsed, and cached. What stays in code is the *algorithm*: how
 * those thresholds combine into a DSR, a price, an eligibility check. That
 * split — values in the document, logic in code — is deliberate: letting a
 * business team tune a number is safe; re-deriving decision logic from
 * parsed prose is not.
 */

export interface PricingTier {
  minScore: number;
  rate: number;
  band: string;
}

export interface PolicyConfig {
  version: string;
  effective: string;

  // §1 eligibility
  minAge: number;
  maxAge: number;
  minAnnualIncome: number;

  // §2 bureau conditions
  minScore: number;
  defaultLookbackMonths: number;
  maxHardEnquiries6m: number;

  // §3 affordability
  maxDSR: number;
  unsecuredIncomeMultiple: number;

  // §4 product
  minLoan: number;
  maxLoan: number;
  tenors: number[];
  pricing: PricingTier[];
  processingFeePct: number;

  // Human referral — see server/agent/tools.ts's referral state machine
  referralScoreMargin: number;
  referralPrincipalThreshold: number;
}

/* ---- shared calculation helpers -------------------------------------- */

/** Monthly instalment for an amortising loan. */
export const instalmentFor = (principal: number, annualPct: number, months: number): number => {
  const r = annualPct / 100 / 12;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
};

/** Inverse of instalmentFor — the largest principal a given instalment supports. */
export const principalFrom = (instalment: number, annualPct: number, months: number): number => {
  const r = annualPct / 100 / 12;
  return (instalment * (1 - Math.pow(1 + r, -months))) / r;
};

export const priceFor = (score: number, pricing: PricingTier[]): PricingTier | null =>
  pricing.find((p) => score >= p.minScore) || null;

export const monthsSince = (iso: string): number => {
  const d = new Date(iso), now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
};

export const sgd = (n: number): string =>
  "S$" + Number(n).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
