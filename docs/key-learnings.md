# Agentic Lending — Key Learnings

A running record of the decisions made building this agent, and why — written for anyone who needs the rationale without reading the code. Updated as the project continues.

*Last updated: 2026-10-01*

---

## Why an AI agent needs the same controls as a human underwriter

The single idea underneath most of what follows: **the AI never gets to be the source of truth for a number, a decision, or a rule.** Every score, rate, DSR figure, and approve/decline outcome is computed by ordinary code and handed to the agent to relay — never invented, never computed by the model itself. The agent's job is to hold a conversation and call the right tools in the right order; it is not trusted to do arithmetic or remember policy correctly, the same way a bank wouldn't trust a call-centre script to freelance the credit decision.

The practical version of this: **a rule the AI is only *asked* to follow isn't a control — it's a suggestion.** A system prompt that says "don't skip the affordability check" can be talked around by a sufficiently creative customer. A line of code that refuses to generate an offer until the affordability check has actually run cannot be. Wherever a rule genuinely matters — sequencing, disclosure, eligibility — it's enforced in code, not requested in a prompt. This principle got tested again later (see "A leak the prompt alone couldn't fix" below) and held up.

## Two agents, not one, for fraud review

Most of the application flow is one AI agent talking to the customer. But fraud detection uses two:

- A fast, automated rule check runs on every application (thin credit file, brand-new employment, unusual enquiry activity, income that doesn't match the applicant's existing credit limits). Clear-cut cases — obviously fine, or obviously synthetic/fraudulent — are resolved instantly, no AI involved at all.
- Only the genuinely ambiguous cases (a signal that's a little unusual but not damning) get escalated to a second, narrower AI reviewer. That reviewer sees *only* the specific signals in question — no name, no loan amount, no conversation history — and can only answer "looks fine" or "flag it." It cannot approve a loan, override policy, or do anything else.

Why split it this way: most applications never need AI judgment for fraud at all (cheaper, faster), and the one case that does gets a reviewer that's deliberately boxed in — it has no other context available to be argued or reasoned around, unlike the customer-facing agent which necessarily sees the whole conversation.

## A real fraud gap we found and closed: income inflation

Early on, the fraud check only looked at identity and application-velocity signals (thin credit file, new employment, too many recent applications). It never looked at the income the customer typed in — because income isn't collected until *after* the fraud check runs. A customer could enter an obviously inflated income and it would sail through untouched.

The fix: a second fraud signal that compares declared income against something the customer can't fabricate — the credit limits their *existing* lenders have already extended them. Those limits reflect income those lenders already verified. A declared income wildly out of proportion to existing limits is now flagged (and, if it's only moderately out of proportion, referred to the same secondary review rather than auto-rejected — a genuinely high earner who just hasn't built up matching credit yet shouldn't be punished by a hard rule).

## Rejections are never explained to the customer

Early versions of the agent explained *why* an application was declined — "your score is 618, below our minimum of 650; you have a written-off debt..." That's a real problem: an applicant who knows exactly which condition tripped a rejection can tune their next application to get around it specifically. The agent now gives only a generic, polite rejection message — "unfortunately your application wasn't successful this time" — for every kind of rejection (fraud hold, policy decline, income mismatch) equally, so the *pattern* of the message can't be used to infer which gate was the actual problem. The specifics are still fully recorded, just in the internal audit trail, not the chat.

The same principle applies to *how the agent talks about itself mid-conversation*: it doesn't narrate which check is currently running for the same reason — telling a customer which gate is live at which moment is itself information they could use to game the process.

## Making the numbers business-editable — and the tradeoff that comes with it

Originally, every policy number (credit score minimum, DSR ceiling, pricing bands, fraud thresholds) lived in code, reviewed and deployed by engineers. That's precise, but it means a risk or credit policy team can't tune a threshold without a code change and a deploy.

Both the credit policy and the fraud policy are now business-editable Word documents — no engineering involved to change a number, just a restart. Two things made this workable rather than risky:

