// ============================================================
// AUTO CASH DISCOUNT - UNIFIED ENGINE  -  v5.2
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Workflow function
// Trigger      Customer Payments - Created / Edited / Deleted
//              (all three rules point at THIS one function)
// Input        customer_payment      Connection  "zerp"
// Writes       Credit Notes - created, corrected, unapplied,
//              voided or deleted
// ------------------------------------------------------------
// WHAT IT DOES
// Grants an early-payment discount on receipt, as a credit note
// applied against the invoice, on a sliding scale (same day, then
// progressively smaller slabs).
//
// ONE FUNCTION FOR THREE EVENTS
// Zoho does not tell a function which event fired - there is no
// event field in the payload. So this script never asks. It asks
// a better question: DOES THE PAYMENT STILL EXIST?
//   payment exists  -> LIVE MODE. Work out what the discount
//                      SHOULD be right now and converge on it:
//                      create, correct, remove, or leave alone.
//                      Create and Edit are the same code path.
//   payment gone    -> DELETE MODE. Reverse the discount.
// Because LIVE MODE always recomputes from the invoice's real
// state rather than from what happened last time, a payment can be
// edited any number of times, in any order, and still land right.
// The design is immune to event ordering and to log replays.
//
// FIFO GUARD
// A discount is withheld when older unpaid debt exists on the
// account, so early payment on a new bill cannot be used to earn a
// discount while old money sits out. GET /invoices does not return
// a customer's opening balance at all, so the opening balance is
// read separately and folded into the FIFO anchor - without that,
// the oldest debt on an account is invisible to the check.
//
// No loop risk: it writes only to Credit Notes, a different module
// from the one that triggers it.
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
// ACME AUTO CASH DISCOUNT - UNIFIED ENGINE - V5.2
// Workflow input: customer_payment | Connection: zerp
//
// *** ONE FUNCTION, THREE WORKFLOW RULES ***
//   Customer Payments - Created  -> this function
//   Customer Payments - Edited   -> this function
//   Customer Payments - Deleted  -> this function
// Replaces all three of:
//   AUTO CASH DISCOUNT             (v4.1)
//   AUTO CASH DISCOUNT EDIT RECON  (v2.0)
//   AUTO CASH DISCOUNT DEL REVERSE (v2.0)
// Do not run the old three alongside this one.
//
// ============================================================
// WHY ONE FUNCTION WORKS
// ============================================================
// Zoho does not tell a function which event fired - there is no event
// field in the payload (verified 2026-08-17). So this script never
// asks. It asks a better question instead: DOES THE PAYMENT STILL
// EXIST? A GET on the payment answers that in one call, and the
// answer is immune to timing and to log replays:
//
//   payment exists    -> LIVE MODE. Work out what the cash discount
//                        SHOULD be right now and converge on it:
//                        create it, correct it, remove it, or leave
//                        it alone. This covers Create and Edit with
//                        exactly the same code.
//   payment gone      -> DELETE MODE. Reverse the cash discount.
//
// Because LIVE MODE always recomputes from the invoice's real state
// rather than from what happened last time, a payment can be edited
// any number of times, in any order, and still end up correct.
//
// ============================================================
// *** V5.2 (2026-08-17) - FIFO COULD NOT SEE AN OPENING BALANCE ***
// ============================================================
// The second silent FIFO failure found in one day. V5.1 fixed the
// comma status filter that made the FIFO query return nothing; this
// fixes the fact that GET /invoices does not return a customer's
// OPENING BALANCE at all, which PROBE C proved on live data. The FIFO
// scan reads exactly that list, so for the 99 customers of 268 who
// carry an opening balance - a material sum in aggregate - the oldest debt on
// the account was invisible and the full slab was handed out.
// DEALER-A: Rs 1,64,884 open since 2026-03-31.
//
// FIXED in STEP 2b: the opening balance is read once per run and folded
// into the FIFO anchor. If it is older than the oldest open invoice, it
// becomes the anchor. Cost: one contact read per run, plus one invoice
// read only when an opening balance exists, and nothing at all in
// DELETE mode.
//
// Owner's rule, stated 2026-08-17: a pending opening balance DOES
// count as an older unpaid bill. See fifoIgnoresDueOnReceipt below for
// why that had to be said out loud.
//
// ============================================================
// WHAT THIS FIXES vs THE OLD THREE SCRIPTS
// ============================================================
// FIX 1 - THE BALANCE THE OLD RECONCILE CORRUPTED
//   AUTO CASH DISCOUNT EDIT RECONCILE read the invoice balance while
//   its OWN old Credit Note was still applied to that invoice, so it
//   saw an artificially LOW balance. That one wrong number poisoned
//   both the eligibility test and the amount applied to the invoice.
//   Reproduced with money on 2026-08-17: a Rs 100 credit note was
//   created but never applied, leaving Rs 250 due on the invoice and
//   Rs 100 floating as unused customer credit that the customer had
//   not earned.
//   HERE: effectiveBalance = live balance + whatever OUR OWN credit
//   note has already applied to this invoice. Every decision uses
//   that. On the reproduced case it now correctly removes the
//   discount and leaves Rs 250 due, which is what the main engine's
//   own "PARTIAL PAYMENT : No CD created" rule always intended.
//
// FIX 2 - CREDIT NOTES THE OLD SCRIPTS COULD NOT SEE
//   A full audit of all 168 credit notes in this org (PROBE B, 2026-
//   08-17) found FOUR marker formats once this version is counted:
//     NEW       CD/<invoice_number>            in reference_number
//     LEGACY 1  AUTO-CD-<invoice_id>           in reference_number
//     LEGACY 2  AUTO-CD-<invoice_id>           in LINE ITEMS only
//     LEGACY 3  AUTO-CD-<payment_id>-<invoice_id>  in LINE ITEMS only
//   The old reconcile and delete-reversal searched reason and
//   reference only, so ALL 35 legacy credit notes were invisible to
//   them. Editing such a payment made reconcile conclude "no discount
//   exists" and create a SECOND one. This version indexes line items
//   too, so it sees every format.
//   LEGACY 3 is proven, not guessed: CN-110 and CN-109 (both DEALER-J)
//   share the first id but carry different second ids and belong to
//   different invoices - one payment applied to two invoices produced
//   two credit notes. So the first id there is the PAYMENT.
//
// FIX 3 - THE MARKER IS NO LONGER PRINTED TO THE CUSTOMER
//   The old marker "AUTO-CD-<LEGACY_PAYMENT_ID>" was written into
//   reference_number, and this org's credit note template PRINTS
//   Ref# on the PDF the customer receives. New credit notes carry
//   "CD/ACME-INV-1080" instead - a reference that actually means
//   something to the reader and still identifies the discount
//   uniquely to this script.
//
// ============================================================
// *** THE LEGACY RULE - READ THIS BEFORE CHANGING ANYTHING ***
// ============================================================
// Old credit notes have already been sent to customers and are
// sitting in their ledgers. Changing one now moves a balance the
// customer has already seen and agreed to, which is a credibility
// problem, not a technical one. So:
//
//   IF A LEGACY-FORMAT CREDIT NOTE IS FOUND FOR AN INVOICE, THIS
//   SCRIPT DOES NOTHING TO IT AND CREATES NOTHING BESIDE IT.
//
// It does not void it, edit it, replace it or duplicate it. It logs
// that the invoice already carries an old-format discount and moves
// on. That satisfies both requirements at once: no shared ledger
// entry is ever disturbed, and no duplicate discount can appear.
// Anything that genuinely needs correcting on an old credit note is
// a human decision, made by hand.
//
// Credit notes with no AUTO-CD or CD/ marker at all - product
// returns, complaint replacements, small adjustments, and the
// manually combined discounts covering several invoices - are
// invisible to this script and always have been. PROBE B counted 129
// of those out of 168. None of them are touched.
//
// ============================================================
// COST AND THE RATE LIMIT (project lesson 13)
// ============================================================
// Line items only appear on the credit note DETAIL endpoint, one API
// call each. Sweeping the whole org that way costs ~165 calls, which
// on every payment event would trigger error {"code":44} and block
// the ENTIRE ORGANISATION for a minute. So the marker index is built
// ONCE per run, from THIS CUSTOMER's credit notes only, and only the
// ones whose reference does not already identify them need a detail
// read. The org holds 168 credit notes across 265 customers - well
// under one each; the heaviest, DEALER-G, has about eleven. Every
// run prints its own API call count at the end. cdDetailReadCap is a
// hard stop against any runaway.
//
// SAFETY: if the index cannot be built completely - a search failed,
// or the cap was hit - this script will NOT create a credit note on
// that run. An incomplete search cannot prove that no discount
// already exists, and acting on that assumption is exactly how a
// duplicate discount happens. It logs MANUAL REVIEW instead.
//
// No loop risk: this only writes to Credit Notes, a different module
// from Customer Payments, so it cannot re-trigger its own workflow.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================
// dryRun = true makes this script decide everything and log exactly
// what it WOULD do, while writing nothing at all. Useful for shadow-
// running it beside the old scripts, or for investigating a customer
// without touching the books.
dryRun = true;

