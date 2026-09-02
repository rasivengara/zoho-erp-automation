// ============================================================
// SCHEDULED CREDIT LIMIT BATCH  -  v15.0  (batch 1 of 4)
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Scheduled function, created under the Customers
//              module (the selected customer is ignored)
// Schedule     Four copies, 30 minutes apart, batchNumber 1-4,
//              batchSize 75. batchNumber is the ONLY line that
//              differs between the four copies.
// Writes       contact.credit_limit, cf_average_payment_days,
//              cf_min_payment_today
// ------------------------------------------------------------
// WHAT IT DOES
// The nightly whole-book counterpart to
// AUTO_CREDIT_LIMIT_ENGINE.js. That script refreshes one dealer
// when they pay; this one refreshes every dealer, including the
// ones who have not paid in months and would otherwise keep a
// stale limit indefinitely.
//
// The shared methodology sits between the CORE START / CORE END
// markers and is byte-identical across the credit-limit scripts,
// so a dealer is never judged by two different numbers.
//
// IT IS ALSO THE CALIBRATION TOOL
// Run with dryRun = true and measureCoverage = true and it prints
// the weighted-average target days the current curve produces -
// that figure IS the resting DSO of the whole book, in days. The
// dayAnchors curve is then re-fitted against it before anything
// is allowed to write. Limit totals are read as multiples of
// monthly sales against a ceiling of 2x monthly sales.
//
// Batch sizing exists because Deluge caps a function at 200,000
// statements and Zoho rate-limits on CUMULATIVE org traffic -
// spacing between the four runs matters more than batch size.
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
// ############################################################
// ####  CREDIT LIMIT V15.0 MEASURED APD  -  COPY 1 of 4
// ####  Run time 03:00   batchNumber = 1   batchSize = 75
// ############################################################
// Ready to paste as-is. NOTHING needs editing.
// batchNumber is the ONLY line that differs between the four.
// dryRun ships TRUE here. Set it to false only after a
// measured dry run.
//
// GENERATED FROM: SCHEDULED_CREDIT_LIMIT_BATCH.js (master copy)
// Never edit a SCHEDULE copy directly. Edit the master and
// regenerate all four, or they drift apart - which is exactly how
// the April bug survived four versions in TOD.
//
// batchSize is 75, not 100: the invoice read is no longer optional
// in V15 (it is where the APD comes from), so a run costs ~283 API
// calls at 75 against the 210 that ran clean at 100 on 2026-08-14.
// Four batches of 75 cover 300 slots against 270 customers. The
// four run 30 minutes apart, which lesson 13 says matters more
// than batch size.
// ############################################################