- **Values move to the document; the decision logic stays in code.** A document can safely say "DSR ceiling is 55%" or "high enquiry velocity is 6 or more." It should *not* be trusted to encode "and if DSR fails but income is very high, allow it anyway" — that kind of logic, parsed out of business prose, is far more likely to be misread or subtly wrong than a single number. So thresholds are business-editable in both `config/policy.docx` and `config/fraud-policy.docx`; the rules for how thresholds combine into a decision remain an engineering change, living in the tool layer's own code (`server/agent/tools.ts`) rather than the domain modules — which, as a direct consequence, are now *just calculation helpers*. `domain/fraud.ts` and `domain/policy.ts` don't know what a "good" score is or what "thin file" means; they only know how to compute a ratio or an instalment. Reading either file tells you nothing about the actual policy — that's deliberate, not an accident of refactoring.
- **A broken document fails loudly, not silently.** If a business editor deletes a required number or fat-fingers a value, the system refuses to start and says exactly what's missing — it will never quietly run with a wrong number.

The residual risk, worth knowing about: each document still has a plain-English description of a rule *and* the actual enforced number in a separate section at the bottom. If someone updates one and forgets the other, the document could describe a different rule than the one actually enforced. That's a much smaller risk than the original code-vs-document split (it's now a documentation quality issue within one file, not a fundamental disagreement between code and policy) — but it isn't eliminated.

The same editable-document treatment now covers *every* prompt in the system — the customer-facing agent's conduct rules and the fraud reviewer's own instructions both live outside the source code repository entirely, since a lender's disclosure rules and fraud-detection criteria are the kind of thing that shouldn't sit in a public code repository even if the repository is otherwise unremarkable.

## Speed and warmth: the real cost of moving to Anthropic's native tool-calling

The system was rebuilt to use Anthropic's own native tool-calling mechanism (replacing a custom, hand-rolled format this app used originally) — mainly so the same tools could be shared with other future AI clients through a standard protocol (MCP), not just this one chat. That migration surfaced two real regressions, both fixed, both worth understanding:

**A leak the prompt alone couldn't fix.** After the migration, the agent started occasionally narrating what it had just done inside its actual reply to the customer — "The fraud check has passed. Could you tell me your income?" That's exactly the kind of disclosure this project has repeatedly guarded against. Explaining the rule clearly in the prompt, even with a concrete right/wrong example, didn't reliably stop it — free-form text simply has no built-in separation between "the agent's internal narration" and "what the customer should actually hear" the way the old custom format did (which had those as two distinct, clearly labeled fields). The fix mirrors the fraud-reviewer pattern: a second, narrowly-scoped AI call, used every time, whose only job is producing the clean customer-facing message from everything that happened — never trusting the first draft. This is the same lesson as the very first entry in this document, applied to a different failure mode: a rule the model is merely asked to follow isn't reliable; only a step that structurally can't include the wrong information is.

**Slower, and colder.** Native tool-calling costs more round trips than the old format did — one AI call per tool used to also carry the reply; now composing the clean reply above is its own extra call. Combined with the new fraud-detection steps added along the way, a full application now involves noticeably more waiting than it used to. Separately, the instruction added to stop the disclosure leak ("write *only* the message, nothing else") had a side effect nobody intended: it made the agent's replies terser and more clinical, including dropping the customer's name from replies where it used to appear naturally. Two independent fixes:
- The "write only the message" instruction was relaxed to explicitly invite warmth and the customer's name back in, while keeping the same hard rule about never mentioning what check just ran.
- The customer now sees a typing indicator while they wait, with a short pre-approved line beside it when the wait runs long. This is deliberately *not* another AI agent chatting in parallel — an earlier version of that idea used AI-generated filler text and was removed for being both robotic-feeling and a second place a disclosure leak could happen. What the later attempts got wrong, and how the wait is handled now, is its own section below.

## Filling the wait with something worth reading

Measured end to end, a first message that runs the full identity, credit-file and fraud sequence takes **fifteen to twenty seconds**. That is simply what the work costs; the question is what the customer experiences while it happens.

This took three attempts, and the first two were wrong in a way worth recording.

The first attempt sent a short "one moment" message on every step of the sequence. A three-step sequence produced three of them back to back, and a step that finished quickly still got one, so it read as a nervous tic. The second attempt fixed the *timing* — tie it to how long the customer has actually waited rather than to how many steps are running, say something at a second and a half and again later, say nothing at all if the request resolves quickly — and filled the longer gaps with genuinely useful content instead of a second "bear with me".

