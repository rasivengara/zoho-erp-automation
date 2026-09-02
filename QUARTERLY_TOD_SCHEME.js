// ============================================================
// QUARTERLY TOD (TURNOVER DISCOUNT) SCHEME  -  v2.0
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Workflow / on-demand function
// Input        customer              Connection  "zerp"
// Writes       Rebate Credit Note, auto-allocated to the oldest
//              outstanding invoices
// Config       One block at the top holds the quarter dates, the
//              posting window and the eligible brands. Nothing
//              else changes between quarters.
// ------------------------------------------------------------
// WHAT IT DOES
// Calculates a dealer's quarterly volume rebate and posts it as a
// credit note during a fixed posting window - preview before it,
// expired after it, so the same script cannot double-pay.
//
// Net eligible purchases are gross sales MINUS returns, filtered
// at LINE ITEM level to the two eligible brands, paginated across
// the whole quarter (per_page=200, hard page cap). If more data
// exists than the cap allows, posting is BLOCKED rather than
// calculated on partial data.
//
// ELIGIBILITY IS OR LOGIC
//   A. measured APD < 75, OR
//   B. nothing outstanding aged past 75 days
// TOD is denied only when both fail.
//
// WHY THE APD MEASUREMENT MATTERS MORE HERE THAN ANYWHERE
// Because the rule is an OR, a dealer passes on APD alone. Under
// the old balance-over-velocity ratio, one well-timed large cheque
// cut that number by ~20 days - so a rebate could effectively be
// BOUGHT and handed straight back as a credit note. APD is now
// max(settled-bill APD, pending-money APD), both amount-weighted
// and both measured from documents, identical to the credit
// engine's number. The eligibility RULE is untouched; only the
// measurement feeding it was wrong.
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
// ACME QUARTERLY TOD + APD ENGINE - PRODUCTION V2.0
//
// *** V2.0 (2026-09-01) - APD IS MEASURED, NOT INFERRED ***
// V1.4 rebuilt this APD to MATCH the credit engine, and that was
// right: a dealer must not be judged by two different numbers. The
// engine's number has now changed, so this one changes with it.
//
// The old APD was todOutstandingBalance / velocity - a DSO ratio.
// It mattered more here than anywhere else in the suite, because
// the rule below is an OR: a dealer passes on APD < 75 alone. One
// large payment cut that ratio by twenty days (measured: DEALER-B
// 99.0 -> 78.7 on a single 10% payment), so a rebate could be
// BOUGHT with a well-timed cheque and handed back as a credit note.
//
// APD is now max(settled-bill APD, pending-money APD), both
// amount-weighted and both measured from documents:
//   settled  = (last_payment_date - invoice date) over bills FULLY
//              PAID in the closure window, weighted by amount
//   pending  = age of everything still owed, opening balance
//              included, weighted by amount
// The max is what closes the loophole: paying small new bills fast
// while an old one rots no longer reads as a good payer.
//
// THE ELIGIBILITY RULE ITSELF IS UNTOUCHED - still APD < 75 OR
// nothing aged past 75. Only the APD is a truer number.
//
// The recovery figure in section 9 changed with it, and is now
// honest in a way the old one could not be: if the SETTLED average
// is already past 75, no payment made today can fix it, and the
// script says so instead of quoting an amount that would not work.
// Customer workflow input: customer
// Connection: zerp
//
// FY26-27 Q2 | sales: 01-Jul-2026 to 30-Sep-2026
// Preview: before 01-Oct-2026 (never posts)
// Posting window: 01-Oct-2026 through 10-Oct-2026 (inclusive)
// Expired: from 11-Oct-2026 (never posts)
//
// V1.4 (2026-08-17): APD MEASUREMENT REBUILT to match CREDIT LIMIT
// ENGINE V12.1. V1.3 claimed to be synced to the "V8.3 Limit Engines"
// and windowed its APD on the FINANCIAL YEAR - the April bug (lesson 6),
// still alive here four versions after it was fixed everywhere else.
// Now: rolling 180-day window, divisor from real observed history with
// a 60-day floor. The eligibility RULE is unchanged - only the number
// feeding it was wrong. A dealer's APD here and on their customer
// record are now the same number.
// Native Unused Credit PDCs keep open invoice balances naturally accurate.
//
// Eligibility is OR logic:
//   A. Weighted average payment days (APD) < 75, OR
//   B. No invoice with an outstanding balance aged > 75 days.
// Only when BOTH A and B fail is TOD denied.
// ============================================================
// ============================================================
// 1. CONFIGURATION - change only this block for a new quarter
// ============================================================
quarterName = "FY26-27 Q2";
quarterStartStr = "2026-07-01";
quarterEndStr = "2026-09-30";
// ============================================================
// *** V1.4 (2026-08-17) - APD MEASUREMENT REBUILT ***
// ============================================================
// V1.3 anchored the APD payment window to the FINANCIAL YEAR:
//        apdPaymentStartStr = "2026-04-01"
// That is exactly THE APRIL BUG recorded as lesson 6, still alive in
// this script four versions after it was fixed in the credit
// engines. Every 1 April the window collapsed to a few days, so the
// divisors collapsed with it and velocity read wildly high or wildly
// low depending on whether anything had been paid yet. Q1's posting
// window falls in July, which is precisely when that thin window was
// being used to decide who gets a discount.
//
// AND THE DIRECTION MATTERS HERE. A short divisor inflates velocity;
// APD is outstanding / velocity, so an inflated velocity makes APD
// look LOW - and a low APD PASSES the "APD < 75" eligibility test.
// The bug was handing turnover discount to customers who had not
// earned it. In the credit engine the same fault only inflated a
// limit; here it spends money.
//
// V1.4 uses the same measurement as CREDIT LIMIT ENGINE V12.1:
//   - a ROLLING 180-day window, never an accounting boundary
//   - the divisor taken from real history (contact age or the
//     earliest payment actually observed, whichever is longer),
//     never from the calendar
//   - a FLOOR of 60 days under that divisor - one full Net 60 credit
//     cycle - because a rate cannot be inferred from a few days
// The eligibility RULE is untouched: APD < 75 OR nothing aged past
// 75 days. That is a commercial decision and not mine to change.
// Only the measurement feeding it was wrong.
//
// apdPaymentStartStr is now COMPUTED from the run date in section 2.
velocityLookbackDays = 180;
minimumVelocityDivisorDays = 60;
postingStartStr = "2026-10-01";
postingEndStr = "2026-10-10";
todAccountID = "<TOD_DISCOUNT_ACCOUNT_ID>";
currencyPrecision = 2;
apdTargetDays = 75.0;
bisectionStepList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
// *** V2.0 *** The measured-APD settings. Keep these IDENTICAL to
// the credit engine's - the whole point of V1.4 was that a dealer
// sees one APD, not two.
apdClosureWindowDays = 90;
apdClosureWindowWideDays = 180;
apdMinClosedBills = 2;
useMeasuredAPD = true;
sortRoundList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80};
eligibleBrandOne = "BRAND_ONE";
eligibleBrandTwo = "BRAND_TWO";
// Static page lists are required by Deluge. 15 x 200 is a safe hard stop;
// if more data exists, posting is blocked rather than calculating partly.
pageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
// ============================================================
// 2. BASIC DATA AND RUN MODE
// ============================================================
organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
customerID = customer.get("customer_id");
if(customerID == null || customerID == "")
{
	customerID = customer.get("contact_id");
}
customerName = customer.get("company_name");
if(customerName == null || customerName == "")
{
	customerName = customer.get("contact_name");
}
if(customerName == null || customerName == "")
{
	customerName = "Unknown Customer";
}
if(customerID == null || customerID == "")
{
	info "ERROR: Customer ID is missing. TOD stopped.";
	return;
}
quarterStartDate = quarterStartStr.toDate("yyyy-MM-dd");
quarterEndDate = quarterEndStr.toDate("yyyy-MM-dd");
postingStartDate = postingStartStr.toDate("yyyy-MM-dd");
postingEndDate = postingEndStr.toDate("yyyy-MM-dd");
runDate = zoho.currentdate;
runDateStr = runDate.toString("yyyy-MM-dd");
// *** V1.4 *** The APD payment window is now ROLLING, computed from
// the run date, so it can never collapse on an accounting boundary.
apdPaymentStartDate = runDate.subDay(velocityLookbackDays - 1);
apdPaymentStartStr = apdPaymentStartDate.toString("yyyy-MM-dd");
// *** V2.0 *** Settlement windows for the measured APD.
apdClosureCutoffDate = runDate.subDay(apdClosureWindowDays);
apdClosureWideCutoffDate = runDate.subDay(apdClosureWindowWideDays);
// Contact age is one half of the divisor. created_time is an
// import/migration date in this org (lesson 7), so it is only ever
// used as a FLOOR alongside the earliest payment actually observed -
// whichever gives the LONGER history wins, because a longer divisor
// is the conservative one.
todCustomerAgeDays = 0;
todCreatedTimeStr = customer.get("created_time");
if(todCreatedTimeStr == null || todCreatedTimeStr == "")
{
	// The customer workflow payload does NOT carry created_time -
	// proven live 2026-08-17, it logged "contact age 0" for a dealer
	// trading since April. Without it the divisor rests entirely on
	// the earliest payment seen INSIDE the window, which is shorter
	// than the real relationship whenever a customer did not happen
	// to pay early in that window. A shorter divisor inflates
	// velocity, which lowers APD, which wrongly PASSES the APD < 75
	// test. One read settles it and keeps this measurement identical
	// to the credit engine, which has always read the contact.
	todContactResp = invokeurl
	[
		url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
		type :GET
		connection:"zerp"
	];
	if(todContactResp != null && todContactResp.containsKey("code") && todContactResp.get("code") == 0 && todContactResp.get("contact") != null)
	{
		todCreatedTimeStr = todContactResp.get("contact").get("created_time");
	}
}
if(todCreatedTimeStr != null && todCreatedTimeStr != "")
{
	todCreatedDateOnly = todCreatedTimeStr.subString(0,10);
	todCustomerAgeDays = todCreatedDateOnly.toDate("yyyy-MM-dd").daysbetween(runDate);
	if(todCustomerAgeDays < 0)
	{
		todCustomerAgeDays = 0;
	}
}
// Never include a document dated after the date this function is run.
salesEndStr = quarterEndStr;
if(runDate < quarterEndDate)
{
	salesEndStr = runDateStr;
}
uniqueTODMarker = "AUTO-TOD-FY26-27-Q2-" + customerID;
runMode = "PREVIEW";
if(runDate >= postingStartDate && runDate <= postingEndDate)
{
	runMode = "POSTING WINDOW";
}
else if(runDate > postingEndDate)
{
	runMode = "EXPIRED";
}
info "========================================";
info "ACME QUARTERLY TOD + APD ENGINE V2.0";
info "Customer : " + customerName + " (" + customerID + ")";
info "Quarter : " + quarterName;
info "Run date : " + runDateStr + " | Mode : " + runMode;
info "Marker : " + uniqueTODMarker;
info "========================================";
// ============================================================
// 3. WORKING VARIABLES / CACHES
// ============================================================
fatalReadError = false;
invoiceReadErrorCount = 0;
itemReadErrorCount = 0;
creditNoteReadErrorCount = 0;
paymentReadErrorCount = 0;
outstandingReadErrorCount = 0;
itemBrandCache = Map();
invoiceDataCache = Map();
eligibleInvoiceMap = Map();
adjustmentInvoiceList = List();
apdCandidateList = List();
over75InvoiceList = List();
brandOneGrossSales = 0.0;
brandTwoGrossSales = 0.0;
grossEligibleSales = 0.0;
brandOneReturns = 0.0;
brandTwoReturns = 0.0;
eligibleReturns = 0.0;
nonEligibleSales = 0.0;
nonEligibleReturns = 0.0;
// ============================================================
// 4. READ QUARTER SALES AND BUILD THE ELIGIBLE-INVOICE MAP
// Item brands are cached: every distinct item is fetched only once.
// ============================================================
hasMoreInvoices = true;
for each  pageNo in pageList
{
	if(hasMoreInvoices == true)
	{
		invoiceListResp = invokeurl
		[
			url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + quarterStartStr + "&date_end=" + salesEndStr + "&per_page=200&page=" + pageNo
			type :GET
			connection:"zerp"
		];
		if(invoiceListResp != null && invoiceListResp.containsKey("code") && invoiceListResp.get("code") == 0)
		{
			invoiceList = invoiceListResp.get("invoices");
			if(invoiceList != null)
			{
				for each  invoiceSummary in invoiceList
				{
					invoiceID = invoiceSummary.get("invoice_id");
					invoiceNumber = invoiceSummary.get("invoice_number");
					invoiceDetailResp = invokeurl
					[
						url :apiEndPoint + "/invoices/" + invoiceID + "?organization_id=" + organizationID
						type :GET
						connection:"zerp"
					];
					if(invoiceDetailResp != null && invoiceDetailResp.containsKey("code") && invoiceDetailResp.get("code") == 0 && invoiceDetailResp.get("invoice") != null)
					{
						invoiceData = invoiceDetailResp.get("invoice");
						invoiceDataCache.put(invoiceID,invoiceData);
						invoiceEligibleValue = 0.0;
						lineItems = invoiceData.get("line_items");
						invoiceStatus = invoiceData.get("status");
						if(invoiceStatus != "draft" && invoiceStatus != "void" && lineItems != null)
						{
							for each  lineItem in lineItems
							{
								itemID = lineItem.get("item_id");
								lineValue = 0.0;
								if(lineItem.get("item_total") != null)
								{
									lineValue = lineItem.get("item_total").toDecimal();
								}
								itemBrand = "";
								if(itemID != null && itemID != "")
								{
									if(itemBrandCache.containsKey(itemID))
									{
										itemBrand = itemBrandCache.get(itemID);
									}
									else
									{
										itemResp = invokeurl
										[
											url :apiEndPoint + "/items/" + itemID + "?organization_id=" + organizationID
											type :GET
											connection:"zerp"
										];
										if(itemResp != null && itemResp.containsKey("code") && itemResp.get("code") == 0 && itemResp.get("item") != null)
										{
											itemBrand = itemResp.get("item").get("brand");
											if(itemBrand == null)
											{
												itemBrand = "";
											}
											itemBrandCache.put(itemID,itemBrand);
										}
										else
										{
											itemReadErrorCount = itemReadErrorCount + 1;
											fatalReadError = true;
											info "ERROR: Item read failed: " + lineItem.get("name");
										}
									}
								}
								if(itemBrand == eligibleBrandOne)
								{
									brandOneGrossSales = brandOneGrossSales + lineValue;
									grossEligibleSales = grossEligibleSales + lineValue;
									invoiceEligibleValue = invoiceEligibleValue + lineValue;
								}
								else if(itemBrand == eligibleBrandTwo)
								{
									brandTwoGrossSales = brandTwoGrossSales + lineValue;
									grossEligibleSales = grossEligibleSales + lineValue;
									invoiceEligibleValue = invoiceEligibleValue + lineValue;
								}
								else
								{
									nonEligibleSales = nonEligibleSales + lineValue;
								}
							}
						}
						if(invoiceEligibleValue > 0)
						{
							eligibleInvoiceMap.put(invoiceID,invoiceEligibleValue);
						}
						// The per-invoice roll call was removed on the owner's instruction,
						// 2026-09-01 - twenty-five lines to say what the three totals in
						// the summary already say. Nothing else depended on it.
					}
					else
					{
						invoiceReadErrorCount = invoiceReadErrorCount + 1;
						fatalReadError = true;
						info "ERROR: Invoice read failed: " + invoiceNumber;
					}
				}
			}
			pageContext = invoiceListResp.get("page_context");
			if(pageContext == null || pageContext.get("has_more_page") != true)
			{
				hasMoreInvoices = false;
			}
		}
		else
		{
			fatalReadError = true;
			invoiceReadErrorCount = invoiceReadErrorCount + 1;
			hasMoreInvoices = false;
			info "ERROR: Quarter invoice list could not be read.";
		}
	}
}
if(hasMoreInvoices == true)
{
	fatalReadError = true;
	info "ERROR: More than 3,000 invoices found. Posting blocked until pagination limit is increased.";
}
// Fast stop: below the minimum slab cannot earn TOD.  The report still shows
// sales, but no payment/APD API calls are needed.
salesMeetMinimum = grossEligibleSales >= 50000;
// ============================================================
// 5. READ PRODUCT RETURNS ONLY (financial / AUTO-CD / AUTO-TOD
// credit notes have no item_id, and therefore never reduce turnover).
// ============================================================
hasMoreCN = true;
for each  cnPageNo in pageList
{
	if(hasMoreCN == true)
	{
		cnListResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + quarterStartStr + "&date_end=" + salesEndStr + "&per_page=200&page=" + cnPageNo
			type :GET
			connection:"zerp"
		];
		if(cnListResp != null && cnListResp.containsKey("code") && cnListResp.get("code") == 0)
		{
			cnList = cnListResp.get("creditnotes");
			if(cnList != null)
			{
				for each  cnSummary in cnList
				{
					cnID = cnSummary.get("creditnote_id");
					cnDetailResp = invokeurl
					[
						url :apiEndPoint + "/creditnotes/" + cnID + "?organization_id=" + organizationID
						type :GET
						connection:"zerp"
					];
					if(cnDetailResp != null && cnDetailResp.containsKey("code") && cnDetailResp.get("code") == 0 && cnDetailResp.get("creditnote") != null)
					{
						cnData = cnDetailResp.get("creditnote");
						cnReason = cnData.get("reason");
						if(cnReason == null)
						{
							cnReason = "";
						}
						cnReference = cnData.get("reference_number");
						if(cnReference == null)
						{
							cnReference = "";
						}
						cnStatus = cnData.get("status");
						cnLines = cnData.get("line_items");
						if(cnStatus != "void" && cnReason.contains("AUTO-CD-") == false && cnReference.contains("AUTO-CD-") == false && cnReason.contains("AUTO-TOD-") == false && cnReference.contains("AUTO-TOD-") == false && cnLines != null)
						{
							for each  cnLine in cnLines
							{
								returnItemID = cnLine.get("item_id");
								if(returnItemID != null && returnItemID != "")
								{
									returnBrand = "";
									if(itemBrandCache.containsKey(returnItemID))
									{
										returnBrand = itemBrandCache.get(returnItemID);
									}
									else
									{
										returnItemResp = invokeurl
										[
											url :apiEndPoint + "/items/" + returnItemID + "?organization_id=" + organizationID
											type :GET
											connection:"zerp"
										];
										if(returnItemResp != null && returnItemResp.containsKey("code") && returnItemResp.get("code") == 0 && returnItemResp.get("item") != null)
										{
											returnBrand = returnItemResp.get("item").get("brand");
											if(returnBrand == null)
											{
												returnBrand = "";
											}
											itemBrandCache.put(returnItemID,returnBrand);
										}
										else
										{
											fatalReadError = true;
											itemReadErrorCount = itemReadErrorCount + 1;
										}
									}
									returnValue = 0.0;
									if(cnLine.get("item_total") != null)
									{
										returnValue = cnLine.get("item_total").toDecimal();
									}
									if(returnBrand == eligibleBrandOne)
									{
										brandOneReturns = brandOneReturns + returnValue;
										eligibleReturns = eligibleReturns + returnValue;
									}
									else if(returnBrand == eligibleBrandTwo)
									{
										brandTwoReturns = brandTwoReturns + returnValue;
										eligibleReturns = eligibleReturns + returnValue;
									}
									else
									{
										nonEligibleReturns = nonEligibleReturns + returnValue;
									}
								}
							}
						}
					}
					else
					{
						fatalReadError = true;
						creditNoteReadErrorCount = creditNoteReadErrorCount + 1;
					}
				}
			}
			cnPageContext = cnListResp.get("page_context");
			if(cnPageContext == null || cnPageContext.get("has_more_page") != true)
			{
				hasMoreCN = false;
			}
		}
		else
		{
			fatalReadError = true;
			creditNoteReadErrorCount = creditNoteReadErrorCount + 1;
			hasMoreCN = false;
		}
	}
}
if(hasMoreCN == true)
{
	fatalReadError = true;
	info "ERROR: More than 3,000 credit notes found. Posting blocked.";
}
netEligiblePurchase = (grossEligibleSales - eligibleReturns).round(currencyPrecision);
if(netEligiblePurchase < 0)
{
	netEligiblePurchase = 0.0;
}
// Only run payment/APD API reads if turnover can still reach a TOD slab
// after eligible returns have been deducted.
salesMeetMinimum = netEligiblePurchase >= 50000;
// ============================================================
// 6. TOD SLAB + ONE-STEP GRACE
// ============================================================
standardTodPct = 0.0;
standardTodSlab = "Below minimum";
nextSlabTarget = 50000.0;
nextSlabPct = 0.75;
nextSlabName = "Rs 50,000+";
if(netEligiblePurchase >= 1000000)
{
	standardTodPct = 7.50;
	standardTodSlab = "Rs 10,00,000+";
	nextSlabTarget = 0.0;
}
else if(netEligiblePurchase >= 750000)
{
	standardTodPct = 5.75;
	standardTodSlab = "Rs 7,50,000+";
	nextSlabTarget = 1000000.0;
	nextSlabPct = 7.50;
	nextSlabName = "Rs 10,00,000+";
}
else if(netEligiblePurchase >= 500000)
{
	standardTodPct = 4.25;
	standardTodSlab = "Rs 5,00,000+";
	nextSlabTarget = 750000.0;
	nextSlabPct = 5.75;
	nextSlabName = "Rs 7,50,000+";
}
else if(netEligiblePurchase >= 350000)
{
	standardTodPct = 3.00;
	standardTodSlab = "Rs 3,50,000+";
	nextSlabTarget = 500000.0;
	nextSlabPct = 4.25;
	nextSlabName = "Rs 5,00,000+";
}
else if(netEligiblePurchase >= 200000)
{
	standardTodPct = 2.00;
	standardTodSlab = "Rs 2,00,000+";
	nextSlabTarget = 350000.0;
	nextSlabPct = 3.00;
	nextSlabName = "Rs 3,50,000+";
}
else if(netEligiblePurchase >= 100000)
{
	standardTodPct = 1.25;
	standardTodSlab = "Rs 1,00,000+";
	nextSlabTarget = 200000.0;
	nextSlabPct = 2.00;
	nextSlabName = "Rs 2,00,000+";
}
else if(netEligiblePurchase >= 50000)
{
	standardTodPct = 0.75;
	standardTodSlab = "Rs 50,000+";
	nextSlabTarget = 100000.0;
	nextSlabPct = 1.25;
	nextSlabName = "Rs 1,00,000+";
}
graceApplied = false;
finalTodPct = standardTodPct;
finalTodSlab = standardTodSlab;
if(nextSlabTarget > 0)
{
	shortfall = (nextSlabTarget - netEligiblePurchase).round(currencyPrecision);
	allowedGrace = (nextSlabTarget * 0.01).round(currencyPrecision);
	if(allowedGrace > 2500)
	{
		allowedGrace = 2500.0;
	}
	if(shortfall > 0 && shortfall <= allowedGrace)
	{
		graceApplied = true;
		finalTodPct = nextSlabPct;
		finalTodSlab = nextSlabName;
	}
}
calculatedTOD = (netEligiblePurchase * finalTodPct / 100).round(currencyPrecision);
// ============================================================
// FAST EXIT WHEN NO TOD CAN BE EARNED
// Below the first slab, payment eligibility cannot change the result.
// Skip ageing, payment/APD, duplicate, and recovery API reads.
// ============================================================
if(calculatedTOD <= 0)
{
	info "========================================";
	info "TOD CALCULATION SUMMARY";
	info "Gross eligible sales : Rs " + grossEligibleSales;
	info "Eligible product returns : Rs " + eligibleReturns;
	info "Net eligible purchase : Rs " + netEligiblePurchase;
	info "Final slab : " + finalTodSlab + " | " + finalTodPct + "% | Grace: " + graceApplied;
	info "Calculated TOD : Rs " + calculatedTOD;
	info "----------------------------------------";
	info "APD CHECK: Skipped - TOD minimum slab is not met; payment APIs were not called.";
	info "NO POST: Calculated TOD is Rs 0.00.";
	info "========================================";
	info "ACME QUARTERLY TOD + APD ENGINE END";
	info "========================================";
	return;
}
// ============================================================
// 7. OUTSTANDING AGEING AS OF THE ACTUAL RUN DATE
// This is deliberately not fixed at 10-Oct: a customer can qualify on
// any manual run from 01-Oct to 10-Oct and will then be protected by marker.
// ============================================================
balance0to60 = 0.0;
balance61to75 = 0.0;
balanceAbove75 = 0.0;
paymentToClearAbove75 = 0.0;
// *** V2.0 *** The two measured APDs are built from this same read.
// The SETTLED side comes off the LIST row - status and
// last_payment_date are both on it (PROBE E dumped the keys), so no
// detail read is needed for a bill that is already closed. The
// PENDING side reuses the ageing the loop already does.
paidWeightedDaysPrimary = 0.0;
paidWeightPrimary = 0.0;
paidCountPrimary = 0;
paidWeightedDaysWide = 0.0;
paidWeightWide = 0.0;
paidCountWide = 0;
paidNoDateCount = 0;
openBalanceTotal = 0.0;
pendingWeightedDays = 0.0;
openItemCount = 0;
openItemsList = List();
hasMoreOutstanding = true;
for each  outstandingPageNo in pageList
{
	if(hasMoreOutstanding == true)
	{
		outstandingListResp = invokeurl
		[
			url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_end=" + runDateStr + "&per_page=200&page=" + outstandingPageNo
			type :GET
			connection:"zerp"
		];
		if(outstandingListResp != null && outstandingListResp.containsKey("code") && outstandingListResp.get("code") == 0)
		{
			outstandingList = outstandingListResp.get("invoices");
			if(outstandingList != null)
			{
				for each  outstandingSummary in outstandingList
				{
					outstandingID = outstandingSummary.get("invoice_id");
					// ---- SETTLED BILLS -> the settled APD (V2.0) ----
					// Read straight off the summary row. A bill that is closed needs no
					// detail read, so this costs nothing.
					summaryStatus = outstandingSummary.get("status");
					summaryDateStr = outstandingSummary.get("date");
					if(summaryStatus == "paid" && summaryDateStr != null && summaryDateStr != "")
					{
						summaryClosureStr = "";
						if(outstandingSummary.containsKey("last_payment_date") && outstandingSummary.get("last_payment_date") != null)
						{
							summaryClosureStr = outstandingSummary.get("last_payment_date");
						}
						if(summaryClosureStr == "")
						{
							// Closed by a credit note - very likely one of THIS script's
							// own TOD notes from a previous quarter. A rebate is not
							// payment behaviour and must never be counted as one.
							paidNoDateCount = paidNoDateCount + 1;
						}
						else
						{
							summaryClosureDate = summaryClosureStr.toDate("yyyy-MM-dd");
							summaryInvoiceDate = summaryDateStr.toDate("yyyy-MM-dd");
							summaryDaysToClose = summaryInvoiceDate.daysbetween(summaryClosureDate);
							if(summaryDaysToClose < 0)
							{
								summaryDaysToClose = 0;
							}
							summaryWeight = 0.0;
							if(outstandingSummary.get("total") != null)
							{
								summaryWeight = outstandingSummary.get("total").toDecimal();
							}
							if(summaryWeight > 0)
							{
								if(summaryClosureDate >= apdClosureWideCutoffDate)
								{
									paidCountWide = paidCountWide + 1;
									paidWeightedDaysWide = paidWeightedDaysWide + summaryDaysToClose * summaryWeight;
									paidWeightWide = paidWeightWide + summaryWeight;
								}
								if(summaryClosureDate >= apdClosureCutoffDate)
								{
									paidCountPrimary = paidCountPrimary + 1;
									paidWeightedDaysPrimary = paidWeightedDaysPrimary + summaryDaysToClose * summaryWeight;
									paidWeightPrimary = paidWeightPrimary + summaryWeight;
								}
							}
						}
					}
					if(invoiceDataCache.containsKey(outstandingID))
					{
						outstandingData = invoiceDataCache.get(outstandingID);
					}
					else
					{
						outstandingDetailResp = invokeurl
						[
							url :apiEndPoint + "/invoices/" + outstandingID + "?organization_id=" + organizationID
							type :GET
							connection:"zerp"
						];
						outstandingData = null;
						if(outstandingDetailResp != null && outstandingDetailResp.containsKey("code") && outstandingDetailResp.get("code") == 0)
						{
							outstandingData = outstandingDetailResp.get("invoice");
							if(outstandingData != null)
							{
								invoiceDataCache.put(outstandingID,outstandingData);
							}
						}
					}
					outstandingStatus = "";
					if(outstandingData != null)
					{
						outstandingStatus = outstandingData.get("status");
					}
					if(outstandingData != null && outstandingStatus != "draft" && outstandingStatus != "void" && outstandingData.get("balance") != null && outstandingData.get("balance").toDecimal() > 0)
					{
						outstandingBalance = outstandingData.get("balance").toDecimal();
						outstandingDateStr = outstandingData.get("date");
						if(outstandingDateStr != null && outstandingDateStr != "")
						{
							outstandingAge = outstandingDateStr.toDate("yyyy-MM-dd").daysbetween(runDate);
							outstandingMap = Map();
							outstandingMap.put("invoice_id",outstandingID);
							outstandingMap.put("invoice_number",outstandingData.get("invoice_number"));
							outstandingMap.put("age_days",outstandingAge);
							outstandingMap.put("balance",outstandingBalance);
							outstandingTotalValue = outstandingBalance;
							if(outstandingData.get("total") != null)
							{
								outstandingTotalValue = outstandingData.get("total").toDecimal();
							}
							// The settled average weights each bill by its TOTAL, so the
							// recovery simulation below needs the total as well as the balance.
							outstandingMap.put("total",outstandingTotalValue);
							// ---- WHAT IS STILL OWED -> the pending APD (V2.0) ----
							openItemCount = openItemCount + 1;
							openBalanceTotal = openBalanceTotal + outstandingBalance;
							pendingWeightedDays = pendingWeightedDays + outstandingAge * outstandingBalance;
							openItemsList.add(outstandingMap);
							if(outstandingAge <= 60)
							{
								balance0to60 = balance0to60 + outstandingBalance;
							}
							else if(outstandingAge <= 75)
							{
								balance61to75 = balance61to75 + outstandingBalance;
								adjustmentInvoiceList.add(outstandingMap);
							}
							else
							{
								balanceAbove75 = balanceAbove75 + outstandingBalance;
								paymentToClearAbove75 = paymentToClearAbove75 + outstandingBalance;
								over75InvoiceList.add(outstandingMap);
							}
							// For APD recovery planning, today's payment is assumed to be
							// allocated to open invoices younger than 75 days first.
							if(outstandingAge < apdTargetDays)
							{
								apdCandidateList.add(outstandingMap);
							}
						}
					}
					else if(outstandingData == null)
					{
						fatalReadError = true;
						outstandingReadErrorCount = outstandingReadErrorCount + 1;
					}
				}
			}
			outstandingPageContext = outstandingListResp.get("page_context");
			if(outstandingPageContext == null || outstandingPageContext.get("has_more_page") != true)
			{
				hasMoreOutstanding = false;
			}
		}
		else
		{
			fatalReadError = true;
			outstandingReadErrorCount = outstandingReadErrorCount + 1;
			hasMoreOutstanding = false;
		}
	}
}
if(hasMoreOutstanding == true)
{
	fatalReadError = true;
	info "ERROR: More than 3,000 invoices in ageing read. Posting blocked.";
}
// ============================================================
// 7b. *** THE PENDING OPENING BALANCE, ADDED 2026-08-17 ***
// The ageing above is built from GET /invoices, and PROBE C proved
// that endpoint does NOT return a customer's opening balance. 99 of
// 268 customers carry one, in aggregate a material sum, with DEALER-A at
// Rs 1,64,884 and DEALER-H at Rs 1,01,395.
//
// FOR TOD THAT MATTERED IN ONE SPECIFIC WAY: balanceAbove75 came out
// as 0 for those customers however old the money was, so noOver75Pass
// wrongly PASSED and a dealer sitting on a months-old opening balance
// could qualify for a rebate. The opening balance on DEALER-A is dated
// 2026-03-31 - well past 75 days.
//
// It is added to the >75 TOTALS, which is what qualification and the
// recovery figure are measured on, and to over75InvoiceList, which is
// only ever printed. It is deliberately NOT added to
// adjustmentInvoiceList: that list drives an actual credit-note
// application later in this script, and the opening balance is not an
// ordinary invoice to apply a TOD note against.
//
// The amount comes from GET /invoices/<ob_invoice_id> - the live
// unpaid figure. contact.opening_balance_amount is the ORIGINAL
// migrated number (175884 against a true 164884) and must never be
// used as the amount owed.
// ============================================================
todOBBalance = 0.0;
todOBAgeDays = -1;
todOBInvoiceID = "";
todOBContactResp = invokeurl
[
	url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
	type :GET
	connection:"zerp"
];
if(todOBContactResp != null && todOBContactResp.containsKey("code") && todOBContactResp.get("code") == 0 && todOBContactResp.get("contact") != null)
{
	todOBContact = todOBContactResp.get("contact");
	todOBFlagValue = todOBContact.get("opening_balance_amount");
	if(todOBFlagValue != null && todOBFlagValue.toDecimal() > 0)
	{
		todOBNested = todOBContact.get("opening_balances");
		if(todOBNested != null)
		{
			// *** DELUGE TYPE NOTE - 2026-08-17, found at paste time ***
			// todOBNested.get("ob_invoice_id") DOES NOT COMPILE. Zoho
			// infers a doubly-nested value as a LIST and demands an
			// integer index:
			//   "Data type of the argument of the function 'get' did
			//    not match the required data type of '[BIGINT]'"
			// It is inconsistent - page_context is read exactly this way
			// elsewhere in this same file and compiles - but arguing with
			// the inference is not worth the time.
			// So the id is taken out of the TEXT instead, using only
			// functions already proven in this codebase: toString,
			// contains, getPrefix, subString, length. PROBE C printed the
			// exact shape, so this is measured and not assumed:
			//   ...,"ob_invoice_id":"<OPENING_BALANCE_INVOICE_ID>","exchange_rate":...
			// 13 is the length of the literal ob_invoice_id.
			// If the parse ever yields something wrong, the GET that
			// follows simply fails and the gap fallback takes over - the
			// amount is never lost, only the age.
			todOBRawText = todOBNested.toString();
			if(todOBRawText.contains("ob_invoice_id"))
			{
				todOBBefore = todOBRawText.getPrefix("ob_invoice_id");
				todOBRest = todOBRawText.subString(todOBBefore.length() + 13);
				todOBChunk = todOBRest;
				if(todOBRest.contains(","))
				{
					todOBChunk = todOBRest.getPrefix(",");
				}
				// todOBChunk now reads  :"<OPENING_BALANCE_INVOICE_ID>"  with the
				// key's own closing quote in front of it - three
				// punctuation characters to drop at the start, one at the
				// end.
				if(todOBChunk.length() > 4)
				{
					todOBInvoiceID = todOBChunk.subString(3,todOBChunk.length() - 1);
				}
			}
		}
	}
}
else
{
	// A TOD posting is real money. If the opening balance cannot even
	// be checked, the qualification test is unproven and this script
	// must not post.
	fatalReadError = true;
	info "ERROR: the contact could not be read, so a pending opening balance cannot be ruled out. Posting blocked.";
}
if(todOBInvoiceID != "")
{
	todOBResp = invokeurl
	[
		url :apiEndPoint + "/invoices/" + todOBInvoiceID + "?organization_id=" + organizationID
		type :GET
		connection:"zerp"
	];
	if(todOBResp != null && todOBResp.containsKey("code") && todOBResp.get("code") == 0 && todOBResp.get("invoice") != null)
	{
		todOBDoc = todOBResp.get("invoice");
		todOBStatus = todOBDoc.get("status");
		if(todOBStatus != "draft" && todOBStatus != "void" && todOBDoc.get("balance") != null)
		{
			todOBBalance = todOBDoc.get("balance").toDecimal();
			todOBDateStr = todOBDoc.get("date");
			if(todOBDateStr != null && todOBDateStr != "")
			{
				todOBAgeDays = todOBDateStr.toDate("yyyy-MM-dd").daysbetween(runDate);
			}
		}
	}
	else
	{
		fatalReadError = true;
		info "ERROR: the opening balance document could not be read. Posting blocked - its age decides the >75 test.";
	}
}
if(todOBBalance > 0)
{
	todOBMap = Map();
	todOBMap.put("invoice_id",todOBInvoiceID);
	todOBMap.put("invoice_number","Customer opening balance");
	todOBMap.put("age_days",todOBAgeDays);
	todOBMap.put("balance",todOBBalance);
	todOBMap.put("total",todOBBalance);
	// The opening balance is the OLDEST debt on the account, so it
	// belongs in the pending age as much as in the >75 test. Leaving it
	// out would make exactly the worst accounts look youngest.
	openItemCount = openItemCount + 1;
	openBalanceTotal = openBalanceTotal + todOBBalance;
	if(todOBAgeDays >= 0)
	{
		pendingWeightedDays = pendingWeightedDays + todOBAgeDays * todOBBalance;
		openItemsList.add(todOBMap);
	}
	else
	{
		// No date to age it from. Unknown age is treated as the worst
		// case, not the best - an opening balance is old by nature.
		pendingWeightedDays = pendingWeightedDays + 150 * todOBBalance;
	}
	if(todOBAgeDays > 75)
	{
		balanceAbove75 = balanceAbove75 + todOBBalance;
		paymentToClearAbove75 = paymentToClearAbove75 + todOBBalance;
		over75InvoiceList.add(todOBMap);
		info "OPENING BALANCE : Rs " + todOBBalance.round(currencyPrecision) + " aged " + todOBAgeDays + " days - counted in >75. This alone can block TOD.";
	}
	else if(todOBAgeDays > 60)
	{
		balance61to75 = balance61to75 + todOBBalance;
		info "OPENING BALANCE : Rs " + todOBBalance.round(currencyPrecision) + " aged " + todOBAgeDays + " days - counted in 61-75. NOT added to the credit-note adjustment list.";
	}
	else if(todOBAgeDays >= 0)
	{
		balance0to60 = balance0to60 + todOBBalance;
		info "OPENING BALANCE : Rs " + todOBBalance.round(currencyPrecision) + " aged " + todOBAgeDays + " days - counted in 0-60.";
	}
	else
	{
		// No date to age it from. Unknown age is treated as the worst
		// case, not the best - an opening balance is old by nature.
		balanceAbove75 = balanceAbove75 + todOBBalance;
		paymentToClearAbove75 = paymentToClearAbove75 + todOBBalance;
		over75InvoiceList.add(todOBMap);
		info "OPENING BALANCE : Rs " + todOBBalance.round(currencyPrecision) + " with NO readable date - counted in >75 as the conservative case.";
	}
}
else
{
	// Say so even when there is nothing to say. A check that only speaks
	// up when it finds something is exactly how the FIFO bug stayed
	// hidden for months - the log looked normal either way. One line.
	info "OPENING BALANCE : none open for this customer.";
}
// ============================================================
// 8. TREND-WEIGHTED APD
// Actual payments only (no future/PDC) are grouped by payment date:
// UPDATED: Sync to 40/40/20 weights.
// ============================================================
totalPayments = 0.0;
paymentCount = 0;
recent30Payments = 0.0;
middle31to90Payments = 0.0;
olderFYPayments = 0.0;
recentStartDate = runDate.subDay(29);
middleStartDate = runDate.subDay(89);
middleEndDate = runDate.subDay(30);
// *** V1.4 *** The earliest payment ACTUALLY OBSERVED is what sets
// the length of history, not the calendar. Lesson 7: created_time is
// an import date in this org - one customer has a payment dated
// BEFORE their own created_time.
todEarliestPaymentDate = runDate;
todFoundAnyPayment = false;
if(salesMeetMinimum == true)
{
	hasMorePayments = true;
	for each  paymentPageNo in pageList
	{
		if(hasMorePayments == true)
		{
			paymentListResp = invokeurl
			[
				url :apiEndPoint + "/customerpayments?organization_id=" + organizationID + "&customer_id=" + customerID + "&date_start=" + apdPaymentStartStr + "&date_end=" + runDateStr + "&per_page=200&page=" + paymentPageNo
				type :GET
				connection:"zerp"
			];
			if(paymentListResp != null && paymentListResp.containsKey("code") && paymentListResp.get("code") == 0)
			{
				paymentList = paymentListResp.get("customerpayments");
				if(paymentList != null)
				{
					for each  paymentSummary in paymentList
					{
						paymentStatus = paymentSummary.get("status");
						if(paymentSummary.get("amount") != null && paymentStatus != "draft" && paymentStatus != "void" && paymentStatus != "cancelled" && paymentStatus != "refunded")
						{
							paymentDateStr = paymentSummary.get("date");
							if(paymentDateStr != null && paymentDateStr != "")
							{
								paymentDate = paymentDateStr.toDate("yyyy-MM-dd");
								paymentAmount = paymentSummary.get("amount").toDecimal();
								totalPayments = totalPayments + paymentAmount;
								paymentCount = paymentCount + 1;
									if(todFoundAnyPayment == false || paymentDate < todEarliestPaymentDate)
									{
										todEarliestPaymentDate = paymentDate;
										todFoundAnyPayment = true;
									}
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
									olderFYPayments = olderFYPayments + paymentAmount;
								}
							}
						}
					}
				}
				paymentPageContext = paymentListResp.get("page_context");
				if(paymentPageContext == null || paymentPageContext.get("has_more_page") != true)
				{
					hasMorePayments = false;
				}
			}
			else
			{
				fatalReadError = true;
				paymentReadErrorCount = paymentReadErrorCount + 1;
				hasMorePayments = false;
			}
		}
	}
	if(hasMorePayments == true)
	{
		fatalReadError = true;
		info "ERROR: More than 3,000 payments found. Posting blocked.";
	}
}
// ============================================================
// *** V1.4 *** DIVISORS FROM REAL HISTORY, NOT THE CALENDAR
// ============================================================
// Identical in shape to CREDIT LIMIT ENGINE V12.1 so the APD a
// dealer sees on their customer record and the APD this scheme
// judges them by are the SAME NUMBER. Two different APDs for one
// customer is confusing internally and indefensible in front of
// the dealer.
//   history  = the longer of contact age and the earliest payment
//              actually observed (lesson 7 - created_time here is
//              an import date, and one customer has a payment
//              dated before their own created_time)
//   floored  at minimumVelocityDivisorDays, one full Net 60 cycle
//   capped   at velocityLookbackDays
todRelationshipDays = todCustomerAgeDays + 1;
if(todFoundAnyPayment == true)
{
	todObservedHistoryDays = todEarliestPaymentDate.daysbetween(runDate) + 1;
	if(todObservedHistoryDays > todRelationshipDays)
	{
		todRelationshipDays = todObservedHistoryDays;
	}
}
todEffectiveLookbackDays = todRelationshipDays;
if(todEffectiveLookbackDays < minimumVelocityDivisorDays)
{
	todEffectiveLookbackDays = minimumVelocityDivisorDays;
}
if(todEffectiveLookbackDays > velocityLookbackDays)
{
	todEffectiveLookbackDays = velocityLookbackDays;
}
info "APD history window : " + todEffectiveLookbackDays + " days (contact age " + todCustomerAgeDays + ", payments found " + todFoundAnyPayment + ")";
recentDaysForAPD = 30;
if(todEffectiveLookbackDays < 30)
{
	recentDaysForAPD = todEffectiveLookbackDays;
}
middleDaysForAPD = 0;
if(todEffectiveLookbackDays > 30)
{
	middleDaysForAPD = todEffectiveLookbackDays - 30;
	if(middleDaysForAPD > 60)
	{
		middleDaysForAPD = 60;
	}
}
olderDaysForAPD = 0;
if(todEffectiveLookbackDays > 90)
{
	olderDaysForAPD = todEffectiveLookbackDays - 90;
}
// Weights 40/40/20 - identical to CREDIT LIMIT ENGINE V12.1.
recentWeight = 0.40;
middleWeight = 0.40;
olderWeight = 0.20;
availableTrendWeight = recentWeight;
if(middleDaysForAPD > 0)
{
	availableTrendWeight = availableTrendWeight + middleWeight;
}
if(olderDaysForAPD > 0)
{
	availableTrendWeight = availableTrendWeight + olderWeight;
}
recentDailyVelocity = 0.0;
middleDailyVelocity = 0.0;
olderDailyVelocity = 0.0;
if(recentDaysForAPD > 0)
{
	recentDailyVelocity = recent30Payments / recentDaysForAPD;
}
if(middleDaysForAPD > 0)
{
	middleDailyVelocity = middle31to90Payments / middleDaysForAPD;
}
if(olderDaysForAPD > 0)
{
	olderDailyVelocity = olderFYPayments / olderDaysForAPD;
}
todOutstandingBalance = balance0to60 + balance61to75 + balanceAbove75;
dailyPaymentVelocity = 0.0;
averagePaymentDays = 150.0;
if(availableTrendWeight > 0)
{
	dailyPaymentVelocity = recentDailyVelocity * recentWeight;
	if(middleDaysForAPD > 0)
	{
		dailyPaymentVelocity = dailyPaymentVelocity + middleDailyVelocity * middleWeight;
	}
	if(olderDaysForAPD > 0)
	{
		dailyPaymentVelocity = dailyPaymentVelocity + olderDailyVelocity * olderWeight;
	}
	dailyPaymentVelocity = dailyPaymentVelocity / availableTrendWeight;
	if(totalPayments > 0 && todOutstandingBalance > 0 && dailyPaymentVelocity > 0)
	{
		averagePaymentDays = (todOutstandingBalance / dailyPaymentVelocity).round(currencyPrecision);
	}
}
if(averagePaymentDays > 150)
{
	averagePaymentDays = 150.0;
}
// ============================================================
// *** V2.0 - THE MEASURED APD REPLACES THE RATIO ***
// averagePaymentDays above is now the OLD model, kept for one
// release so both numbers appear in the log and any drift is
// visible. It decides nothing unless useMeasuredAPD is false.
// ============================================================
oldModelAPD = averagePaymentDays;
todPaidAPD = -1.0;
todPaidAPDCount = 0;
todPaidWindowUsed = apdClosureWindowDays;
if(paidCountPrimary >= apdMinClosedBills && paidWeightPrimary > 0)
{
	todPaidAPD = (paidWeightedDaysPrimary / paidWeightPrimary).round(2);
	todPaidAPDCount = paidCountPrimary;
}
else if(paidCountWide >= apdMinClosedBills && paidWeightWide > 0)
{
	todPaidAPD = (paidWeightedDaysWide / paidWeightWide).round(2);
	todPaidAPDCount = paidCountWide;
	todPaidWindowUsed = apdClosureWindowWideDays;
}
// A settled figure resting on bills we had to throw away is not a
// measurement. It matters more here than in the credit engine: the
// bills with no payment date are the ones THIS SCRIPT closed with a
// TOD note last quarter, so a dealer with several past rebates is
// exactly the customer whose settled sample gets thin.
if(todPaidAPD >= 0 && paidNoDateCount > todPaidAPDCount)
{
	info "NOTE: " + paidNoDateCount + " settled bills carried no payment date (closed by a credit note, very likely a past TOD or CD note) against only " + todPaidAPDCount + " that did. The settled APD is DISCARDED as unsafe; the pending age decides alone.";
	todPaidAPD = -1.0;
	todPaidAPDCount = 0;
}
if(todPaidAPD > 150)
{
	todPaidAPD = 150.0;
}
todPendingAPD = -1.0;
if(openBalanceTotal > 0)
{
	todPendingAPD = (pendingWeightedDays / openBalanceTotal).round(2);
	if(todPendingAPD > 150)
	{
		todPendingAPD = 150.0;
	}
}
todMeasuredAPD = -1.0;
todAPDSource = "";
if(todPaidAPD >= 0)
{
	todMeasuredAPD = todPaidAPD;
	todAPDSource = "settled " + todPaidAPDCount + " bills/" + todPaidWindowUsed + "d";
}
if(todPendingAPD > todMeasuredAPD)
{
	todMeasuredAPD = todPendingAPD;
	if(todPaidAPD >= 0)
	{
		todAPDSource = "PENDING governs (settled reads " + todPaidAPD.round(1) + ")";
	}
	else
	{
		todAPDSource = "PENDING only - no settled bill to measure";
	}
}
if(todOutstandingBalance <= 0 && todMeasuredAPD < 0)
{
	todMeasuredAPD = 0.0;
	todAPDSource = "nothing outstanding";
}
if(useMeasuredAPD == true)
{
	if(todMeasuredAPD >= 0)
	{
		averagePaymentDays = todMeasuredAPD;
	}
	else
	{
		// A TOD posting is real money. If the APD cannot be measured
		// at all, this script does not guess in the dealer's favour -
		// it keeps the old model's answer and says so.
		todAPDSource = "NOT MEASURABLE - held the old balance/velocity figure";
		info "WARNING: no settled bill and no ageable open document. APD could not be measured; the old figure of " + oldModelAPD + " stands for this qualification.";
	}
}
else
{
	todAPDSource = "old balance/velocity model (useMeasuredAPD is OFF)";
}
info "APD (old model, balance/velocity) : " + oldModelAPD;
info "APD settled : " + todPaidAPD + " from " + todPaidAPDCount + " settled bills in " + todPaidWindowUsed + " days | " + paidNoDateCount + " excluded, closed by credit note";
info "APD pending : " + todPendingAPD + " over Rs " + openBalanceTotal.round(currencyPrecision) + " across " + openItemCount + " open items";
info ">>> APD USED FOR QUALIFICATION : " + averagePaymentDays + "   (" + todAPDSource + ")";
apdPass = averagePaymentDays < apdTargetDays;
noOver75Pass = balanceAbove75 <= 0;
paymentEligibilityPass = apdPass == true || noOver75Pass == true;
// ============================================================
// 9. "HOW MUCH PAYMENT IS NEEDED?" RECOVERY GUIDANCE
// Path 1 is exact: clear every >75-day balance.
// Path 2 places a hypothetical payment in the current 30-day bucket.
// This both reduces outstanding and improves the highest-weighted velocity.
// ============================================================
// *** V2.0 *** REBUILT, AND THEN REBUILT AGAIN THE SAME DAY.
// ------------------------------------------------------------
// The first attempt declared that a payment made today cannot move
// the settled average, because it is a record of bills already
// closed. THE OWNER POINTED OUT THAT THIS IS WRONG, and it is:
// paying today CLOSES bills, and those bills join the settled sample
// immediately, with a settlement time equal to their age today.
//
// So the honest answer is not "impossible" - it is a measurement.
// But it cannot be found by bisection, because the settled average
// is NOT monotone in the payment. Money is applied oldest-first, so
// the first bills closed are the OLDEST, and a 100-day-old bill
// closed today enters the sample AT 100 DAYS and pushes the average
// UP. Only as younger bills follow does it come back down. The curve
// rises, then falls; a bisection would walk off it.
//
// Hence a SCAN, bill by bill, which is also the right granularity:
// a part payment does not close a bill, so only whole bills change
// the settled side. Each step asks the real question - "if the
// oldest k bills were cleared today, what would this dealer's APD
// be?" - and the first k that clears 75 is the answer.
//
// Cost: at most 80 x 80 comparisons on a customer, once. Nothing
// compared to the API reads above.
// ------------------------------------------------------------
apdRecoveryAmount = 0.0;
apdRecoveryPossible = false;
apdRecoveryBills = 0;
apdRecoveryBlockedBySettled = false;
if(apdPass == false && openBalanceTotal > 0)
{
	// Sort the open items oldest first, once.
	recoverySorted = List();
	recoveryLastAge = 1000000;
	for each  recoveryRound in sortRoundList
	{
		if(recoverySorted.size() < openItemsList.size())
		{
			recoveryNextAge = -1;
			for each  recoveryCandidate in openItemsList
			{
				if(recoveryCandidate.get("age_days") < recoveryLastAge && recoveryCandidate.get("age_days") > recoveryNextAge)
				{
					recoveryNextAge = recoveryCandidate.get("age_days");
				}
			}
			if(recoveryNextAge >= 0)
			{
				for each  recoveryTaker in openItemsList
				{
					if(recoveryTaker.get("age_days") == recoveryNextAge)
					{
						recoverySorted.add(recoveryTaker);
					}
				}
				recoveryLastAge = recoveryNextAge;
			}
		}
	}
	// Walk the sorted list, clearing one more bill each round.
	scanCumulativePayment = 0.0;
	scanSettledWeighted = paidWeightedDaysPrimary;
	scanSettledWeight = paidWeightPrimary;
	scanBillsCleared = 0;
	for each  scanItem in recoverySorted
	{
		if(apdRecoveryPossible == false)
		{
			scanCumulativePayment = scanCumulativePayment + scanItem.get("balance").toDecimal();
			scanBillsCleared = scanBillsCleared + 1;
			// This bill closes TODAY, so it settled in exactly its
			// current age - and it joins the settled sample weighted
			// by its total, the same way every other settled bill is.
			scanItemAge = scanItem.get("age_days").toDecimal();
			scanItemTotal = scanItem.get("balance").toDecimal();
			if(scanItem.get("total") != null)
			{
				scanItemTotal = scanItem.get("total").toDecimal();
			}
			scanSettledWeighted = scanSettledWeighted + scanItemAge * scanItemTotal;
			scanSettledWeight = scanSettledWeight + scanItemTotal;
			scanSettledAPD = -1.0;
			if(scanSettledWeight > 0)
			{
				scanSettledAPD = scanSettledWeighted / scanSettledWeight;
			}
			// What is left open, re-aged.
			scanPendingWeighted = 0.0;
			scanPendingTotal = 0.0;
			scanIndex = 0;
			for each  scanRemaining in recoverySorted
			{
				scanIndex = scanIndex + 1;
				if(scanIndex > scanBillsCleared)
				{
					scanRemainingBalance = scanRemaining.get("balance").toDecimal();
					scanPendingWeighted = scanPendingWeighted + scanRemaining.get("age_days").toDecimal() * scanRemainingBalance;
					scanPendingTotal = scanPendingTotal + scanRemainingBalance;
				}
			}
			scanPendingAPD = -1.0;
			if(scanPendingTotal > 0)
			{
				scanPendingAPD = scanPendingWeighted / scanPendingTotal;
			}
			// The same max() the qualification uses. No other rule.
			scanRiskAPD = scanSettledAPD;
			if(scanPendingAPD > scanRiskAPD)
			{
				scanRiskAPD = scanPendingAPD;
			}
			if(scanRiskAPD >= 0 && scanRiskAPD < apdTargetDays)
			{
				apdRecoveryPossible = true;
				apdRecoveryAmount = scanCumulativePayment.round(currencyPrecision);
				apdRecoveryBills = scanBillsCleared;
			}
		}
	}
	if(apdRecoveryPossible == false)
	{
		// Every bill on the account cleared today and the settled
		// average still does not come under the line. That is the
		// case the first version assumed was the only one.
		apdRecoveryBlockedBySettled = true;
	}
}
// 10. DUPLICATE CHECK. Summary response is sufficient because the
// live AUTO-CD engine stores its marker in the CN reason field.
// ============================================================
duplicateTODFound = false;
existingTODCNNumber = "";
hasMoreDuplicateCN = true;
for each  duplicatePageNo in pageList
{
	if(hasMoreDuplicateCN == true)
	{
		duplicateResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes?organization_id=" + organizationID + "&customer_id=" + customerID + "&per_page=200&page=" + duplicatePageNo
			type :GET
			connection:"zerp"
		];
		if(duplicateResp != null && duplicateResp.containsKey("code") && duplicateResp.get("code") == 0)
		{
			duplicateCNList = duplicateResp.get("creditnotes");
			if(duplicateCNList != null)
			{
				for each  duplicateCN in duplicateCNList
				{
					duplicateReason = duplicateCN.get("reason");
					duplicateReference = duplicateCN.get("reference_number");
					if(duplicateReason == null)
					{
						duplicateReason = "";
					}
					if(duplicateReference == null)
					{
						duplicateReference = "";
					}
					duplicateStatus = duplicateCN.get("status");
					if(duplicateStatus != "void" && (duplicateReason.contains(uniqueTODMarker) || duplicateReference.contains(uniqueTODMarker)))
					{
						duplicateTODFound = true;
						existingTODCNNumber = duplicateCN.get("creditnote_number");
					}
				}
			}
			duplicatePageContext = duplicateResp.get("page_context");
			if(duplicatePageContext == null || duplicatePageContext.get("has_more_page") != true)
			{
				hasMoreDuplicateCN = false;
			}
		}
		else
		{
			fatalReadError = true;
			creditNoteReadErrorCount = creditNoteReadErrorCount + 1;
			hasMoreDuplicateCN = false;
		}
	}
}
if(hasMoreDuplicateCN == true)
{
	fatalReadError = true;
	info "ERROR: More than 3,000 credit notes in duplicate check. Posting blocked.";
}
// ============================================================
// 11. COMPLETE REPORT BEFORE ANY FINANCIAL ACTION
// ============================================================
info "========================================";
info "TOD CALCULATION SUMMARY";
info "Gross eligible sales : Rs " + grossEligibleSales;
info "Eligible product returns : Rs " + eligibleReturns;
info "Net eligible purchase : Rs " + netEligiblePurchase;
info "Final slab : " + finalTodSlab + " | " + finalTodPct + "% | Grace: " + graceApplied;
info "Calculated TOD : Rs " + calculatedTOD;
info "----------------------------------------";
info "APD payments in the rolling 180-day window: Rs " + totalPayments;
// FIX: Audit logs updated to reflect 40/40 weights
info "Last 30 days: Rs " + recent30Payments + " | daily Rs " + recentDailyVelocity + " | weight 40%";
info "Days 31-90: Rs " + middle31to90Payments + " | daily Rs " + middleDailyVelocity + " | weight 40%";
info "Older bucket (91 days and back): Rs " + olderFYPayments + " | daily Rs " + olderDailyVelocity + " | weight 20%";
info "Trend-weighted daily payment velocity: Rs " + dailyPaymentVelocity;
info "TREND-WEIGHTED APD : " + averagePaymentDays + " days";
info "APD < 75 pass : " + apdPass;
info "0-60 outstanding : Rs " + balance0to60;
info "61-75 outstanding : Rs " + balance61to75;
info ">75 outstanding : Rs " + balanceAbove75;
info "No >75 outstanding pass : " + noOver75Pass;
info "FINAL PAYMENT ELIGIBILITY (APD OR no >75): " + paymentEligibilityPass;
if(paymentEligibilityPass == false)
{
	// The per-invoice "PAY FIRST" breakdown that used to print here was
	// removed on the owner's instruction, 2026-08-18. It listed every
	// invoice aged past 75 days - eleven lines for DEALER-B alone -
	// and the only number anyone acts on is the total on the line above.
	// over75InvoiceList is still built, so restoring the breakdown is a
	// matter of putting the loop back; nothing else depends on it.
	info "RECOVERY PATH 1 - pay >75 invoices: Rs " + paymentToClearAbove75 + " across " + over75InvoiceList.size() + " invoice(s)";
	if(apdRecoveryPossible == true)
	{
		info "RECOVERY PATH 2 - clear the " + apdRecoveryBills + " oldest bill(s), Rs " + apdRecoveryAmount + ", and the APD comes under " + apdTargetDays + " days. (Those bills close today, so they enter the settled average at their present age - that is already counted in this figure.)";
	}
	else if(apdRecoveryBlockedBySettled == true)
	{
		info "RECOVERY PATH 2 - not available. Even clearing EVERY open bill today leaves the settled average past " + apdTargetDays + " days, because bills closed today enter that average at their present age. Path 1 is the route, and the lasting fix is settling next quarter's bills faster.";
	}
	else
	{
		info "RECOVERY PATH 2 - no open document could be aged, so no payment figure can be worked out. Path 1 is the route.";
	}
}
if(fatalReadError == true)
{
	info "SAFETY: One or more required API reads failed/incomplete. Posting is blocked.";
}
if(duplicateTODFound == true)
{
	info "DUPLICATE: TOD CN already exists: " + existingTODCNNumber;
}
// ============================================================
// 12. POST ONLY IN THE 01-OCT TO 10-OCT WINDOW
// ============================================================
canCreateTOD = true;
if(runMode != "POSTING WINDOW")
{
	canCreateTOD = false;
	info "NO POST: Run mode is " + runMode + ".";
}
if(fatalReadError == true || duplicateTODFound == true || calculatedTOD <= 0 || paymentEligibilityPass == false)
{
	canCreateTOD = false;
}
createdTODCNID = "";
createdTODCNNumber = "";
if(canCreateTOD == true)
{
	qualificationRule = "NONE";
	if(apdPass == true && noOver75Pass == true)
	{
		qualificationRule = "APD AND NO-OVER-75";
	}
	else if(apdPass == true)
	{
		qualificationRule = "APD";
	}
	else if(noOver75Pass == true)
	{
		qualificationRule = "NO-OVER-75";
	}
	// Permanent audit snapshot: this remains attached to the financial CN.
	todDescription = "Quarterly TOD | " + quarterName + " | Net Rs " + netEligiblePurchase.round(currencyPrecision) + " | Returns Rs " + eligibleReturns.round(currencyPrecision) + " | " + finalTodSlab + " | " + finalTodPct + "% | APD " + averagePaymentDays.round(currencyPrecision) + " | >75 Rs " + balanceAbove75.round(currencyPrecision) + " | Eligible by " + qualificationRule + " | Run " + runDateStr + " | V2.0 | " + uniqueTODMarker;
	todLine = Map();
	todLine.put("name","Quarterly TOD - " + quarterName);
	todLine.put("description",todDescription);
	todLine.put("account_id",todAccountID);
	todLine.put("quantity",1);
	todLine.put("rate",calculatedTOD);
	todLines = List();
	todLines.add(todLine);
	todCNMap = Map();
	todCNMap.put("customer_id",customerID);
	todCNMap.put("date",runDateStr);
	todCNMap.put("reason","Quarterly TOD | " + quarterName + " | " + uniqueTODMarker);
	todCNMap.put("reference_number",uniqueTODMarker);
	todCNMap.put("line_items",todLines);
	todCNParams = Map();
	todCNParams.put("JSONString",todCNMap.toString());
	createTODResp = invokeurl
	[
		url :apiEndPoint + "/creditnotes?organization_id=" + organizationID
		type :POST
		parameters:todCNParams
		connection:"zerp"
	];
	if(createTODResp != null && createTODResp.containsKey("code") && createTODResp.get("code") == 0 && createTODResp.get("creditnote") != null)
	{
		createdTODCNID = createTODResp.get("creditnote").get("creditnote_id");
		createdTODCNNumber = createTODResp.get("creditnote").get("creditnote_number");
		info "SUCCESS: TOD CN created: " + createdTODCNNumber;
	}
	else
	{
		info "ERROR: TOD CN creation failed. No allocation was attempted.";
		info createTODResp;
	}
}
// ============================================================
// 13. APPLY ONLY TO 61-75 DAY INVOICES, OLDEST FIRST.
// One bulk request is faster and avoids partial per-invoice posting.
// Balances >75 are never auto-adjusted; any unused TOD remains credit.
// ============================================================
if(createdTODCNID != "" && adjustmentInvoiceList.size() > 0)
{
	applyInvoiceList = List();
	remainingTODCredit = calculatedTOD;
	for each  applyAge in {75,74,73,72,71,70,69,68,67,66,65,64,63,62,61}
	{
		if(remainingTODCredit > 0)
		{
			for each  adjustmentInvoice in adjustmentInvoiceList
			{
				if(adjustmentInvoice.get("age_days") == applyAge && remainingTODCredit > 0)
				{
					adjustBalance = adjustmentInvoice.get("balance").toDecimal();
					applyAmount = adjustBalance;
					if(remainingTODCredit < adjustBalance)
					{
						applyAmount = remainingTODCredit;
					}
					applyAmount = applyAmount.round(currencyPrecision);
					if(applyAmount > 0)
					{
						applyMap = Map();
						applyMap.put("invoice_id",adjustmentInvoice.get("invoice_id"));
						applyMap.put("amount_applied",applyAmount);
						applyInvoiceList.add(applyMap);
						remainingTODCredit = (remainingTODCredit - applyAmount).round(currencyPrecision);
					}
				}
			}
		}
	}
	if(applyInvoiceList.size() > 0)
	{
		applyPayload = Map();
		applyPayload.put("invoices",applyInvoiceList);
		applyParams = Map();
		applyParams.put("JSONString",applyPayload.toString());
		applyResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes/" + createdTODCNID + "/invoices?organization_id=" + organizationID
			type :POST
			parameters:applyParams
			connection:"zerp"
		];
		if(applyResp != null && applyResp.containsKey("code") && applyResp.get("code") == 0)
		{
			info "SUCCESS: TOD applied to 61-75 day invoices. Unused customer credit: Rs " + remainingTODCredit;
		}
		else
		{
			info "CRITICAL WARNING: TOD CN exists but its allocation failed. Review manually; no retry was made.";
			info applyResp;
		}
	}
}
else if(createdTODCNID != "")
{
	info "TOD CN remains entirely as unused customer credit.";
}
// ============================================================
// 13. THE DEALER'S COPY  (V2.0, owner's instruction 2026-09-01)
// ------------------------------------------------------------
// Everything above is the working. This block is the only part meant
// to leave the office, so it carries no internal words at all - no
// APD, no velocity, no buckets. A dealer should be able to read it
// once and know three things: what the scheme pays, what they earned,
// and what to do about it.
//
// It states the whole rule, not a simplified one. If this block and
// the working above ever disagree, THIS BLOCK IS WRONG and must be
// fixed - never the other way round.
//
// The release amount is the CHEAPER of the two routes, because the
// dealer is being asked for money and there is no honest reason to
// quote the larger one. The other is shown so nothing looks hidden.
// ============================================================
releaseAmount = paymentToClearAbove75;
releaseAction = "clear every bill older than 75 days";
releaseOtherAmount = 0.0;
releaseOtherAction = "";
if(apdRecoveryPossible == true)
{
	if(apdRecoveryAmount < paymentToClearAbove75)
	{
		releaseAmount = apdRecoveryAmount;
		releaseAction = "clear your " + apdRecoveryBills + " oldest bill(s)";
		releaseOtherAmount = paymentToClearAbove75;
		releaseOtherAction = "clear every bill older than 75 days";
	}
	else
	{
		releaseOtherAmount = apdRecoveryAmount;
		releaseOtherAction = "clear your " + apdRecoveryBills + " oldest bill(s)";
	}
}
info " ";
info "============================================================";
info "   SEND EVERYTHING BELOW THIS LINE TO THE DEALER";
info "============================================================";
info "ACME DISTRIBUTION";
info "TURNOVER DISCOUNT SCHEME - " + quarterName;
info "Dealer : " + customerName;
info " ";
info "THE SLABS - on your net purchases for the quarter";
info "   Rs 50,000 and above      0.75%";
info "   Rs 1,00,000 and above    1.25%";
info "   Rs 2,00,000 and above    2.00%";
info "   Rs 3,50,000 and above    3.00%";
info "   Rs 5,00,000 and above    4.25%";
info "   Rs 7,50,000 and above    5.75%";
info "   Rs 10,00,000 and above   7.50%";
info " ";
info "TWO THINGS MUST BOTH BE TRUE TO EARN IT";
info "   1. Your net purchases reach one of the slabs above.";
info "   2. Your payments are up to date - meaning EITHER your bills";
info "      clear in under 75 days on average, OR you have nothing";
info "      outstanding older than 75 days.";
info " ";
info "YOUR QUARTER";
info "   Purchases        Rs " + grossEligibleSales.round(currencyPrecision);
info "   Less returns     Rs " + eligibleReturns.round(currencyPrecision);
info "   Net purchases    Rs " + netEligiblePurchase.round(currencyPrecision);
info "   Your slab        " + finalTodSlab + "  =  " + finalTodPct + "%";
info "   Discount         Rs " + calculatedTOD.round(currencyPrecision);
info " ";
if(calculatedTOD <= 0)
{
	info "STATUS : NOT EARNED - purchases did not reach the first slab.";
}
else if(paymentEligibilityPass == true)
{
	info "STATUS : EARNED. Rs " + calculatedTOD.round(currencyPrecision) + " will be issued as a credit note to your account.";
}
else
{
	info "STATUS : ON HOLD - condition 2 is not met.";
	info "   Your bills are taking " + averagePaymentDays + " days on average to clear.";
	info "   You have Rs " + balanceAbove75.round(currencyPrecision) + " outstanding beyond 75 days.";
	info " ";
	info "TO RELEASE IT, PAY Rs " + releaseAmount.round(currencyPrecision) + " - " + releaseAction + ".";
	if(releaseOtherAmount > 0)
	{
		info "   (The other way is Rs " + releaseOtherAmount.round(currencyPrecision) + " - " + releaseOtherAction + ". Either works; the amount above is the smaller one.)";
	}
	info "   Always pay your oldest bills first.";
}
info "============================================================";
info "========================================";
info "ACME QUARTERLY TOD + APD ENGINE END";
info "========================================";