// Cash discount slabs, as a percentage of the INVOICE TOTAL.
cdSameDay = 3.0;
cdWithin8 = 2.5;
cdWithin15 = 1.5;
cdWithin30 = 1.0;
cdWithin45 = 0.5;

roundingTolerance = 1.00;
currencyPrecision = 0;

// Should an open DUE ON RECEIPT invoice count as "an older unpaid
// bill" when STRICT FIFO assesses a Net 60 payment?
//
// NO, by the owner's rule (2026-08-17). A Due on Receipt bill is not
// ordinary credit - it is released against a promise of full payment
// the same day, and it is generally not offered at all to a dealer
// who is already carrying old pending. It gets first call on the
// money and sometimes runs on its own special terms. Letting one sit
// in the FIFO scan would cut the cash discount on a genuinely well
// paid Net 60 invoice for reasons that have nothing to do with
// ordinary credit behaviour. FIFO applies to everything else.
//
// Due on Receipt is detected from due_date == invoice date, which
// costs no extra API call - payment_terms is not returned on the
// invoice list (the same limitation the overdue-aging script pays an
// extra read for). Both dates are printed to the log so the
// assumption stays visible.
//
// *** THIS EXEMPTION DOES NOT EXTEND TO A PENDING OPENING BALANCE ***
// V5.2 (2026-08-17). An opening balance looks IDENTICAL to a Due on
// Receipt invoice from the API - due_date equal to its date and
// payment_terms 0 - so without saying this plainly the exemption
// above would have swallowed it. The owner ruled the other way: an
// opening balance is the oldest pending money on the account and it
// DOES count for FIFO. The exemption exists for a bill released
// against a same-day promise, which a migrated opening balance is
// not. See STEP 2b.
fifoIgnoresDueOnReceipt = true;

// When STRICT FIFO reduces the discount because an older unpaid
// invoice exists, should the credit note say so on the customer's
// copy? true is transparent and explains the smaller discount; false
// keeps the days off the document entirely for those cases.
showFifoNoteOnCN = true;

cnPageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
cdDetailReadCap = 40;


// ============================================================
// STATE
// ============================================================
organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
apiCallCount = 0;
cdDetailReadsUsed = 0;
cdIndexIncomplete = false;
cdSearchFailed = false;
cdNewRefMap = Map();
cdLegacyMap = Map();
cdNumberMap = Map();
paymentStillExists = false;

paymentID = customer_payment.get("payment_id");
if(paymentID == null || paymentID == "")
{
	paymentID = customer_payment.get("customer_payment_id");
}
paymentDateStr = customer_payment.get("date");
customerID = customer_payment.get("customer_id");
customerName = customer_payment.get("customer_name");
invoiceString = customer_payment.get("invoices");

info "========================================";
info "ACME AUTO CASH DISCOUNT - UNIFIED ENGINE V5.2";
info "Payment : " + paymentID + " | Customer : " + customerName + " | Payload date : " + paymentDateStr;
if(dryRun == true)
{
	info "*** DRY RUN - NOTHING WILL BE WRITTEN ***";
}
info "========================================";

if(paymentID == null || paymentID == "" || customerID == null || customerID == "")
{
	info "ERROR: payment id or customer id missing from the event. Cash discount handling stopped.";
	info "========================================";
	return;
}
if(invoiceString == null || invoiceString == "")
{
	info "This payment is not linked to any invoice in the event payload - nothing to do.";
	info "MANUAL REVIEW NEEDED only if you know this payment had earned a cash discount: find the Credit Note by hand (Ref# starts CD/, or an old one whose text contains AUTO-CD-).";
	info "========================================";
	return;
}

