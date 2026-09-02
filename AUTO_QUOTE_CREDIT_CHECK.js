// ============================================================
// AUTO QUOTE CREDIT CHECK  -  v15.0
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Workflow function
// Trigger      Quotes / Estimates - On Create ONLY
//              (On Edit would re-trigger itself forever, since
//              this writes back to the quote)
// Input        estimate              Connection  "zerp"
// Writes       cf_credit_check on the quote
// ------------------------------------------------------------
// WHAT IT DOES
// Answers one question at the counter: can this quote be billed,
// and if not, what is the SMALLEST payment that would let it be?
//
// It recomputes the credit limit from scratch using the same
// measured-APD methodology as AUTO_CREDIT_LIMIT_ENGINE.js rather
// than trusting the stored contact.credit_limit, so the answer
// cannot be stale.
//
// TWO ROUTES, AND IT QUOTES THE CHEAPER ONE
//   FULL ROUTE     the recovery solve - pay this and the account
//                  is genuinely back inside its limit. Right for
//                  a large order.
//   EXPRESS ROUTE  this bill plus a slice of the old balance. The
//                  slice is (factor - 1) x bill, and the factor is
//                  read off the account's own APD: slightly behind
//                  pays ~105-110% of the bill, far behind pays up
//                  to 200%.
//
// Why express is safe in one line: the money coming IN always
// exceeds the goods going OUT, so the exposure falls by exactly
// the surcharge on every express bill. The route can shrink debt,
// never grow it, and the factor is recomputed live so a dealer who
// keeps drip-feeding keeps meeting a steeper one.
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
// ACME QUOTE CREDIT CHECK - V15.0 (MATCHES CREDIT LIMIT V15.0)
// *** V15.0 (2026-09-01) - APD IS MEASURED, NOT INFERRED.
// Read the V15 header note in AUTO_CREDIT_LIMIT_ENGINE.js for the full reasoning. APD was
// outstandingBalance/velocity, a DSO ratio a single cheque could
// move twenty days; it is now max(settled-bill APD, pending-money
// APD), both amount-weighted and measured from documents.
//
// THE EXPRESS ROUTE IS UNCHANGED. Its factor curve still reads off
// the live APD - it just reads a truthful APD now. That matters
// more here than anywhere else: the express factor is what a dealer
// is quoted at the counter, and under the old ratio a dealer who
// had just paid was quoted a cheaper factor than the same dealer
// three weeks later, with no change in behaviour in between.
//
// This script gained ONE new API read - see section 5B.
// Workflow input: estimate | Connection: zerp
// Trigger: QUOTES module, "On Create" ONLY (see loop-safety note)
//
// Answers one question: can we bill this Quote, and if not, what is
// the smallest payment that would let us?
//
// V12.2 CHANGES (2026-08-20) - THE EXPRESS ROUTE
// ----------------------------------------------
// The problem it fixes: a dealer who is far behind but wants a SMALL
// urgent lot was being told to pay the full recovery amount, which
// can run to lakhs. That answer is right for the book and useless for
// the shop - the sale walks out of the door and often the dealer
// with it.
//
// So the Quote now offers TWO routes and asks for whichever is
// CHEAPER for the dealer today:
//
//   FULL ROUTE    = the recovery solve (unchanged). Pay it and the
//                   account is genuinely back inside its credit
//                   limit. Still the right answer for a large order.
//   EXPRESS ROUTE = this bill PLUS a slice of the old balance. The
//                   slice is (factor - 1) x bill, and the factor is
//                   read off the account's own APD - a dealer only a
//                   little behind pays about 105-110% of the bill,
//                   one far behind pays up to 200%.
//
// WHY IT IS SAFE, in one line: the money coming IN is always MORE
// than the goods going OUT, so every express bill leaves ACME with
// LESS at risk than before it. The balance falls by exactly the
// surcharge. No dealer can use this route to GROW his debt, only to
// shrink it slowly while still buying. And the factor is recomputed
// from live APD every time, so a dealer who keeps drip-feeding keeps
// meeting a steeper factor.
//
// Two guards worth knowing:
//   - the surcharge is capped at the old balance itself (nobody can
//     pay down more old debt than exists), so a clean account facing
//     one big order is simply asked for the advance, never more than
//     the goods are worth;
//   - the express amount is only ever taken when it is BELOW the full
//     recovery amount, so this route can never ask for more than
//     V12.1 already did.
//
// Everything written onto the Quote field was also rewritten in plain
// shop language - that field is the only thing collection staff and
// the dealer actually read.
//
// V12.0 CHANGES FROM V10
// ----------------------
// 1. COMPUTES THE LIMIT FRESH instead of trusting contact.credit_limit.
//    The old version read the stored field, which is only as fresh as
//    the last payment or the last weekly batch - and any staff member
//    can edit it. This script already pulls every input it needs, so
//    computing it costs nothing and cannot be defeated by a manual
//    edit. If the stored value disagrees materially, that is now
//    REPORTED rather than silently trusted.
// 2. Full V12.0 methodology - continuous curve, rolling 180-day
//    window, divisors from the earliest observed payment, continuous
//    guards, concentration cap, NO SMOOTHING.
// 3. NO SMOOTHING IN THE SOLVE. The old version simulated the +15%
//    smoothing cap, so the limit could not reach its true value and
//    the minimum payment came out far too HIGH. Staff have been
//    quoting inflated numbers. Expect the new figures to be roughly a
//    third of the old ones.
// 4. Bisection cut from 40 steps to 15. With smoothing gone the
//    condition reduces to "has APD fallen to the curve's fixed point"
//    (the velocity cancels algebraically), so 15 steps give rupee
//    precision where 40 was wasted statements.
//
// See AUTO CREDIT LIMIT ENGINE V12.0 for the full reasoning behind
// every constant here. They MUST match that file exactly.
//
// LOOP-SAFETY: this only writes to the Quote's own custom field. Keep
// the workflow trigger as "On Create" ONLY. If set to also fire "On
// Edit", this update re-triggers itself forever. To re-check after an
// edit, add a Custom Button on Quotes calling this same function.
// ============================================================
// ============================================================
// 1. CONFIGURATION - keep identical to AUTO CREDIT LIMIT ENGINE V12.0
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
// MUST match the other three V12 scripts exactly.
minimumVelocityDivisorDays = 60;
// *** V12.1 *** Was 1.25 - a 25% uplift handed to the customer with
// the LEAST evidence, multiplying an already inflated velocity.
newCustomerBonusFactor = 1.00;
absoluteMinimumCreditLimit = 1;
creditCheckFieldAPIName = "cf_credit_check";
// *** V12.2 (2026-08-20) *** EXPRESS ROUTE - see the header note.
// expressFactorAnchors are MULTIPLES OF THE BILL, interpolated
// continuously against APD exactly the way targetDays is. Change the
// numbers here and nothing else; 1.10 means "pay 110% of the bill".
// Set expressBillingEnabled = false to fall back to V12.1 behaviour.
expressBillingEnabled = true;
expressAPDAnchors = {30,60,90,130,150};
expressFactorAnchors = {1.05,1.10,1.25,1.50,2.00};
expressSegmentList = {0,1,2,3};
expressLastAnchorIndex = 4;
// Every rupee figure quoted to a dealer is rounded UP to this step so
// the field never reads Rs 11,873. Up is also the safe direction - it
// can only ask slightly more, never less.
paymentRoundingStep = 100;
bisectionSteps = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
pageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50};
// ============================================================
// 2. BASIC DATA / SAFETY
// ============================================================
organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
estimateID = estimate.get("estimate_id");
customerID = estimate.get("customer_id");
customerName = estimate.get("customer_name");
estimateTotal = 0.0;
if(estimate.get("total") != null)
{
	estimateTotal = estimate.get("total").toDecimal();
}
if(estimateID == null || estimateID == "" || customerID == null || customerID == "")
{
	info "ERROR: Estimate ID or Customer ID missing. Credit check skipped.";
	return;
}
fatalReadError = false;
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
info "ACME QUOTE CREDIT CHECK V12.2";
info "Customer : " + customerName + " (" + customerID + ")";
info "Quote : " + estimateID + " | Order Amount Rs " + estimateTotal.round(currencyPrecision);
info "========================================";
// ============================================================
// 3. CONTACT
// ============================================================
contactResp = invokeurl
[
	url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
	type :GET
	connection:"zerp"
];
if(contactResp == null || contactResp.containsKey("code") == false || contactResp.get("code") != 0 || contactResp.get("contact") == null)
{
	info "ERROR: Customer contact could not be read. Credit check skipped.";
	return;
}
contactData = contactResp.get("contact");
outstandingBalance = 0.0;
if(contactData.get("outstanding_receivable_amount") != null)
{
	outstandingBalance = contactData.get("outstanding_receivable_amount").toDecimal();
}
storedCreditLimit = 0.0;
if(contactData.get("credit_limit") != null)
{
	storedCreditLimit = contactData.get("credit_limit").toDecimal();
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
paymentTermLabel = contactData.get("payment_terms_label");
if(paymentTermLabel == null || paymentTermLabel == "")
{
	paymentTermLabel = "Not set";
}
totalExposure = outstandingBalance + estimateTotal;
// ============================================================
// 4. COMPANY COLLECTIONS - LAST 30 DAYS (concentration cap)
// ============================================================
companyRecentCollections = 0.0;
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
			fatalReadError = true;
			hasMoreCompanyPayments = false;
			info "ERROR: Company collections could not be read.";
		}
	}
}
if(hasMoreCompanyPayments == true)
{
	fatalReadError = true;
}
// ============================================================
// 5. CUSTOMER PAYMENT TREND (rolling window, earliest tracked)
// ============================================================
recent30Payments = 0.0;
middle31to90Payments = 0.0;
olderWindowPayments = 0.0;
paymentCountWindow = 0;
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
					paymentStatus = historicalPayment.get("status");
					paymentDateStr = historicalPayment.get("date");
					if(historicalPayment.get("amount") != null && paymentDateStr != null && paymentDateStr != "" && paymentStatus != "draft" && paymentStatus != "void" && paymentStatus != "cancelled" && paymentStatus != "refunded")
					{
						paymentDate = paymentDateStr.toDate("yyyy-MM-dd");
						paymentAmount = historicalPayment.get("amount").toDecimal();
						if(paymentDate >= queryStartDate && paymentDate <= runDate)
						{
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
}
// ============================================================
// 6. FUTURE PDCs
// ============================================================
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
}
// ============================================================
// 5B. THE BILLS  (V15.0 - NEW READ IN THIS SCRIPT)
// ------------------------------------------------------------
// This script never read invoices before. It did not need to: APD
// was outstandingBalance / velocity, and both of those come from the
// contact and the payment list. V15 measures APD from the documents
// themselves, so the bills have to be read here too.
//
// COST: one paginated call, plus one more for a customer carrying an
// opening balance. last_payment_date is on the LIST response (PROBE
// E confirmed it against live data), so the settlement dates are
// free once the page is fetched.
//
// The window is 365 days, deliberately wider than the closure window
// - a bill raised 200 days ago and settled last week belongs in a
// 90-day settlement average, and a 180-day query cannot see it.
// ============================================================
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
								// A rebate is not payment behaviour.
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
			info "ERROR: the customer's invoices could not be read. Response: " + invoiceResp.toString();
		}
	}
}
if(hasMoreInvoices == true)
{
	fatalReadError = true;
	info "ERROR: invoice pagination exceeded 10,000 rows.";
}
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
pendingReconGap = outstandingBalance - openBalanceTotal;
if(pendingReconGap < 0)
{
	pendingReconGap = pendingReconGap * -1;
}
pendingIsReconciled = true;
if(pendingReconGap > 1)
{
	pendingIsReconciled = false;
	info "WARNING: pending reconciliation gap of Rs " + pendingReconGap.round(0) + " - the contact says Rs " + outstandingBalance.round(0) + " but the documents add to Rs " + openBalanceTotal.round(0) + ". The pending APD is measured from the documents, so it does not describe all of the money.";
}
if(fatalReadError == true)
{
	info "SAFETY BLOCK: Required data could not be read completely. Credit check was not written.";
	info "========================================";
	return;
}
// ============================================================
// 7. DIVISORS FROM OBSERVED TRANSACTIONS, THEN VELOCITY
// ============================================================
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
comparisonDailyVelocity = 0.0;
if(middleDays > 0)
{
	comparisonDailyVelocity = middleDailyVelocity;
}
else if(olderDays > 0)
{
	comparisonDailyVelocity = olderDailyVelocity;
}
// Curve fixed point - the APD where target(APD) = APD.
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
info "----------------------------------------";
info "Outstanding Balance : Rs " + outstandingBalance.round(currencyPrecision);
info "Order Amount (this Quote) : Rs " + estimateTotal.round(currencyPrecision);
info "Total Exposure : Rs " + totalExposure.round(currencyPrecision);
info "Payment terms : " + paymentTermLabel;
info "Effective history for divisors : " + effectiveLookbackDays + " days (contact age " + customerAgeDays + ", earliest payment " + earliestPaymentDate.toString("yyyy-MM-dd") + ")";
info "Curve fixed point : " + curveFixedPointAPD + " days";
info "----------------------------------------";
// ============================================================
// 8. SOLVE
// Step 0 evaluates the CURRENT state (X = 0) so the live credit limit
// is computed fresh here rather than trusted from the stored field.
// Steps 1-15 bisect for the smallest payment that clears the exposure.
// One copy of the methodology serves both - Deluge has no inline
// functions, and duplicating it is exactly how the old scripts drifted
// out of sync with the engine.
// ============================================================
// ============================================================
// 7B. *** V15.0 - THE MEASURED APD ***
// ------------------------------------------------------------
// This script has no APD of its own: step 0 of the solve loop below
// computes the live one, so both the live figure and every simulated
// one come out of the same code. All that is needed here are the two
// measurements the loop will take the worse of.
//
//   paidAPD    amount-weighted (last_payment_date - invoice date)
//              over bills FULLY PAID inside the closure window.
//   pendingAPD amount-weighted age of everything still owed, the
//              opening balance included.
//
// The quote must judge a dealer by exactly the number their customer
// record shows, or the shop floor and the ledger tell two stories
// about the same person.
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
	paidAPD = (paidWeightedDaysWide / paidWeightWide).round(2);
	paidAPDCount = paidCountWide;
	paidAPDWindowUsed = apdClosureWindowWideDays;
}
// A paid figure built mostly from bills we had to throw away is not
// a measurement.
if(paidAPD >= 0 && paidNoDateCount > paidAPDCount)
{
	info "NOTE: " + paidNoDateCount + " settled bills carried no payment date (closed by a credit note) against only " + paidAPDCount + " that did. The settled APD is being DISCARDED as unsafe.";
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
// Can anything be measured at all? If not, the solve loop keeps the
// old balance/velocity ratio and the log says so - a quote must never
// silently switch models without saying which one it used.
apdMeasurementFailed = false;
apdSourceText = "settled bills";
if(paidAPD < 0 && pendingAPD < 0)
{
	if(outstandingBalance > 0)
	{
		apdMeasurementFailed = true;
		apdSourceText = "NOT MEASURABLE - fell back to the old balance/velocity model";
		info "WARNING: no settled bill and no ageable open document for this customer. APD could not be measured; the old balance/velocity figure is being used for this quote.";
	}
	else
	{
		apdSourceText = "nothing outstanding";
	}
}
else if(paidAPD < 0)
{
	apdSourceText = "PENDING only - no settled bill to measure";
}
else if(pendingAPD >= paidAPD)
{
	apdSourceText = "PENDING governs (settled reads " + paidAPD.round(1) + ")";
}
else
{
	apdSourceText = "settled " + paidAPDCount + " bills/" + paidAPDWindowUsed + "d";
}
if(useMeasuredAPD == false)
{
	apdMeasurementFailed = true;
	apdSourceText = "old balance/velocity model (useMeasuredAPD is OFF)";
}
// ------------------------------------------------------------
// THE OPEN ITEMS, SORTED OLDEST FIRST
// The solve asks "what does the pending age become if Rs X arrives",
// and a payment retires the OLDEST debt first. Sorted ONCE here so
// the sixteen evaluation steps stay linear.
// Sorted by finding the next-lower age each round and taking every
// item that shares it, so ties need no special handling and nothing
// has to be marked as used.
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
	unsortedItemCount = openItemsList.size() - sortedOpenList.size();
	info "NOTE: " + unsortedItemCount + " open items could not be ordered for the payment simulation (more than 80 distinct ages). The minimum payment will read slightly high.";
}
info "APD settled : " + paidAPD + " from " + paidAPDCount + " settled bills in " + paidAPDWindowUsed + " days | " + paidNoDateCount + " excluded, closed by credit note";
info "APD pending : " + pendingAPD + " over Rs " + openBalanceTotal.round(0) + " across " + openItemCount + " open items | oldest " + oldestOpenAgeDays + " days";
if(obBalance > 0)
{
	info "   pending includes an OPENING BALANCE of Rs " + obBalance.round(0) + " aged " + obAgeDays + " days";
}
info "APD source  : " + apdSourceText;
evaluationSteps = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
liveComputedLimit = 0.0;
liveAPD = 0.0;
liveTargetDays = 0.0;
solveLowX = 0.0;
solveHighX = totalExposure;
for each  evalStep in evaluationSteps
{
	if(evalStep == 0)
	{
		midX = 0.0;
	}
	else
	{
		midX = (solveLowX + solveHighX) / 2;
	}
	simOutstanding = outstandingBalance - midX;
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
	// NO SMOOTHING - the limit is free to reach its true value, which
	// is what makes this minimum honest rather than inflated.
	if(evalStep == 0)
	{
		liveComputedLimit = simCreditLimit.round(currencyPrecision);
		if(liveComputedLimit <= 0)
		{
			liveComputedLimit = absoluteMinimumCreditLimit;
		}
		liveAPD = simAPD.round(2);
		liveTargetDays = simTargetDays.round(2);
	}
	else
	{
		simTotalExposure = simOutstanding + estimateTotal;
		if(simTotalExposure <= simCreditLimit)
		{
			solveHighX = midX;
		}
		else
		{
			solveLowX = midX;
		}
	}
}
// ============================================================
// 9. VERDICT - FULL ROUTE vs EXPRESS ROUTE
// ============================================================
verdictText = "";
withinLimit = true;
minimumPaymentRequired = 0.0;
paymentRoute = "NONE";
recoveryPayment = 0.0;
expressPayment = 0.0;
expressFactor = 1.0;
expressSurcharge = 0.0;
balanceAfterBilling = 0.0;
naiveGap = 0.0;
if(foundAnyPayment == false && customerAgeDays <= newCustomerProbationDays)
{
	withinLimit = false;
	paymentRoute = "NEW";
	verdictText = "NEW PARTY - no payment record with us yet. Collect Rs " + estimateTotal.round(currencyPrecision) + " full advance and bill, or get office approval first.";
}
else if(totalExposure <= liveComputedLimit)
{
	headroom = (liveComputedLimit - totalExposure).round(currencyPrecision);
	verdictText = "OK TO BILL - no payment needed now. This order Rs " + estimateTotal.round(currencyPrecision) + ". Credit still free after this order Rs " + headroom + ".";
}
else
{
	withinLimit = false;
	naiveGap = (totalExposure - liveComputedLimit).round(currencyPrecision);
	// ---------- FULL ROUTE (V12.1 solve, rounded up) ----------
	recoveryPayment = solveHighX;
	recoverySteps = (recoveryPayment / paymentRoundingStep).round(0);
	if(recoverySteps * paymentRoundingStep < recoveryPayment)
	{
		recoverySteps = recoverySteps + 1;
	}
	recoveryPayment = (recoverySteps * paymentRoundingStep).round(currencyPrecision);
	// ---------- EXPRESS ROUTE ----------
	// Factor off the live APD, using the same continuous interpolation
	// the targetDays curve uses. Below the first anchor it stays flat at
	// the first factor, above the last anchor flat at the last.
	expressFactor = expressFactorAnchors.get(0).toDecimal();
	if(liveAPD >= expressAPDAnchors.get(expressLastAnchorIndex).toDecimal())
	{
		expressFactor = expressFactorAnchors.get(expressLastAnchorIndex).toDecimal();
	}
	else if(liveAPD > expressAPDAnchors.get(0).toDecimal())
	{
		for each  expressSegment in expressSegmentList
		{
			expressLowAPD = expressAPDAnchors.get(expressSegment).toDecimal();
			expressHighAPD = expressAPDAnchors.get(expressSegment + 1).toDecimal();
			if(liveAPD > expressLowAPD && liveAPD <= expressHighAPD)
			{
				expressLowFactor = expressFactorAnchors.get(expressSegment).toDecimal();
				expressHighFactor = expressFactorAnchors.get(expressSegment + 1).toDecimal();
				expressSpan = expressHighAPD - expressLowAPD;
				if(expressSpan > 0)
				{
					expressFactor = expressLowFactor + (liveAPD - expressLowAPD) / expressSpan * (expressHighFactor - expressLowFactor);
				}
				else
				{
					expressFactor = expressHighFactor;
				}
			}
		}
	}
	// The surcharge is the ONLY part that touches old debt, so it can
	// never exceed the old debt. With nothing outstanding it falls to
	// zero and the express ask becomes a plain full advance.
	expressSurcharge = (expressFactor - 1) * estimateTotal;
	if(expressSurcharge > outstandingBalance)
	{
		expressSurcharge = outstandingBalance;
	}
	if(expressSurcharge < 0)
	{
		expressSurcharge = 0.0;
	}
	expressPayment = estimateTotal + expressSurcharge;
	expressSteps = (expressPayment / paymentRoundingStep).round(0);
	if(expressSteps * paymentRoundingStep < expressPayment)
	{
		expressSteps = expressSteps + 1;
	}
	expressPayment = (expressSteps * paymentRoundingStep).round(currencyPrecision);
	// ---------- ASK FOR WHICHEVER IS CHEAPER ----------
	if(expressBillingEnabled == true && estimateTotal > 0 && expressPayment < recoveryPayment)
	{
		minimumPaymentRequired = expressPayment;
		paymentRoute = "EXPRESS";
	}
	else
	{
		minimumPaymentRequired = recoveryPayment;
		paymentRoute = "FULL";
	}
	balanceAfterBilling = (outstandingBalance - minimumPaymentRequired + estimateTotal).round(currencyPrecision);
	if(balanceAfterBilling < 0)
	{
		balanceAfterBilling = 0.0;
	}
	if(paymentRoute == "EXPRESS" && expressSurcharge <= 0)
	{
		verdictText = "ADVANCE ONLY - collect Rs " + minimumPaymentRequired + " and bill. This order is bigger than his credit line of Rs " + liveComputedLimit + ", so it goes on advance.";
	}
	else if(paymentRoute == "EXPRESS")
	{
		verdictText = "COLLECT Rs " + minimumPaymentRequired + " NOW, THEN BILL THIS ORDER. Order Rs " + estimateTotal.round(currencyPrecision) + ". Old balance Rs " + outstandingBalance.round(currencyPrecision) + " comes down to Rs " + balanceAfterBilling + ". To get his full credit back the amount is Rs " + recoveryPayment + ".";
	}
	else
	{
		verdictText = "COLLECT Rs " + minimumPaymentRequired + " NOW, THEN BILL THIS ORDER. Order Rs " + estimateTotal.round(currencyPrecision) + ". After this payment his account is back inside his credit limit of Rs " + liveComputedLimit + ".";
	}
}
info "Live computed credit limit : Rs " + liveComputedLimit + " | APD " + liveAPD + " | target " + liveTargetDays + " days";
if(storedCreditLimit > 0)
{
	limitGap = liveComputedLimit - storedCreditLimit;
	if(limitGap > storedCreditLimit * 0.10 || limitGap < storedCreditLimit * -0.10)
	{
		info "NOTE: stored contact.credit_limit is Rs " + storedCreditLimit.round(currencyPrecision) + ", which differs from the freshly computed Rs " + liveComputedLimit + " by more than 10%. Either the customer has not been recalculated recently, or the field was edited by hand. This check used the COMPUTED value.";
	}
}
info "Within Live Limit : " + withinLimit;
if(withinLimit == false && paymentRoute != "NEW")
{
	info "----------------------------------------";
	info "HOW THE ASK WAS BUILT";
	info "  Full route (back inside the limit) : Rs " + recoveryPayment;
	info "    Raw gap, ignoring the lift the payment itself gives : Rs " + naiveGap;
	info "    In plain terms: collect until his APD comes down to about " + curveFixedPointAPD + " days.";
	info "  Express route (this bill + a slice of the old debt) : Rs " + expressPayment;
	info "    APD " + liveAPD + " days -> factor " + expressFactor.round(3) + " x bill";
	info "    = bill Rs " + estimateTotal.round(currencyPrecision) + " + old-debt slice Rs " + expressSurcharge.round(currencyPrecision) + ", rounded up to the next Rs " + paymentRoundingStep;
	info "  ASKED FOR (the cheaper of the two) : Rs " + minimumPaymentRequired + " via the " + paymentRoute + " route";
	info "    Money in Rs " + minimumPaymentRequired + " against goods out Rs " + estimateTotal.round(currencyPrecision) + ". On the EXPRESS route the payment is always bigger than the goods, so his balance can only come down; on the FULL route a large order can still lift it, but only up to a limit he has now earned.";
	info "    His balance after paying and billing : Rs " + balanceAfterBilling;
	info "----------------------------------------";
}
info "Verdict : " + verdictText;
info "========================================";
// ============================================================
// 10. WRITE VERDICT ONTO THE QUOTE
// ============================================================
customFieldEntry = Map();
customFieldEntry.put("api_name",creditCheckFieldAPIName);
customFieldEntry.put("value",verdictText);
customFieldList = List();
customFieldList.add(customFieldEntry);
updateMap = Map();
updateMap.put("custom_fields",customFieldList);
updateParams = Map();
updateParams.put("JSONString",updateMap.toString());
updateResp = invokeurl
[
	url :apiEndPoint + "/estimates/" + estimateID + "?organization_id=" + organizationID
	type :PUT
	parameters:updateParams
	connection:"zerp"
];
if(updateResp != null && updateResp.containsKey("code") && updateResp.get("code") == 0)
{
	info "SUCCESS: Credit check field updated on Quote.";
}
else
{
	info "ERROR: Failed to update credit check field on Quote.";
	info updateResp;
}
info "========================================";
info "ACME QUOTE CREDIT CHECK V12.2 END";
info "========================================";
