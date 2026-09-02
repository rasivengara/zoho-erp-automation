// ============================================================
// AUTO CREDIT LIMIT ENGINE  -  v15.0  (MEASURED APD)
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Workflow function (real time, one customer)
// Trigger      Customer Payments - Created / Edited / Deleted
// Input        customer_payment      Connection  "zerp"
// Writes       contact.credit_limit, cf_average_payment_days,
//              cf_min_payment_today
// Companions   SCHEDULED_CREDIT_LIMIT_BATCH.js (nightly, all
//              customers), AUTO_QUOTE_CREDIT_CHECK.js (same
//              methodology at quote time)
// ------------------------------------------------------------
// WHAT IT DOES
// Recalculates one dealer's credit limit from their measured
// payment behaviour every time they pay, instead of leaving a
// static limit set by hand.
//
// HOW THE RISK NUMBER IS BUILT
//   paidAPD      amount-weighted (last_payment_date - invoice
//                date) across bills FULLY SETTLED inside a
//                rolling closure window
//   pendingAPD   amount-weighted age of everything still owed,
//                including a pending opening balance
//   riskAPD      = max(paidAPD, pendingAPD)  <- drives the limit
// The max is what stops a dealer from clearing small new bills
// quickly while a large old one rots and still reading as a good
// payer. Both halves are measurements taken from documents, not
// ratios derived from the balance - a single large cheque cannot
// move the score.
//
// FROM RISK TO LIMIT
// riskAPD is mapped through a continuous target-days curve (no
// band cliffs), multiplied by the dealer's own rolling payment
// velocity, and constrained by a portfolio concentration cap.
// Minimum Payment Today is solved from the same numbers by
// bisection, so the limit and the payment ask can never disagree.
//
// SAFETY
// Stateless - the existing credit_limit is never an input, so a
// bad run cannot compound. Any incomplete or failed API read
// aborts the write for that customer rather than writing a limit
// derived from partial data.
// ============================================================
// ============================================================
// SANITIZED PUBLIC COPY
// Company name, dealer names, product brands, Zoho account IDs and
// whole-book financial totals have been replaced with placeholders.
// Placeholders in use: ACME DISTRIBUTION (company), DEALER-A..J
// (customers), BRAND_ONE / BRAND_TWO (product brands),
// <..._ID> (Zoho record IDs). Rupee figures that remain are
// illustrative examples, not live company data.
// dryRun ships as TRUE in this copy. Nothing is written to Zoho
// until that line is changed.
// ============================================================
// ------------------------------------------------------------
// DESIGN NOTES AND CHANGE HISTORY BELOW.
// Long. Skip to the CONFIGURATION section for the code itself.
// ------------------------------------------------------------
// ============================================================
// ACME AUTO CREDIT LIMIT - TREND ENGINE V15.0  (MEASURED APD)
// Workflow input: customer_payment | Connection: zerp
//
// Actual payment trend 40/40/20 over a ROLLING window.
// PDCs are kept as Unused Credits natively in Zoho.
// True Outstanding Balance natively matches Zoho's Outstanding.
// Any incomplete API read blocks the credit-limit update.
// Handles Create, Edit, AND Delete safely (see section 2B).
//
// ============================================================
// *** V15.0 (2026-09-01) - APD IS NOW MEASURED, NOT INFERRED ***
// ------------------------------------------------------------
// THE DEFECT, found by the owner. Every version up to V12.1
// computed
//        APD = outstandingBalance / trendDailyVelocity
// which is a DSO RATIO, not a count of payment days. The recent
// 30-day bucket carries 40% weight over a 30-day divisor, so one
// payment of Rs P adds P/75 to daily velocity while removing P
// from the balance. PROBE E measured the consequence on the live
// book, on the largest eight accounts - the second number is what
// today's APD becomes if that customer pays 10% of their balance
// and NOTHING ELSE CHANGES:
//        DEALER-B      99.0 -> 78.7
//        DEALER-D         89.4 -> 71.9
//        DEALER-E  101.7 -> 80.6
//        DEALER-F     99.2 -> 78.8
// One cheque moved a "risk level" by twenty days. Thirty days
// later that payment leaves the recent bucket and the number
// climbs back on its own, with no change in behaviour either
// time. The mirror image is worse: BUYING GOODS raises the
// balance and not the velocity, so a dealer who pays perfectly
// and places a large order is punished for the order.
//
// THE REPLACEMENT - two numbers that are both measurements:
//   paidAPD    the AMOUNT-WEIGHTED average of
//              (last_payment_date - invoice date) over bills that
//              were FULLY PAID inside the closure window. This is
//              the plain question "how many days does this dealer
//              take to settle a bill", answered from bills that
//              actually settled.
//   pendingAPD the AMOUNT-WEIGHTED age of everything still owed,
//              the pending OPENING BALANCE included. This is the
//              money that has NOT settled, and it cannot be
//              gamed by paying small new bills early.
//   riskAPD  = max(paidAPD, pendingAPD)      <- drives everything
//
// WHY THE MAX AND NOT THE PAID FIGURE ALONE. Without it a dealer
// clearing small new bills promptly while a large old one rots
// reads as an excellent payer. PROBE E shows the max is not a
// blunt instrument: on every ACTIVE account pending sits near
// half of paid (DEALER-B 53.6 against 114.7, DEALER-D 48.8 against 96.1,
// DEALER-F 38.3 against 85.4) because a healthy book is always
// mid-cycle, so paid governs and the floor never bites. It bit on
// exactly the two accounts it was built for - DEALER-A and DEALER-C,
// who between them had ONE settled bill in a year.
//
// WHY AMOUNT-WEIGHTED. Ten Rs 5,000 bills paid in 20 days plus one
// Rs 5,00,000 bill paid in 120 days is a simple average of 29 days
// and a weighted average of 111. The risk is carried by the
// rupees, not by the bill count. PROBE E measured the gap as real
// but modest on this book (DEALER-I 52.7 weighted against
// 42.8 simple); it will widen as order sizes spread.
//
// WHAT A THIN SAMPLE MUST NOT DO. DEALER-C had exactly ONE
// settled bill, closed the same day it was raised, so the paid
// average read 0.00 days - a perfect score built on one row.
// paidAPD is therefore only ACCEPTED when it rests on at least
// apdMinClosedBills bills; below that it is UNAVAILABLE, not
// zero, and pendingAPD carries the customer alone. A missing
// measurement must never read as a good one.
//
// BILLS CLOSED BY A CREDIT NOTE. PROBE E found paid invoices with
// an EMPTY last_payment_date even on the detail read (DEALER-D
// ACME-INV-196, DEALER-I ACME-INV-299 and ACME-INV-72) - a bill
// settled by a TOD rebate or a cash-discount credit note has no
// payment date because it took no payment. Those are excluded
// from paidAPD, which is correct (a rebate is not payment
// behaviour), but they are COUNTED and LOGGED, and if more were
// excluded than included the paid figure is dropped as unsafe.
// A silent exclusion is how the comma-status-filter bug lived for
// a year.
//
// THE INVOICE QUERY IS NOW 365 DAYS, NOT 180. A bill raised 200
// days ago and settled last week belongs in a 90-day closure
// window, and a 180-day invoice-date query cannot see it. PROBE E
// measured ZERO such bills today - but only because this org
// holds ~143 days of history, so nothing CAN be older. The wider
// query costs no extra API call (one page of 200 covers every
// customer here) and stops the hole opening as history builds.
// Coverage still measures the 180-day window; it is filtered by
// date in code from the same read - see section 5B.
//
// WHAT DID NOT CHANGE. The credit limit is still velocity-based,
// deliberately: a dealer's behaviour moves, so the limit must
// follow the money actually arriving. The curve, Min Payment
// Today, the aging scripts, the PDC trust weighting and the
// opening-balance handling are all untouched. Only the APD that
// feeds them is now a measurement.
//
// *** CALIBRATION WARNING - READ BEFORE DEPLOYING ***
// The curve's anchors were fitted against the OLD APD. The new one
// is a different distribution: PROBE E's eight accounts moved
// -50.1, -41.0, -22.5, -13.8, -6.1, 0.0, +6.7 and +15.7 days, net
// downward, and a lower APD means a HIGHER limit. Run the BULK
// engine with dryRun = true and re-fit dayAnchors so the fixed
// point stays at 60 and the book stays inside the 2x-monthly-sales ceiling
// BEFORE any of this writes to a customer.
// ============================================================
//
// ============================================================
// WHY THIS ENGINE IS SHAPED THE WAY IT IS - READ BEFORE TUNING
// ============================================================
// Strip the formula to its core and velocity cancels out:
//
//     creditLimit  = trendDailyVelocity x targetDays
//     outstanding  = trendAPD          x trendDailyVelocity
//     ------------------------------------------------------
//     outstanding / creditLimit = trendAPD / targetDays
//
// So the whole engine reduces to ONE comparison: is the
// customer's APD below the target APD we assigned them? Volume
// never decides whether someone is over limit - it scales both
// sides equally. Which means targetDays is not an abstract knob.
// It IS the pay-down percentage being demanded:
//
//     pay-down required = 1 - targetDays / APD
//
// Always reason about the curve in that unit. The day numbers
// are just its encoding.
// ============================================================
//
// V11.0 CHANGES (from V10.0)
// --------------------------
// A. CONTINUOUS TARGET-DAYS CURVE replaces the 6 hard bands.
//    V10.0's bands were cliffs: one extra day of APD at the
//    90/91 boundary moved the demand from 36% to 51% of balance,
//    and at 110/111 from 59% to 71%. Most of the book sits in
//    the 60-150 APD range, i.e. directly on those cliffs, and
//    APD is a noisy ratio that drifts across them with no change
//    in customer behaviour. Now interpolated - one day of drift
//    moves the demand ~1-2%.
//
// B. THE LOOSENING IS SPENT ONLY IN THE MAINTAIN ZONE.
//    Owner policy has two halves: "60-90 is a maintain zone, not
//    a punishment zone" AND "past 90 they MUST pay down extra".
//    V10.0 silently demanded 24-36% of balance INSIDE the
//    maintain zone - materially stricter than intended, and the
//    likely reason V9.0 pulled market outstanding well below
//    its intended baseline. V11 fixes that half and leaves the
//    must-reduce half at V10 levels:
//        APD  85 -> 20% pay-down  (was 32%)
//        APD  90 -> 27% pay-down  (was 36%)
//        APD 110 -> 58% pay-down  (was 59%)  <- deliberately firm
//        APD 130 -> 75% pay-down  (was 75%)  <- deliberately firm
//
// C. NO-PAYMENT-HISTORY BUG FIXED. A customer with zero payments
//    got velocity 0, so the limit computed to 0 and floored to
//    Rs 1 - which HARD BLOCKED every brand-new customer from
//    ordering until their first payment landed. Now detected and
//    left alone (probation) instead.
//
// D. currentPaymentAPD BLEND REMOVED. It existed only in this
//    engine, not the bulk one, so the two produced different
//    limits for the same customer and the weekly bulk run kept
//    undoing the payment-triggered run - a 29% swing near a band
//    edge, oscillating weekly. All engines now use plain trendAPD.
//
// E. (SUPERSEDED IN V11.3 - SEE (L) BELOW.) V11.0 used asymmetric
//    smoothing to cap how far a limit could move per run. That
//    whole mechanism has since been REMOVED. Do not reinstate it
//    without reading (L) first.
//
// F. PDC WEIGHTS CONTINUOUS via a single trust factor (full to
//    APD 60, zero at APD 130) x per-bucket decay. Still capped
//    at 40% of the actual-collection-based limit.
//
// G. UPTREND SPIKE GUARD mirroring the existing downtrend guard.
//    Fires only above a 3x recent-vs-middle jump - a one-off lump
//    payment, not a new sustained pace.
//
// V11.2 CHANGES
// -------------
// H. *** THE APRIL BUG - THE MOST IMPORTANT FIX IN THIS FILE ***
//    Velocity used to be windowed on the FINANCIAL YEAR. That
//    made the engine violently unstable every April:
//      - On 1 April, payment history resets to zero for every
//        customer. Velocity -> 0, APD -> 150, and every
//        established customer's limit starts decaying to Rs 1.
//      - Then as April payments arrive, recentDays was clamped
//        to the FY start, so on 10 April a payment was divided
//        by 10 days instead of 30 - roughly 3x the true velocity.
//        APD collapses, limits inflate several-fold.
//      - And fyAgeDays < 90 was true for EVERY customer in
//        April-June, so the 25% new-customer bonus fired company-
//        wide for a full quarter each year.
//    Crash, then explode, every single year.
//    Velocity is a RATE. An accounting boundary has no business
//    defining it. V11.2 uses a rolling velocityLookbackDays
//    window (default 365), clamped to the customer's actual age
//    so a genuinely new customer is not measured over days that
//    do not exist. The new-customer bonus now keys off real
//    contact age, not the calendar.
//
// I. PAYMENT TERMS ARE NOW VISIBLE. This business runs Net 60,
//    Net 30, Net 20 and Due on Receipt, and payment_terms is
//    already in the contact response being read - it was free
//    data the engine ignored. A Due-on-Receipt customer at APD
//    80 is 80 days late; a Net 60 customer at APD 80 is 20 days
//    late; V10 scored them identically.
//    V11.2 MEASURES AND REPORTS the gap (excess days over terms)
//    but does NOT yet let it drive the limit - the owner's policy
//    is stated in absolute days ("60 normal, 60-90 maintain, 90+
//    reduce"), so switching to term-relative scoring is a policy
//    decision, not a bug fix. Run it, read the logs, then decide.
//
// J. CONCENTRATION CAP. No single customer's limit may exceed
//    concentrationCapPct of company 30-day collections. Standard
//    credit practice - nothing previously stopped one dealer
//    becoming an outsized share of the book. Set to 0 to disable.
//
// K. APD TREND. The previous APD is recovered from the customer
//    field and the direction is reported ("106.2 days, worsening
//    from 92.4"). Display only - it does not touch the maths,
//    because a rising APD conflates "paying less" (bad, already
//    caught by the downtrend guard) with "buying more" (good).
//
// V11.3 CHANGE
// ------------
// L. *** SMOOTHING REMOVED. THE CALCULATION IS NOW STATELESS. ***
//    THE RULE: contact.credit_limit is an OUTPUT of this engine.
//    It must NEVER be an input. Nothing in the calculation may
//    read the customer's existing credit limit.
//
//    Why this matters more than the noise-damping smoothing was
//    buying: credit_limit is an ordinary editable field. Any
//    staff member can type a number into it in Zoho. Under
//    smoothing, that typed number did not simply get overwritten
//    on the next run - it became the ANCHOR the next run was
//    measured against. Someone sets a customer to Rs 50,00,000
//    and the engine, capped at -15% per run, needs a dozen-plus
//    recalculations to crawl back to the correct Rs 1,70,000.
//    One manual edit corrupted the number for weeks, and nothing
//    in the log would have made that obvious. A credit policy
//    that can be silently defeated by one keystroke is not a
//    policy.
//
//    Now: same data in, same limit out, every single time,
//    regardless of what the field previously held or who touched
//    it. A manual edit is corrected completely on the very next
//    payment. The engine is self-healing instead of path-
//    dependent, and the limit is fully explainable from the
//    customer's own numbers alone.
//
//    What smoothing was actually protecting against was churn -
//    limits swinging week to week. Most of that churn came from
//    V10.0's band CLIFFS (a one-day APD drift could move the
//    limit 22-37%), and change (A) already removed those: on the
//    continuous curve, APD drift moves the limit proportionally.
//    The remaining damping is all on the INPUT side, where it
//    belongs and where no mutable state is involved: the 40/40/20
//    velocity blend, and the uptrend spike guard (G).
//    If churn still looks high after the dry run, the stateless
//    dial is the velocity weighting - shift it toward the longer
//    buckets (e.g. 30/40/30). Do NOT solve it by reintroducing a
//    dependency on the previous limit.
//
//    Tier is consequently informational again - it no longer
//    affects anything, since its only job was scaling the
//    smoothing-down rate.
//
// V11.4 CHANGE (this version)
// ---------------------------
// M. VELOCITY DIVISORS NOW CALIBRATED FROM TRANSACTIONS, NOT
//    METADATA. V11.2 clamped the payment window to created_time
//    so a new customer would not be measured over days that did
//    not exist. A live DEALER-D run disproved the
//    premise: the payment count dropped 13 -> 12 because a real
//    payment was dated BEFORE the contact's own created_time.
//    created_time is an import/migration date here, not the start
//    of trading.
//
//    The damage was quiet but material. Clamping shortened the
//    older-bucket divisor from ~46 days to 36, which pushed that
//    bucket's daily rate (Rs 4,167) ABOVE both the recent
//    (Rs 3,833) and middle (Rs 3,000) rates - the oldest history
//    reading as the fastest, which is a tell that the divisor is
//    wrong, not that the customer sped up. Velocity rose 4.7%,
//    APD fell 106 -> 101, and the limit came out ~11% high
//    (Rs 194,562 against a truer ~Rs 174,500).
//
//    Now: the query always covers the full velocityLookbackDays,
//    every payment found counts, and the divisor length comes
//    from the EARLIEST PAYMENT ACTUALLY OBSERVED. created_time
//    survives only as a fallback for customers with no payments
//    at all, and for the probation rule. Data beats metadata.
//
//    Watch for this pattern in future logs: if the 91+ bucket's
//    daily rate is much higher than the 30-day rate for a steady
//    customer, suspect the divisor before believing the trend.
//
// V11.5 CHANGE (this version)
// ---------------------------
// N. COVERAGE RATIO - THE ENGINE CAN FINALLY SEE WHAT CUSTOMERS BUY.
//    Every other input is payment-derived. Billing was invisible,
//    which meant APD - a LEVEL - had no way to express DIRECTION.
//    Two real statements on 2026-08-14 showed how badly that fails:
//
//      DEALER-D    APD 105.7 | billed 5,12,375 paid 4,50,202 =  88%
//             -> balance INFLATING by Rs 62,173
//      DEALER-B APD 102.8 | billed 3,27,604 paid 4,34,343 = 133%
//             -> balance SHRINKING by Rs 1,06,739
//
//    Near-identical APD, near-identical limits (1,72,183 vs
//    1,77,418), opposite trajectories. DEALER-B comfortably beats
//    the owner's own maintain-zone rule and was still asked to
//    clear 48% of their balance; DEALER-D drifts the wrong way and is
//    treated the same. The two largest dealers in the book,
//    mis-priced in opposite directions.
//
//    Coverage = payments / invoiced over the same rolling window.
//    Above 1.0 the balance is shrinking, below 1.0 it is inflating
//    - and because it is a ratio of two flows over one period, a
//    migrated opening balance does not distort it.
//
//    A sales-based DSO was evaluated as an alternative and is
//    WRONG: it reads DEALER-D 95 days / DEALER-B 135 days, inverting the
//    truth purely because DEALER-B buys less. Coverage has to be a
//    SEPARATE signal, never a replacement for the APD denominator.
//
//    SHIPPED OFF (applyCoverageFactor = false). The ratio and the
//    factor it WOULD apply are logged on every run, the limit is
//    untouched. Review a full bulk dry run before enabling, and
//    tune coverageLowFactor / coverageHighFactor from that data
//    rather than from these two customers.
//
//    Cost: one extra paginated read per customer. Negligible here;
//    in the bulk engine it may require dropping batchSize to 75.
//
// V11.6 CHANGES (this version)
// ----------------------------
// O. COVERAGE DEMOTED TO A WARNING - AND WHY. Six customers' logs
//    plus their statements showed coverage is ALREADY INSIDE APD:
//    APD_payment = DSO_sales / coverage, verified to within rounding
//    on all six. A coverage MULTIPLIER would therefore charge twice
//    for the same fact. It is now permanently report-only, surfaced
//    in the log and on the customer field as a "WATCH" flag so
//    collections can see the trajectory. Full reasoning in config.
//
//    This also corrected an earlier misreading. DEALER-D (coverage 84%)
//    vs DEALER-B (120%) looked like proof the engine was blind, but on
//    SALES-DSO DEALER-B is the worse of the two (120 days vs 91) - they
//    simply buy less. The engine scoring them near-equal is the
//    correct blend, not a blind spot.
//
// P. CREDIT NOTES NETTED OFF BILLING. The quarterly TOD scheme makes
//    credit notes systematic here, and ignoring them read billing
//    ~5% high for DEALER-D and ~12% high for DEALER-B against their own
//    statements. Coverage now uses invoices minus credit notes.
//
// ============================================================
// KNOWN STRATEGIC PROPERTY - THE EQUILIBRIUM IS ~73 DAYS
// ============================================================
// A customer sitting exactly at their limit has outstanding = limit,
// and since outstanding/limit = APD/targetDays, that means APD =
// targetDays. Solving target(APD) = APD on the current curve gives a
// fixed point of about 73 days.
//
// So any customer who uses their full credit line settles at APD ~73,
// and the book's resting DSO is AT MOST 73 (lower for customers who
// do not use their whole line - 3 of the 6 sampled were well under).
// Measured book DSO across the sample was 92 days, so this curve
// moves the business 92 -> ~73.
//
// That is a real improvement against a 60-day goal and a market that
// offers 90, but it is NOT 60. Landing at 60 requires the crossing
// point to be 60, i.e. target(60) = 60 instead of today's 75 - a
// substantially tighter maintain zone, which is the V9.0 setting the
// owner already rejected as too strict.
//
// 73 is therefore a deliberate compromise, not an accident. Anyone
// re-tuning should move the crossing point knowingly. The engine now
// computes this number at runtime from the anchors and prints it, so
// it can never silently drift away from what anyone believes it is.
// ============================================================
//
// V12.0 CHANGES (this version)
// ----------------------------
// Q. MINIMUM PAYMENT TODAY IS NOW COMPUTED HERE. CUSTOMER MINIMUM
//    PAYMENT CHECK and BULK MINIMUM PAYMENT CHECK were separate
//    scripts that re-fetched this customer's entire payment and PDC
//    history and then solved against the STORED credit limit - which
//    could be days old, or hand-edited. Two scripts, two data pulls,
//    two chances to disagree, and a five-file sync burden.
//
//    Now it is one guarded solve on numbers already in memory, so the
//    limit and the collection target are mathematically incapable of
//    disagreeing. It also writes cf_min_payment_today on every single
//    payment rather than once a night, and reaches the mobile app,
//    which the old Custom Button never did.
//
//    THE SOLVE IS NEARLY FREE. Looking for the smallest X where
//        O - X <= (v + kX) * f(simAPD)
//    and substituting O - X = simAPD * (v + kX) gives
//        simAPD <= f(simAPD)
//    The velocity cancels completely: the condition is just "has APD
//    fallen to the curve's fixed point". Hence 15 bisection steps
//    instead of 30-40 (15 steps give rupee-level precision on a typical balance range), and
//    hence the plain-language line in the log - "collect until their
//    APD reaches ~72.5 days".
//
//    NOTE the answers will be LOWER than the old scripts produced.
//    Those simulated the +15% smoothing cap, so the limit could not
//    rise to its true value in the simulation and staff were told to
//    collect more than was actually required.
//
// S. VELOCITY WINDOW 365 -> 180, AND BOTH GUARDS MADE CONTINUOUS.
//    The rolling-window fix (H) had an unintended side effect: it
//    stretched the older bucket to 275 days. Since the buckets are
//    30/60/remainder but weighted 40/40/20, per RUPEE that made a
//    payment today count ~18x a payment six months ago, against ~3x
//    under the old FY windowing - far more recency bias than anyone
//    chose. At 180 days the older bucket is 90 and the ratio is ~6x.
//    No effect today (only ~135 days of history exists, so the clamp
//    binds first); it prevents the imbalance emerging over time.
//    The guards were also still step functions - the exact cliff
//    pattern (A) removed from the curve. DEALER-E at ratio 0.5077
//    was treated identically to DEALER-G at 0.7375. Both are now
//    proportional: downtrend ramps 1.0 -> 0.85 between ratio 1.0 and
//    0.30, uptrend ramps 1.0 -> 0.85 between 2.0 and 4.0.
//
// R. DOWNTREND GUARD SOFTENED, 0.75/0.90 -> 0.85/0.95 (then made
//    continuous by (S) above). It fires after
//    a velocity drop has already been charged for twice (through
//    trendDailyVelocity at 40% weight, and again through APD rising
//    and dragging the target down the curve). A halved recent
//    velocity already costs ~47% of the limit; at 0.75 the total hit
//    reached ~60%. DEALER-E and DEALER-G both tripped it on real
//    data and neither is distressed. Kept rather than deleted because
//    the 40/40/20 blend deliberately damps recent behaviour, and a
//    dealer who has truly stopped paying should not have to wait for
//    that blend to catch up.
// ============================================================
//
// SYNC NOTE: the block between the CORE START / CORE END markers
// is the shared methodology and must be identical in all five
// credit-limit scripts. Nothing outside those markers is shared.
// ============================================================
// ============================================================
// 1. CONFIGURATION
// ============================================================
runDate = zoho.currentdate;
runDateStr = runDate.toString("yyyy-MM-dd");
currencyPrecision = 0;
recentWeight = 0.40;
middleWeight = 0.40;
olderWeight = 0.20;
maximumCreditLimit = 0.0;
minimumPaymentsForExcellent = 3;
pdcSupportCapPct = 0.40;
// Rolling velocity window - see change (H). Replaces FY windowing.
// 180, NOT 365, and the reason matters (change (S)): the buckets are
// 30 / 60 / remainder days but weighted 40 / 40 / 20, so per RUPEE the
// recent bucket counts 40%/30d = 1.33%/day against the older bucket's
// 20%/remainder. At a 365-day window the older bucket is 275 days
// (0.073%/day) and a payment made today counts EIGHTEEN TIMES more
// than one six months ago - far more recency bias than the old FY
// windowing ever had (~3x). At 180 the older bucket is 90 days and
// the ratio is ~6x, which is a trend engine rather than a
// last-30-days engine.
// This changes nothing today: only ~135 days of history exists in
// Zoho, so effectiveLookbackDays clamps below both values. It stops
// the imbalance appearing as history accumulates.
velocityLookbackDays = 180;
// ------------------------------------------------------------
// *** V15.0 - THE MEASURED APD BLOCK ***
// These five lines are the whole tuning surface of the new APD.
// ------------------------------------------------------------
// How far back a SETTLEMENT counts. The owner's choice, and it
// matches how the TOD schemes are already run - the business
// thinks in quarters, so a dealer is judged on the quarter just
// finished, not on what they were a year ago.
apdClosureWindowDays = 90;
// The widen. If 90 days does not hold enough settled bills, the
// window opens to this before the paid figure is abandoned. It is
// a sample-size rescue, NOT a second opinion: 90 is used whenever
// 90 is usable.
apdClosureWindowWideDays = 180;
// The smallest number of settled bills a paid average may rest on.
// Two, because DEALER-C's single same-day bill produced a
// 0.00-day "perfect" score in PROBE E. One row is an anecdote.
apdMinClosedBills = 2;
// How far back the INVOICE QUERY reaches - deliberately wider than
// the closure window, so a long-overdue bill settled last week is
// still visible. See the V15 header note.
invoiceLookbackDays = 365;
// Set false to fall back to the old balance/velocity APD without
// touching anything else. Kept for one release as a rollback path;
// delete it once the new APD has run a full quarter.
useMeasuredAPD = true;
// ------------------------------------------------------------
// THE POLICY CURVE - THIS IS THE ONLY THING YOU NORMALLY TUNE.
// Two parallel lists, linearly interpolated between anchors.
//
//    APD  30 -> target 76 -> headroom (excellent payer)
//    APD  45 -> target 69 -> headroom
//    APD  60 -> target 60 -> NEUTRAL (fixed point, book settles here)
//    APD  75 -> target 52 -> 31% pay-down
//    APD  90 -> target 45 -> 50% pay-down
//    APD 110 -> target 33 -> 70% pay-down
//    APD 130 -> target 25 -> 81% pay-down
//    APD 150 -> target 18 -> 88% pay-down
//
// ============================================================
// HOW TO SET THIS CURVE FROM A ROTATION TARGET - THE IDENTITY
// ============================================================
// total limits = SUM(velocity x target)
//              = (SUM velocity) x weighted-average-target
// and SUM(velocity) is just the company's daily collections, while
// target outstanding = daily sales x rotation days. In steady state
// collections = sales, so the two cancel and leave:
//
//     WEIGHTED-AVERAGE TARGET DAYS = THE BOOK'S ROTATION IN DAYS
//
// That makes the curve DESIGNABLE instead of guessable. Want a
// 60-day book? The velocity-weighted average of dayAnchors must be
// 60. The bulk engine now computes and prints this figure directly.
//
// CALIBRATED AGAINST TWO FULL DRY RUNS OF THE ENTIRE CUSTOMER BASE.
// Limit totals below are expressed as multiples of MONTHLY SALES (M),
// which is how the ceiling is defined - absolute figures are internal:
//   curve 95/85/75/72/66/46/32/22 -> 2.48 x M in limits -> 75-day book
//   curve 68/62/55/47/40/30/22/16 -> 1.75 x M in limits -> 53-day book
//   curve 76/69/60/52/45/33/25/18 -> 1.95 x M in limits -> ~59-day book
// against monthly sales M (M/30 of sales per day) and a starting
// position of 2.77 x M outstanding = 83 days.
// The owner chose ~58-60 days: comfortably inside the 45-60 target
// and just under the hard ceiling of 2 x monthly sales.
//
// WHICH ANCHORS MOVE THE TOTAL. Customers with high velocity
// mathematically have LOW APD, so the top of the curve carries most
// of the limit rupees - measured at about 57% in the APD<=45 group
// (an earlier note guessed 76%, which was too high; 57% is backed
// out from the real weighted average of 48.3 the engine reported).
// The 40% of customers sitting at APD 131+ contribute almost
// nothing, because their velocity is tiny. Tuning 25/18 barely
// moves the book. With the split near 57/43 a UNIFORM scaling of
// the whole curve is the right way to shift the rotation: this one
// is the previous curve x 1.114.
//
// A CONSEQUENCE WORTH OWNING: at a 45-60 day rotation the owner's
// original "60-90 is a maintain zone" no longer fits - APD 90 now
// demands 56%. The two goals genuinely conflict. Chasing the
// rotation target won; the maintain zone has effectively shrunk to
// about 60-75 days.
//
// RULE: dayAnchors MUST stay strictly decreasing. If a slower
// payer ever got a higher target than a faster one, they would
// get a BIGGER limit at the same velocity - which is perverse.
// RULE: unprovenTargetDaysCap must stay BELOW the top anchor, or
// it silently does nothing.
// ------------------------------------------------------------
apdAnchors = {30,45,60,75,90,110,130,150};
dayAnchors = {76,69,60,52,45,33,25,18};
anchorSegmentList = {0,1,2,3,4,5,6};
lastAnchorIndex = 7;
// A customer without enough payments in the window cannot reach
// the top of the curve on one lucky early payment.
unprovenTargetDaysCap = 60;
// PDC trust: full weight up to this APD, decaying to zero at
// pdcTrustZeroAPD.
pdcTrustFullAPD = 60.0;
pdcTrustZeroAPD = 130.0;
pdcBaseWeight0to30 = 0.80;
pdcBaseWeight31to60 = 0.50;
pdcBaseWeight61to90 = 0.20;
pdcBaseWeight91to120 = 0.10;
// NO SMOOTHING PARAMETERS HERE BY DESIGN - see change (L).
// contact.credit_limit is an OUTPUT of this engine and must never
// become an input. If you find yourself adding a "max change per
// run" setting, you are about to make the calculation depend on a
// field any staff member can edit, and one manual entry will then
// corrupt the limit for weeks. Damp on the INPUT side instead
// (velocity weights, uptrend guard).
// Downtrend guard - SOFTENED IN V12.0 from 0.75/0.90 to 0.85/0.95.
// A velocity drop is already charged for TWICE before this guard runs:
// once through trendDailyVelocity itself (the recent bucket carries
// 40% weight) and again through APD, which rises as velocity falls
// and drags the target down the curve. A halved recent velocity
// already costs ~47% of the limit before any guard. At 0.75 the total
// reached ~60%, which is too much for a dealer who simply had one
// slow month - DEALER-E and DEALER-G both tripped it on 2026-08-14
// and neither looks distressed. Kept rather than removed because the
// 40/40/20 blend deliberately damps recent behaviour, and a dealer
// who has genuinely stopped paying should not have to wait for that
// blend to catch up.
// BOTH GUARDS ARE CONTINUOUS (V12.0). They used to be step functions,
// which is exactly the cliff pattern change (A) removed from the main
// curve - DEALER-E at a velocity ratio of 0.5077 was getting the same
// treatment as DEALER-G at 0.7375 despite a far worse drop. Now the
// response is proportional to how far the pace actually fell.
// Downtrend: no damping at ratio 1.0, full damping at or below 0.30.
downtrendFullRatio = 0.30;
downtrendMaxDamping = 0.85;
// Uptrend: no damping up to 2.0, full damping at or above 4.0. A big
// one-off payment inflates the 30-day bucket and briefly lifts the
// limit; this bleeds off the extreme end of that without punishing
// genuine growth. Set uptrendMaxDamping = 1.0 to disable.
uptrendStartRatio = 2.0;
uptrendFullRatio = 4.0;
uptrendMaxDamping = 0.85;
// Minimum-payment solver. 15 steps over a range of at most the full
// outstanding gives rupee-level precision (range / 2^15) - the
// old 30-40 steps were wasted statements. See change (Q).
bisectionSteps = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
minPaymentFieldAPIName = "cf_min_payment_today";
// Concentration cap - max single-customer limit as a fraction of
// company 30-day collections. Set to 0 to disable.
concentrationCapPct = 0.25;
// ------------------------------------------------------------
// COVERAGE RATIO (V11.5) = payments / invoiced over the window.
// This is the owner's own rule made measurable: "as long as a
// customer pays roughly what they're being billed, they can keep
// getting billed." Coverage > 1 means the balance is SHRINKING;
// coverage < 1 means it is INFLATING.
//
// APD is a LEVEL, coverage is the DIRECTION. APD alone cannot
// tell them apart - proven on real statements 2026-08-14:
//   DEALER-D    : billed 5,12,375  paid 4,50,202  = 88%  (+62k debt)
//   DEALER-B : billed 3,27,604  paid 4,34,343  = 133% (-107k debt)
// Both scored APD ~105 and got near-identical limits, despite
// moving in opposite directions. DEALER-B more than satisfies the
// owner's rule and was still asked for a 48% pay-down.
//
// NOTE a sales-based DSO was considered as an alternative and is
// WRONG here: it reads DEALER-D 95 days / DEALER-B 135 days, inverting
// the truth purely because DEALER-B buys less. Coverage must be a
// separate signal, not a replacement for the APD denominator.
//
// *** DO NOT ENABLE applyCoverageFactor WITHOUT READING THIS ***
// Six real customers on 2026-08-14 revealed that coverage is ALREADY
// INSIDE APD. The algebra is exact:
//
//     APD_payment = outstanding / paidPerDay
//     DSO_sales   = outstanding / billedPerDay
//     coverage    = paidPerDay  / billedPerDay
//     ==> APD_payment = DSO_sales / coverage
//
// Verified against live data (engine APD vs DSO/coverage):
//     DEALER-D      105.7 vs 108.5   DEALER-B   102.8 vs 100.1
//     DEALER-I    56.8 vs  61.6   DEALER-G 40.3 vs  39.3
//
// So a customer paying 80% of billings ALREADY carries an APD 25%
// worse than their sales position, which the curve then punishes.
// Multiplying by a coverage factor on top charges for the same fact
// a second time: coverage 1.0 -> 0.8 already cuts the limit ~33% at
// APD 90 through the curve alone; the factor would make it ~38%.
//
// What coverage genuinely adds is LAG - it is the leading indicator
// of where APD is heading, which is collections information, not
// limit information. It is therefore surfaced in the log and in the
// customer field as a WARNING, and left out of the maths.
// Keep this false unless a full portfolio dry run gives a positive
// reason to change it.
applyCoverageFactor = false;
// Band edges for the reported factor and the warning text. The 0.90
// to 1.10 plateau is the owner's rule made literal: "as long as a
// customer pays roughly what they're being billed".
coverageLowRatio = 0.70;
coverageLowFactor = 0.85;
coverageNeutralLow = 0.90;
coverageNeutralHigh = 1.10;
coverageHighRatio = 1.30;
coverageHighFactor = 1.15;
// Below this, the balance is inflating fast enough to flag to staff.
coverageWarnBelow = 0.85;
// Too few / too small invoices makes the ratio meaningless, and a
// customer who bought nothing would divide by zero.
coverageMinInvoiced = 1000;
coverageMinInvoiceCount = 3;
// New-customer probation: a contact created within this many days
// that has made no payment yet used to be LEFT ALONE. V12.1 stopped
// doing that - see minimumVelocityDivisorDays note below and the
// write-gate change further down.
newCustomerProbationDays = 90;
newCustomerBonusMaxAgeDays = 90;
// ============================================================
// *** V12.1 (2026-08-17) - MINIMUM VELOCITY DIVISOR ***
// ============================================================
// A daily payment rate divided by a handful of days is not a rate,
// it is an extrapolation. Reproduced on a live test contact:
//     contact age 0 days -> divisor 1 day
//     one payment of Rs 1,940 -> velocity Rs 1,940 PER DAY
//     limit = 1,940 x 60 x 1.25 = Rs 1,45,500
// A Rs 1,940 payment bought a Rs 1.45 LAKH credit limit. On a real
// new dealer whose first payment is Rs 1,00,000 the same arithmetic
// runs straight into the concentration cap and hands them the
// largest limit in the book on day one.
//
// This is the same family as lesson 6 (THE APRIL BUG): "April
// payments were divided by a clamped 10-day window giving ~3x true
// velocity and limits exploded". The financial-year windowing was
// fixed then; nobody put a FLOOR under the divisor.
//
// 60 days is chosen deliberately: terms here are Net 60 and the
// curve's fixed point is 60 days, so 60 days is one full credit
// cycle. Below a complete cycle there is nothing to extrapolate
// from. Established customers are untouched - their divisor is
// already the full 180.
minimumVelocityDivisorDays = 60;
// ============================================================
// *** V12.1 - THE NEW-CUSTOMER BONUS IS OFF ***
// ============================================================
// This used to be 1.25 - a 25% uplift for a contact under 90 days
// old with any payment and APD <= 45. It gave the LARGEST bonus to
// the customer with the LEAST evidence, and it multiplied a velocity
// that was already inflated by the missing divisor floor. Two errors
// compounding. Lesson 6 records it firing company-wide for a whole
// quarter during the April bug; the bug was fixed but the idea was
// never questioned.
// If a new dealer should get more room, that belongs in the curve,
// not in a multiplier sitting on top of the least reliable number in
// the calculation. Set back to 1.25 only after a portfolio dry run
// gives a positive reason.
newCustomerBonusFactor = 1.00;
absoluteMinimumCreditLimit = 1;
pageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50};
// ============================================================
// 2. BASIC DATA / SAFETY
// ============================================================
organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
customerID = customer_payment.get("customer_id");
currentPaymentID = customer_payment.get("payment_id");
if(currentPaymentID == null || currentPaymentID == "")
{
	currentPaymentID = customer_payment.get("customer_payment_id");
}
if(customerID == null || customerID == "")
{
	info "ERROR: Customer ID is missing. Credit limit was not changed.";
	return;
}
fatalReadError = false;
// ============================================================
// 2B. DELETE-EVENT SAFETY CHECK
// If this run was triggered by a payment DELETE, the payment no longer
// exists. Confirm this by re-reading it - if the read fails, this
// payment must NOT be added back into the totals below (section 4),
// otherwise a deleted payment would still inflate the credit limit.
// ============================================================
paymentWasDeleted = false;
if(currentPaymentID != null && currentPaymentID != "")
{
	paymentExistsResp = invokeurl
	[
		url :apiEndPoint + "/customerpayments/" + currentPaymentID + "?organization_id=" + organizationID
		type :GET
		connection:"zerp"
	];
	if(paymentExistsResp == null || paymentExistsResp.containsKey("code") == false || paymentExistsResp.get("code") != 0)
	{
		paymentWasDeleted = true;
		info "This payment no longer exists (deleted). Excluding it from totals - recalculating from live data only.";
	}
}
contactResp = invokeurl
[
	url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
	type :GET
	connection:"zerp"
];
if(contactResp == null || contactResp.containsKey("code") == false || contactResp.get("code") != 0 || contactResp.get("contact") == null)
{
	info "ERROR: Customer contact could not be read. Credit limit was not changed.";
	return;
}
contactData = contactResp.get("contact");
customerName = contactData.get("contact_name");
if(customerName == null || customerName == "")
{
	customerName = "Unknown Customer";
}
outstandingBalance = 0.0;
if(contactData.get("outstanding_receivable_amount") != null)
{
	outstandingBalance = contactData.get("outstanding_receivable_amount").toDecimal();
}
currentCreditLimit = 0.0;
if(contactData.get("credit_limit") != null)
{
	currentCreditLimit = contactData.get("credit_limit").toDecimal();
}
// Contact age. Used for (a) clamping the velocity window so a new
// customer is not measured over days that do not exist, (b) the
// probation rule, and (c) the new-customer bonus - which in V10 keyed
// off the FY start instead and therefore fired for EVERY customer
// during April-June. See change (H).
customerAgeDays = 9999;
createdTimeStr = contactData.get("created_time");
if(createdTimeStr != null && createdTimeStr != "" && createdTimeStr.length() >= 10)
{
	createdDateOnly = createdTimeStr.subString(0,10);
	customerAgeDays = createdDateOnly.toDate("yyyy-MM-dd").daysbetween(runDate);
	if(customerAgeDays < 0)
	{
		customerAgeDays = 0;
	}
}
// Payment terms - free data already in this response. Reported, not
// yet used in the maths. See change (I).
paymentTermDays = 0;
if(contactData.get("payment_terms") != null)
{
	paymentTermDays = contactData.get("payment_terms").toLong();
}
paymentTermLabel = contactData.get("payment_terms_label");
if(paymentTermLabel == null || paymentTermLabel == "")
{
	paymentTermLabel = "Not set";
}
// Previous APD, recovered from the customer field this same script
// wrote last time, so the log can show direction. Display only.
// Both the V10 format ("104.5 days (Concerning)") and the V11 format
// ("106.2 days (Reduce Required) | Pay down ...") start with the
// number followed by " days", so both parse. Anything else (e.g. the
// probation message) fails the length guard and is ignored.
previousAPD = -1.0;
existingCustomFields = contactData.get("custom_fields");
if(existingCustomFields != null)
{
	for each  cfEntry in existingCustomFields
	{
		if(cfEntry.get("api_name") == "cf_average_payment_days")
		{
			cfExistingValue = cfEntry.get("value");
			if(cfExistingValue != null && cfExistingValue != "" && cfExistingValue.contains(" days"))
			{
				apdPrefix = cfExistingValue.getPrefix(" days");
				if(apdPrefix != null && apdPrefix.length() <= 6)
				{
					previousAPD = apdPrefix.toDecimal();
				}
			}
		}
	}
}
// ------------------------------------------------------------
// ROLLING VELOCITY WINDOW (V11.4)
// ALWAYS query the full lookback. The divisor is calibrated AFTER
// the read, from the earliest payment actually found - see the
// note in section 6. Do not clamp the QUERY by contact age: real
// DEALER-D data showed a payment dated before the
// contact's own created_time, so created_time is an import/
// migration artifact, not the true start of the relationship.
// Clamping the query to it silently dropped genuine history and
// inflated velocity by ~11%.
// ------------------------------------------------------------
queryStartDate = runDate.subDay(velocityLookbackDays - 1);
queryStartStr = queryStartDate.toString("yyyy-MM-dd");
// *** V15.0 *** The INVOICE query has its own, wider window. The
// payment window above still governs velocity and coverage; this one
// only has to be wide enough that a bill settled inside the closure
// window is visible however old the bill itself is.
invoiceQueryStartDate = runDate.subDay(invoiceLookbackDays - 1);
invoiceQueryStartStr = invoiceQueryStartDate.toString("yyyy-MM-dd");
apdClosureCutoffDate = runDate.subDay(apdClosureWindowDays);
apdClosureWideCutoffDate = runDate.subDay(apdClosureWindowWideDays);
recentStartDate = runDate.subDay(29);
recentStartStr = recentStartDate.toString("yyyy-MM-dd");
middleStartDate = runDate.subDay(89);
middleEndDate = runDate.subDay(30);
info "========================================";
info "ACME AUTO CREDIT LIMIT - TREND ENGINE V12.1";
info "Customer : " + customerName + " (" + customerID + ")";
info "Run date : " + runDateStr + " | Contact age : " + customerAgeDays + " days";
info "Payment terms : " + paymentTermLabel + " (" + paymentTermDays + " days)";
info "Payment query window : " + queryStartStr + " to " + runDateStr + " (" + velocityLookbackDays + " days, rolling)";
info "Current credit limit : Rs " + currentCreditLimit.round(currencyPrecision);
info "========================================";
// ============================================================
// 3. COMPANY ACTUAL COLLECTIONS - LAST 30 DAYS
// Drives the concentration cap, and the Tier shown in the log.
// ============================================================
companyRecentCollections = 0.0;
companyReadFailed = false;
hasMoreCompanyPayments = true;
for each  companyPageNo in pageList
{
	if(hasMoreCompanyPayments == true)
	{
		companyResp = invokeurl
		[
			url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&date_start=" + recentStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + companyPageNo
			type :GET
			connection:"zerp"
		];
		if(companyResp != null && companyResp.containsKey("code") && companyResp.get("code") == 0)
		{
			companyPayments = companyResp.get("customerpayments");
			if(companyPayments != null)
			{
				for each  companyPayment in companyPayments
				{
					companyPaymentStatus = companyPayment.get("status");
					if(companyPayment.get("amount") != null && companyPaymentStatus != "draft" && companyPaymentStatus != "void" && companyPaymentStatus != "cancelled" && companyPaymentStatus != "refunded")
					{
						companyRecentCollections = companyRecentCollections + companyPayment.get("amount").toDecimal();
					}
				}
			}
			companyPageContext = companyResp.get("page_context");
			if(companyPageContext == null || companyPageContext.get("has_more_page") != true)
			{
				hasMoreCompanyPayments = false;
			}
		}
		else
		{
			// NOT FATAL as of V12.0. This total only feeds the
			// concentration cap and the informational Tier label -
			// neither affects the credit limit. Blocking the whole
			// update over it (as V10 did, when Tier still drove target
			// days) is disproportionate. Zeroed rather than left
			// partial, since a partial total would make the cap
			// wrongly tight, and the zero guard disables it cleanly.
			companyReadFailed = true;
			hasMoreCompanyPayments = false;
			if(companyResp == null)
			{
				info "WARNING: company collections read got no response.";
			}
			else
			{
				info "WARNING: company collections read failed. Zoho said: " + companyResp.toString();
			}
		}
	}
}
if(hasMoreCompanyPayments == true)
{
	companyReadFailed = true;
	info "WARNING: company payment pagination exceeded 10,000 rows.";
}
if(companyReadFailed == true)
{
	companyRecentCollections = 0.0;
	info "  NOT FATAL - concentration cap disabled for this run, credit limit unaffected.";
	info "  If the message above mentions a rate limit, wait a minute and re-run.";
}
// ============================================================
// 4. CUSTOMER ACTUAL PAYMENT TREND (40/40/20, ROLLING WINDOW)
// ============================================================
recent30Payments = 0.0;
middle31to90Payments = 0.0;
olderWindowPayments = 0.0;
totalWindowPayments = 0.0;
paymentCountWindow = 0;
currentPaymentWasInList = false;
// Earliest payment actually observed - this, not created_time, is what
// calibrates the velocity divisors in section 6.
earliestPaymentDate = runDate;
foundAnyPayment = false;
hasMoreCustomerPayments = true;
for each  customerPageNo in pageList
{
	if(hasMoreCustomerPayments == true)
	{
		customerPaymentsResp = invokeurl
		[
			url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + queryStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + customerPageNo
			type :GET
			connection:"zerp"
		];
		if(customerPaymentsResp != null && customerPaymentsResp.containsKey("code") && customerPaymentsResp.get("code") == 0)
		{
			customerPayments = customerPaymentsResp.get("customerpayments");
			if(customerPayments != null)
			{
				for each  historicalPayment in customerPayments
				{
					historicalPaymentID = historicalPayment.get("payment_id");
					if(historicalPaymentID == null || historicalPaymentID == "")
					{
						historicalPaymentID = historicalPayment.get("customer_payment_id");
					}
					if(currentPaymentID != null && currentPaymentID != "" && historicalPaymentID == currentPaymentID)
					{
						currentPaymentWasInList = true;
					}
					paymentStatus = historicalPayment.get("status");
					paymentDateStr = historicalPayment.get("date");
					if(historicalPayment.get("amount") != null && paymentDateStr != null && paymentDateStr != "" && paymentStatus != "draft" && paymentStatus != "void" && paymentStatus != "cancelled" && paymentStatus != "refunded")
					{
						paymentDate = paymentDateStr.toDate("yyyy-MM-dd");
						paymentAmount = historicalPayment.get("amount").toDecimal();
						if(paymentDate >= queryStartDate && paymentDate <= runDate)
						{
							totalWindowPayments = totalWindowPayments + paymentAmount;
							paymentCountWindow = paymentCountWindow + 1;
							if(foundAnyPayment == false || paymentDate < earliestPaymentDate)
							{
								earliestPaymentDate = paymentDate;
							}
							foundAnyPayment = true;
							if(paymentDate >= recentStartDate)
							{
								recent30Payments = recent30Payments + paymentAmount;
							}
							else if(paymentDate >= middleStartDate && paymentDate <= middleEndDate)
							{
								middle31to90Payments = middle31to90Payments + paymentAmount;
							}
							else
							{
								olderWindowPayments = olderWindowPayments + paymentAmount;
							}
						}
					}
				}
			}
			customerPageContext = customerPaymentsResp.get("page_context");
			if(customerPageContext == null || customerPageContext.get("has_more_page") != true)
			{
				hasMoreCustomerPayments = false;
			}
		}
		else
		{
			fatalReadError = true;
			hasMoreCustomerPayments = false;
			info "ERROR: Customer payment history could not be read.";
		}
	}
}
if(hasMoreCustomerPayments == true)
{
	fatalReadError = true;
	info "ERROR: Customer payment pagination exceeded 10,000 rows.";
}
currentPaymentDateStr = customer_payment.get("date");
currentPaymentAmount = 0.0;
if(customer_payment.get("amount") != null)
{
	currentPaymentAmount = customer_payment.get("amount").toDecimal();
}
currentPaymentStatus = customer_payment.get("status");
currentPaymentIsActual = false;
if(currentPaymentDateStr != null && currentPaymentDateStr != "" && currentPaymentAmount > 0 && currentPaymentStatus != "draft" && currentPaymentStatus != "void" && currentPaymentStatus != "cancelled" && currentPaymentStatus != "refunded" && paymentWasDeleted == false)
{
	currentPaymentDate = currentPaymentDateStr.toDate("yyyy-MM-dd");
	if(currentPaymentDate >= queryStartDate && currentPaymentDate <= runDate)
	{
		currentPaymentIsActual = true;
		if(currentPaymentWasInList == false)
		{
			totalWindowPayments = totalWindowPayments + currentPaymentAmount;
			paymentCountWindow = paymentCountWindow + 1;
			if(foundAnyPayment == false || currentPaymentDate < earliestPaymentDate)
			{
				earliestPaymentDate = currentPaymentDate;
			}
			foundAnyPayment = true;
			if(currentPaymentDate >= recentStartDate)
			{
				recent30Payments = recent30Payments + currentPaymentAmount;
			}
			else if(currentPaymentDate >= middleStartDate && currentPaymentDate <= middleEndDate)
			{
				middle31to90Payments = middle31to90Payments + currentPaymentAmount;
			}
			else
			{
				olderWindowPayments = olderWindowPayments + currentPaymentAmount;
			}
		}
	}
}
// ============================================================
// 5. FETCH FUTURE PDCs (FOR LIMIT SUPPORT ONLY)
// PDCs are now Unused Credits. The Zoho Outstanding Balance is naturally TRUE.
// We no longer add PDCs to the outstanding balance, avoiding double-counting.
//
// CONFIRMED BY THE OWNER (2026-08-14), so do not re-raise this:
// PDCs are deliberately held as UNUSED CREDITS and are NOT netted off
// outstanding_receivable_amount. Outstanding is therefore the GROSS
// receivable. That makes the design below correct and not a double-
// count: APD is measured against the full gross balance (conservative,
// a cheque in hand is not cash), and pdcWeightedSupport is then added
// back on top as a separate, weighted, 40%-capped allowance.
//
// Known consequence, accepted: an uncashed PDC inflates the customer's
// APD, which lowers pdcTrustFactor, which discounts that same PDC. So
// a customer holding large PDCs is slightly self-penalised. This is
// deliberately conservative. If it ever looks too harsh on a heavy-PDC
// customer, the fix is to compute pdcTrustFactor from a PDC-net APD
// while leaving the CURVE on the gross APD - do not "fix" it by
// reducing outstanding, which was tried and reverted before.
// ============================================================
totalUncashedPDC = 0.0;
pdc0to30Total = 0.0;
pdc31to60Total = 0.0;
pdc61to90Total = 0.0;
pdc91to120Total = 0.0;
pdcStartStr = runDate.addDay(1).toString("yyyy-MM-dd");
pdcEndStr = runDate.addDay(365).toString("yyyy-MM-dd");
hasMorePDC = true;
for each  pdcPageNo in pageList
{
	if(hasMorePDC == true)
	{
		pdcResp = invokeurl
		[
			url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + pdcStartStr + "&date_end=" + pdcEndStr + "&per_page=200&page=" + pdcPageNo
			type :GET
			connection:"zerp"
		];
		if(pdcResp != null && pdcResp.containsKey("code") && pdcResp.get("code") == 0)
		{
			pdcList = pdcResp.get("customerpayments");
			if(pdcList != null)
			{
				for each  pdcPayment in pdcList
				{
					pdcStatus = pdcPayment.get("status");
					pdcDateStr = pdcPayment.get("date");
					if(pdcPayment.get("amount") != null && pdcDateStr != null && pdcDateStr != "" && pdcStatus != "draft" && pdcStatus != "void" && pdcStatus != "cancelled" && pdcStatus != "refunded")
					{
						pdcDate = pdcDateStr.toDate("yyyy-MM-dd");
						pdcDaysAway = runDate.daysbetween(pdcDate);
						pdcAmount = pdcPayment.get("amount").toDecimal();
						totalUncashedPDC = totalUncashedPDC + pdcAmount;
						if(pdcDaysAway >= 1 && pdcDaysAway <= 30)
						{
							pdc0to30Total = pdc0to30Total + pdcAmount;
						}
						else if(pdcDaysAway <= 60)
						{
							pdc31to60Total = pdc31to60Total + pdcAmount;
						}
						else if(pdcDaysAway <= 90)
						{
							pdc61to90Total = pdc61to90Total + pdcAmount;
						}
						else if(pdcDaysAway <= 120)
						{
							pdc91to120Total = pdc91to120Total + pdcAmount;
						}
					}
				}
			}
			pdcPageContext = pdcResp.get("page_context");
			if(pdcPageContext == null || pdcPageContext.get("has_more_page") != true)
			{
				hasMorePDC = false;
			}
		}
		else
		{
			fatalReadError = true;
			hasMorePDC = false;
			info "ERROR: Future PDC data could not be read.";
		}
	}
}
if(hasMorePDC == true)
{
	fatalReadError = true;
	info "ERROR: PDC pagination exceeded 10,000 rows.";
}
// ============================================================
// 5B. BILLING VOLUME AND COVERAGE RATIO (V11.5)
// The only read in this engine that looks at what the customer BUYS
// rather than what they pay. Everything else is payment-derived,
// which is exactly why APD could not distinguish a dealer paying
// down their balance from one inflating it.
// ============================================================
totalWindowInvoiced = 0.0;
invoiceCountWindow = 0;
// *** V15.0 *** The same read now also builds the two measured APDs.
// Nothing here costs an extra API call - these are fields already
// arriving in the response the engine was paying for anyway
// (last_payment_date confirmed present on the LIST by PROBE E).
paidWeightedDaysPrimary = 0.0;
paidWeightPrimary = 0.0;
paidCountPrimary = 0;
paidWeightedDaysWide = 0.0;
paidWeightWide = 0.0;
paidCountWide = 0;
// Settled bills carrying no payment date - a credit note closed
// them. Counted so the exclusion can never be silent.
paidNoDateCount = 0;
// The pending side.
openBalanceTotal = 0.0;
pendingWeightedDays = 0.0;
openItemCount = 0;
oldestOpenAgeDays = -1;
// Every open item is kept as (age, balance) as well as summed,
// because Min Payment Today has to simulate what happens to the
// pending age when a payment lands - see section 11.
openItemsList = List();
hasMoreInvoices = true;
for each  invoicePageNo in pageList
{
	if(hasMoreInvoices == true)
	{
		invoiceResp = invokeurl
		[
			url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + invoiceQueryStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + invoicePageNo
			type :GET
			connection:"zerp"
		];
		if(invoiceResp != null && invoiceResp.containsKey("code") && invoiceResp.get("code") == 0)
		{
			invoiceList = invoiceResp.get("invoices");
			if(invoiceList != null)
			{
				for each  invoiceItem in invoiceList
				{
					invoiceStatus = invoiceItem.get("status");
					if(invoiceItem.get("total") != null && invoiceStatus != "draft" && invoiceStatus != "void")
					{
						invoiceDateStr = invoiceItem.get("date");
						// COVERAGE still measures the 180-day payment
						// window. The query is 365 days wide now, so the
						// billing total has to be filtered back down in
						// code - otherwise coverage would compare a year
						// of billing against six months of payments and
						// read half of what it should.
						if(invoiceDateStr != null && invoiceDateStr != "")
						{
							if(invoiceDateStr.toDate("yyyy-MM-dd") >= queryStartDate)
							{
								totalWindowInvoiced = totalWindowInvoiced + invoiceItem.get("total").toDecimal();
								invoiceCountWindow = invoiceCountWindow + 1;
							}
						}
						else
						{
							// No date at all: keep it in the billing total
							// rather than lose it. It cannot be aged or
							// timed, so it takes no part in either APD.
							totalWindowInvoiced = totalWindowInvoiced + invoiceItem.get("total").toDecimal();
							invoiceCountWindow = invoiceCountWindow + 1;
						}
						invoiceBalanceNow = 0.0;
						if(invoiceItem.get("balance") != null)
						{
							invoiceBalanceNow = invoiceItem.get("balance").toDecimal();
						}
						// ---- SETTLED BILLS -> paidAPD ----
						if(invoiceStatus == "paid" && invoiceDateStr != null && invoiceDateStr != "")
						{
							closureDateStr = "";
							if(invoiceItem.containsKey("last_payment_date") && invoiceItem.get("last_payment_date") != null)
							{
								closureDateStr = invoiceItem.get("last_payment_date");
							}
							if(closureDateStr == "")
							{
								// Closed by a credit note, not by money.
								// Not payment behaviour - excluded, but
								// counted and reported below.
								paidNoDateCount = paidNoDateCount + 1;
							}
							else
							{
								closureDate = closureDateStr.toDate("yyyy-MM-dd");
								settledInvoiceDate = invoiceDateStr.toDate("yyyy-MM-dd");
								daysToClose = settledInvoiceDate.daysbetween(closureDate);
								if(daysToClose < 0)
								{
									// An advance receipt applied to a bill
									// raised later. Money arrived first, so
									// this is zero days late, not negative.
									daysToClose = 0;
								}
								settledWeight = invoiceItem.get("total").toDecimal();
								if(settledWeight > 0)
								{
									if(closureDate >= apdClosureWideCutoffDate)
									{
										paidCountWide = paidCountWide + 1;
										paidWeightedDaysWide = paidWeightedDaysWide + daysToClose * settledWeight;
										paidWeightWide = paidWeightWide + settledWeight;
									}
									if(closureDate >= apdClosureCutoffDate)
									{
										paidCountPrimary = paidCountPrimary + 1;
										paidWeightedDaysPrimary = paidWeightedDaysPrimary + daysToClose * settledWeight;
										paidWeightPrimary = paidWeightPrimary + settledWeight;
									}
								}
							}
						}
						// ---- WHAT IS STILL OWED -> pendingAPD ----
						if(invoiceBalanceNow > 0 && invoiceDateStr != null && invoiceDateStr != "")
						{
							openItemAgeDays = invoiceDateStr.toDate("yyyy-MM-dd").daysbetween(runDate);
							openItemCount = openItemCount + 1;
							openBalanceTotal = openBalanceTotal + invoiceBalanceNow;
							pendingWeightedDays = pendingWeightedDays + openItemAgeDays * invoiceBalanceNow;
							if(openItemAgeDays > oldestOpenAgeDays)
							{
								oldestOpenAgeDays = openItemAgeDays;
							}
							openItemMap = Map();
							openItemMap.put("age",openItemAgeDays);
							openItemMap.put("bal",invoiceBalanceNow);
							openItemsList.add(openItemMap);
						}
					}
				}
			}
			invoicePageContext = invoiceResp.get("page_context");
			if(invoicePageContext == null || invoicePageContext.get("has_more_page") != true)
			{
				hasMoreInvoices = false;
			}
		}
		else
		{
			fatalReadError = true;
			hasMoreInvoices = false;
			info "ERROR: Customer invoice history could not be read.";
		}
	}
}
if(hasMoreInvoices == true)
{
	fatalReadError = true;
	info "ERROR: Invoice pagination exceeded 10,000 rows.";
}
// ---- CREDIT NOTES - must be netted off billing ----
// This business runs a QUARTERLY TOD (turnover discount) scheme, so
// credit notes are systematic, not incidental. Ignoring them
// overstated billing badly on real data: the gross invoice total read
// ~5% high for DEALER-D and ~12% high for DEALER-B against their own
// statements, which understated coverage by the same amount.
totalWindowCreditNotes = 0.0;
hasMoreCreditNotes = true;
for each  creditNotePageNo in pageList
{
	if(hasMoreCreditNotes == true)
	{
		creditNoteResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + queryStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + creditNotePageNo
			type :GET
			connection:"zerp"
		];
		if(creditNoteResp != null && creditNoteResp.containsKey("code") && creditNoteResp.get("code") == 0)
		{
			creditNoteList = creditNoteResp.get("creditnotes");
			if(creditNoteList != null)
			{
				for each  creditNoteItem in creditNoteList
				{
					creditNoteStatus = creditNoteItem.get("status");
					if(creditNoteItem.get("total") != null && creditNoteStatus != "draft" && creditNoteStatus != "void")
					{
						totalWindowCreditNotes = totalWindowCreditNotes + creditNoteItem.get("total").toDecimal();
					}
				}
			}
			creditNotePageContext = creditNoteResp.get("page_context");
			if(creditNotePageContext == null || creditNotePageContext.get("has_more_page") != true)
			{
				hasMoreCreditNotes = false;
			}
		}
		else
		{
			fatalReadError = true;
			hasMoreCreditNotes = false;
			info "ERROR: Customer credit note history could not be read.";
		}
	}
}
if(hasMoreCreditNotes == true)
{
	fatalReadError = true;
	info "ERROR: Credit note pagination exceeded 10,000 rows.";
}
netWindowBilled = totalWindowInvoiced - totalWindowCreditNotes;
if(netWindowBilled < 0)
{
	netWindowBilled = 0.0;
}
// Coverage factor, interpolated with a neutral plateau - no cliffs,
// same philosophy as the target-days curve. REPORTED ONLY by default;
// see the long note in the config block for why it must not multiply
// the limit.
coverageRatio = -1.0;
coverageFactor = 1.0;
coverageIsMeasurable = false;
if(netWindowBilled >= coverageMinInvoiced && invoiceCountWindow >= coverageMinInvoiceCount)
{
	coverageIsMeasurable = true;
	coverageRatio = (totalWindowPayments / netWindowBilled).round(4);
	if(coverageRatio <= coverageLowRatio)
	{
		coverageFactor = coverageLowFactor;
	}
	else if(coverageRatio >= coverageHighRatio)
	{
		coverageFactor = coverageHighFactor;
	}
	else if(coverageRatio < coverageNeutralLow)
	{
		coverageFactor = coverageLowFactor + (coverageRatio - coverageLowRatio) / (coverageNeutralLow - coverageLowRatio) * (1.0 - coverageLowFactor);
	}
	else if(coverageRatio > coverageNeutralHigh)
	{
		coverageFactor = 1.0 + (coverageRatio - coverageNeutralHigh) / (coverageHighRatio - coverageNeutralHigh) * (coverageHighFactor - 1.0);
	}
	else
	{
		// 0.90 - 1.10 : "paying roughly what they're billed" - neutral.
		coverageFactor = 1.0;
	}
}
// NOTE: True Outstanding for APD risk is TOTAL outstanding (not just
// the overdue portion). Tried switching this to overdue-only balance
// once - real Zoho AR Aging data (invoice-date-based, matching this
// business's own convention) showed that made APD read too LOW versus
// this customer's actual observed 85-105 day payment cycle. For an
// ongoing customer with a steady purchase pattern, the not-yet-due
// balance is a genuine part of that cycle length, not noise to
// exclude - total-outstanding / velocity (a standard DSO-style ratio)
// captures this correctly. Reverted - do not change this again
// without re-validating against real aging data first.
trueOutstandingBalance = outstandingBalance;
// ============================================================
// 5C. THE PENDING OPENING BALANCE  (V15.0)
// ------------------------------------------------------------
// GET /invoices NEVER returns it (project lesson 15), so the loop
// above cannot have seen it, and 99 of 268 customers carry one. The
// owner's standing rule is that a pending opening balance counts as
// an older unpaid bill - it is the OLDEST debt on the account, so
// leaving it out would make exactly the worst accounts look youngest.
// DEALER-A is the proof: Rs 1,64,884 of its Rs 1,70,246 balance IS
// the opening balance, aged 154 days. Without this block DEALER-A's
// pending APD would be built from Rs 5,362 of recent bills.
//
// opening_balance_amount is a FLAG ONLY - it holds the original
// migrated figure, not the current unpaid one (175884 against a true
// 164884 on DEALER-A). The live amount comes from the document.
// Cost: one API call, and only for customers who actually have one.
// This did not affect the credit LIMIT before V15 - the limit reads
// the contact-level balance, which already includes it - so this is
// new information the engine never needed until APD started being
// measured from documents.
// ============================================================
obBalance = 0.0;
obAgeDays = -1;
obReadFailed = false;
obAmountFlagValue = contactData.get("opening_balance_amount");
if(obAmountFlagValue != null && obAmountFlagValue.toDecimal() > 0)
{
	obInvoiceID = "";
	obNested = contactData.get("opening_balances");
	if(obNested != null)
	{
		// The doubly-nested .get() does not compile here - Zoho infers
		// the inner object as a LIST and demands an integer index
		// ("[BIGINT]"). Pull the id out of the text instead, using only
		// functions proven in this codebase. Identical to the block in
		// CUSTOMER OVERDUE AGING V3.0 - keep them the same.
		obRawText = obNested.toString();
		if(obRawText.contains("ob_invoice_id"))
		{
			obBefore = obRawText.getPrefix("ob_invoice_id");
			obRest = obRawText.subString(obBefore.length() + 13);
			obChunk = obRest;
			if(obRest.contains(","))
			{
				obChunk = obRest.getPrefix(",");
			}
			if(obChunk.length() > 4)
			{
				obInvoiceID = obChunk.subString(3,obChunk.length() - 1);
			}
		}
	}
	if(obInvoiceID == "")
	{
		obReadFailed = true;
	}
	else
	{
		obResp = invokeurl
		[
			url :apiEndPoint + "/invoices/" + obInvoiceID + "?organization_id=" + organizationID
			type :GET
			connection:"zerp"
		];
		if(obResp != null && obResp.containsKey("code") && obResp.get("code") == 0 && obResp.get("invoice") != null)
		{
			obDoc = obResp.get("invoice");
			obStatus = obDoc.get("status");
			if(obStatus != "draft" && obStatus != "void" && obDoc.get("balance") != null)
			{
				obBalance = obDoc.get("balance").toDecimal();
				obDateStr = obDoc.get("date");
				if(obDateStr != null && obDateStr != "")
				{
					obAgeDays = obDateStr.toDate("yyyy-MM-dd").daysbetween(runDate);
				}
				if(obBalance > 0 && obAgeDays >= 0)
				{
					openItemCount = openItemCount + 1;
					openBalanceTotal = openBalanceTotal + obBalance;
					pendingWeightedDays = pendingWeightedDays + obAgeDays * obBalance;
					if(obAgeDays > oldestOpenAgeDays)
					{
						oldestOpenAgeDays = obAgeDays;
					}
					obItemMap = Map();
					obItemMap.put("age",obAgeDays);
					obItemMap.put("bal",obBalance);
					openItemsList.add(obItemMap);
				}
			}
		}
		else
		{
			obReadFailed = true;
		}
	}
	if(obReadFailed == true)
	{
		info "WARNING: an opening balance is flagged on this customer but its document could not be read. The pending APD below is measured WITHOUT it and therefore reads YOUNGER than the truth.";
	}
}
// RECONCILIATION (the project's standing rule: if the parts do not
// add up to the whole, say so - never write a reassuring value over
// an unexplained gap). The invoice balances plus the opening balance
// should equal the contact's own outstanding figure. A gap means
// money is visible in one place and not the other, which is exactly
// the shape of the bug that hid for a year.
pendingReconGap = trueOutstandingBalance - openBalanceTotal;
if(pendingReconGap < 0)
{
	pendingReconGap = pendingReconGap * -1;
}
pendingIsReconciled = true;
if(pendingReconGap > 1)
{
	pendingIsReconciled = false;
	info "WARNING: pending reconciliation gap of Rs " + pendingReconGap.round(0) + " - the contact says Rs " + trueOutstandingBalance.round(0) + " but the documents add to Rs " + openBalanceTotal.round(0) + ". The pending APD is measured from the documents, so it does not describe all of the money.";
}
// ============================================================
// 6. TREND VELOCITY AND TRUE APD
// ------------------------------------------------------------
// DIVISOR CALIBRATION (V11.4). A daily rate must be divided by the
// number of days the relationship has actually existed, or a short
// history reads as a high rate.
//
// V11.2 took that length from created_time. Real data killed that:
// DEALER-D had a payment dated BEFORE its own
// created_time, proving created_time is an import/migration date,
// not the start of trading. Trusting it shortened the older-bucket
// divisor from ~46 days to 36, which pushed the older daily rate
// ABOVE both the recent and middle rates, cut APD from 106 to 101,
// and inflated the limit by ~11%.
//
// So the length is now taken from OBSERVED TRANSACTIONS - the
// earliest payment actually found - and created_time is only a
// fallback when there are no payments at all. Data beats metadata.
// ------------------------------------------------------------
relationshipDays = customerAgeDays + 1;
if(foundAnyPayment == true)
{
	observedHistoryDays = earliestPaymentDate.daysbetween(runDate) + 1;
	if(observedHistoryDays > relationshipDays)
	{
		relationshipDays = observedHistoryDays;
	}
}
effectiveLookbackDays = relationshipDays;
// *** V12.1 *** Never divide by less than one full credit cycle.
if(effectiveLookbackDays < minimumVelocityDivisorDays)
{
	effectiveLookbackDays = minimumVelocityDivisorDays;
}
if(effectiveLookbackDays > velocityLookbackDays)
{
	effectiveLookbackDays = velocityLookbackDays;
}
if(effectiveLookbackDays < 1)
{
	effectiveLookbackDays = 1;
}
info "Effective history for divisors : " + effectiveLookbackDays + " days (contact age " + customerAgeDays + ", earliest payment " + earliestPaymentDate.toString("yyyy-MM-dd") + ")";
recentDays = 30;
if(effectiveLookbackDays < 30)
{
	recentDays = effectiveLookbackDays;
}
middleDays = 0;
if(effectiveLookbackDays > 30)
{
	middleDays = effectiveLookbackDays - 30;
	if(middleDays > 60)
	{
		middleDays = 60;
	}
}
olderDays = 0;
if(effectiveLookbackDays > 90)
{
	olderDays = effectiveLookbackDays - 90;
}
availableWeight = recentWeight;
if(middleDays > 0)
{
	availableWeight = availableWeight + middleWeight;
}
if(olderDays > 0)
{
	availableWeight = availableWeight + olderWeight;
}
recentDailyVelocity = 0.0;
middleDailyVelocity = 0.0;
olderDailyVelocity = 0.0;
if(recentDays > 0)
{
	recentDailyVelocity = recent30Payments / recentDays;
}
if(middleDays > 0)
{
	middleDailyVelocity = middle31to90Payments / middleDays;
}
if(olderDays > 0)
{
	olderDailyVelocity = olderWindowPayments / olderDays;
}
trendDailyVelocity = recentDailyVelocity * recentWeight;
if(middleDays > 0)
{
	trendDailyVelocity = trendDailyVelocity + middleDailyVelocity * middleWeight;
}
if(olderDays > 0)
{
	trendDailyVelocity = trendDailyVelocity + olderDailyVelocity * olderWeight;
}
if(availableWeight > 0)
{
	trendDailyVelocity = trendDailyVelocity / availableWeight;
}
trendAPD = 150.0;
if(trueOutstandingBalance <= 0)
{
	// Nothing owed at all - this is the BEST case, not the worst. Do
	// not let a fully-paid-up customer default to the 150-day ceiling.
	trendAPD = 0.0;
}
else if(trendDailyVelocity > 0)
{
	trendAPD = (trueOutstandingBalance / trendDailyVelocity).round(2);
	if(trendAPD > 150)
	{
		trendAPD = 150.0;
	}
}
// No currentPaymentAPD blend - see change (D).
// ============================================================
// 6A. *** V15.0 - THE MEASURED APD ***
// trendAPD above is now kept for ONE purpose only: it is logged
// beside the measured figure so any drift between the old model and
// the new measurement is visible while the change beds in. It no
// longer drives anything unless useMeasuredAPD is switched off.
// ============================================================
// ---- paidAPD : how long settled bills actually took ----
paidAPD = -1.0;
paidAPDCount = 0;
paidAPDWindowUsed = apdClosureWindowDays;
if(paidCountPrimary >= apdMinClosedBills && paidWeightPrimary > 0)
{
	paidAPD = (paidWeightedDaysPrimary / paidWeightPrimary).round(2);
	paidAPDCount = paidCountPrimary;
}
else if(paidCountWide >= apdMinClosedBills && paidWeightWide > 0)
{
	// The widen. Not a second opinion - 90 days simply did not hold
	// enough settled bills to average.
	paidAPD = (paidWeightedDaysWide / paidWeightWide).round(2);
	paidAPDCount = paidCountWide;
	paidAPDWindowUsed = apdClosureWindowWideDays;
}
// A paid figure built mostly from bills we had to throw away is not
// a measurement. DEALER-C would otherwise have scored 0.00
// days off a single same-day bill.
if(paidAPD >= 0 && paidNoDateCount > paidAPDCount)
{
	info "NOTE: " + paidNoDateCount + " settled bills carried no payment date (closed by a credit note) against only " + paidAPDCount + " that did. The paid APD is being DISCARDED as unsafe rather than measured from the minority.";
	paidAPD = -1.0;
	paidAPDCount = 0;
}
if(paidAPD > 150)
{
	paidAPD = 150.0;
}
// ---- pendingAPD : how old the unsettled money is ----
pendingAPD = -1.0;
if(openBalanceTotal > 0)
{
	pendingAPD = (pendingWeightedDays / openBalanceTotal).round(2);
	if(pendingAPD > 150)
	{
		pendingAPD = 150.0;
	}
}
// ---- riskAPD = the worse of the two ----
// Order matters here. Start from "nothing measured", then let each
// available measurement raise it. Never let an ABSENT measurement
// lower it - that is the whole lesson of the opening balance.
measuredAPD = -1.0;
apdSourceText = "";
if(paidAPD >= 0)
{
	measuredAPD = paidAPD;
	apdSourceText = "settled " + paidAPDCount + " bills/" + paidAPDWindowUsed + "d";
}
if(pendingAPD > measuredAPD)
{
	measuredAPD = pendingAPD;
	if(paidAPD >= 0)
	{
		apdSourceText = "PENDING governs (settled reads " + paidAPD.round(1) + ")";
	}
	else
	{
		apdSourceText = "PENDING only - no settled bill to measure";
	}
}
if(trueOutstandingBalance <= 0 && measuredAPD < 0)
{
	// Owes nothing and settled nothing recently. Nothing owed is the
	// BEST case, not the worst - same rule as the old model.
	measuredAPD = 0.0;
	apdSourceText = "nothing outstanding";
}
finalRiskAPD = trendAPD;
apdMeasurementFailed = false;
if(useMeasuredAPD == true)
{
	if(measuredAPD >= 0)
	{
		finalRiskAPD = measuredAPD;
	}
	else
	{
		// Owes money, settled nothing, and the documents could not
		// account for the balance. That is not a customer to be
		// generous with, and it is not a customer to guess about
		// either: hold the old model's answer and say so loudly.
		apdMeasurementFailed = true;
		apdSourceText = "NOT MEASURABLE - fell back to the old balance/velocity model";
		info "WARNING: no settled bill and no ageable open document for this customer. APD could not be measured; the old balance/velocity figure of " + trendAPD + " is being used instead.";
	}
}
else
{
	apdSourceText = "old balance/velocity model (useMeasuredAPD is OFF)";
}
info "APD (old model, balance/velocity) : " + trendAPD;
info "APD paid    : " + paidAPD + " from " + paidAPDCount + " settled bills in " + paidAPDWindowUsed + " days | " + paidNoDateCount + " excluded, closed by credit note";
info "APD pending : " + pendingAPD + " over Rs " + openBalanceTotal.round(0) + " across " + openItemCount + " open items | oldest " + oldestOpenAgeDays + " days";
if(obBalance > 0)
{
	info "   pending includes an OPENING BALANCE of Rs " + obBalance.round(0) + " aged " + obAgeDays + " days";
}
info ">>> APD USED : " + finalRiskAPD + "   (" + apdSourceText + ")";
// ------------------------------------------------------------
// 6A-2. THE OPEN ITEMS, SORTED OLDEST FIRST  (V15.0)
// Min Payment Today has to answer "what does the pending age become
// if Rs X arrives today", and a payment retires the OLDEST debt
// first - that is how this business applies money and how the cash
// discount engine already reasons. So the items are sorted ONCE
// here; the bisection then walks the sorted list, which keeps the
// solve linear instead of quadratic.
//
// Sorted by finding the next-lower age each round and taking every
// item that shares it, so ties need no special handling and nothing
// has to be marked as used. Only List.add / .size / .get are used -
// no sort helper this codebase has not already proven.
// ------------------------------------------------------------
sortRoundList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80};
sortedOpenList = List();
sortLastAge = 1000000;
for each  sortRound in sortRoundList
{
	if(sortedOpenList.size() < openItemsList.size())
	{
		sortNextAge = -1;
		for each  sortCandidate in openItemsList
		{
			if(sortCandidate.get("age") < sortLastAge && sortCandidate.get("age") > sortNextAge)
			{
				sortNextAge = sortCandidate.get("age");
			}
		}
		if(sortNextAge >= 0)
		{
			for each  sortTaker in openItemsList
			{
				if(sortTaker.get("age") == sortNextAge)
				{
					sortedOpenList.add(sortTaker);
				}
			}
			sortLastAge = sortNextAge;
		}
	}
}
if(sortedOpenList.size() < openItemsList.size())
{
	// More than 80 distinct ages. The unsorted tail is simply absent
	// from the simulation, which makes the payment ask HIGHER than
	// necessary, never lower - the safe direction - but say so.
	// DELUGE NOTE: the difference MUST be worked out into a
	// variable first. Written inline as ... + (a.size() - b.size())
	// + ... this fails at paste time with "Left expression is of
	// type STRING and right expression is of type BIGINT and
	// operator - is not valid" - the concatenation swallows the
	// parentheses and turns the left side into a string before the
	// subtraction happens. Note that (x * 100).round(0) inline is
	// FINE and is used all over this file: it is the BARE
	// parenthesised arithmetic, with no method call on it, that
	// breaks.
	unsortedItemCount = openItemsList.size() - sortedOpenList.size();
	info "NOTE: " + unsortedItemCount + " open items could not be ordered for the payment simulation (more than 80 distinct ages). Min Payment Today will read slightly high.";
}
// Days beyond this customer's own agreed terms. Reported only.
excessDaysOverTerms = finalRiskAPD - paymentTermDays;
// APD direction, for the log and the field. Display only - see (K).
apdTrendText = "";
if(previousAPD >= 0)
{
	apdMovement = (finalRiskAPD - previousAPD).round(1);
	if(apdMovement > 2)
	{
		apdTrendText = " | WORSENING from " + previousAPD.round(1);
	}
	else if(apdMovement < -2)
	{
		apdTrendText = " | improving from " + previousAPD.round(1);
	}
	else
	{
		apdTrendText = " | stable";
	}
}
// ============================================================
// 6B. NO-PAYMENT-HISTORY STATE (fixes the new-customer block)
// A customer with zero payments in the window has velocity 0, so every
// multiplicative formula below collapses to 0 and floors to Rs 1. For
// a genuinely delinquent account that is correct. For a BRAND NEW
// customer whose first invoice is not even due yet it is a hard block
// on ordering, which is exactly what this business does not want to
// do. Distinguish the two by contact age.
// ============================================================
hasPaymentHistory = paymentCountWindow > 0;
skipUpdateReason = "";
if(hasPaymentHistory == false)
{
	if(customerAgeDays <= newCustomerProbationDays)
	{
		skipUpdateReason = "NEW CUSTOMER (" + customerAgeDays + " days old, no payment yet) - no credit line until a payment history exists. Sell on advance or Due on Receipt.";
	}
	else if(trueOutstandingBalance <= 0)
	{
		skipUpdateReason = "DORMANT (no payments in 180 days, nothing outstanding) - no credit line until payments resume.";
	}
}
// ============================================================
// 6C. DERIVED INPUTS THE SHARED CORE NEEDS
// ============================================================
comparisonDailyVelocity = 0.0;
if(middleDays > 0)
{
	comparisonDailyVelocity = middleDailyVelocity;
}
else if(olderDays > 0)
{
	comparisonDailyVelocity = olderDailyVelocity;
}
// Customer Tier. INFORMATIONAL ONLY as of V11.3 - it is logged and
// affects nothing, since its only job was scaling the smoothing-down
// rate that has now been removed. A Tier-based limit MULTIPLIER was
// considered earlier and rejected on separate grounds:
// companyRecentCollections is the denominator here, so in a slow
// collection month every customer's volume % rises and tiers inflate
// - a multiplier would loosen credit across the whole book exactly
// when cash is tightest.
customerMonthlyVelocity = trendDailyVelocity * 30;
customerVolumePercentage = 0.0;
if(companyRecentCollections > 0)
{
	customerVolumePercentage = customerMonthlyVelocity / companyRecentCollections * 100;
}
customerTier = 3;
if(customerVolumePercentage >= 5.0)
{
	customerTier = 1;
}
else if(customerVolumePercentage >= 1.0)
{
	customerTier = 2;
}
// ============================================================
// >>>>>>>>>>>>>>>> SHARED CALCULATION CORE - START <<<<<<<<<<<<<<<<
// Must be identical in all five credit-limit scripts. Inputs:
//   finalRiskAPD, trendDailyVelocity, recentDailyVelocity,
//   comparisonDailyVelocity, recentDays, customerAgeDays,
//   paymentCountWindow, recent30Payments, pdc*Total,
//   companyRecentCollections
// NOTE what is NOT in that list: currentCreditLimit. The core is
// stateless by design - see change (L). Never add it back.
// ============================================================
// ------------------------------------------------------------
// 7. TARGET DAYS - CONTINUOUS CURVE (piecewise-linear, no cliffs)
// ------------------------------------------------------------
dynamicTargetDays = dayAnchors.get(0).toDecimal();
if(finalRiskAPD >= apdAnchors.get(lastAnchorIndex).toDecimal())
{
	dynamicTargetDays = dayAnchors.get(lastAnchorIndex).toDecimal();
}
else if(finalRiskAPD > apdAnchors.get(0).toDecimal())
{
	for each  segmentIndex in anchorSegmentList
	{
		segmentLowAPD = apdAnchors.get(segmentIndex).toDecimal();
		segmentHighAPD = apdAnchors.get(segmentIndex + 1).toDecimal();
		if(finalRiskAPD > segmentLowAPD && finalRiskAPD <= segmentHighAPD)
		{
			segmentLowDays = dayAnchors.get(segmentIndex).toDecimal();
			segmentHighDays = dayAnchors.get(segmentIndex + 1).toDecimal();
			segmentSpan = segmentHighAPD - segmentLowAPD;
			if(segmentSpan > 0)
			{
				dynamicTargetDays = segmentLowDays + (finalRiskAPD - segmentLowAPD) / segmentSpan * (segmentHighDays - segmentLowDays);
			}
			else
			{
				dynamicTargetDays = segmentHighDays;
			}
		}
	}
}
// Evidence gate: not enough payments in the window means the top of
// the curve stays locked.
qualifiesForExcellent = paymentCountWindow >= minimumPaymentsForExcellent;
if(qualifiesForExcellent == false && dynamicTargetDays > unprovenTargetDaysCap)
{
	dynamicTargetDays = unprovenTargetDaysCap.toDecimal();
}
// Human-readable band label - logs and the customer field ONLY. It
// does not feed the maths, so moving these boundaries is cosmetic.
slabName = "Severe Risk";
if(trueOutstandingBalance <= 0)
{
	slabName = "Clear - Nothing Outstanding";
}
else if(finalRiskAPD <= 45)
{
	slabName = "Excellent";
}
else if(finalRiskAPD <= 60)
{
	slabName = "Good";
}
else if(finalRiskAPD <= 75)
{
	slabName = "Normal";
}
else if(finalRiskAPD <= 90)
{
	slabName = "Maintain Zone";
}
else if(finalRiskAPD <= 110)
{
	slabName = "Reduce Required";
}
else if(finalRiskAPD <= 130)
{
	slabName = "Serious Risk";
}
if(qualifiesForExcellent == false)
{
	slabName = slabName + " (Unproven - under " + minimumPaymentsForExcellent + " payments in window)";
}
// The pay-down percentage this target actually demands. This is the
// policy in the units the owner and collection staff think in.
requiredPayDownPct = 0.0;
if(finalRiskAPD > 0 && dynamicTargetDays < finalRiskAPD)
{
	requiredPayDownPct = ((1 - dynamicTargetDays / finalRiskAPD) * 100).round(1);
}
// ------------------------------------------------------------
// 8. PDC SUPPORT - CONTINUOUS TRUST FACTOR
// ------------------------------------------------------------
pdcTrustFactor = 1.0;
if(finalRiskAPD >= pdcTrustZeroAPD)
{
	pdcTrustFactor = 0.0;
}
else if(finalRiskAPD > pdcTrustFullAPD)
{
	pdcTrustFactor = 1.0 - (finalRiskAPD - pdcTrustFullAPD) / (pdcTrustZeroAPD - pdcTrustFullAPD);
}
pdc0to30Weight = pdcBaseWeight0to30 * pdcTrustFactor;
pdc31to60Weight = pdcBaseWeight31to60 * pdcTrustFactor;
pdc61to90Weight = pdcBaseWeight61to90 * pdcTrustFactor;
pdc91to120Weight = pdcBaseWeight91to120 * pdcTrustFactor;
pdcWeightedSupport = pdc0to30Total * pdc0to30Weight + pdc31to60Total * pdc31to60Weight + pdc61to90Total * pdc61to90Weight + pdc91to120Total * pdc91to120Weight;
// ------------------------------------------------------------
// 8B. GUARDS AND THE LIMIT ITSELF
// ------------------------------------------------------------
// Downtrend guard - the customer's recent pace has fallen off a cliff.
trendGuardFactor = 1.0;
uptrendGuardFactor = 1.0;
velocityRatio = 1.0;
if(comparisonDailyVelocity > 0 && recentDays >= 30)
{
	velocityRatio = recentDailyVelocity / comparisonDailyVelocity;
	if(velocityRatio <= downtrendFullRatio)
	{
		trendGuardFactor = downtrendMaxDamping;
	}
	else if(velocityRatio < 1.0)
	{
		trendGuardFactor = downtrendMaxDamping + (velocityRatio - downtrendFullRatio) / (1.0 - downtrendFullRatio) * (1.0 - downtrendMaxDamping);
	}
	if(velocityRatio >= uptrendFullRatio)
	{
		uptrendGuardFactor = uptrendMaxDamping;
	}
	else if(velocityRatio > uptrendStartRatio)
	{
		uptrendGuardFactor = 1.0 - (velocityRatio - uptrendStartRatio) / (uptrendFullRatio - uptrendStartRatio) * (1.0 - uptrendMaxDamping);
	}
}
// New-customer bonus. Keyed off REAL contact age - in V10 this used
// days-since-FY-start, so it fired for every customer in April-June.
newCustomerFactor = 1.0;
if(customerAgeDays < newCustomerBonusMaxAgeDays && recent30Payments > 0 && finalRiskAPD <= 45)
{
	newCustomerFactor = newCustomerBonusFactor;
}
actualCollectionCreditLimit = trendDailyVelocity * dynamicTargetDays * trendGuardFactor * uptrendGuardFactor * newCustomerFactor;
// Coverage factor - OFF by default. When enabled it rewards a dealer
// whose balance is shrinking and damps one whose balance is inflating,
// which APD alone cannot distinguish. See the config block.
limitWithoutCoverage = actualCollectionCreditLimit;
if(applyCoverageFactor == true && coverageIsMeasurable == true)
{
	actualCollectionCreditLimit = actualCollectionCreditLimit * coverageFactor;
}
// PDC support is capped relative to the actual-collection-based limit,
// so promised-but-uncashed cheques can never dominate real history.
pdcWeightedSupportBeforeCap = pdcWeightedSupport;
maxPdcContribution = actualCollectionCreditLimit * pdcSupportCapPct;
if(pdcWeightedSupport > maxPdcContribution)
{
	pdcWeightedSupport = maxPdcContribution;
}
calculatedCreditLimit = actualCollectionCreditLimit + pdcWeightedSupport;
// Concentration cap - no single dealer may hold an outsized share of
// the book, however well they pay.
concentrationCapAmount = 0.0;
concentrationCapApplied = false;
if(concentrationCapPct > 0 && companyRecentCollections > 0)
{
	concentrationCapAmount = companyRecentCollections * concentrationCapPct;
	if(calculatedCreditLimit > concentrationCapAmount)
	{
		calculatedCreditLimit = concentrationCapAmount;
		concentrationCapApplied = true;
	}
}
if(maximumCreditLimit > 0 && calculatedCreditLimit > maximumCreditLimit)
{
	calculatedCreditLimit = maximumCreditLimit;
}
roundedCreditLimit = calculatedCreditLimit.round(currencyPrecision);
if(roundedCreditLimit <= 0)
{
	roundedCreditLimit = absoluteMinimumCreditLimit;
}
// ------------------------------------------------------------
// 8C. (DELIBERATELY EMPTY - NO SMOOTHING STAGE)
// roundedCreditLimit above IS the final answer. The engine never
// looks at what the limit used to be, so a manual edit is fully
// corrected on the next run rather than becoming the anchor for the
// next dozen. See change (L). Do not add a clamp here.
// ------------------------------------------------------------
// ------------------------------------------------------------
// 8D. THE CURVE'S FIXED POINT - the APD where target(APD) = APD.
// A customer sitting exactly at their limit has outstanding = limit,
// and since outstanding/limit = APD/targetDays, that means APD =
// targetDays. So this number IS the resting DSO of the whole book:
// every customer who uses their full line settles here.
// Computed from the anchors at runtime so it stays correct if the
// curve is ever retuned. On the current curve it is ~72.5 days.
// ------------------------------------------------------------
curveFixedPointAPD = dayAnchors.get(lastAnchorIndex).toDecimal();
for each  fixedSegment in anchorSegmentList
{
	fpLowAPD = apdAnchors.get(fixedSegment).toDecimal();
	fpHighAPD = apdAnchors.get(fixedSegment + 1).toDecimal();
	fpLowDays = dayAnchors.get(fixedSegment).toDecimal();
	fpHighDays = dayAnchors.get(fixedSegment + 1).toDecimal();
	fpSpan = fpHighAPD - fpLowAPD;
	if(fpSpan > 0)
	{
		fpSlope = (fpHighDays - fpLowDays) / fpSpan;
		if(fpSlope != 1)
		{
			fpCross = (fpLowDays - fpLowAPD * fpSlope) / (1 - fpSlope);
			if(fpCross >= fpLowAPD && fpCross <= fpHighAPD)
			{
				curveFixedPointAPD = fpCross.round(1);
			}
		}
	}
}
// ============================================================
// >>>>>>>>>>>>>>>>> SHARED CALCULATION CORE - END <<<<<<<<<<<<<<<<<
// ============================================================
// ============================================================
// 8E. MINIMUM PAYMENT TODAY - MERGED IN (V12.0)
// Previously two separate scripts (CUSTOMER MINIMUM PAYMENT CHECK and
// BULK MINIMUM PAYMENT CHECK) that re-fetched all of this data and
// solved against the STORED credit limit, which could be days stale.
// Computing it here from the same in-memory numbers makes the two
// answers impossible to disagree, and costs one guarded solve.
//
// WHY THE SOLVE IS CHEAP. We need the smallest X where
//     O - X <= (v + kX) * f(simAPD)
// but by definition O - X = simAPD * (v + kX), so dividing through:
//     simAPD <= f(simAPD)
// The velocity cancels entirely - the condition is just "has APD come
// down to the curve's fixed point". That is why 15 bisection steps
// are plenty where the old scripts used 30-40. The guards and PDC
// support shift the crossing slightly, so the full simulation is
// still run rather than using the closed form directly.
// ============================================================
minimumPaymentRequired = 0.0;
naiveGap = 0.0;
minPaymentVerdict = "WITHIN LIMIT";
if(skipUpdateReason != "")
{
	minPaymentVerdict = skipUpdateReason;
}
else if(trueOutstandingBalance <= 0)
{
	minPaymentVerdict = "NOTHING OUTSTANDING";
}
else if(trueOutstandingBalance <= roundedCreditLimit)
{
	minPaymentVerdict = "WITHIN LIMIT (headroom Rs " + (roundedCreditLimit - trueOutstandingBalance).round(currencyPrecision) + ")";
}
else
{
	solveLowX = 0.0;
	solveHighX = trueOutstandingBalance;
	for each  solveStep in bisectionSteps
	{
		midX = (solveLowX + solveHighX) / 2;
		simOutstanding = trueOutstandingBalance - midX;
		if(simOutstanding < 0)
		{
			simOutstanding = 0.0;
		}
		simRecent30Payments = recent30Payments + midX;
		simRecentDailyVelocity = 0.0;
		if(recentDays > 0)
		{
			simRecentDailyVelocity = simRecent30Payments / recentDays;
		}
		simTrendDailyVelocity = simRecentDailyVelocity * recentWeight;
		if(middleDays > 0)
		{
			simTrendDailyVelocity = simTrendDailyVelocity + middleDailyVelocity * middleWeight;
		}
		if(olderDays > 0)
		{
			simTrendDailyVelocity = simTrendDailyVelocity + olderDailyVelocity * olderWeight;
		}
		if(availableWeight > 0)
		{
			simTrendDailyVelocity = simTrendDailyVelocity / availableWeight;
		}
		simAPD = 150.0;
		if(simOutstanding <= 0)
		{
			simAPD = 0.0;
		}
		else if(simTrendDailyVelocity > 0)
		{
			simAPD = simOutstanding / simTrendDailyVelocity;
			if(simAPD > 150)
			{
				simAPD = 150.0;
			}
		}
		// *** V15.0 *** The simulated APD must be the SAME KIND OF
		// NUMBER as the one the engine actually uses, or the answer
		// solves for a quantity nobody is measured on.
		//
		// Rs midX arriving today retires the OLDEST debt first, so the
		// PENDING age falls - that is modelled exactly, walking the
		// sorted list.
		//
		// The SETTLED average is deliberately held STILL. Today's money
		// does close old bills, and closing a 120-day-old bill would
		// RAISE the settled average, which would make paying money look
		// like it worsened the customer. That is an artifact of when a
		// measurement is taken, not a fact about the dealer, and no
		// engine should ever quote a payment ask that punishes the
		// payment. Holding it still is also the conservative side: if
		// the settled figure governs, the ask can only come out at or
		// above the truth.
		if(useMeasuredAPD == true)
		{
			simRemainingPayment = midX;
			simPendingWeighted = 0.0;
			simPendingTotal = 0.0;
			for each  simOpenItem in sortedOpenList
			{
				simItemBalance = simOpenItem.get("bal").toDecimal();
				simApplied = 0.0;
				if(simRemainingPayment > 0)
				{
					simApplied = simRemainingPayment;
					if(simApplied > simItemBalance)
					{
						simApplied = simItemBalance;
					}
					simRemainingPayment = simRemainingPayment - simApplied;
				}
				simItemLeft = simItemBalance - simApplied;
				if(simItemLeft > 0)
				{
					simPendingWeighted = simPendingWeighted + simOpenItem.get("age").toDecimal() * simItemLeft;
					simPendingTotal = simPendingTotal + simItemLeft;
				}
			}
			simPendingAPD = -1.0;
			if(simPendingTotal > 0)
			{
				simPendingAPD = simPendingWeighted / simPendingTotal;
				if(simPendingAPD > 150)
				{
					simPendingAPD = 150.0;
				}
			}
			simMeasuredAPD = -1.0;
			if(paidAPD >= 0)
			{
				simMeasuredAPD = paidAPD;
			}
			if(simPendingAPD > simMeasuredAPD)
			{
				simMeasuredAPD = simPendingAPD;
			}
			if(simOutstanding <= 0 && simMeasuredAPD < 0)
			{
				simMeasuredAPD = 0.0;
			}
			// If nothing could be measured, the run is already using
			// the old model for the real APD (apdMeasurementFailed),
			// so the simulation stays on it too and the two agree.
			if(simMeasuredAPD >= 0 && apdMeasurementFailed == false)
			{
				simAPD = simMeasuredAPD;
			}
		}
		simTargetDays = dayAnchors.get(0).toDecimal();
		if(simAPD >= apdAnchors.get(lastAnchorIndex).toDecimal())
		{
			simTargetDays = dayAnchors.get(lastAnchorIndex).toDecimal();
		}
		else if(simAPD > apdAnchors.get(0).toDecimal())
		{
			for each  simSegment in anchorSegmentList
			{
				simLowAPD = apdAnchors.get(simSegment).toDecimal();
				simHighAPD = apdAnchors.get(simSegment + 1).toDecimal();
				if(simAPD > simLowAPD && simAPD <= simHighAPD)
				{
					simLowDays = dayAnchors.get(simSegment).toDecimal();
					simHighDays = dayAnchors.get(simSegment + 1).toDecimal();
					simSpan = simHighAPD - simLowAPD;
					if(simSpan > 0)
					{
						simTargetDays = simLowDays + (simAPD - simLowAPD) / simSpan * (simHighDays - simLowDays);
					}
					else
					{
						simTargetDays = simHighDays;
					}
				}
			}
		}
		simPaymentCount = paymentCountWindow;
		if(midX > 0)
		{
			simPaymentCount = paymentCountWindow + 1;
		}
		if(simPaymentCount < minimumPaymentsForExcellent && simTargetDays > unprovenTargetDaysCap)
		{
			simTargetDays = unprovenTargetDaysCap.toDecimal();
		}
		simPdcTrust = 1.0;
		if(simAPD >= pdcTrustZeroAPD)
		{
			simPdcTrust = 0.0;
		}
		else if(simAPD > pdcTrustFullAPD)
		{
			simPdcTrust = 1.0 - (simAPD - pdcTrustFullAPD) / (pdcTrustZeroAPD - pdcTrustFullAPD);
		}
		simPdcSupport = pdc0to30Total * pdcBaseWeight0to30 * simPdcTrust + pdc31to60Total * pdcBaseWeight31to60 * simPdcTrust + pdc61to90Total * pdcBaseWeight61to90 * simPdcTrust + pdc91to120Total * pdcBaseWeight91to120 * simPdcTrust;
		simDownGuard = 1.0;
		simUpGuard = 1.0;
		if(comparisonDailyVelocity > 0 && recentDays >= 30)
		{
			simVelocityRatio = simRecentDailyVelocity / comparisonDailyVelocity;
			if(simVelocityRatio <= downtrendFullRatio)
			{
				simDownGuard = downtrendMaxDamping;
			}
			else if(simVelocityRatio < 1.0)
			{
				simDownGuard = downtrendMaxDamping + (simVelocityRatio - downtrendFullRatio) / (1.0 - downtrendFullRatio) * (1.0 - downtrendMaxDamping);
			}
			if(simVelocityRatio >= uptrendFullRatio)
			{
				simUpGuard = uptrendMaxDamping;
			}
			else if(simVelocityRatio > uptrendStartRatio)
			{
				simUpGuard = 1.0 - (simVelocityRatio - uptrendStartRatio) / (uptrendFullRatio - uptrendStartRatio) * (1.0 - uptrendMaxDamping);
			}
		}
		simNewFactor = 1.0;
		if(customerAgeDays < newCustomerBonusMaxAgeDays && simRecent30Payments > 0 && simAPD <= 45)
		{
			simNewFactor = newCustomerBonusFactor;
		}
		simBaseLimit = simTrendDailyVelocity * simTargetDays * simDownGuard * simUpGuard * simNewFactor;
		simMaxPdc = simBaseLimit * pdcSupportCapPct;
		if(simPdcSupport > simMaxPdc)
		{
			simPdcSupport = simMaxPdc;
		}
		simCreditLimit = simBaseLimit + simPdcSupport;
		if(concentrationCapPct > 0 && companyRecentCollections > 0)
		{
			simConcentrationCap = companyRecentCollections * concentrationCapPct;
			if(simCreditLimit > simConcentrationCap)
			{
				simCreditLimit = simConcentrationCap;
			}
		}
		if(maximumCreditLimit > 0 && simCreditLimit > maximumCreditLimit)
		{
			simCreditLimit = maximumCreditLimit;
		}
		// No smoothing stage - the limit is free to move to its true
		// value, so this answer is the honest minimum. The old scripts
		// capped the simulated limit's rise at +15%, which OVERSTATED
		// the payment collection staff were told to ask for.
		if(simOutstanding <= simCreditLimit)
		{
			solveHighX = midX;
		}
		else
		{
			solveLowX = midX;
		}
	}
	minimumPaymentRequired = solveHighX.round(currencyPrecision);
	naiveGap = (trueOutstandingBalance - roundedCreditLimit).round(currencyPrecision);
	minPaymentVerdict = "COLLECT TODAY: Rs " + minimumPaymentRequired;
}
// ============================================================
// 9. AUDIT LOG AND SAFE UPDATE
// ============================================================
info "----------------------------------------";
info "Outstanding receivable (Zoho) : Rs " + outstandingBalance.round(currencyPrecision);
info "Total uncashed PDCs detected (For Limit Support Only): Rs " + totalUncashedPDC.round(currencyPrecision);
info "----------------------------------------";
info "Payments in window : Rs " + totalWindowPayments.round(currencyPrecision) + " | Count : " + paymentCountWindow;
info "Last 30 days : Rs " + recent30Payments.round(currencyPrecision) + " | " + recentDays + "d | Daily Rs " + recentDailyVelocity.round(2) + " | 40%";
info "Days 31-90 : Rs " + middle31to90Payments.round(currencyPrecision) + " | " + middleDays + "d | Daily Rs " + middleDailyVelocity.round(2) + " | 40%";
info "Days 91+ : Rs " + olderWindowPayments.round(currencyPrecision) + " | " + olderDays + "d | Daily Rs " + olderDailyVelocity.round(2) + " | 20%";
info "Trend daily velocity : Rs " + trendDailyVelocity.round(2);
info "----------------------------------------";
info "TRUE RISK APD : " + finalRiskAPD.round(2) + " days (" + slabName + ")" + apdTrendText;
info "Agreed terms : " + paymentTermLabel + " -> running " + excessDaysOverTerms.round(1) + " days beyond terms";
if(coverageIsMeasurable == true)
{
	balanceDirection = "INFLATING";
	if(coverageRatio >= 1.0)
	{
		balanceDirection = "shrinking";
	}
	balanceMovement = netWindowBilled - totalWindowPayments;
	if(balanceMovement < 0)
	{
		balanceMovement = balanceMovement * -1;
	}
	info "COVERAGE : paid Rs " + totalWindowPayments.round(currencyPrecision) + " vs billed Rs " + netWindowBilled.round(currencyPrecision) + " net (" + invoiceCountWindow + " invoices Rs " + totalWindowInvoiced.round(currencyPrecision) + " less credit notes Rs " + totalWindowCreditNotes.round(currencyPrecision) + ") = " + (coverageRatio * 100).round(1) + "% -> balance " + balanceDirection + " by Rs " + balanceMovement.round(currencyPrecision);
	if(applyCoverageFactor == true)
	{
		info "Coverage factor APPLIED : x" + coverageFactor.round(3);
	}
	else
	{
		info "Coverage is a LEADING INDICATOR ONLY - it is already inside APD (APD = salesDSO / coverage), so it never multiplies the limit. Reference factor x" + coverageFactor.round(3) + ".";
	}
	if(coverageRatio < coverageWarnBelow)
	{
		info "*** WATCH: balance inflating - this customer's APD is heading UP even though today's number may look acceptable. ***";
	}
}
else
{
	info "COVERAGE : not measurable (billed Rs " + totalWindowInvoiced.round(currencyPrecision) + " across " + invoiceCountWindow + " invoices - below the minimum for a meaningful ratio)";
}
info "TARGET DAYS (interpolated from curve) : " + dynamicTargetDays.round(2);
info "=> CURVE DEMAND at this APD : " + requiredPayDownPct + "% of the balance sits above the limit";
info "   (STATIC figure - assumes the limit never moves. It does. The real";
info "    collection number is MIN PAYMENT TODAY below, and it is far lower.)";
info "----------------------------------------";
info "PDC trust factor : " + (pdcTrustFactor * 100).round(1) + "%";
info "PDC 0-30 : " + (pdc0to30Weight * 100).round(1) + "% of Rs " + pdc0to30Total.round(currencyPrecision);
info "PDC 31-60 : " + (pdc31to60Weight * 100).round(1) + "% of Rs " + pdc31to60Total.round(currencyPrecision);
info "PDC 61-90 : " + (pdc61to90Weight * 100).round(1) + "% of Rs " + pdc61to90Total.round(currencyPrecision);
info "PDC 91-120 : " + (pdc91to120Weight * 100).round(1) + "% of Rs " + pdc91to120Total.round(currencyPrecision);
info "Weighted PDC support : Rs " + pdcWeightedSupportBeforeCap.round(currencyPrecision) + " (before cap) -> Rs " + pdcWeightedSupport.round(currencyPrecision) + " (cap was Rs " + maxPdcContribution.round(currencyPrecision) + ")";
info "----------------------------------------";
info "Company actual collections (30 days) : Rs " + companyRecentCollections.round(currencyPrecision);
info "Customer volume : " + customerVolumePercentage.round(2) + "% | Tier " + customerTier + " (informational only - affects nothing)";
info "Velocity ratio (recent vs prior pace) : " + velocityRatio.round(3) + " -> downtrend guard " + trendGuardFactor.round(3) + " | uptrend guard " + uptrendGuardFactor.round(3) + " | new-customer factor " + newCustomerFactor;
info "Actual-collection credit limit : Rs " + actualCollectionCreditLimit.round(currencyPrecision);
if(concentrationCapApplied == true)
{
	info "CONCENTRATION CAP APPLIED : limit held down to Rs " + concentrationCapAmount.round(currencyPrecision) + " (" + (concentrationCapPct * 100).round(0) + "% of company 30-day collections)";
}
// No smoothing stage - the computed figure IS the final answer. The
// old limit is shown purely so the log reads as a before/after; it
// takes no part in the calculation.
limitMovement = roundedCreditLimit - currentCreditLimit;
info "FINAL credit limit : Rs " + roundedCreditLimit + "  (was Rs " + currentCreditLimit.round(currencyPrecision) + ", movement Rs " + limitMovement.round(currencyPrecision) + ")";
info "Calculated fully from this customer's own data - previous limit not used as an input.";
info "----------------------------------------";
info "MIN PAYMENT TODAY : " + minPaymentVerdict;
if(minimumPaymentRequired > 0)
{
	info "  (raw gap without the limit-lift that payment triggers : Rs " + naiveGap + ")";
	info "  In plain terms: collect until this customer's APD comes down to about " + curveFixedPointAPD + " days.";
}
info "Curve fixed point (the book's resting DSO) : " + curveFixedPointAPD + " days";
if(fatalReadError == true)
{
	info "SAFETY BLOCK: Required data could not be read completely. Credit limit was not changed.";
}
else
{
	// STATUS ONLY - no collection figure here. The pay-down percentage
	// used to be written as "Pay down 52.4% to order more", which was
	// wrong twice over: it is the STATIC gap (what is over limit if the
	// limit never moved), and it directly contradicted Min Payment
	// Today on the same record. For DEALER-D it read 52.4% (~Rs 1,89,600)
	// while the true collection figure was Rs 57,791 - because paying
	// that lifts the limit to meet the reduced balance exactly. Staff
	// would have chased three times the money they needed.
	// Average Payment Days answers "how risky, and which way is it
	// going". Min Payment Today answers "what do I collect". One
	// number, one field, no contradiction.
	// *** V12.1 *** A customer with no payment history used to be
	// skipped here entirely - credit_limit was left at whatever it
	// happened to hold. That caused two faults at once:
	//   a brand new contact kept an EMPTY credit_limit, and Zoho reads
	//   an empty credit limit as UNLIMITED - the least trustworthy
	//   customers in the book were the only ones with no ceiling;
	//   a customer whose payment history had been removed kept a STALE
	//   number frozen forever, so the engine stopped being idempotent -
	//   create a transaction and delete it and the limit did not come
	//   back (reproduced 2026-08-17: frozen at Rs 3,75,000 while the
	//   engine had correctly computed Rs 1).
	// Both are now written like every other customer. The engine
	// already computes the right answer - Rs 1, which means "sell, but
	// on advance or Due on Receipt until a payment history exists",
	// not "refuse the sale". This also restores lesson 9: credit_limit
	// is an OUTPUT, never an input, with no exceptions.
	// *** V15.0 *** BOTH measurements go on the customer record, at the
	// owner's instruction. Collection staff see this field on the
	// mobile app and nothing else - a single blended number tells them
	// what the engine decided but not why, and the two halves answer
	// two different questions on the doorstep: "does this dealer settle
	// bills" and "how old is the money he is sitting on".
	// The leading "<number> days" must stay first: the previous-APD
	// reader at the top of this script parses exactly that prefix.
	apdDetailText = "";
	if(paidAPD >= 0)
	{
		apdDetailText = "Settled " + paidAPD.round(1) + "d";
	}
	else
	{
		apdDetailText = "Settled n/a";
	}
	if(pendingAPD >= 0)
	{
		apdDetailText = apdDetailText + " | Pending " + pendingAPD.round(1) + "d";
	}
	else
	{
		apdDetailText = apdDetailText + " | Pending n/a";
	}
	// Say which one decided, in words, so nobody has to work it out
	// from the two numbers.
	if(apdMeasurementFailed == true)
	{
		apdDetailText = apdDetailText + " | NOT MEASURABLE";
	}
	else if(useMeasuredAPD == false)
	{
		apdDetailText = apdDetailText + " | old model";
	}
	else if(paidAPD < 0)
	{
		// Batch 1 of the 2026-09-01 dry run showed why this branch has to
		// exist: 55 of 75 customers had no settled bill to average, so
		// they are judged on the age of pending money alone. A dealer who
		// bought last week and has never paid anything then reads
		// "36.0 days (Excellent)" on the one field collection staff can
		// see. The number is not wrong - young money IS young - but shown
		// without this warning it reads as a verdict on the dealer rather
		// than on the age of a bill.
		apdDetailText = apdDetailText + " | NO SETTLED BILL - judged on age of pending money only";
	}
	else if(pendingAPD >= paidAPD)
	{
		apdDetailText = apdDetailText + " | OLD MONEY DECIDES";
	}
	else
	{
		apdDetailText = apdDetailText + " | settlement decides";
	}
	apdFieldText = "" + finalRiskAPD.round(1) + " days (" + slabName + ") | " + apdDetailText;
	if(skipUpdateReason != "")
	{
		apdFieldText = skipUpdateReason;
	}
	else if(trueOutstandingBalance > roundedCreditLimit)
	{
		apdFieldText = apdFieldText + " | OVER LIMIT - see Min Payment Today";
	}
	else
	{
		apdFieldText = apdFieldText + " | Within limit";
	}
	// The trend and coverage decorations are meaningless for a customer
	// with no payment history, so they are left off that message.
	if(skipUpdateReason == "")
	{
		apdFieldText = apdFieldText + apdTrendText;
		// Coverage warning goes on the customer record so collection staff
		// see the trajectory, not just today's level.
		if(coverageIsMeasurable == true && coverageRatio < coverageWarnBelow)
		{
			apdFieldText = apdFieldText + " | WATCH: paying only " + (coverageRatio * 100).round(0) + "% of billings, balance inflating";
		}
	}
	apdFieldEntry = Map();
	apdFieldEntry.put("api_name","cf_average_payment_days");
	apdFieldEntry.put("value",apdFieldText);
	// Min Payment Today is written from the SAME run that set the limit,
	// so the two can never disagree. This is what retires the separate
	// CUSTOMER / BULK MINIMUM PAYMENT CHECK scripts - and it reaches the
	// mobile app, which the old Custom Button never did.
	minPaymentFieldEntry = Map();
	minPaymentFieldEntry.put("api_name",minPaymentFieldAPIName);
	minPaymentFieldEntry.put("value",minPaymentVerdict);
	apdFieldList = List();
	apdFieldList.add(apdFieldEntry);
	apdFieldList.add(minPaymentFieldEntry);
	updateMap = Map();
	updateMap.put("credit_limit",roundedCreditLimit);
	updateMap.put("custom_fields",apdFieldList);
	updateParams = Map();
	updateParams.put("JSONString",updateMap.toString());
	updateResp = invokeurl
	[
		url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
		type :PUT
		parameters:updateParams
		connection:"zerp"
	];
	if(updateResp != null && updateResp.containsKey("code") && updateResp.get("code") == 0)
	{
		info "SUCCESS: Credit limit updated to Rs " + roundedCreditLimit;
	}
	else
	{
		info "ERROR: Credit limit update failed.";
		info updateResp;
	}
}
info "========================================";
info "ACME AUTO CREDIT LIMIT - TREND ENGINE V12.1 END";
info "========================================";