Seen in a terminal log, that looked fine. Seen in the actual chat window, it was obviously wrong, and it took someone looking at the real screen to notice. **The problem was never the wording. It was that these were chat messages at all.** In a chat interface, a bubble from the bank reads as the bank speaking to you — so the app greeted an empty screen with "Give me a second here." before it had said hello, answered a customer who had just typed their ID with "Let me sort that out for you." and then merely asked a question, and left a fact about the origin of the word *salary* sitting permanently in the transcript directly above a rejection. No amount of rewriting survives being the wrong kind of object.

The chat already had the right thing for this and it had been there all along: the typing indicator. Wait-time content is now attached to it — it streams to the open connection, is never added to the transcript, is never saved, and disappears the moment a real reply arrives. Nothing survives the wait it was covering, so nothing can end up juxtaposed against a decision. The acknowledgement lines are gone entirely: the animated dots already say "I am here", and they say it without promising to sort anything out. What remains appears only when a wait is genuinely long — around seven seconds — and a fast turn now shows nothing at all.

The general lesson, and it is not really about chat: **the mistake was choosing the wrong kind of object, and no amount of polish on the content would have fixed it.** It stayed invisible through a lot of testing because the logs showed the right text at the right times. It became obvious in about two seconds of looking at the real interface.

**The important decision was to curate that content, not generate it.** Generating it per conversation is the obvious idea and it is the wrong one, for four reasons that are worth recording because they will come up again:

- **It would break the rule the whole system rests on.** Nothing customer-facing is invented here; every figure comes from a tool. A model writing product copy live will invent features, fees and rates — factual claims about financial products, made to a customer, with nothing behind them. That is the exact failure this architecture exists to prevent, reintroduced through a side door.
- **The timing would become a signal.** If richer content only appeared during long waits, and long waits correlate with the fraud escalation, then "I was shown something" quietly becomes "my application went to manual review." This is the same class of leak already closed twice. Content that is fixed, non-credit and outcome-neutral can run on a plain clock and reveals nothing, because elapsed time is not a secret — the customer is watching the same clock. Making it transient closes the question entirely: there is nothing left afterwards to read anything into.
- **Generation costs the very thing it is hiding.** A model call takes one to three seconds. The first line needs to appear at 1.5 seconds. To be fast enough it would have to be written in advance — at which point it is curated content, and the generation bought nothing.
- **Anything credit-related is a conduct problem here regardless.** Promoting a card or a second loan to someone whose application is still undecided, who may be about to be declined, and who may already be under financial strain, is not a tone question. Keeping this content strictly non-credit removes the issue rather than managing it.

So the copy lives in the same business-editable, version-controlled-by-example place as the policy documents, with rules at the top of the file explaining what may and may not go in it — never credit, never presuming an outcome, never referring to the application. AI is still useful for writing it; it just does that offline, with a human approving the result, rather than at the moment a customer is waiting. A pleasant side effect is that "which message was shown to which applicant, and when" becomes an ordinary auditable record, which for anything resembling a financial promotion is something you want anyway.

## The bug that told the customer their money was on its way

Worth recording in full, because the failure was silent and the cause was one line.

An applicant reached the final step and gave a bank name and account number, but not the name on the account — which the transfer needs. The agent handled that correctly in private: it declined to attempt the transfer, and wrote "I still need the name on the account" in its internal notes. What it actually *said* to the customer was "Disbursing the funds to the provided account now." Nothing was being disbursed. The customer waited, asked "hello?", and was told the disbursement was still processing. It would have waited forever, because the question that would have unblocked it never reached them.

The cause was the two-call reply design described above. The first call thinks and drafts; the second produces the clean, non-disclosing message. But the draft was being *discarded* before the second call ran, so that call was re-deciding what to say from the tool results alone. Almost always the two agree. They cannot agree when the draft's decision exists nowhere except the draft — "I am waiting on one more piece of information" is not recorded in any tool result, so the second call had no way to know, and filled the gap with a reassurance that happened to be false.

The fix was to hand the draft to the second call and ask it to **rewrite** rather than re-decide: keep the question, the information and the decision exactly, change only the wording. That preserves the disclosure control — verified by re-running the rejection paths and confirming nothing leaks — while making it structurally impossible for the customer-facing message to contradict what the agent actually decided.