// ============================================================
// STEP 1 - LIVE MODE OR DELETE MODE?
// One call. A deleted payment answers {"code":1002,"message":
// "Payment does not exist."} - verified 2026-08-17.
// ============================================================
paymentResp = invokeurl
[
	url :apiEndPoint + "/customerpayments/" + paymentID + "?organization_id=" + organizationID
	type :GET
	connection:"zerp"
];
apiCallCount = apiCallCount + 1;
if(paymentResp != null && paymentResp.containsKey("code") && paymentResp.get("code") == 0 && paymentResp.get("payment") != null)
{
	paymentStillExists = true;
	// Trust the LIVE payment date, not the payload's copy. On an edit
	// the payload is a snapshot and can lag; the live record cannot.
	livePaymentData = paymentResp.get("payment");
	livePaymentDate = livePaymentData.get("date");
	if(livePaymentDate != null && livePaymentDate != "")
	{
		paymentDateStr = livePaymentDate;
	}
	info "MODE : LIVE (payment exists) - date " + paymentDateStr;
}
else if(paymentResp != null && paymentResp.containsKey("code") && paymentResp.get("code") == 1002)
{
	paymentStillExists = false;
	info "MODE : DELETE (payment no longer exists) - reversing any cash discount.";
}
else
{
	// Neither a clean read nor a clean not-found. Guessing here could
	// void a valid discount, so stop.
	info "MANUAL REVIEW NEEDED: could not determine whether this payment still exists. Nothing was changed.";
	info paymentResp;
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}
if(paymentStillExists == true && (paymentDateStr == null || paymentDateStr == ""))
{
	info "ERROR: payment date missing. Cash discount handling stopped.";
	info "TOTAL API CALLS : " + apiCallCount;
	info "========================================";
	return;
}