// ============================================================
// ACME CREDIT LIMIT + MIN PAYMENT REBUILD - BATCH V15.0
// *** V15.0 (2026-09-01) - APD IS NOW MEASURED, NOT INFERRED.
// Read the V15 header note in AUTO_CREDIT_LIMIT_ENGINE.js before changing anything here. Short version:
// APD was outstandingBalance/velocity, a DSO ratio that one cheque
// could move twenty days. It is now max(settled-bill APD, pending
// money APD), both amount-weighted and both measured from
// documents. THIS FILE IS THE CALIBRATION TOOL: run it with
// dryRun = true and re-fit dayAnchors before the new APD writes
// anything, because a lower APD means a HIGHER limit and the
// anchors were fitted against the old number.
// Create under Customers module. The selected customer is ignored.
//
// Mirrors AUTO CREDIT LIMIT ENGINE V12.0 exactly. That file's header
// carries the full reasoning for every design choice (A) to (S) -
// read it before changing anything here. The short version:
//   - continuous target-days curve, no band cliffs
//   - loosening spent only inside the 60-90 maintain zone
//   - rolling 180-day velocity window (kills the April FY bug)
//   - divisors calibrated from the earliest OBSERVED payment
//   - stateless: contact.credit_limit is never an input
//   - coverage measured but never multiplied into the limit
//   - min payment solved here, from the same numbers
//
// V12.0 REPLACES TWO SCRIPTS. BULK MINIMUM PAYMENT CHECK is now
// redundant - this run writes cf_min_payment_today from the same
// numbers that set the credit limit, so the two cannot disagree.
// Delete those four scheduled copies once this is live.
//
// ============================================================
// THIS IS ALSO THE MEASUREMENT TOOL - USE IT BEFORE GOING LIVE
// ============================================================
//   1. dryRun = true (default). measureCoverage = true. Run all
//      batches.
//   2. Read "Weighted-average target days" in the summary. That IS
//      the rotation this curve produces, in days - no arithmetic
//      needed. The VERDICT line says whether it hits your target.
//   3. Too loose? LOWER the top anchors (68/62/55) - they carry ~76%
//      of all limit rupees. Too tight and sales are suffering? Raise
//      them. Re-run - it costs nothing and writes nothing.
//   4. CURVE FIXED POINT is where a customer who uses their whole
//      line settles. It should sit at or below your rotation target.
//   5. Only when the totals look right: dryRun = false, and set
//      measureCoverage = false on the production schedules.
//
// STATEMENT-COST NOTE. Deluge caps a run at 200,000 statements.
//   measureCoverage = false -> 2 paginated reads per customer.
//   measureCoverage = true  -> 4 paginated reads per customer.
//
// *** API RATE LIMIT - THE TIGHTER CONSTRAINT, AND THE ONE THAT
// *** ACTUALLY BIT ON 2026-08-14.
// Zoho Books throttles API calls per minute per organization. This
// function makes roughly (5 x batchSize) calls back to back with
// coverage on, or (3 x batchSize) with it off. At batchSize 60 with
// coverage that is 300+ calls in one burst, and the run failed on its
// very first read because the quota was already spent by preceding
// runs.
//
// CONFIRMED on 2026-08-14: {"code":44,"message":"...blocked as it have
// exceeded the maximum number of requests per minute..."} - the block
// is on the ORGANISATION, not this function, so every other Zoho
// integration is affected too while it lasts.
//
// TWO SAVINGS ARE BUILT IN:
//  - the PDC query is SKIPPED entirely when the contact holds no
//    unused credits (all six sampled customers had none), removing
//    roughly one call per customer;
//  - the run now COUNTS its own API calls and prints the total, so
//    batch size can be set from evidence rather than guesswork.
//
// BATCH SIZE IS NOT THE PROBLEM - CUMULATIVE TRAFFIC IS.
// The V10 BULK MINIMUM PAYMENT CHECK ran 100 customers cleanly (its
// own test notes: 100 customers, 62 needing collection, 0 failures),
// and that made roughly 330 calls - more than V12 does at the same
// size, because V12 now skips the PDC query for the majority of
// customers. A single run's calls also spread across more than one
// minute-window, so a large batch is far less dangerous than several
// runs fired back to back.
//
//   measureCoverage = false -> batchSize 100  (~200 calls, dry run)
//   measureCoverage = true  -> batchSize 50   (coverage doubles it)
//
// The rule that matters is SPACING, not size: leave 2-3 minutes
// between runs, and never fire a batch straight after testing the
// AUTO engine several times. The quota belongs to the whole
// organisation, so while it is blocked every other Zoho integration
// is blocked too.
//
// A failed COMPANY read is now survivable (see the block below). A
// failed per-customer read still skips that one customer safely and
// reports it, which is correct - those reads DO drive the limit.
// ============================================================
// *** V15.0 SHIPS WITH dryRun = TRUE, DELIBERATELY. ***
// The curve below was calibrated on 2026-08-14 against the OLD APD
// (limits at ~1.95 x monthly sales, 58.3-day rotation).
// V15 changes what APD MEANS, and PROBE E measured the new number
// coming out lower on most accounts - which raises limits. Running
// this live before re-fitting dayAnchors would loosen the whole book
// silently. Measure first: leave dryRun true, run all four batches,
// add up TOTAL NEW LIMITS, compare against the 2 x monthly sales
// ceiling, and
// only then set this to false.
dryRun = true;
// Coverage is report-only and costs two extra API calls per customer.
// Keep it OFF in production. Switch on for a sample batch if you ever
// want the payments-vs-billings distribution again.
measureCoverage = false;
// 100 with coverage off, 50 with it on.
// 100 is NOT a guess - the V10 BULK MINIMUM PAYMENT CHECK ran 100
// customers cleanly with 0 failures, and that made MORE calls than
// this does (V12 skips the PDC query for customers holding no unused
// credits, which is most of them). The code-44 block on 2026-08-14
// came from CUMULATIVE traffic - repeated AUTO tests plus two
// coverage-enabled batches inside a few minutes - not from batch size.
// Watch "API CALLS THIS RUN" in the summary and size from that.
// *** V15.0 *** 100 -> 75. The invoice read is no longer optional
// (it is where the APD now comes from), which adds about one
// paginated call per customer, and customers carrying an opening
// balance cost one more. 100 customers would put this near 350 calls
// in a run against the 210 that ran clean on 2026-08-14. Four
// batches of 75 still cover 300 slots against 270 customers, so no
// extra schedule is needed. Raise it back only with an "API CALLS
// THIS RUN" figure in hand.
batchSize = 75;
batchNumber = 1;
// Run 1, then 2, 3, 4 ... based on total customers.
// ------------------------------------------------------------
// YOUR ROTATION TARGET. Set these and the summary will tell you, in
// one line, whether the curve delivers it - no arithmetic needed.
//
// The identity that makes this work:
//   total limits = SUM(velocity x target) = SUM(velocity) x avg target
//   SUM(velocity) = daily collections ~= daily sales
//   target outstanding = daily sales x rotation days
//   ==> WEIGHTED-AVERAGE TARGET DAYS = THE BOOK'S ROTATION IN DAYS
//
// So the weighted average target printed below IS the rotation this
// curve produces. Want 60 days? Make that number 60.
// ------------------------------------------------------------
monthlyAverageSales = 1550000;
targetRotationDaysMax = 60;
targetRotationDaysIdeal = 45;
runDate = zoho.currentdate;
runDateStr = runDate.toString("yyyy-MM-dd");
currencyPrecision = 0;
recentWeight = 0.40;
middleWeight = 0.40;
olderWeight = 0.20;
maximumCreditLimit = 0.0;
minimumPaymentsForExcellent = 3;
pdcSupportCapPct = 0.40;
velocityLookbackDays = 180;
// ------------------------------------------------------------
// *** V15.0 - THE MEASURED APD BLOCK ***
// These five lines are the whole tuning surface of the new APD.
// ------------------------------------------------------------
// How far back a SETTLEMENT counts. The owner's choice, and it
// matches how the TOD schemes are already run - the business thinks
// in quarters, so a dealer is judged on the quarter just finished.
apdClosureWindowDays = 90;
// The widen. If 90 days does not hold enough settled bills, the
// window opens to this before the paid figure is abandoned. A
// sample-size rescue, NOT a second opinion.
apdClosureWindowWideDays = 180;
// The smallest number of settled bills a paid average may rest on.
// Two, because DEALER-C's single same-day bill produced a
// 0.00-day "perfect" score in PROBE E. One row is an anecdote.
apdMinClosedBills = 2;
// How far back the INVOICE QUERY reaches - deliberately wider than
// the closure window, so a long-overdue bill settled last week is
// still visible.
invoiceLookbackDays = 365;
// Set false to fall back to the old balance/velocity APD without
// touching anything else. A rollback path for one release.
useMeasuredAPD = true;
sortRoundList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80};
// ------------------------------------------------------------
// THE POLICY CURVE - MUST BE IDENTICAL IN ALL ENGINES.
//    APD  30 -> 76 | APD  45 -> 69 | APD  60 -> 60 (NEUTRAL)
//    APD  75 -> 52 (31% pay-down) | APD  90 -> 45 (50%)
//    APD 110 -> 33 (70%) | APD 130 -> 25 (81%) | APD 150 -> 18 (88%)
// Calibrated on two full dry runs of all 265 customers: this curve
// produces ~1.95 x monthly sales in limits, i.e. a ~59-day book,
// from a starting position of ~2.77 x monthly sales / 83 days.
// The APD<=45 group carries ~57% of all limit rupees (measured, not
// guessed), so a UNIFORM scaling of the curve is the right way to
// shift the rotation up or down.
// RULE: dayAnchors MUST stay strictly decreasing.
// RULE: unprovenTargetDaysCap must stay BELOW the top anchor.
// ------------------------------------------------------------
apdAnchors = {30,45,60,75,90,110,130,150};
dayAnchors = {76,69,60,52,45,33,25,18};
anchorSegmentList = {0,1,2,3,4,5,6};
lastAnchorIndex = 7;
unprovenTargetDaysCap = 60;
pdcTrustFullAPD = 60.0;
pdcTrustZeroAPD = 130.0;
pdcBaseWeight0to30 = 0.80;
pdcBaseWeight31to60 = 0.50;
pdcBaseWeight61to90 = 0.20;
pdcBaseWeight91to120 = 0.10;
// NO SMOOTHING PARAMETERS BY DESIGN - credit_limit is an OUTPUT and
// must never become an input. See change (L) in AUTO V12.0.
// Continuous guards - see change (S).
downtrendFullRatio = 0.30;
downtrendMaxDamping = 0.85;
uptrendStartRatio = 2.0;
uptrendFullRatio = 4.0;
uptrendMaxDamping = 0.85;
concentrationCapPct = 0.25;
newCustomerProbationDays = 90;
newCustomerBonusMaxAgeDays = 90;
// *** V12.1 (2026-08-17) *** A daily rate divided by a handful of
// days is an extrapolation, not a rate. Reproduced live: a 0-day-old
// contact paying Rs 1,940 read as Rs 1,940 PER DAY and earned a
// Rs 1,45,500 limit. Same family as lesson 6 (the April bug) - the
// financial-year windowing was fixed then, but nobody put a floor
// under the divisor. 60 = one full Net 60 credit cycle, which is also
// the curve's fixed point. Established customers are unaffected;
// their divisor is already the full 180.
// THIS IS THE KNOB TO DRY-RUN. Try 30 / 60 / 90 and compare the
// portfolio totals the same way the curve was calibrated in section 4
// of the project notes.
minimumVelocityDivisorDays = 60;
// *** V12.1 *** Was 1.25 - a 25% uplift handed to the customer with
// the LEAST evidence, multiplying an already inflated velocity. If a
// new dealer needs more room it belongs in the curve, not here.
newCustomerBonusFactor = 1.00;
absoluteMinimumCreditLimit = 1;
// Coverage is REPORTED ONLY and must stay that way - it is already
// inside APD (APD = salesDSO / coverage). See change (O).
coverageLowRatio = 0.70;
coverageLowFactor = 0.85;
coverageNeutralLow = 0.90;
coverageNeutralHigh = 1.10;
coverageHighRatio = 1.30;
coverageHighFactor = 1.15;
coverageWarnBelow = 0.85;
coverageMinInvoiced = 1000;
coverageMinInvoiceCount = 3;
minPaymentFieldAPIName = "cf_min_payment_today";
bisectionSteps = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
pageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50};
// Counts every Zoho API call this run makes, so batch size can be set
// from evidence instead of guesswork. Zoho blocks the whole
// organisation near 100 calls/minute (error code 44).
// MUST be declared here, above the first invokeurl - the company
// collections read below increments it.
apiCallCount = 0;
organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
recentStartDate = runDate.subDay(29);
recentStartStr = recentStartDate.toString("yyyy-MM-dd");
middleStartDate = runDate.subDay(89);
middleEndDate = runDate.subDay(30);
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
// ------------------------------------------------------------
// CURVE FIXED POINT - the APD where target(APD) = APD, i.e. the
// resting DSO of the whole book. Computed from the anchors so it
// stays correct if the curve is retuned.
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
// Company last-30-day collections - read ONCE for the whole batch.
//
// NOT FATAL AS OF V12.0. In V10 this drove Tier, which drove target
// days, so a failed read genuinely invalidated everything. In V12 it
// feeds only the concentration cap and the informational Tier label -
// NEITHER of which touches the credit limit. Aborting a 60-customer
// batch over a ceiling that does not currently bind is the wrong
// trade, so on failure the cap is simply disabled and the run
// continues.
//
// A PARTIAL read is worse than none: it would make the cap wrongly
// tight. So on any error the total is zeroed rather than kept.
//
// Each page gets one immediate retry. Most failures here are
// transient, and the commonest cause is Zoho's per-minute API rate
// limit - see the STATEMENT-COST / RATE-LIMIT note in the header.
// ============================================================
companyRecentCollections = 0.0;
companyReadError = false;
companyErrorDetail = "";
companyMore = true;
attemptList = {1,2};
for each  companyPage in pageList
{
	if(companyMore == true)
	{
		companyPageDone = false;
		for each  companyAttempt in attemptList
		{
			if(companyPageDone == false)
			{
				companyResp = invokeurl
				[
					url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&date_start=" + recentStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + companyPage
					type :GET
					connection:"zerp"
				];
				apiCallCount = apiCallCount + 1;
				if(companyResp != null && companyResp.containsKey("code") && companyResp.get("code") == 0)
				{
					companyPageDone = true;
					companyList = companyResp.get("customerpayments");
					if(companyList != null)
					{
						for each  companyPayment in companyList
						{
							companyStatus = companyPayment.get("status");
							if(companyPayment.get("amount") != null && companyStatus != "draft" && companyStatus != "void" && companyStatus != "cancelled" && companyStatus != "refunded")
							{
								companyRecentCollections = companyRecentCollections + companyPayment.get("amount").toDecimal();
							}
						}
					}
					companyCtx = companyResp.get("page_context");
					if(companyCtx == null || companyCtx.get("has_more_page") != true)
					{
						companyMore = false;
					}
				}
				else if(companyAttempt == 2)
				{
					// Print what Zoho actually said. The old code discarded
					// this and reported only "could not be read", which made
					// the failure impossible to diagnose.
					if(companyResp == null)
					{
						companyErrorDetail = "no response at all on page " + companyPage;
					}
					else
					{
						companyErrorDetail = "page " + companyPage + " returned: " + companyResp.toString();
					}
					companyReadError = true;
					companyMore = false;
				}
			}
		}
	}
}
if(companyMore == true)
{
	companyReadError = true;
	companyErrorDetail = "pagination exceeded 10,000 rows";
}
if(companyReadError == true)
{
	companyRecentCollections = 0.0;
	info "WARNING: company collection data could not be read after a retry.";
	info "  Zoho said: " + companyErrorDetail;
	info "  NOT FATAL - this only feeds the concentration cap and the Tier";
	info "  label, neither of which affects the credit limit. Continuing with";
	info "  the concentration cap DISABLED for this run.";
	info "  If this says anything about rate limits, reduce batchSize and";
	info "  space the schedules further apart.";
}
modeLabel = "LIVE (limits WILL be written)";
if(dryRun == true)
{
	modeLabel = "DRY RUN (nothing written)";
}
info "========================================";
info "ACME CREDIT LIMIT + MIN PAYMENT V12.1 - BATCH " + batchNumber + " (size " + batchSize + ")";
info "MODE: " + modeLabel + " | coverage measured: " + measureCoverage;
info "Run date: " + runDateStr + " | Company 30-day collections: Rs " + companyRecentCollections.round(currencyPrecision);
info "CURVE FIXED POINT (book's resting DSO): " + curveFixedPointAPD + " days";
info "========================================";
customersUpdated = 0;
customersBlocked = 0;
customersFailed = 0;
customersSkippedNoHistory = 0;
customersOverNewLimit = 0;
sumOutstanding = 0.0;
sumCurrentLimits = 0.0;
sumNewLimits = 0.0;
// Sum of trendDailyVelocity across scored customers. Divided into
// sumNewLimits it gives the velocity-weighted average target days -
// which IS the rotation this curve produces. See the identity above.
sumVelocity = 0.0;
sumMinPayments = 0.0;
sumAPD = 0.0;
sumAPDWeighted = 0.0;
// *** V15.0 *** Old-model versus measured, accumulated so the shift
// the new APD makes to the whole book is one line in the summary
// rather than something to work out from 268 customer blocks.
sumOldAPD = 0.0;
sumOldAPDWeighted = 0.0;
countSettledGoverned = 0;
countPendingGoverned = 0;
countNoSettledBill = 0;
countBelowMinClosed = 0;
countAPDNotMeasurable = 0;
countCreditNoteClosures = 0;
countScored = 0;
apdBucketUnder45 = 0;
apdBucket46to60 = 0;
apdBucket61to75 = 0;
apdBucket76to90 = 0;
apdBucket91to110 = 0;
apdBucket111to130 = 0;
apdBucket131plus = 0;
countLimitUp = 0;
countLimitDown = 0;
sumExcessDaysOverTerms = 0.0;
countBeyondTerms = 0;
countTermsNotSet = 0;
sumCoverage = 0.0;
countCoverageMeasured = 0;
countCoverageInflating = 0;
contactsListFailed = false;
contactsMore = true;
batchStartIndex = (batchNumber - 1) * batchSize;
batchEndIndex = batchStartIndex + batchSize - 1;
contactIndex = 0;
batchComplete = false;
for each  contactsPage in pageList
{
	if(contactsMore == true)
	{
		contactsResp = invokeurl
		[
			url :apiEndPoint + "/contacts?organization_id=" + organizationID + "&contact_type=customer&per_page=200&page=" + contactsPage
			type :GET
			connection:"zerp"
		];
		apiCallCount = apiCallCount + 1;
		if(contactsResp != null && contactsResp.containsKey("code") && contactsResp.get("code") == 0)
		{
			contactsList = contactsResp.get("contacts");
			if(contactsList != null)
			{
				for each  contactSummary in contactsList
				{
					if(batchComplete == false)
					{
						if(contactIndex >= batchStartIndex && contactIndex <= batchEndIndex)
						{
							customerID = contactSummary.get("contact_id");
							customerName = contactSummary.get("contact_name");
							customerError = false;
							contactStatus = contactSummary.get("status");
							if(contactStatus == "inactive")
							{
								customerError = true;
							}
							if(customerID == null || customerID == "")
							{
								customerError = true;
							}
							if(customerError == false)
							{
								contactResp = invokeurl
								[
									url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
									type :GET
									connection:"zerp"
								];
								apiCallCount = apiCallCount + 1;
								if(contactResp != null && contactResp.containsKey("code") && contactResp.get("code") == 0 && contactResp.get("contact") != null)
								{
									contactData = contactResp.get("contact");
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
									// Drives the PDC-read skip below.
									unusedCredits = 0.0;
									if(contactData.get("unused_credits_receivable_amount") != null)
									{
										unusedCredits = contactData.get("unused_credits_receivable_amount").toDecimal();
									}
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
									paymentTermDays = 0;
									termsAreSet = false;
									if(contactData.get("payment_terms") != null)
									{
										paymentTermDays = contactData.get("payment_terms").toLong();
										termsAreSet = true;
									}
									paymentTermLabel = contactData.get("payment_terms_label");
									if(paymentTermLabel == null || paymentTermLabel == "")
									{
										paymentTermLabel = "Not set";
									}
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
									// ---- payments (full window, earliest tracked) ----
									recent30Payments = 0.0;
									middle31to90Payments = 0.0;
									olderWindowPayments = 0.0;
									totalWindowPayments = 0.0;
									paymentCountWindow = 0;
									earliestPaymentDate = runDate;
									foundAnyPayment = false;
									paymentsMore = true;
									for each  paymentPage in pageList
									{
										if(paymentsMore == true)
										{
											paymentsResp = invokeurl
											[
												url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + queryStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + paymentPage
												type :GET
												connection:"zerp"
											];
											apiCallCount = apiCallCount + 1;
											if(paymentsResp != null && paymentsResp.containsKey("code") && paymentsResp.get("code") == 0)
											{
												paymentList = paymentsResp.get("customerpayments");
												if(paymentList != null)
												{
													for each  paymentItem in paymentList
													{
														payStatus = paymentItem.get("status");
														payDateStr = paymentItem.get("date");
														if(paymentItem.get("amount") != null && payDateStr != null && payDateStr != "" && payStatus != "draft" && payStatus != "void" && payStatus != "cancelled" && payStatus != "refunded")
														{
															payDate = payDateStr.toDate("yyyy-MM-dd");
															payAmount = paymentItem.get("amount").toDecimal();
															paymentCountWindow = paymentCountWindow + 1;
															totalWindowPayments = totalWindowPayments + payAmount;
															if(foundAnyPayment == false || payDate < earliestPaymentDate)
															{
																earliestPaymentDate = payDate;
															}
															foundAnyPayment = true;
															if(payDate >= recentStartDate)
															{
																recent30Payments = recent30Payments + payAmount;
															}
															else if(payDate >= middleStartDate && payDate <= middleEndDate)
															{
																middle31to90Payments = middle31to90Payments + payAmount;
															}
															else
															{
																olderWindowPayments = olderWindowPayments + payAmount;
															}
														}
													}
												}
												payCtx = paymentsResp.get("page_context");
												if(payCtx == null || payCtx.get("has_more_page") != true)
												{
													paymentsMore = false;
												}
											}
											else
											{
												customerError = true;
												paymentsMore = false;
											}
										}
									}
									if(paymentsMore == true)
									{
										customerError = true;
									}
									// ---- PDCs ----
									// Held as Unused Credits and NOT netted off outstanding
									// (confirmed by the owner), so outstanding is GROSS and
									// this support is a genuine addition, not a double-count.
									pdc0to30Total = 0.0;
									pdc31to60Total = 0.0;
									pdc61to90Total = 0.0;
									pdc91to120Total = 0.0;
									// PDCs sit in Zoho as UNUSED CREDITS. So if this contact
									// holds none, there are no future-dated payments to find
									// and the whole query is a wasted API call. All six test
									// customers on 2026-08-14 had zero PDCs, so this skips a
									// call for most of the book - the single biggest saving
									// available against the code-44 rate limit.
									// If a future-dated payment HAS been applied to an invoice
									// it is not an unused credit, but then it has already
									// reduced outstanding, so counting it as PDC support would
									// double-count. Skipping is the correct direction.
									pdcMore = false;
									if(unusedCredits > 0)
									{
										pdcMore = true;
									}
									for each  pdcPage in pageList
									{
										if(pdcMore == true)
										{
											pdcResp = invokeurl
											[
												url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + runDate.addDay(1).toString("yyyy-MM-dd") + "&date_end=" + runDate.addDay(365).toString("yyyy-MM-dd") + "&per_page=200&page=" + pdcPage
												type :GET
												connection:"zerp"
											];
											apiCallCount = apiCallCount + 1;
											if(pdcResp != null && pdcResp.containsKey("code") && pdcResp.get("code") == 0)
											{
												pdcList = pdcResp.get("customerpayments");
												if(pdcList != null)
												{
													for each  pdcItem in pdcList
													{
														pdcStatus = pdcItem.get("status");
														if(pdcItem.get("amount") != null && pdcItem.get("date") != null && pdcStatus != "draft" && pdcStatus != "void" && pdcStatus != "cancelled" && pdcStatus != "refunded")
														{
															pdcAmount = pdcItem.get("amount").toDecimal();
															pdcDays = runDate.daysbetween(pdcItem.get("date").toDate("yyyy-MM-dd"));
															if(pdcDays >= 1 && pdcDays <= 30)
															{
																pdc0to30Total = pdc0to30Total + pdcAmount;
															}
															else if(pdcDays <= 60)
															{
																pdc31to60Total = pdc31to60Total + pdcAmount;
															}
															else if(pdcDays <= 90)
															{
																pdc61to90Total = pdc61to90Total + pdcAmount;
															}
															else if(pdcDays <= 120)
															{
																pdc91to120Total = pdc91to120Total + pdcAmount;
															}
														}
													}
												}
												pdcCtx = pdcResp.get("page_context");
												if(pdcCtx == null || pdcCtx.get("has_more_page") != true)
												{
													pdcMore = false;
												}
											}
											else
											{
												customerError = true;
												pdcMore = false;
											}
										}
									}
									if(pdcMore == true)
									{
										customerError = true;
									}
									// ---- invoice history ----
									// *** V15.0 *** THIS READ IS NO LONGER OPTIONAL. It used to sit
									// inside if(measureCoverage), because coverage was all it fed and
									// coverage is report-only. It is now where BOTH measured APDs come
									// from, so it has to run for every customer on every pass.
									// COST: one paginated read per customer that production used to
									// skip - roughly +100 API calls at batchSize 100, on top of the 210
									// that ran clean on 2026-08-14. Watch "API CALLS THIS RUN" in the
									// summary. If code 44 appears, cut batchSize; do not cut this read,
									// because without it there is no APD.
									totalWindowInvoiced = 0.0;
									invoiceCountWindow = 0;
									totalWindowCreditNotes = 0.0;
									coverageRatio = -1.0;
									coverageFactor = 1.0;
									coverageIsMeasurable = false;
									netWindowBilled = 0.0;
									// The two measured APDs are accumulated straight off this response.
									// last_payment_date is confirmed present on the LIST by PROBE E, so
									// none of this costs an extra call.
									paidWeightedDaysPrimary = 0.0;
									paidWeightPrimary = 0.0;
									paidCountPrimary = 0;
									paidWeightedDaysWide = 0.0;
									paidWeightWide = 0.0;
									paidCountWide = 0;
									// Settled bills carrying no payment date - a credit note closed
									// them. Counted so the exclusion can never be silent.
									paidNoDateCount = 0;
									openBalanceTotal = 0.0;
									pendingWeightedDays = 0.0;
									openItemCount = 0;
									oldestOpenAgeDays = -1;
									// Every open item is kept as (age, balance) as well as summed,
									// because Min Payment Today has to simulate what happens to the
									// pending age when a payment lands.
									openItemsList = List();
									invoicesMore = true;
									for each  invoicePage in pageList
									{
										if(invoicesMore == true)
										{
											invoiceResp = invokeurl
											[
												url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + invoiceQueryStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + invoicePage
												type :GET
												connection:"zerp"
											];
											apiCallCount = apiCallCount + 1;
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
															// billing total is filtered back down in code -
															// otherwise coverage would compare a year of
															// billing against six months of payments.
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
																	// counted and reported.
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
																		// zero days late, not negative.
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
												invoiceCtx = invoiceResp.get("page_context");
												if(invoiceCtx == null || invoiceCtx.get("has_more_page") != true)
												{
													invoicesMore = false;
												}
											}
											else
											{
												customerError = true;
												invoicesMore = false;
											}
										}
									}
									if(invoicesMore == true)
									{
										customerError = true;
									}
									if(measureCoverage == true)
									{
										creditNotesMore = true;
										for each  creditNotePage in pageList
										{
											if(creditNotesMore == true)
											{
												creditNoteResp = invokeurl
												[
													url :apiEndPoint + "/creditnotes?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + queryStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + creditNotePage
													type :GET
													connection:"zerp"
												];
												apiCallCount = apiCallCount + 1;
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
													creditNoteCtx = creditNoteResp.get("page_context");
													if(creditNoteCtx == null || creditNoteCtx.get("has_more_page") != true)
													{
														creditNotesMore = false;
													}
												}
												else
												{
													customerError = true;
													creditNotesMore = false;
												}
											}
										}
										if(creditNotesMore == true)
										{
											customerError = true;
										}
										netWindowBilled = totalWindowInvoiced - totalWindowCreditNotes;
										if(netWindowBilled < 0)
										{
											netWindowBilled = 0.0;
										}
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
												coverageFactor = 1.0;
											}
										}
									}
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
											apiCallCount = apiCallCount + 1;
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
									// an unexplained gap).
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
									// ---- divisor calibration from OBSERVED transactions ----
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
									// *** V12.1 *** Never divide by less than one
									// full credit cycle.
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
									if(recentDays > 0)
									{
										recentDailyVelocity = recent30Payments / recentDays;
									}
									middleDailyVelocity = 0.0;
									if(middleDays > 0)
									{
										middleDailyVelocity = middle31to90Payments / middleDays;
									}
									olderDailyVelocity = 0.0;
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
										// Nothing owed at all - this is the BEST case, not the worst.
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
									// ============================================================
									// *** V15.0 - THE MEASURED APD ***
									// trendAPD above is kept for ONE purpose: it is logged beside the
									// measured figure so drift between the old model and the new
									// measurement stays visible. It drives nothing unless
									// useMeasuredAPD is switched off.
									// ============================================================
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
									// a measurement.
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
									pendingAPD = -1.0;
									if(openBalanceTotal > 0)
									{
										pendingAPD = (pendingWeightedDays / openBalanceTotal).round(2);
										if(pendingAPD > 150)
										{
											pendingAPD = 150.0;
										}
									}
									// riskAPD = the worse of the two. Start from "nothing measured",
									// then let each available measurement RAISE it. Never let an ABSENT
									// measurement lower it - that is the whole lesson of the opening
									// balance.
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
											// account for the balance. Not a customer to be generous with,
											// and not one to guess about either: hold the old model's
											// answer and say so loudly.
											apdMeasurementFailed = true;
											apdSourceText = "NOT MEASURABLE - fell back to the old balance/velocity model";
											info "WARNING: no settled bill and no ageable open document for this customer. APD could not be measured; the old balance/velocity figure of " + trendAPD + " is being used instead.";
										}
									}
									else
									{
										apdSourceText = "old balance/velocity model (useMeasuredAPD is OFF)";
									}
									// ------------------------------------------------------------
									// THE OPEN ITEMS, SORTED OLDEST FIRST
									// Min Payment Today has to answer "what does the pending age become
									// if Rs X arrives today", and a payment retires the OLDEST debt
									// first. Sorted ONCE here so the bisection stays linear.
									// Sorted by finding the next-lower age each round and taking every
									// item that shares it, so ties need no special handling and nothing
									// has to be marked as used. Only List.add / .size are used - no sort
									// helper this codebase has not already proven.
									// ------------------------------------------------------------
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
										// More than 80 distinct ages. The unsorted tail is absent from the
										// simulation, which makes the payment ask HIGHER than necessary,
										// never lower - the safe direction - but say so.
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
									excessDaysOverTerms = finalRiskAPD - paymentTermDays;
									apdTrendText = "";
									if(previousAPD >= 0)
									{
										apdMovement = finalRiskAPD - previousAPD;
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
									comparisonDailyVelocity = 0.0;
									if(middleDays > 0)
									{
										comparisonDailyVelocity = middleDailyVelocity;
									}
									else if(olderDays > 0)
									{
										comparisonDailyVelocity = olderDailyVelocity;
									}
									// Tier is INFORMATIONAL ONLY - logged, affects nothing.
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
									// >>>>>>>>>> SHARED CALCULATION CORE - START <<<<<<<<<<
									// Identical to AUTO V12.0. currentCreditLimit is NOT an input.
									// ============================================================
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
									qualifiesForExcellent = paymentCountWindow >= minimumPaymentsForExcellent;
									if(qualifiesForExcellent == false && dynamicTargetDays > unprovenTargetDaysCap)
									{
										dynamicTargetDays = unprovenTargetDaysCap.toDecimal();
									}
									slabName = "Severe Risk";
									if(trueOutstandingBalance <= 0)
									{
										slabName = "Clear";
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
									requiredPayDownPct = 0.0;
									if(finalRiskAPD > 0 && dynamicTargetDays < finalRiskAPD)
									{
										requiredPayDownPct = ((1 - dynamicTargetDays / finalRiskAPD) * 100).round(1);
									}
									pdcTrustFactor = 1.0;
									if(finalRiskAPD >= pdcTrustZeroAPD)
									{
										pdcTrustFactor = 0.0;
									}
									else if(finalRiskAPD > pdcTrustFullAPD)
									{
										pdcTrustFactor = 1.0 - (finalRiskAPD - pdcTrustFullAPD) / (pdcTrustZeroAPD - pdcTrustFullAPD);
									}
									pdcWeightedSupport = pdc0to30Total * pdcBaseWeight0to30 * pdcTrustFactor + pdc31to60Total * pdcBaseWeight31to60 * pdcTrustFactor + pdc61to90Total * pdcBaseWeight61to90 * pdcTrustFactor + pdc91to120Total * pdcBaseWeight91to120 * pdcTrustFactor;
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
									newCustomerFactor = 1.0;
									if(customerAgeDays < newCustomerBonusMaxAgeDays && recent30Payments > 0 && finalRiskAPD <= 45)
									{
										newCustomerFactor = newCustomerBonusFactor;
									}
									actualCollectionCreditLimit = trendDailyVelocity * dynamicTargetDays * trendGuardFactor * uptrendGuardFactor * newCustomerFactor;
									maxPdcContribution = actualCollectionCreditLimit * pdcSupportCapPct;
									if(pdcWeightedSupport > maxPdcContribution)
									{
										pdcWeightedSupport = maxPdcContribution;
									}
									calculatedCreditLimit = actualCollectionCreditLimit + pdcWeightedSupport;
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
									roundedLimit = calculatedCreditLimit.round(currencyPrecision);
									if(roundedLimit <= 0)
									{
										roundedLimit = absoluteMinimumCreditLimit;
									}
									// NO SMOOTHING - roundedLimit IS the final answer.
									// ============================================================
									// >>>>>>>>>> SHARED CALCULATION CORE - END <<<<<<<<<<
									// ============================================================
									// ---- MIN PAYMENT TODAY (merged, see change (Q)) ----
									minimumPaymentRequired = 0.0;
									minPaymentVerdict = "WITHIN LIMIT";
									if(skipUpdateReason != "")
									{
										minPaymentVerdict = skipUpdateReason;
									}
									else if(trueOutstandingBalance <= 0)
									{
										minPaymentVerdict = "NOTHING OUTSTANDING";
									}
									else if(trueOutstandingBalance <= roundedLimit)
									{
										minPaymentVerdict = "WITHIN LIMIT (headroom Rs " + (roundedLimit - trueOutstandingBalance).round(currencyPrecision) + ")";
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
											// *** V15.0 *** The simulated APD must be the SAME KIND OF NUMBER as
											// the one the engine actually uses, or the solve answers for a
											// quantity nobody is measured on.
											//
											// Rs midX arriving today retires the OLDEST debt first, so the
											// PENDING age falls - modelled exactly, walking the sorted list.
											//
											// The SETTLED average is deliberately held STILL. Today's money does
											// close old bills, and closing a 120-day-old bill would RAISE the
											// settled average, making a payment look like it worsened the
											// customer. That is an artifact of when the measurement is taken,
											// not a fact about the dealer, and no engine should quote an ask
											// that punishes the payment. It is also the conservative side: if
											// the settled figure governs, the ask can only come out at or above
											// the truth.
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
												if(simMeasuredAPD >= 0 && apdMeasurementFailed == false)
												{
													simAPD = simMeasuredAPD;
												}
											}
											else if(simTrendDailyVelocity > 0)
											{
												simAPD = simOutstanding / simTrendDailyVelocity;
												if(simAPD > 150)
												{
													simAPD = 150.0;
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
										minPaymentVerdict = "COLLECT TODAY: Rs " + minimumPaymentRequired;
									}
									if(customerError == true)
									{
										customersBlocked = customersBlocked + 1;
										info "SKIPPED - DATA ERROR: " + customerName;
									}
									else
									{
										// *** V12.1 (2026-08-17) *** Customers with no
										// payment history used to be LEFT ALONE here -
										// their credit_limit was never written. Two
										// faults came out of that: a brand new contact
										// kept an EMPTY credit_limit, which Zoho reads
										// as UNLIMITED, and a customer whose history had
										// been removed kept a stale number frozen
										// forever, so the engine stopped being
										// idempotent. They are now written like everyone
										// else - Rs 1, meaning "sell, but on advance or
										// Due on Receipt until a payment history
										// exists". The counter is kept so the summary
										// still reports how many are in that state.
										if(skipUpdateReason != "")
										{
											customersSkippedNoHistory = customersSkippedNoHistory + 1;
										}
										countScored = countScored + 1;
										sumOutstanding = sumOutstanding + outstandingBalance;
										sumCurrentLimits = sumCurrentLimits + currentCreditLimit;
										sumNewLimits = sumNewLimits + roundedLimit;
										sumVelocity = sumVelocity + trendDailyVelocity;
										sumMinPayments = sumMinPayments + minimumPaymentRequired;
										sumAPD = sumAPD + finalRiskAPD;
										sumAPDWeighted = sumAPDWeighted + finalRiskAPD * outstandingBalance;
										sumOldAPD = sumOldAPD + trendAPD;
										sumOldAPDWeighted = sumOldAPDWeighted + trendAPD * outstandingBalance;
										countCreditNoteClosures = countCreditNoteClosures + paidNoDateCount;
										if(apdMeasurementFailed == true)
										{
											countAPDNotMeasurable = countAPDNotMeasurable + 1;
										}
										else if(paidAPD < 0)
										{
											// A customer with ONE settled bill is not the same as one with
											// none - the first is a sample too thin to average, the second
											// is a dealer who has closed nothing. Counted apart, because the
											// two say different things about whether apdMinClosedBills = 2
											// is set right.
											if(paidCountWide > 0)
											{
												countBelowMinClosed = countBelowMinClosed + 1;
											}
											else
											{
												countNoSettledBill = countNoSettledBill + 1;
											}
											countPendingGoverned = countPendingGoverned + 1;
										}
										else if(pendingAPD >= paidAPD)
										{
											countPendingGoverned = countPendingGoverned + 1;
										}
										else
										{
											countSettledGoverned = countSettledGoverned + 1;
										}
										if(termsAreSet == true)
										{
											sumExcessDaysOverTerms = sumExcessDaysOverTerms + excessDaysOverTerms;
											if(excessDaysOverTerms > 0)
											{
												countBeyondTerms = countBeyondTerms + 1;
											}
										}
										else
										{
											countTermsNotSet = countTermsNotSet + 1;
										}
										if(coverageIsMeasurable == true)
										{
											countCoverageMeasured = countCoverageMeasured + 1;
											sumCoverage = sumCoverage + coverageRatio;
											if(coverageRatio < 1.0)
											{
												countCoverageInflating = countCoverageInflating + 1;
											}
										}
										if(roundedLimit > currentCreditLimit)
										{
											countLimitUp = countLimitUp + 1;
										}
										else if(roundedLimit < currentCreditLimit)
										{
											countLimitDown = countLimitDown + 1;
										}
										if(finalRiskAPD <= 45)
										{
											apdBucketUnder45 = apdBucketUnder45 + 1;
										}
										else if(finalRiskAPD <= 60)
										{
											apdBucket46to60 = apdBucket46to60 + 1;
										}
										else if(finalRiskAPD <= 75)
										{
											apdBucket61to75 = apdBucket61to75 + 1;
										}
										else if(finalRiskAPD <= 90)
										{
											apdBucket76to90 = apdBucket76to90 + 1;
										}
										else if(finalRiskAPD <= 110)
										{
											apdBucket91to110 = apdBucket91to110 + 1;
										}
										else if(finalRiskAPD <= 130)
										{
											apdBucket111to130 = apdBucket111to130 + 1;
										}
										else
										{
											apdBucket131plus = apdBucket131plus + 1;
										}
										if(minimumPaymentRequired > 0)
										{
											customersOverNewLimit = customersOverNewLimit + 1;
										}
										coverageNote = "";
										if(coverageIsMeasurable == true)
										{
											coverageNote = " | coverage " + (coverageRatio * 100).round(1) + "%";
											if(coverageRatio < coverageWarnBelow)
											{
												coverageNote = coverageNote + " WATCH";
											}
										}
										capNote = "";
										if(concentrationCapApplied == true)
										{
											capNote = " | CONC CAP";
										}
										if(dryRun == true)
										{
											customersUpdated = customersUpdated + 1;
											info "DRY RUN: " + customerName + " | Rs " + currentCreditLimit.round(currencyPrecision) + " -> Rs " + roundedLimit + " | APD " + finalRiskAPD.round(1) + " " + slabName + " | target " + dynamicTargetDays.round(1) + "d | pay-down " + requiredPayDownPct + "% | " + minPaymentVerdict + coverageNote + capNote;
										}
										else
										{
											// STATUS ONLY - no collection figure here. The
											// pay-down % is the STATIC gap and contradicted
											// Min Payment Today on the same record (DEALER-D read
											// 52.4% / ~Rs 1,89,600 against a true figure of
											// Rs 57,791). Average Payment Days = how risky.
											// Min Payment Today = what to collect.
											// *** V15.0 *** BOTH measurements go on the customer record, at the
											// owner's instruction. Collection staff see this field on the mobile
											// app and nothing else - a single blended number tells them what the
											// engine decided but not why, and the two halves answer two
											// different questions on the doorstep: "does this dealer settle
											// bills" and "how old is the money he is sitting on".
											// The leading "<number> days" must stay FIRST: the previous-APD
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
											else if(outstandingBalance > roundedLimit)
											{
												apdFieldText = apdFieldText + " | OVER LIMIT - see Min Payment Today";
											}
											else
											{
												apdFieldText = apdFieldText + " | Within limit";
											}
											// Trend and coverage decorations mean nothing
											// for a customer with no payment history.
											if(skipUpdateReason == "")
											{
												apdFieldText = apdFieldText + apdTrendText;
												if(coverageIsMeasurable == true && coverageRatio < coverageWarnBelow)
												{
													apdFieldText = apdFieldText + " | WATCH: paying only " + (coverageRatio * 100).round(0) + "% of billings, balance inflating";
												}
											}
											apdFieldEntry = Map();
											apdFieldEntry.put("api_name","cf_average_payment_days");
											apdFieldEntry.put("value",apdFieldText);
											minPaymentFieldEntry = Map();
											minPaymentFieldEntry.put("api_name",minPaymentFieldAPIName);
											minPaymentFieldEntry.put("value",minPaymentVerdict);
											customFieldList = List();
											customFieldList.add(apdFieldEntry);
											customFieldList.add(minPaymentFieldEntry);
											updateMap = Map();
											updateMap.put("credit_limit",roundedLimit);
											updateMap.put("custom_fields",customFieldList);
											updateParams = Map();
											updateParams.put("JSONString",updateMap.toString());
											updateResp = invokeurl
											[
												url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
												type :PUT
												parameters:updateParams
												connection:"zerp"
											];
											apiCallCount = apiCallCount + 1;
											if(updateResp != null && updateResp.containsKey("code") && updateResp.get("code") == 0)
											{
												customersUpdated = customersUpdated + 1;
												info "UPDATED: " + customerName + " | Rs " + currentCreditLimit.round(currencyPrecision) + " -> Rs " + roundedLimit + " | APD " + finalRiskAPD.round(1) + " | " + minPaymentVerdict + coverageNote + capNote;
											}
											else
											{
												customersFailed = customersFailed + 1;
												info "UPDATE FAILED: " + customerName;
											}
										}
									}
								}
								else
								{
									customersBlocked = customersBlocked + 1;
									info "SKIPPED - CONTACT READ ERROR: " + customerName;
								}
							}
							else
							{
								customersBlocked = customersBlocked + 1;
							}
						}
						contactIndex = contactIndex + 1;
						if(contactIndex > batchEndIndex)
						{
							batchComplete = true;
						}
					}
				}
			}
			contactsCtx = contactsResp.get("page_context");
			if(batchComplete == true || contactsCtx == null || contactsCtx.get("has_more_page") != true)
			{
				contactsMore = false;
			}
		}
		else
		{
			contactsMore = false;
			contactsListFailed = true;
			if(contactsResp == null)
			{
				info "ERROR: customer list read got no response.";
			}
			else
			{
				info "ERROR: customer list read failed. Zoho said: " + contactsResp.toString();
			}
		}
	}
}
// ============================================================
// A FAILED CUSTOMER LIST MUST NOT PRODUCE A REPORT.
// The first version printed a full portfolio summary of zeros after
// the list read failed, which reads exactly like a finished run. In
// LIVE mode a list read that dies part-way would produce a total that
// looks complete but silently covers fewer customers - and that total
// is the number the whole curve gets tuned against.
// ============================================================
if(contactsListFailed == true && countScored == 0)
{
	info "========================================";
	info "BATCH " + batchNumber + " ABORTED - the customer list could not be read.";
	info "NOTHING was processed. The portfolio figures are deliberately NOT";
	info "printed, because zeros here would look like a valid result.";
	info "If the error above is code 44, the whole ORGANISATION is rate-";
	info "limited: wait a minute or two, then re-run this same batch.";
	info "========================================";
	return;
}
// ============================================================
// PORTFOLIO SUMMARY - THIS IS THE TUNING DIAL
// ============================================================
averageAPD = 0.0;
if(countScored > 0)
{
	averageAPD = (sumAPD / countScored).round(1);
}
weightedAPD = 0.0;
if(sumOutstanding > 0)
{
	weightedAPD = (sumAPDWeighted / sumOutstanding).round(1);
}
limitChangePct = 0.0;
if(sumCurrentLimits > 0)
{
	limitChangePct = ((sumNewLimits / sumCurrentLimits - 1) * 100).round(1);
}
// Weighted-average target days = total limits / total daily velocity.
// This equals the rotation in days - see the identity in the config.
weightedAvgTargetDays = 0.0;
if(sumVelocity > 0)
{
	weightedAvgTargetDays = (sumNewLimits / sumVelocity).round(1);
}
rotationVerdict = "ON TARGET";
if(weightedAvgTargetDays > targetRotationDaysMax)
{
	rotationVerdict = "TOO LOOSE by " + (weightedAvgTargetDays - targetRotationDaysMax).round(1) + " days - LOWER the top anchors (68/62/55)";
}
else if(weightedAvgTargetDays < targetRotationDaysIdeal)
{
	rotationVerdict = "TIGHTER than the ideal - you could RAISE the top anchors if sales are suffering";
}
averageExcessDays = 0.0;
termsScored = countScored - countTermsNotSet;
if(termsScored > 0)
{
	averageExcessDays = (sumExcessDaysOverTerms / termsScored).round(1);
}
averageCoverage = 0.0;
if(countCoverageMeasured > 0)
{
	averageCoverage = (sumCoverage / countCoverageMeasured * 100).round(1);
}
info "========================================";
info "BATCH " + batchNumber + " COMPLETE | MODE: " + modeLabel;
info "Processed: " + customersUpdated + " | Left alone (new/dormant): " + customersSkippedNoHistory + " | Blocked: " + customersBlocked + " | Failures: " + customersFailed;
info "API CALLS THIS RUN : " + apiCallCount + "   (210 at batchSize 100 ran clean on 2026-08-14 - spacing between runs matters more than size)";
if(contactsListFailed == true)
{
	info "*** WARNING: the customer list read FAILED part-way. The totals below";
	info "*** cover only the customers reached before that, and are NOT a";
	info "*** complete picture of this batch. Re-run it.";
}
info "----------------------------------------";
info "PORTFOLIO SUMMARY (" + countScored + " scored customers in this batch)";
info "TOTAL OUTSTANDING    : Rs " + sumOutstanding.round(currencyPrecision);
info "TOTAL CURRENT LIMITS : Rs " + sumCurrentLimits.round(currencyPrecision);
info "TOTAL NEW LIMITS     : Rs " + sumNewLimits.round(currencyPrecision);
info "Change in total limits : " + limitChangePct + "%";
info "Limits going UP: " + countLimitUp + " | going DOWN: " + countLimitDown;
info "----------------------------------------";
info "*** ROTATION THIS CURVE PRODUCES - THE TUNING DIAL ***";
info "Weighted-average target days : " + weightedAvgTargetDays + " days";
info "  This IS the book's rotation. Total limits divided by total daily";
info "  payment velocity - and velocity equals sales in steady state, so";
info "  the two cancel. No conversion needed: read it as days.";
info "YOUR TARGET : " + targetRotationDaysIdeal + " to " + targetRotationDaysMax + " days";
info "VERDICT : " + rotationVerdict;
info "  (at Rs " + monthlyAverageSales + " monthly sales, " + targetRotationDaysMax + " days = Rs " + (monthlyAverageSales / 30.0 * targetRotationDaysMax).round(currencyPrecision) + " of outstanding)";
info "  To move it: scale the WHOLE curve. The APD<=45 group carries";
info "  ~57% of all limit rupees (measured, not guessed), so a uniform";
info "  lift/cut of dayAnchors moves the rotation proportionally.";
info "  Total daily velocity this batch : Rs " + sumVelocity.round(currencyPrecision) + " (compare the sum";
info "  across all batches against company collections/30 - if velocity";
info "  runs above collections, the true rotation is HIGHER than shown).";
info "----------------------------------------";
info "Average APD (simple)              : " + averageAPD + " days";
info "Average APD (outstanding-weighted): " + weightedAPD + " days   <<< THE REAL DSO";
oldAverageAPD = 0.0;
oldWeightedAPD = 0.0;
if(countScored > 0)
{
	oldAverageAPD = (sumOldAPD / countScored).round(1);
}
if(sumOutstanding > 0)
{
	oldWeightedAPD = (sumOldAPDWeighted / sumOutstanding).round(1);
}
info "----------------------------------------";
info "*** V15.0 - WHAT THE NEW APD CHANGED ***";
info "Old model, simple average         : " + oldAverageAPD + " days";
info "Old model, outstanding-weighted   : " + oldWeightedAPD + " days";
info "Shift in the weighted figure      : " + (weightedAPD - oldWeightedAPD).round(1) + " days   <<< a FALL here means limits RISE";
info "Decided by settled bills          : " + countSettledGoverned;
info "Decided by pending money          : " + countPendingGoverned;
info "  ...closed NOTHING at all         : " + countNoSettledBill;
info "  ...closed some, but under the " + apdMinClosedBills + "   : " + countBelowMinClosed + "   (raise or lower apdMinClosedBills from this)";
info "APD not measurable at all         : " + countAPDNotMeasurable + "   (these fell back to the old model)";
info "Bills closed by credit note       : " + countCreditNoteClosures + "   (excluded from the settled average)";
info "CURVE FIXED POINT                 : " + curveFixedPointAPD + " days   <<< where the book settles";
info "----------------------------------------";
info "APD DISTRIBUTION - shows which part of the curve actually matters";
info "  <= 45  (Excellent)       : " + apdBucketUnder45;
info "  46-60  (Good)            : " + apdBucket46to60;
info "  61-75  (Normal)          : " + apdBucket61to75;
info "  76-90  (Maintain Zone)   : " + apdBucket76to90;
info "  91-110 (Reduce Required) : " + apdBucket91to110;
info " 111-130 (Serious Risk)    : " + apdBucket111to130;
info "  131+   (Severe Risk)     : " + apdBucket131plus;
info "----------------------------------------";
info "PAYMENT TERMS - evidence for whether the curve should be term-relative";
info "Customers running BEYOND their own agreed terms : " + countBeyondTerms + " of " + termsScored;
info "Average days beyond agreed terms                : " + averageExcessDays;
info "Customers with no payment terms set             : " + countTermsNotSet;
info "----------------------------------------";
if(measureCoverage == true)
{
	info "COVERAGE (payments / net billings) - leading indicator only";
	info "Measured for : " + countCoverageMeasured + " customers | average " + averageCoverage + "%";
	info "Balance INFLATING (coverage < 100%) : " + countCoverageInflating;
	info "----------------------------------------";
}
info "COLLECTION EXPOSURE";
info "Customers over their NEW limit    : " + customersOverNewLimit;
info "Total to collect to bring in line : Rs " + sumMinPayments.round(currencyPrecision);
info "  (this is the recovery-solved figure - the payment itself lifts";
info "   the limit, so it is far below the raw gap. In plain terms:";
info "   collect until each customer's APD reaches " + curveFixedPointAPD + " days.)";
info "========================================";
info "NEXT: run the remaining batches and add up TOTAL NEW LIMITS.";
info "Divide that total by (monthly sales / 30) for the true rotation.";
info "Per-batch figures are NOT comparable - each batch has a different";
info "customer mix. Only the book-wide total means anything.";
info "Too loose -> scale dayAnchors down. Too tight -> scale them up.";
info "========================================";