Two things generalise. First, **a "sanitising" step must not also be a deciding step**, or it will quietly invent whatever it wasn't told. Second, the worst failure mode here was not the missing question — it was the confident false reassurance that replaced it. A conduct rule now forbids claiming any action is done or under way unless a tool has confirmed it, on the same footing as the existing rule against inventing numbers.

## The agent was inventing part of a customer's name

Found while investigating the above, and arguably the more serious of the two. The demo's applicant record holds the name `Tan Wei L`. The agent had been cheerfully addressing her as **Tan Wei Ling** — expanding an abbreviated name into a plausible-looking full one. In other runs it shortened the same name to "Tan Wei". Nobody noticed for a long time, because a slightly-wrong name reads perfectly naturally.

This is the founding principle of the whole system failing in a place nobody had thought to guard: the agent is never trusted to invent a score or a rate, but it had been handed a raw name string and left to work out how to address someone — which is a *convention* question, not a language one. Faced with an abbreviation, it filled in the blank.

The fix is the same shape as every other control here: make it data instead of inference. The applicant record now carries an explicit "address as" value, the bureau lookup returns it, and the agent is told to use it exactly — never expanding, shortening, or re-ordering it. Getting a customer's name wrong is a small thing that reads as carelessness; *inventing* one is the same class of error as inventing their credit score, and deserved the same treatment.

## Measuring before optimising — and being wrong about it

The application was slow enough to be worth measuring properly, so it now has a benchmark that drives complete journeys through the real interface and reports what a customer actually waits. Two findings, one of them a correction.

**Almost none of the delay is our own code.** The credit-file lookups, the affordability maths, the policy evaluation and the database together account for under two percent of the time. A typical turn spends about twenty-five milliseconds inside them. Everything else is waiting for the AI model to respond, and a single customer message can need five separate model calls. That reframes the whole optimisation question: there is no point tuning the underwriting logic for speed, because it is already free.

**And the fix we were most confident about turned out to be the smallest one.** The obvious improvement was to stream the reply — show it word by word as it is written, rather than waiting for the finished paragraph. The prediction was that this would recover around two and a half seconds. It was implemented, measured, and delivers about *seven tenths* of a second at the median. The reasoning error is worth keeping: we assumed the delay in each model call was the model *writing*, which streaming recovers. It is mostly the model *starting* — and streaming cannot touch that. It is still worth having, and it pays best exactly where it should, on the longest message in the journey (the offer, with all its figures), which now reaches the customer almost two seconds sooner. But the headline fix has to attack something else.

The general lesson is the ordinary one, which is why it is worth writing down rather than assuming: the intuition about where the time goes was confidently held, specific, and wrong, and thirty seconds of measurement settled it.

## Can the model just set the state itself?

Asked directly, late in the build, and worth answering precisely rather than reassuringly: can the agent set `fraudPassed`, `checksPassed`, or any other internal flag to true without the real check having run?

No, and the reason is structural rather than a rule anyone has to remember. Every tool's arguments are a fixed zod schema (`mcp-server/index.ts`), and none of them accept a state field — `run_fraud_check`, `run_policy_checks`, and `disburse_funds` take no arguments at all beyond the application id. There is no tool shaped like "mark this check passed." A handler's only way to change `state` is to compute the change itself, from data the model didn't supply, and the model's only way to make that happen is to call the tool and wait for whatever it decides.

So the real question is narrower: can the model feed those computations something fabricated? Walking the actual inputs:

- `get_credit_score(customer_id)` only chooses *which* fixed server-side record to read (`CUSTOMERS[customer_id]`) — an unrecognised id returns `NOT_FOUND`, not a fabricated file.
- `run_fraud_check()` and `run_policy_checks()` take no caller input whatsoever; they read bureau data and policy config the model never touched.
- `validate_bank_account(bank, account_number, account_name)` looks like free text passed straight through, but the handler checks `bank` against a real allowlist and `account_name` against the applicant's actual name on file — a plausible-looking fake gets rejected, not trusted.

Two places genuinely do take the model's word for something, and both are worth naming rather than glossing over, because they're a different *kind* of risk than a bypass:

- `assess_affordability(monthly_income)` takes whatever the customer said their income was. That's an intended input, not a hole — it's exactly why `run_income_check` exists downstream, cross-checking the figure against the bureau's own facility limits rather than trusting it.
- `record_acceptance(accepted)` is just the model's report of what the customer said in chat. There is no independent signal to check it against — the same exposure a human phone agent recording a verbal "yes" has. Nothing currently guards this one specifically, beyond the fact that every number in whatever gets disbursed still came from a real tool regardless.

The general shape worth keeping: a control doesn't have to be a rule the model is asked to respect. If the only road from "model decides something" to "state changes" runs through a handler that computes the change itself, the model's intent is structurally irrelevant to the outcome — it can only ever be as honest as its one remaining job, relaying what a human actually said.

## One tool server, and only one of its two clients actually chooses anything

Three more questions came up once the staff portal existed alongside the customer agent, all pointing at the same underlying fact: the two sides use the same tool server in genuinely different ways, not just with different credentials.

**Is `mcp-server` the only way in?** For the handlers themselves, yes — `TOOLS` and `STAFF_TOOLS` are imported by exactly one file in the whole codebase, `mcp-server/index.ts`. Nothing else ever touches them directly. But "access the list of tools" turns out to be the wrong frame for half of the system: the customer orchestrator calls the real MCP `listTools()` RPC, because Claude needs an actual menu to choose from every turn — but the staff portal never calls `listTools()` at all. Each of its REST routes already knows exactly which one tool it wants (`GET /applications` always calls `list_applications`, nothing else) and calls it by name directly. Listing and calling are separately gated in fastmcp, and the staff side only ever exercises the calling half.

**Same server, different clients.** There is one `mcp-server` process and one `FastMCP` instance — both tool registries live on it, gated apart by `canAccess`. But `server/agent/mcpClient.ts` and `staff-server/mcpClient.ts` are two separate files, running in two separate processes, each opening its own connection. The orchestrator caches a single connection for its whole lifetime, because it's always the same unauthenticated identity. The staff client opens a fresh connection on every call instead, because there's a *specific person's* bearer token behind each request, different per caller and expiring on its own — nothing safe to cache a connection under.

**The customer agent decides; the staff portal doesn't.** This is the one worth being plain about, because "the staff agent" is a slightly misleading way to describe it. On the customer side, Claude genuinely picks the next tool itself, shaped by the conduct prompt's described order, each tool's own description, and the conversation so far — none of which the code enforces, which is why the precondition checks above exist as the actual backstop. On the staff side there is no model in the loop at all. Every route is a hardcoded call to one named tool, the same way any ordinary backend knows which query a given endpoint runs. It isn't a cautious or constrained agent; it was never an agent to begin with — which is also exactly why it's the one side trusted with a write action (`resolve_referral`) the customer-facing model never gets near.

## Small things worth knowing

- **Applicant ID numbers no longer look like real Singapore NRICs.** The demo previously used realistic-looking ID formats (letter + 7 digits + letter); a real NRIC has that exact shape, so there was a small but real risk of a demo ID being mistaken for — or coinciding with — an actual person's. IDs are now plain digit strings that can't be confused with a real identity document.
- **The system now runs on TypeScript**, adopted at the point the codebase was being rewritten for a shared, multi-client backend anyway, rather than as a separate pass later.
- **Two bugs surfaced while testing the wait behaviour**, both worth recording because neither was where it appeared to be. The agent kept asking customers for an ID number they had already typed — which looked like the AI ignoring instructions, and survived three increasingly explicit attempts to fix it by rewording the instructions. It was not the AI at all: the very first message of a conversation was being discarded by the server before the agent ever saw it, so the agent was answering a customer whose opening line it had never been shown. The second was a leftover reference in the agent's instructions to a numbered list of steps that had been deleted during an earlier rewrite, telling the agent to "run steps 1 and 2" when nothing defined what those were. The lesson is an old one: when a model appears to be disobeying a clear instruction, check what it was actually given before rewriting the instruction again.
- **The tool logic runs as its own service**, separate from the part of the system that talks to the customer — specifically so a second client could eventually connect to the exact same underwriting logic without duplicating it. It now has that second client: the staff portal, a human-in-the-loop referral queue for near-threshold declines and large offers, authenticated through a real Keycloak login rather than a stub. The interesting part needed no new infrastructure on the tool server's side — one process, not two, with `canAccess` on each staff-only tool deciding per connection who gets to see it exist, keyed off whether the caller presented a verified staff token at all.