// ============================================================
// STEP 2 - BUILD THIS CUSTOMER'S CASH-DISCOUNT INDEX
// Built once, before the invoice loop, so a payment spread over
// several invoices does not rescan the same credit notes.
// Void credit notes are skipped - they carry no financial effect, so
// they can neither be stale nor block a new discount.
// ============================================================
info "Building cash-discount index for this customer...";
hasMoreCN = true;
for each  cnPageNo in cnPageList
{
	if(hasMoreCN == true && cdSearchFailed == false)
	{
		cnListResp = invokeurl
		[
			url :apiEndPoint + "/creditnotes?organization_id=" + organizationID + "&customer_id=" + customerID + "&per_page=200&page=" + cnPageNo
			type :GET
			connection:"zerp"
		];
		apiCallCount = apiCallCount + 1;
		if(cnListResp != null && cnListResp.containsKey("code") && cnListResp.get("code") == 0)
		{
			cnList = cnListResp.get("creditnotes");
			if(cnList != null)
			{
				for each  cnSummary in cnList
				{
					cnID = cnSummary.get("creditnote_id");
					cnNumber = cnSummary.get("creditnote_number");
					cnStatus = cnSummary.get("status");
					cnReference = cnSummary.get("reference_number");
					cnReason = cnSummary.get("reason");
					if(cnReference == null)
					{
						cnReference = "";
					}
					if(cnReason == null)
					{
						cnReason = "";
					}
					if(cnStatus != "void" && cnID != null && cnID != "")
					{
						if(cnReference.startsWith("CD/"))
						{
							// NEW FORMAT - ours, fully under our control.
							cdNewRefMap.put(cnID,cnReference);
							cdNumberMap.put(cnID,cnNumber);
						}
						else
						{
							headerText = cnReason + " ~ " + cnReference;
							if(headerText.contains("AUTO-CD-"))
							{
								// LEGACY 1 - marker in the header.
								cdLegacyMap.put(cnID,headerText);
								cdNumberMap.put(cnID,cnNumber);
							}
							else if(cdDetailReadsUsed >= cdDetailReadCap)
							{
								cdIndexIncomplete = true;
							}
							else
							{
								// LEGACY 2 / 3 - the marker can only be in the
								// line items, which the list endpoint does not
								// return. One detail call settles it.
								cnDetailForIndex = invokeurl
								[
									url :apiEndPoint + "/creditnotes/" + cnID + "?organization_id=" + organizationID
									type :GET
									connection:"zerp"
								];
								apiCallCount = apiCallCount + 1;
								cdDetailReadsUsed = cdDetailReadsUsed + 1;
								if(cnDetailForIndex != null && cnDetailForIndex.containsKey("code") && cnDetailForIndex.get("code") == 0 && cnDetailForIndex.get("creditnote") != null)
								{
									cnDetailData = cnDetailForIndex.get("creditnote");
									detailReason = cnDetailData.get("reason");
									detailReference = cnDetailData.get("reference_number");
									if(detailReason == null)
									{
										detailReason = "";
									}
									if(detailReference == null)
									{
										detailReference = "";
									}
									// The LIST endpoint returns reason empty in
									// this org even when it was written, so the
									// detail copy is re-checked here.
									combinedText = detailReason + " ~ " + detailReference;
									cnDetailLines = cnDetailData.get("line_items");
									if(cnDetailLines != null)
									{
										for each  cnDetailLine in cnDetailLines
										{
											lineName = cnDetailLine.get("name");
											lineDesc = cnDetailLine.get("description");
											if(lineName == null)
											{
												lineName = "";
											}
											if(lineDesc == null)
											{
												lineDesc = "";
											}
											combinedText = combinedText + " ~ " + lineName + " ~ " + lineDesc;
										}
									}
									if(combinedText.contains("AUTO-CD-"))
									{
										cdLegacyMap.put(cnID,combinedText);
										cdNumberMap.put(cnID,cnNumber);
									}
								}
								else
								{
									// A credit note we could not classify might be
									// an existing discount we must not duplicate.
									cdIndexIncomplete = true;
									info "WARNING: could not read Credit Note " + cnNumber + " while indexing.";
								}
							}
						}
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
			cdSearchFailed = true;
			hasMoreCN = false;
			info "ERROR: credit note search failed for this customer.";
		}
	}
}
if(hasMoreCN == true && cdSearchFailed == false)
{
	cdIndexIncomplete = true;
	info "WARNING: this customer has more than 3,000 credit notes - index truncated.";
}
info "Index : " + cdNewRefMap.size() + " current-format + " + cdLegacyMap.size() + " legacy | detail reads " + cdDetailReadsUsed + " of " + cdDetailReadCap + " | API calls so far " + apiCallCount;
if(cdIndexIncomplete == true)
{
	info "NOTE: index INCOMPLETE - no new credit note will be created on this run.";
}

// ============================================================
// STEP 2b - THE CUSTOMER'S PENDING OPENING BALANCE (2026-08-17)
// *** FIFO WAS BLIND TO IT ***
// PROBE C proved that GET /invoices does not return a customer's
// opening balance, and the FIFO check below scans exactly that list.
// So for the 99 customers of 268 who carry an opening balance
// - a material sum in aggregate - the oldest debt on the books was invisible
// and the full discount slab was being handed out. This is the second
// silent FIFO failure found in one day; the first was the comma
// status filter.
//
// OWNER'S DECISION, 2026-08-17: a pending opening balance DOES count
// as an older unpaid bill for FIFO. It has to be stated explicitly
// because the opening balance looks exactly like a Due on Receipt
// invoice - due_date equal to its date, payment_terms 0 - and Due on
// Receipt is FIFO-exempt by an earlier decision. That exemption
// exists for a bill released against a same-day promise, which a
// migrated opening balance is not.
//
// Read ONCE here, outside the per-invoice loop, so a payment applied
// to five invoices still costs one contact read and one invoice read
// rather than ten. Skipped entirely in DELETE mode, which never
// prices a discount.
// ============================================================
cdOBBalance = 0.0;
cdOBDateStr = "";
cdOBReadFailed = false;
if(paymentStillExists == true)
{
	cdOBContactResp = invokeurl
	[
		url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
		type :GET
		connection:"zerp"
	];
	apiCallCount = apiCallCount + 1;
	if(cdOBContactResp != null && cdOBContactResp.containsKey("code") && cdOBContactResp.get("code") == 0 && cdOBContactResp.get("contact") != null)
	{
		cdOBContact = cdOBContactResp.get("contact");
		cdOBFlagValue = cdOBContact.get("opening_balance_amount");
		if(cdOBFlagValue != null && cdOBFlagValue.toDecimal() > 0)
		{
			cdOBInvoiceID = "";
			cdOBNested = cdOBContact.get("opening_balances");
			if(cdOBNested != null)
			{
				// *** DELUGE TYPE NOTE - 2026-08-17, found at paste time ***
				// cdOBNested.get("ob_invoice_id") DOES NOT COMPILE. Zoho
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
				cdOBRawText = cdOBNested.toString();
				if(cdOBRawText.contains("ob_invoice_id"))
				{
					cdOBBefore = cdOBRawText.getPrefix("ob_invoice_id");
					cdOBRest = cdOBRawText.subString(cdOBBefore.length() + 13);
					cdOBChunk = cdOBRest;
					if(cdOBRest.contains(","))
					{
						cdOBChunk = cdOBRest.getPrefix(",");
					}
					// cdOBChunk now reads  :"<OPENING_BALANCE_INVOICE_ID>"  with the
					// key's own closing quote in front of it - three
					// punctuation characters to drop at the start, one at the
					// end.
					if(cdOBChunk.length() > 4)
					{
						cdOBInvoiceID = cdOBChunk.subString(3,cdOBChunk.length() - 1);
					}
				}
			}
			if(cdOBInvoiceID == "")
			{
				cdOBReadFailed = true;
			}
			else
			{
				cdOBResp = invokeurl
				[
					url :apiEndPoint + "/invoices/" + cdOBInvoiceID + "?organization_id=" + organizationID
					type :GET
					connection:"zerp"
				];
				apiCallCount = apiCallCount + 1;
				if(cdOBResp != null && cdOBResp.containsKey("code") && cdOBResp.get("code") == 0 && cdOBResp.get("invoice") != null)
				{
					cdOBDoc = cdOBResp.get("invoice");
					cdOBStatus = cdOBDoc.get("status");
					if(cdOBStatus != "draft" && cdOBStatus != "void" && cdOBDoc.get("balance") != null)
					{
						cdOBBalance = cdOBDoc.get("balance").toDecimal();
						if(cdOBDoc.get("date") != null)
						{
							cdOBDateStr = cdOBDoc.get("date");
						}
					}
				}
				else
				{
					cdOBReadFailed = true;
				}
			}
		}
	}
	else
	{
		cdOBReadFailed = true;
	}
	// Always say what was found. A silent FIFO check is how the first
	// FIFO bug hid for months, and this is the same check.
	if(cdOBReadFailed == true)
	{
		info "OPENING BALANCE : could not be read. FIFO cannot see it this run - treat any discount created now as unverified.";
	}
	else if(cdOBBalance > 0)
	{
		info "OPENING BALANCE : Rs " + cdOBBalance + " open, dated " + cdOBDateStr + " - counts for FIFO (owner's rule, 2026-08-17).";
	}
	else
	{
		info "OPENING BALANCE : none open for this customer.";
	}
}

// ============================================================
// STEP 3 - WORK THROUGH EVERY INVOICE ON THIS PAYMENT
// ============================================================
invoiceList = invoiceString.toList();
for each  paymentInvoice in invoiceList
{
	invoiceID = paymentInvoice.get("invoice_id");
	invoiceNumber = paymentInvoice.get("invoice_number");
	if(invoiceNumber == null)
	{
		invoiceNumber = "";
	}
	info "----------------------------------------";
	info "Invoice : " + invoiceNumber;
	if(invoiceNumber == "Customer opening balance")
	{
		info "SKIPPED : customer opening balance carries no cash discount.";
	}
	else if(invoiceID == null || invoiceID == "")
	{
		info "SKIPPED : no invoice id on this payload line.";
	}
	else if(cdSearchFailed == true)
	{
		info "MANUAL REVIEW NEEDED: the credit note search failed, so this invoice was not processed.";
	}
	else
	{
		cdReference = "CD/" + invoiceNumber;
		legacyTail = "-" + invoiceID;
		// --------------------------------------------------------
		// MATCH. Exact reference match, never "contains" - the
		// reference of ACME-INV-108 is a substring of the reference
		// of ACME-INV-1080, and "contains" would confuse the two.
		// The startsWith arm leaves room for a future suffix without
		// breaking anything written today.
		// --------------------------------------------------------
		matchedCNID = "";
		matchedCNNumber = "";
		for each  newCNID in cdNewRefMap.keys()
		{
			newCNRef = cdNewRefMap.get(newCNID);
			if(matchedCNID == "" && (newCNRef == cdReference || newCNRef.startsWith(cdReference + "/")))
			{
				matchedCNID = newCNID;
				matchedCNNumber = cdNumberMap.get(newCNID);
			}
		}
		legacyCNNumber = "";
		for each  legacyCNID in cdLegacyMap.keys()
		{
			legacyText = cdLegacyMap.get(legacyCNID);
			if(legacyCNNumber == "" && legacyText.contains("AUTO-CD-") && legacyText.contains(legacyTail))
			{
				legacyCNNumber = cdNumberMap.get(legacyCNID);
			}
		}
		if(legacyCNNumber != "" && matchedCNID == "")
		{
			// ====================================================
			// THE LEGACY RULE. Hands off, and nothing new beside it.
			// ====================================================
			info "LEGACY CASH DISCOUNT PRESENT : " + legacyCNNumber;
			info "This invoice already carries an old-format cash discount that has been sent to the customer. It is left completely untouched, and no new discount is created beside it. Review by hand if it genuinely needs correcting.";
		}
		else if(paymentStillExists == false)
		{
			// ====================================================
			// DELETE MODE
			// ====================================================
			if(matchedCNID == "")
			{
				if(cdIndexIncomplete == true)
				{
					info "MANUAL REVIEW NEEDED: no cash discount matched this invoice, but the index was incomplete - that is not proof none exists. Check the customer's Credit Notes by hand.";
				}
				else
				{
					info "No cash discount to reverse.";
				}
			}
			else
			{
				info "DECISION : REMOVE " + matchedCNNumber + " - the payment that earned it was deleted.";
				if(dryRun == true)
				{
					info "DRY RUN - nothing written.";
				}
				else
				{
					// -------- unapply, void, delete ------------------
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
							info "SUCCESS: Credit Note " + matchedCNNumber + " voided.";
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
								info "NOTE: " + matchedCNNumber + " is Void but could not be deleted - fine, Void already removes its financial effect.";
							}
						}
						else
						{
							info "MANUAL REVIEW NEEDED: void failed for Credit Note " + matchedCNNumber + ".";
							info voidResp;
						}
					}
				}
			}
		}
		else
		{
			// ====================================================
			// LIVE MODE - recompute from the invoice's real state
			// ====================================================
			paymentDate = paymentDateStr.toDate("yyyy-MM-dd");
			invoiceResp = invokeurl
			[
				url :apiEndPoint + "/invoices/" + invoiceID + "?organization_id=" + organizationID
				type :GET
				connection:"zerp"
			];
			apiCallCount = apiCallCount + 1;
			if(invoiceResp == null || invoiceResp.containsKey("code") == false || invoiceResp.get("code") != 0 || invoiceResp.get("invoice") == null)
			{
				info "MANUAL REVIEW NEEDED: could not read invoice " + invoiceNumber + ".";
			}
			else
			{
				invoiceData = invoiceResp.get("invoice");
				paymentTerms = invoiceData.get("payment_terms");
				paymentTermsText = "";
				if(paymentTerms != null)
				{
					paymentTermsText = paymentTerms.toString();
				}
				readFailed = false;
				historical = false;
				eligible = false;
				discountPct = 0.0;
				discountSlab = "No Discount";
				creditNoteAmount = 0.0;
				sourceApplyAmount = 0.0;
				daysElapsed = 0;
				fifoPenaltyApplied = false;
				effectiveBalance = 0.0;
				if(paymentTermsText != "60")
				{
					info "Not a Net 60 invoice (terms " + paymentTermsText + ") - no cash discount applies.";
				}
				else
				{
					invoiceDateStr = invoiceData.get("date");
					invoiceDate = invoiceDateStr.toDate("yyyy-MM-dd");
					invoiceTotal = invoiceData.get("total").toDecimal();
					liveBalance = invoiceData.get("balance").toDecimal();
					// ------------------------------------------------
					// *** FIX 1 *** Our own credit note, if one exists,
					// is already applied to this invoice and has pushed
					// the balance down. Add it back, or every decision
					// below is made against a number that includes the
					// very discount we are re-deciding.
					// ------------------------------------------------
					ourCreditApplied = 0.0;
					if(matchedCNID != "")
					{
						creditsResp = invokeurl
						[
							url :apiEndPoint + "/invoices/" + invoiceID + "/creditsapplied?organization_id=" + organizationID
							type :GET
							connection:"zerp"
						];
						apiCallCount = apiCallCount + 1;
						if(creditsResp != null && creditsResp.containsKey("code") && creditsResp.get("code") == 0)
						{
							appliedCredits = creditsResp.get("credits");
							if(appliedCredits != null)
							{
								for each  appliedCredit in appliedCredits
								{
									if(appliedCredit.get("creditnote_id") == matchedCNID && appliedCredit.get("amount_applied") != null)
									{
										ourCreditApplied = ourCreditApplied + appliedCredit.get("amount_applied").toDecimal();
									}
								}
							}
						}
						else
						{
							// Without this figure the balance cannot be
							// trusted, and a wrong balance is how money
							// ends up in the wrong place.
							readFailed = true;
							info "MANUAL REVIEW NEEDED: could not read the credits applied to invoice " + invoiceNumber + ". Nothing was changed.";
						}
					}
					effectiveBalance = liveBalance + ourCreditApplied;
					if(readFailed == false)
					{
						// ------------------------------------------------
						// Do not price a discount for an old payment when a
						// newer one has since landed on the same invoice.
						// ------------------------------------------------
						lastPaymentDateStr = invoiceData.get("last_payment_date");
						if(lastPaymentDateStr != null && lastPaymentDateStr != "")
						{
							lastPaymentDate = lastPaymentDateStr.toDate("yyyy-MM-dd");
							if(paymentDate < lastPaymentDate)
							{
								historical = true;
								info "SKIPPED : a newer payment (" + lastPaymentDateStr + ") exists on this invoice. Leaving the cash discount alone.";
							}
						}
					}
					if(readFailed == false && historical == false)
					{
						daysElapsed = invoiceDate.daysbetween(paymentDate);
						// ------------------------------------------------
						// STRICT FIFO - paying a new bill while older ones
						// sit open is assessed against the oldest debt.
						//
						// The anchor is declared HERE, before the read, so it
						// exists even when the read fails - and so that the
						// opening balance folded in afterwards can never be
						// compared against an unassigned variable.
						// ------------------------------------------------
						fifoAnchorDateStr = "";
						fifoAnchorLabel = "";
						openInvResp = invokeurl
						[
							url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&sort_column=date&sort_order=A&per_page=200"
							type :GET
							connection:"zerp"
						];
						apiCallCount = apiCallCount + 1;
						if(openInvResp != null && openInvResp.get("code") == 0 && openInvResp.get("invoices") != null)
						{
							openInvoicesList = openInvResp.get("invoices");
							if(openInvoicesList.size() > 0)
							{
								// V5.1 - FIND THE OLDEST *OPEN* INVOICE IN CODE.
								// The API call above used to carry
								// &status=sent,overdue,partially_paid and take
								// per_page=1. Zoho does not accept that comma
								// list as a status filter, so the call came
								// back with nothing and FIFO NEVER FIRED - not
								// in this version, and not in V4.0 either,
								// which is where the query came from. Proven on
								// 2026-08-17: a payment made the same day on a
								// customer holding a 40-day-old unpaid invoice
								// still got the full 3% instead of 0.5%.
								// The surplus-allocation query, which has never
								// carried a status filter, sorted the very same
								// invoices correctly in the very same run - so
								// sort_column=date was never the problem.
								oldestInv = Map();
								dorSkippedCount = 0;
								for each  candidateInv in openInvoicesList
								{
									candidateBalanceValue = candidateInv.get("balance");
									candidateStatus = candidateInv.get("status");
									candidateDateStr = candidateInv.get("date");
									candidateDueStr = candidateInv.get("due_date");
									candidateIsOpen = false;
									if(candidateBalanceValue != null && candidateStatus != "draft" && candidateStatus != "void" && candidateBalanceValue.toDecimal() > 0)
									{
										candidateIsOpen = true;
									}
									// Due on Receipt: due_date is the invoice date
									// itself. See fifoIgnoresDueOnReceipt above.
									candidateIsDueOnReceipt = false;
									if(fifoIgnoresDueOnReceipt == true && candidateDateStr != null && candidateDueStr != null && candidateDueStr == candidateDateStr)
									{
										candidateIsDueOnReceipt = true;
									}
									if(candidateIsOpen == true && candidateIsDueOnReceipt == true)
									{
										dorSkippedCount = dorSkippedCount + 1;
										info "FIFO check : skipping open DUE ON RECEIPT invoice " + candidateInv.get("invoice_number") + " (date " + candidateDateStr + ", due " + candidateDueStr + ") - not ordinary credit.";
									}
									if(oldestInv.size() == 0 && candidateIsOpen == true && candidateIsDueOnReceipt == false)
									{
										oldestInv = candidateInv;
									}
								}
								// Always say what was found. A silent FIFO check
								// is how this hid for months.
								if(oldestInv.size() == 0)
								{
									info "FIFO check : no other open invoice counts for FIFO (" + dorSkippedCount + " Due on Receipt invoice(s) skipped).";
								}
								else
								{
									info "FIFO check : oldest open invoice is " + oldestInv.get("invoice_number") + " dated " + oldestInv.get("date") + " (due " + oldestInv.get("due_date") + ").";
									if(oldestInv.get("date") != null && oldestInv.get("date") != "")
									{
										fifoAnchorDateStr = oldestInv.get("date");
										fifoAnchorLabel = "invoice " + oldestInv.get("invoice_number");
									}
								}
							}
						}
						// ------------------------------------------------
						// FOLD IN THE OPENING BALANCE (2026-08-17)
						// Read once in STEP 2b. It sits OUTSIDE the invoice-list
						// read above on purpose: GET /invoices never returns it,
						// so if this were left inside that block the oldest debt
						// in the book would stay invisible - which is exactly
						// the bug being fixed. It also still works when the
						// invoice-list read itself fails.
						// ------------------------------------------------
						if(cdOBBalance > 0 && cdOBDateStr != "")
						{
							cdOBDate = cdOBDateStr.toDate("yyyy-MM-dd");
							cdOBIsOlder = false;
							if(fifoAnchorDateStr == "")
							{
								cdOBIsOlder = true;
							}
							else if(cdOBDate < fifoAnchorDateStr.toDate("yyyy-MM-dd"))
							{
								cdOBIsOlder = true;
							}
							if(cdOBIsOlder == true)
							{
								fifoAnchorDateStr = cdOBDateStr;
								fifoAnchorLabel = "opening balance";
								info "FIFO check : the pending OPENING BALANCE dated " + cdOBDateStr + " is older than any open invoice - it becomes the FIFO anchor.";
							}
						}
						// ------------------------------------------------
						// ONE PLACE APPLIES THE PENALTY, whichever source won.
						// ------------------------------------------------
						if(fifoAnchorDateStr != "")
						{
							oldestDate = fifoAnchorDateStr.toDate("yyyy-MM-dd");
							if(oldestDate < invoiceDate)
							{
								daysElapsed = oldestDate.daysbetween(paymentDate);
								fifoPenaltyApplied = true;
								info "FIFO : older unpaid " + fifoAnchorLabel + " dated " + fifoAnchorDateStr + " - assessed at " + daysElapsed + " days.";
							}
						}
						if(daysElapsed <= 0)
						{
							discountPct = cdSameDay;
							discountSlab = "Same Day / Advance";
						}
						else if(daysElapsed <= 8)
						{
							discountPct = cdWithin8;
							discountSlab = "Within 8 Days";
						}
						else if(daysElapsed <= 15)
						{
							discountPct = cdWithin15;
							discountSlab = "Within 15 Days";
						}
						else if(daysElapsed <= 30)
						{
							discountPct = cdWithin30;
							discountSlab = "Within 30 Days";
						}
						else if(daysElapsed <= 45)
						{
							discountPct = cdWithin45;
							discountSlab = "Within 45 Days";
						}
						maxEligibleDiscount = (invoiceTotal * discountPct / 100).round(currencyPrecision);
						info "Invoice total Rs " + invoiceTotal + " | balance Rs " + liveBalance + " + our credit Rs " + ourCreditApplied + " = effective Rs " + effectiveBalance;
						info "Days " + daysElapsed + " | slab " + discountSlab + " | max discount Rs " + maxEligibleDiscount;
						if(discountPct == 0 || maxEligibleDiscount <= 0)
						{
							info "Outside the cash-discount period.";
						}
						else if(effectiveBalance > maxEligibleDiscount + roundingTolerance)
						{
							info "PARTIAL PAYMENT : the invoice is not settled down to the discount, so no cash discount is due.";
						}
						else
						{
							eligible = true;
							creditNoteAmount = maxEligibleDiscount;
							if(effectiveBalance > maxEligibleDiscount)
							{
								// Rounding variance - settle the exact balance.
								creditNoteAmount = effectiveBalance.round(currencyPrecision);
							}
							sourceApplyAmount = effectiveBalance.round(currencyPrecision);
							if(sourceApplyAmount > creditNoteAmount)
							{
								sourceApplyAmount = creditNoteAmount;
							}
						}
					}
				}
				// ------------------------------------------------
				// DECIDE
				// ------------------------------------------------
				decision = "NONE";
				if(readFailed == true || historical == true)
				{
					decision = "NONE";
				}
				else if(matchedCNID == "")
				{
					if(eligible == false)
					{
						info "DECISION : nothing to do - no discount due and none exists.";
					}
					else if(cdIndexIncomplete == true)
					{
						info "MANUAL REVIEW NEEDED: this invoice is eligible and no discount was found, but the index was INCOMPLETE - one may exist that this run could not see. NOT creating one, to avoid a duplicate.";
					}
					else
					{
						decision = "CREATE";
						info "DECISION : CREATE a cash discount of Rs " + creditNoteAmount.round(currencyPrecision) + ".";
					}
				}
				else
				{
					existingCNAmount = 0.0;
					existingReadOK = false;
					existingDetailResp = invokeurl
					[
						url :apiEndPoint + "/creditnotes/" + matchedCNID + "?organization_id=" + organizationID
						type :GET
						connection:"zerp"
					];
					apiCallCount = apiCallCount + 1;
					if(existingDetailResp != null && existingDetailResp.containsKey("code") && existingDetailResp.get("code") == 0 && existingDetailResp.get("creditnote") != null)
					{
						existingReadOK = true;
						if(existingDetailResp.get("creditnote").get("total") != null)
						{
							existingCNAmount = existingDetailResp.get("creditnote").get("total").toDecimal();
						}
					}
					if(existingReadOK == false)
					{
						info "MANUAL REVIEW NEEDED: could not read the existing Credit Note " + matchedCNNumber + ". Nothing was changed.";
					}
					else if(eligible == true && (existingCNAmount - creditNoteAmount).abs() <= roundingTolerance)
					{
						info "DECISION : nothing to do - " + matchedCNNumber + " is already correct at Rs " + existingCNAmount.round(currencyPrecision) + ".";
					}
					else if(eligible == true)
					{
						decision = "REPLACE";
						info "DECISION : REPLACE " + matchedCNNumber + " - it says Rs " + existingCNAmount.round(currencyPrecision) + ", it should be Rs " + creditNoteAmount.round(currencyPrecision) + ".";
					}
					else
					{
						decision = "REMOVE";
						info "DECISION : REMOVE " + matchedCNNumber + " (Rs " + existingCNAmount.round(currencyPrecision) + ") - no cash discount is due any more.";
					}
				}
				// ------------------------------------------------
				// ACT
				// ------------------------------------------------
				if(decision != "NONE" && dryRun == true)
				{
					info "DRY RUN - nothing written.";
				}
				else if(decision != "NONE")
				{
					actionBlocked = false;
					if(decision == "REPLACE" || decision == "REMOVE")
					{
						staleDetailResp = invokeurl
						[
							url :apiEndPoint + "/creditnotes/" + matchedCNID + "?organization_id=" + organizationID
							type :GET
							connection:"zerp"
						];
						apiCallCount = apiCallCount + 1;
						if(staleDetailResp == null || staleDetailResp.containsKey("code") == false || staleDetailResp.get("code") != 0 || staleDetailResp.get("creditnote") == null)
						{
							actionBlocked = true;
							info "MANUAL REVIEW NEEDED: could not re-read Credit Note " + matchedCNNumber + ". Nothing was changed.";
						}
						else
						{
							staleApplied = staleDetailResp.get("creditnote").get("invoices_credited");
							if(staleApplied != null && staleApplied.size() > 0)
							{
								for each  staleEntry in staleApplied
								{
									staleInvoiceID = staleEntry.get("invoice_id");
									staleLinkID = staleEntry.get("creditnote_invoice_id");
									if(staleLinkID == null || staleLinkID == "")
									{
										actionBlocked = true;
									}
									else if(actionBlocked == false)
									{
										unapplyResp = invokeurl
										[
											url :apiEndPoint + "/creditnotes/" + matchedCNID + "/invoices/" + staleLinkID + "?organization_id=" + organizationID
											type :DELETE
											connection:"zerp"
										];
										apiCallCount = apiCallCount + 1;
										if(unapplyResp == null || unapplyResp.containsKey("code") == false || unapplyResp.get("code") != 0)
										{
											actionBlocked = true;
											info "ERROR: could not unapply from invoice " + staleInvoiceID + ".";
										}
									}
								}
							}
						}
						if(actionBlocked == true)
						{
							info "MANUAL REVIEW NEEDED: could not safely unwind Credit Note " + matchedCNNumber + ". It was NOT changed.";
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
								info "Credit Note " + matchedCNNumber + " voided.";
								deleteResp = invokeurl
								[
									url :apiEndPoint + "/creditnotes/" + matchedCNID + "?organization_id=" + organizationID
									type :DELETE
									connection:"zerp"
								];
								apiCallCount = apiCallCount + 1;
								if(deleteResp != null && deleteResp.containsKey("code") && deleteResp.get("code") == 0)
								{
									info "Credit Note " + matchedCNNumber + " also deleted.";
								}
								else
								{
									info "NOTE: " + matchedCNNumber + " is Void but could not be deleted - fine, Void already removes its financial effect.";
								}
							}
							else
							{
								actionBlocked = true;
								info "MANUAL REVIEW NEEDED: void failed for Credit Note " + matchedCNNumber + ".";
								info voidResp;
							}
						}
					}
					if((decision == "CREATE" || decision == "REPLACE") && actionBlocked == false)
					{
						// ------------------------------------------------
						// CUSTOMER-FACING WORDING. This appears on the PDF
						// the dealer receives, so it stays plain: what the
						// discount is, which invoice it is against, how
						// quickly it was paid, and which slab that earned.
						// No internal ids anywhere.
						// ------------------------------------------------
						cdDescription = "Against Invoice " + invoiceNumber;
						// "Paid same day or in advance" and the slab name
						// "Same Day / Advance" carry the same meaning, so the
						// slab is dropped in that one case instead of being
						// printed twice on the customer's copy.
						cdSlabInDescription = true;
						if(fifoPenaltyApplied == true)
						{
							if(showFifoNoteOnCN == true)
							{
								cdDescription = cdDescription + " | Assessed at " + daysElapsed + " days from the earliest open bill";
							}
						}
						else
						{
							if(daysElapsed <= 0)
							{
								cdDescription = cdDescription + " | Paid same day or in advance";
								cdSlabInDescription = false;
							}
							else
							{
								cdDescription = cdDescription + " | Paid in " + daysElapsed + " days";
							}
						}
						if(cdSlabInDescription == true)
						{
							cdDescription = cdDescription + " | " + discountSlab;
						}
						lineItemMap = Map();
						lineItemMap.put("name","Cash Discount @ " + discountPct + "%");
						lineItemMap.put("description",cdDescription);
						lineItemMap.put("quantity",1);
						lineItemMap.put("rate",creditNoteAmount);
						lineItemList = List();
						lineItemList.add(lineItemMap);
						cnMap = Map();
						cnMap.put("customer_id",customerID);
						cnMap.put("date",paymentDateStr);
						cnMap.put("reason","Cash Discount | Invoice " + invoiceNumber);
						cnMap.put("reference_number",cdReference);
						cnMap.put("line_items",lineItemList);
						cnParams = Map();
						cnParams.put("JSONString",cnMap.toString());
						newCNResp = invokeurl
						[
							url :apiEndPoint + "/creditnotes?organization_id=" + organizationID
							type :POST
							parameters:cnParams
							connection:"zerp"
						];
						apiCallCount = apiCallCount + 1;
						if(newCNResp != null && newCNResp.containsKey("code") && newCNResp.get("code") == 0 && newCNResp.get("creditnote") != null)
						{
							newCNID = newCNResp.get("creditnote").get("creditnote_id");
							newCNNumber = newCNResp.get("creditnote").get("creditnote_number");
							info "SUCCESS: Credit Note " + newCNNumber + " created for Rs " + creditNoteAmount.round(currencyPrecision) + " | Ref# " + cdReference;
							// ------------------------------------------------
							// Apply to this invoice, then spread any surplus
							// over the customer's other open invoices, oldest
							// first.
							// ------------------------------------------------
							applyInvoiceList = List();
							remainingCredit = creditNoteAmount;
							if(sourceApplyAmount > 0)
							{
								sourceApplyMap = Map();
								sourceApplyMap.put("invoice_id",invoiceID);
								sourceApplyMap.put("amount_applied",sourceApplyAmount);
								applyInvoiceList.add(sourceApplyMap);
								remainingCredit = (remainingCredit - sourceApplyAmount).round(currencyPrecision);
							}
							if(remainingCredit > 0)
							{
								allocResp = invokeurl
								[
									url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&sort_column=date&sort_order=A&per_page=200"
									type :GET
									connection:"zerp"
								];
								apiCallCount = apiCallCount + 1;
								if(allocResp != null && allocResp.get("code") == 0 && allocResp.get("invoices") != null)
								{
									for each  otherInvoice in allocResp.get("invoices")
									{
										otherInvoiceID = otherInvoice.get("invoice_id");
										otherInvoiceNumber = otherInvoice.get("invoice_number");
										otherInvoiceStatus = otherInvoice.get("status");
										otherBalanceValue = otherInvoice.get("balance");
										if(remainingCredit > 0 && otherInvoiceID != invoiceID && otherBalanceValue != null && otherInvoiceStatus != "draft" && otherInvoiceStatus != "void")
										{
											otherBalance = otherBalanceValue.toDecimal();
											if(otherBalance > 0)
											{
												amountForOther = otherBalance;
												if(remainingCredit < otherBalance)
												{
													amountForOther = remainingCredit;
												}
												amountForOther = amountForOther.round(currencyPrecision);
												otherApplyMap = Map();
												otherApplyMap.put("invoice_id",otherInvoiceID);
												otherApplyMap.put("amount_applied",amountForOther);
												applyInvoiceList.add(otherApplyMap);
												remainingCredit = (remainingCredit - amountForOther).round(currencyPrecision);
												info "Surplus Rs " + amountForOther + " allocated to " + otherInvoiceNumber + ".";
											}
										}
									}
								}
								else
								{
									info "NOTE: could not read other open invoices - Rs " + remainingCredit.round(currencyPrecision) + " stays as unused customer credit.";
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
									url :apiEndPoint + "/creditnotes/" + newCNID + "/invoices?organization_id=" + organizationID
									type :POST
									parameters:applyParams
									connection:"zerp"
								];
								apiCallCount = apiCallCount + 1;
								if(applyResp != null && applyResp.containsKey("code") && applyResp.get("code") == 0)
								{
									info "SUCCESS: allocated. Unused customer credit remaining Rs " + remainingCredit.round(currencyPrecision) + ".";
								}
								else
								{
									info "MANUAL REVIEW NEEDED: Credit Note " + newCNNumber + " was created but could not be applied. Apply it by hand.";
								}
							}
							else
							{
								info "SUCCESS: the whole Credit Note stays as unused customer credit.";
							}
						}
						else
						{
							info "MANUAL REVIEW NEEDED: could not create the Credit Note. This customer may be missing their cash discount - create it by hand.";
							info newCNResp;
						}
					}
				}
			}
		}
	}
}
info "========================================";
info "TOTAL API CALLS : " + apiCallCount;
if(dryRun == true)
{
	info "DRY RUN COMPLETE - NOTHING WAS WRITTEN.";
}
info "ACME AUTO CASH DISCOUNT - UNIFIED ENGINE END";
info "========================================";
