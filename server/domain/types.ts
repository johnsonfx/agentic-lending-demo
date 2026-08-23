export interface Facility {
  type: string;
  issuer: string;
  limit: number;
  outstanding: number;
  monthlyCommitment: number;
  status: string;
  unsecured: boolean;
}

export interface DefaultRecord {
  date: string;
  issuer: string;
  amount: number;
  status: string;
}

export interface CustomerRecord {
  name: string;
  /** Exactly how the agent should address this person. Held as data rather
   *  than inferred from `name`, because working out which part of a name to
   *  use is a convention question, not a language one — and a model asked to
   *  guess will guess wrong or, worse, invent the missing part. */
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
}

/** What get_bureau_report assembles: the customer record plus derived totals. */
export interface BureauReport extends CustomerRecord {
  totalCommitment: number;
  unsecuredOutstanding: number;
}

export interface FraudSignal {
  signal: string;
  detail: string;
}

export interface FraudResult {
  decision: "PASS" | "REVIEW" | "FLAG";
  signals: FraudSignal[];
  reviewed?: boolean;
  rationale?: string;
}

export interface Affordability {
  income: number;
  currentDSR: number;
  headroom: number;
  maxPrincipal: number;
  rate: number | null;
  band?: string;
}

export interface PolicyCheck {
  rule: string;
  pass: boolean;
  observed: string;
}

export interface Offer {
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

export interface BankInfo {
  bank: string;
  masked: string;
  name: string;
}

export interface Receipt {
  status: string;
  reference: string;
  principal: number;
  processing_fee: number;
  amount_credited: number;
  beneficiary: string;
  value_date: string;
  first_repayment_due: string;
}

/** The full per-application record — was newSession()'s in-memory shape,
 *  now loaded from and saved back to a DB row per turn. */
export interface ApplicationState {
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
}

export function newApplicationState(): ApplicationState {
  return {
    customerId: null,
    bureau: null,
    fraudPassed: false,
    fraudDecision: null,
    incomePassed: false,
    incomeDecision: null,
    policyRead: false,
    affordability: null,
    checksPassed: false,
    offer: null,
    accepted: false,
    bank: null,
    receipt: null,
  };
}

export interface ToolError {
  error: string;
  detail: string;
}

export interface ToolDefinition {
  step: number;
  signature: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

/* ---- UI-facing event log shapes, shared with the client ---------------- */

export interface ChatMsg {
  role: "agent" | "customer" | "system";
  text: string;
}

export interface TraceEntry {
  id: string;
  kind: "thought" | "tool" | "error";
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  done: boolean;
  result?: unknown;
  ms?: number;
}
