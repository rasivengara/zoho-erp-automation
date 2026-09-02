// ============================================================
// AUTO INVOICE EVENT HANDLER  -  v2.0
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Workflow function
// Trigger      Invoices - Created or Edited; Invoices - Deleted
//              (a VOID arrives through Edited; there is no
//              separate Void action type)
// Input        invoice               Connection  "zerp"
// Writes       Nothing directly - it INVOKES the other engines,
//              plus a cash-discount pull-back on void/delete
// ------------------------------------------------------------
// WHAT IT DOES, AND WHY IT DOES SO LITTLE
//   1. When a bill is raised or its total changes, it refreshes
//      that customer's credit limit, Minimum Payment Today and
//      overdue aging immediately, instead of leaving them stale
//      until the next morning's batch.
//   2. When an invoice is voided or deleted, it pulls back the
//      cash discount that invoice earned. Nothing else can reach
//      that case.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - Nothing when a PAYMENT caused the event. The payment-side
//     scripts already handle that in real time; repeating it here
//     would double the API cost of every payment against a rate
//     limit that throttles the whole organisation.
//   - Nothing on a DRAFT. A draft is not a receivable.
//   - It does not REIMPLEMENT the limit or the aging - it calls
//     the real engines. A cached copy was designed and abandoned:
//     a second copy of a measurement drifts from the first, and
//     this project has already paid that price once.
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
// ACME AUTO INVOICE EVENT HANDLER - V2.0   (2026-08-18)
// Workflow input: invoice | Connection: zerp
// Function name: auto_invoice_event
//
// *** TWO WORKFLOW RULES, NOT THREE ***
//   Invoices - Created or Edited -> this function
//   Invoices - Deleted           -> this function
// "Created or Edited" is a single Action Type in this org, seen on
// the dropdown 2026-08-18. There is NO "Void" action type - a void
// arrives through Edited, which PROBE D proved on live data.
//
// *** SHIPPED WITH dryRun = true. IT WRITES NOTHING UNTIL THAT LINE
// IS CHANGED. *** Run it in shadow first, exactly as the cash-discount
// merge was run, and read the logs before letting it touch anything.
//
// ============================================================
// WHAT THIS DOES, AND WHY IT DOES SO LITTLE
// ============================================================
// It does TWO jobs:
//
//  1. WHEN A BILL IS RAISED, or its total changes, it refreshes that
//     customer's credit limit, Min Payment Today and Overdue Aging
//     immediately - by CALLING THE EXISTING ENGINES, not by copying
//     them. Before V2.0 those numbers stayed stale until the next
//     morning's batch, up to 21 hours. This was the main thing the
//     handler was asked for.
//
//  2. WHEN AN INVOICE IS VOIDED OR DELETED, it pulls back the cash
//     discount that invoice earned. Nothing else can reach that case.
//
// Everything it does NOT do is deliberate, and worth reading before
// anyone widens it.
//
// WHAT IT DOES NOT DO, AND WHY
//   - It does not touch anything when a PAYMENT caused the event.
//     auto_cd_unified, auto_overdue_aging and auto_credit_limit_engine
//     already fire on the Customer Payment side, in real time and
//     correctly - seen live in the 11:59 log of 2026-08-18. Repeating
//     that here would double the cost of every payment in the org
//     against a rate limit that blocks the whole organisation.
//   - It does not touch a DRAFT. A draft is not a receivable, it sits
//     outside outstanding_receivable_amount, and roughly half of all
//     invoice events in this org are drafts.
//   - It does not REIMPLEMENT the limit or the aging. It invokes the
//     real engines. A cached copy was designed and abandoned: the
//     limit needs about twelve payment-derived inputs, pdcTrustFactor
//     cannot be cached at all because it moves with APD, and MIN
//     PAYMENT TODAY is a bisection solve that rebuilds the whole limit
//     inside its loop. That copy would have been A THIRD COPY OF THE
//     ENGINE, and QUARTERLY TOD already showed the price - it carried
//     the April bug for four versions after it was fixed everywhere
//     else, because it was a second copy of the same measurement.
//     Calling the real engine cannot drift from the real engine.
//
// ACCEPTED GAP, STATED PLAINLY RATHER THAN DESIGNED AROUND:
// an invoice that is already PARTIALLY PAID and then has its total
// edited is skipped here, and picked up by the morning batch within
// 24 hours. Editing an already part-paid bill is rare; the
// alternative is repeating every payment's work for the whole org.
//
// ============================================================
// WHAT PROBE D ESTABLISHED, ALL LIVE ON 2026-08-18
// ============================================================
//  1. The Created rule fires while an invoice is still a DRAFT, and a
//     draft is not a receivable. Roughly half of all invoice events
//     in this org are drafts. They must cost nothing.
//  2. Marking a draft as Sent fires its own event.
//  3. Voiding fires an event, and the status reads "void" live.
//  4. Deleting fires an event, the payload is COMPLETE - customer_id,
//     invoice_number, total, line items, all 72 keys - and a deleted
//     invoice answers code 1002 on a GET. Identical to a deleted
//     payment, so one proven pattern covers both modules.
//  5. A payment landing fires ONE event. Applying a credit note fires
//     NOTHING. So this handler's own credit-note work cannot re-enter
//     it. There is no loop.
//  6. *** THE PAYLOAD IS ACCURATE ON A DIRECT CHANGE AND A STALE
//     SNAPSHOT ON AN INDIRECT ONE. *** On the payment event it said
//     partially_paid and balance 300 while the invoice was really
//     paid at balance 0. So NOTHING below decides from a payload
//     figure. The payload supplies identifiers and nothing else.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================
// dryRun = true decides everything and logs exactly what it WOULD do,
// while writing nothing at all.
dryRun = true;

// How many credit notes may be opened in full to hunt for a legacy
// marker hidden in line items. Only spent when no current-format
// discount was found, and only on a void or a delete, which are rare.
cdDetailReadCap = 15;

organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
apiCallCount = 0;

// ---- IDENTIFIERS ONLY, never figures ----
invoiceID = invoice.get("invoice_id");
customerID = invoice.get("customer_id");
invoiceNumber = invoice.get("invoice_number");
customerName = invoice.get("customer_name");
if(invoiceNumber == null)
{
	invoiceNumber = "";
}
if(customerName == null)
{
	customerName = "Unknown Customer";
}
payloadStatus = "";
if(invoice.get("status") != null)
{
	payloadStatus = invoice.get("status");
}
info "========================================";
info "ACME AUTO INVOICE EVENT HANDLER V2.0";
info "Invoice : " + invoiceNumber + " | Customer : " + customerName + " | Payload status : " + payloadStatus;
if(dryRun == true)
{
	info "*** DRY RUN - NOTHING WILL BE WRITTEN ***";
}
info "========================================";
if(invoiceID == null || invoiceID == "" || customerID == null || customerID == "")
{
	info "ERROR: invoice id or customer id missing from the event. Stopped.";
	info "========================================";
	return;
}
// ============================================================
// STEP 1 - WHICH EVENT IS THIS?
// Zoho does not say, so this asks the data - the same question
// auto_cd_unified asks about a payment, and the same answer: a
// deleted record no longer exists.
// The LIVE status decides, never the payload's copy of it.
// ============================================================
mode = "";
liveStatus = "";
liveResp = invokeurl
[
	url :apiEndPoint + "/invoices/" + invoiceID + "?organization_id=" + organizationID
	type :GET
	connection:"zerp"
];
apiCallCount = apiCallCount + 1;
if(liveResp != null && liveResp.containsKey("code") && liveResp.get("code") == 0 && liveResp.get("invoice") != null)
{
	if(liveResp.get("invoice").get("status") != null)
	{
		liveStatus = liveResp.get("invoice").get("status");
	}
	if(liveStatus == "void")
	{
		mode = "VOID";
	}
	else if(liveStatus == "draft")
	{
		mode = "DRAFT";
	}
	else if(liveStatus == "partially_paid" || liveStatus == "paid")
	{
		// A payment caused this. The Customer Payment rules have
		// already refreshed everything correctly and in real time -
		// doing it again here would double the cost of every payment
		// in the org against a rate limit that blocks the whole
		// organisation for a minute when it trips.
		mode = "STANDDOWN";
	}
	else
	{
		mode = "LIVE";
	}
}
else
{
	liveCode = "no response";
	if(liveResp != null && liveResp.containsKey("code"))
	{
		liveCode = liveResp.get("code").toString();
	}
	if(liveCode == "1002")
	{
		mode = "DELETE";
	}
	else
	{
		// Anything else is a FAILED READ, not a deletion. Guessing
		// which one it is would be exactly the mistake this project
		// keeps finding, so it stops and says so.
		info "SAFETY BLOCK: the invoice could not be read, and the response was not the code 1002 that means deleted - it was " + liveCode + ". Nothing was done. If this invoice really was voided or deleted, its cash discount may still be standing: check it by hand.";
		info "TOTAL API CALLS : " + apiCallCount;
		info "========================================";
		return;
	}
}
info "MODE : " + mode + " (live status is '" + liveStatus + "')";
// ============================================================
// STEP 2 - THE CHEAP EXITS
// Two of the four outcomes stop here having spent ONE API call.
// Between them they are the large majority of all invoice events in
// this org, and that is the whole reason this handler is affordable
// to run on every one of them.
// ============================================================
if(mode == "DRAFT")
{
	info "A draft is not a receivable - it sits outside outstanding_receivable_amount and every script in this suite skips it. Nothing to do.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
if(mode == "STANDDOWN")
{
	info "A payment caused this event. auto_cd_unified, auto_overdue_aging and auto_credit_limit_engine have already run on the Customer Payment side and done it correctly. Standing down.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
if(mode == "LIVE")
{
	// ============================================================
	// *** V2.0 - THE POINT OF THE WHOLE HANDLER ***
	// A bill has just been raised, or its total has just changed.
	// The customer now owes more than the credit limit and the
	// collection figure on their record were calculated against, and
	// until this existed those numbers stayed stale until the 07:00
	// batch the next morning - up to 21 hours. If a dealer sitting
	// near their limit is billed a large invoice in the morning, the
	// COLLECT TODAY figure the staff read all day is UNDERSTATED.
	// That was the single most important thing this handler was asked
	// for, and V1.0 did not do it.
	//
	// *** IT DOES NOT REIMPLEMENT ANYTHING. IT CALLS THE ENGINES
	// THEMSELVES. ***
	// auto_credit_limit_engine and auto_overdue_aging both take a
	// workflow payload and read exactly ONE thing out of it -
	//     customer_payment.get("customer_id")
	// - which is why a Map carrying just that key is enough to drive
	// them. So there is ONE implementation of the limit and ONE of
	// the aging, called from three places: the payment rules, the
	// morning batches, and here.
	//
	// That matters more than it looks. A cached reimplementation was
	// designed and abandoned precisely because it would have been a
	// THIRD COPY of the engine, and QUARTERLY TOD already showed what
	// a second copy costs - it carried the April bug for four
	// versions after it was fixed everywhere else. Calling the real
	// engine cannot drift from the real engine.
	//
	// COST, and it is not small: the credit engine is 15-20 API calls
	// and the aging another 4-6. That is spent ONCE per invoice, on
	// the sent event only - drafts return above, and payment-driven
	// events stand down. Watch the log during a billing burst; if
	// error code 44 ever appears, the answer is to move this to the
	// TIME-BASED action on the workflow rule rather than the
	// immediate one, so Zoho spaces the runs itself.
	// ============================================================
	if(dryRun == true)
	{
		info "DRY RUN - would refresh this customer now by invoking auto_credit_limit_engine and auto_overdue_aging. Nothing written.";
	}
	else
	{
		refreshPayload = Map();
		refreshPayload.put("customer_id",customerID);
		// THREE arguments, not one. Zoho generates the wrapper
		//     void auto_credit_limit_engine( Map customer_payment ,
		//                Map organization , Map user )
		// for a Customer Payment workflow function, exactly as it
		// generated (Map invoice, Map organization, Map user) for this
		// one. Passing a single map fails at paste time with
		// "No. of arguments mismatch". organization and user are this
		// function's own arguments, so they are simply handed through -
		// and the engines want the same organization map anyway, since
		// that is where they read organization_id and
		// api_root_endpoint from.
		thisapp.auto_credit_limit_engine(refreshPayload,organization,user);
		info "Invoked auto_credit_limit_engine for this customer - credit limit, Min Payment Today and Average Payment Days are now current.";
		thisapp.auto_overdue_aging(refreshPayload,organization,user);
		info "Invoked auto_overdue_aging for this customer - the Overdue Aging field is now current.";
	}
	info "TOTAL API CALLS : " + apiCallCount + " here, plus whatever the two engines spent (see their own log lines).";
	info "========================================";
	return;
}
// ============================================================
// STEP 3 - VOID OR DELETE: FIND THE CASH DISCOUNT
// The marker is matched EXACTLY, never with "contains" -
// "CD/ACME-INV-108" is a substring of "CD/ACME-INV-1080", and
// contains would confuse two different invoices.
// ============================================================
if(invoiceNumber == "")
{
	info "MANUAL REVIEW NEEDED: this event carried no invoice_number, so the marker CD/<number> cannot be built. Check by hand whether this invoice had a discount.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
ourMarker = "CD/" + invoiceNumber;
legacyMarker = "AUTO-CD-" + invoiceID;
matchedCNID = "";
matchedCNNumber = "";
matchedCNTotal = 0.0;
legacyFound = false;
legacyCNNumber = "";
searchFailed = false;
candidateIDs = List();
cnPageList = {1,2,3,4,5,6,7,8,9,10};
hasMoreCN = true;
for each  cnPage in cnPageList
{
	if(hasMoreCN == true)
	{
		cnResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes?organization_id=" + organizationID + "&customer_id=" + customerID + "&per_page=200&page=" + cnPage
			type :GET
			connection:"zerp"
		];
		apiCallCount = apiCallCount + 1;
		if(cnResp != null && cnResp.containsKey("code") && cnResp.get("code") == 0)
		{
			cnList = cnResp.get("creditnotes");
			if(cnList != null)
			{
				for each  cnItem in cnList
				{
					cnStatus = cnItem.get("status");
					cnRef = cnItem.get("reference_number");
					cnID = cnItem.get("creditnote_id");
					cnNumber = cnItem.get("creditnote_number");
					if(cnStatus != "void" && cnID != null && cnID != "")
					{
						if(cnRef != null && cnRef == ourMarker)
						{
							matchedCNID = cnID;
							matchedCNNumber = cnNumber;
							if(cnItem.get("total") != null)
							{
								matchedCNTotal = cnItem.get("total").toDecimal();
							}
						}
						else if(cnRef != null && cnRef == legacyMarker)
						{
							// Legacy format 1 - marker in the reference.
							// Free to spot, and left alone by the rule.
							legacyFound = true;
							legacyCNNumber = cnNumber;
						}
						else
						{
							// May carry a legacy marker in its LINE ITEMS
							// only. Collected now, opened later and only
							// if nothing better turns up.
							candidateIDs.add(cnID);
						}
					}
				}
			}
			cnCtx = cnResp.get("page_context");
			if(cnCtx == null || cnCtx.get("has_more_page") != true)
			{
				hasMoreCN = false;
			}
		}
		else
		{
			searchFailed = true;
			hasMoreCN = false;
			info "ERROR: the credit note search failed for this customer.";
		}
	}
}
if(searchFailed == true)
{
	info "MANUAL REVIEW NEEDED: the credit note list could not be read, so it cannot be proved whether " + invoiceNumber + " carried a cash discount. NOTHING was touched - an incomplete search is not evidence of absence. Check by hand.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
// Legacy hunt in line items - only when no current-format note was
// found, because a current-format match already settles the question.
if(matchedCNID == "" && legacyFound == false)
{
	detailReads = 0;
	for each  candidateID in candidateIDs
	{
		if(detailReads < cdDetailReadCap && legacyFound == false)
		{
			detailReads = detailReads + 1;
			candDetailResp = invokeurl
			[
				url :apiEndPoint + "/creditnotes/" + candidateID + "?organization_id=" + organizationID
				type :GET
				connection:"zerp"
			];
			apiCallCount = apiCallCount + 1;
			if(candDetailResp != null && candDetailResp.containsKey("code") && candDetailResp.get("code") == 0 && candDetailResp.get("creditnote") != null)
			{
				candDetail = candDetailResp.get("creditnote");
				candItems = candDetail.get("line_items");
				if(candItems != null)
				{
					for each  candItem in candItems
					{
						candText = "";
						if(candItem.get("description") != null)
						{
							candText = candItem.get("description").toString();
						}
						if(candItem.get("name") != null)
						{
							candText = candText + " " + candItem.get("name").toString();
						}
						if(candText.contains(legacyMarker))
						{
							legacyFound = true;
							legacyCNNumber = candDetail.get("creditnote_number");
						}
					}
				}
			}
		}
	}
	info "Legacy line-item scan : " + detailReads + " credit note(s) opened, cap " + cdDetailReadCap + ".";
}
// ============================================================
// STEP 4 - ACT
// ============================================================
if(legacyFound == true && matchedCNID == "")
{
	// THE LEGACY RULE - the owner's decision, 2026-08-18. Old credit
	// notes have already been sent to customers and sit in their
	// ledgers. Moving one now is a credibility problem, not a
	// technical one, so this reports it and stops.
	info "LEGACY CD PRESENT - MANUAL REVIEW : " + invoiceNumber + " carries an old-format cash discount (" + legacyCNNumber + "). By the legacy rule it was NOT touched. If this " + mode + " should reverse it, do that by hand.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
if(matchedCNID == "")
{
	info "No cash discount stands against " + invoiceNumber + ". Nothing to reverse.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
info "FOUND : credit note " + matchedCNNumber + " for Rs " + matchedCNTotal + " against " + invoiceNumber + ". It must be reversed because the invoice was " + mode + "ED.";
if(dryRun == true)
{
	info "DRY RUN - would unapply, void and delete " + matchedCNNumber + ". Nothing written.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
// -------- unapply, then void, then delete --------------------
// Exactly the sequence auto_cd_unified uses and has proved on live
// money. A credit note cannot be voided while it is still applied.
reverseBlocked = false;
cnDetailResp = invokeurl
[
	url :apiEndPoint + "/creditnotes/" + matchedCNID + "?organization_id=" + organizationID
	type :GET
	connection:"zerp"
];
apiCallCount = apiCallCount + 1;
if(cnDetailResp == null || cnDetailResp.containsKey("code") == false || cnDetailResp.get("code") != 0 || cnDetailResp.get("creditnote") == null)
{
	info "MANUAL REVIEW NEEDED: could not read Credit Note " + matchedCNNumber + ". Void it by hand if appropriate.";
	reverseBlocked = true;
}
else
{
	cnDetail = cnDetailResp.get("creditnote");
	appliedInvoices = cnDetail.get("invoices_credited");
	if(appliedInvoices != null && appliedInvoices.size() > 0)
	{
		for each  appliedEntry in appliedInvoices
		{
			appliedToInvoiceID = appliedEntry.get("invoice_id");
			creditNoteInvoiceID = appliedEntry.get("creditnote_invoice_id");
			if(creditNoteInvoiceID == null || creditNoteInvoiceID == "")
			{
				reverseBlocked = true;
			}
			else if(reverseBlocked == false)
			{
				unapplyResp = invokeurl
				[
					url :apiEndPoint + "/creditnotes/" + matchedCNID + "/invoices/" + creditNoteInvoiceID + "?organization_id=" + organizationID
					type :DELETE
					connection:"zerp"
				];
				apiCallCount = apiCallCount + 1;
				if(unapplyResp == null || unapplyResp.containsKey("code") == false || unapplyResp.get("code") != 0)
				{
					reverseBlocked = true;
					info "ERROR: could not unapply from invoice " + appliedToInvoiceID + ".";
				}
				else
				{
					info "Unapplied from invoice " + appliedToInvoiceID + ".";
				}
			}
		}
	}
	else
	{
		info "The credit note is not applied to anything, so it can be voided directly.";
	}
}
if(reverseBlocked == true)
{
	info "MANUAL REVIEW NEEDED: could not safely unwind Credit Note " + matchedCNNumber + ". It was NOT voided - please review it by hand.";
}
else
{
	voidResp = invokeurl
	[
		url :apiEndPoint + "/creditnotes/" + matchedCNID + "/status/void?organization_id=" + organizationID
		type :POST
		connection:"zerp"
	];
	apiCallCount = apiCallCount + 1;
	if(voidResp != null && voidResp.containsKey("code") && voidResp.get("code") == 0)
	{
		info "SUCCESS: Credit Note " + matchedCNNumber + " voided - the cash discount on " + invoiceNumber + " is reversed.";
		deleteResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes/" + matchedCNID + "?organization_id=" + organizationID
			type :DELETE
			connection:"zerp"
		];
		apiCallCount = apiCallCount + 1;
		if(deleteResp != null && deleteResp.containsKey("code") && deleteResp.get("code") == 0)
		{
			info "SUCCESS: Credit Note " + matchedCNNumber + " also deleted.";
		}
		else
		{
			info "NOTE: " + matchedCNNumber + " is Void but could not be deleted - that is fine, Void already removes its financial effect.";
		}
	}
	else
	{
		info "MANUAL REVIEW NEEDED: void failed for Credit Note " + matchedCNNumber + ".";
		info voidResp;
	}
}
info "========================================";
info "TOTAL API CALLS : " + apiCallCount;
info "ACME AUTO INVOICE EVENT HANDLER END";
info "========================================";
