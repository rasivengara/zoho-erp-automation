// ============================================================
// SCHEDULED OVERDUE AGING BATCH  -  v3.0  (batch 4 of 4)
// ------------------------------------------------------------
// Platform     Zoho Books / Zoho Inventory - Deluge, REST API v3
// Type         Scheduled function, created under the Customers
//              module (the selected customer is ignored)
// Schedule     Four copies, batchNumber 1-4. batchNumber is the
//              ONLY line that differs between the four copies.
// Writes       cf_overdue_aging on the contact
// ------------------------------------------------------------
// WHAT IT DOES
// Rewrites the single overdue-aging field that collection staff
// actually read, for every customer, every morning - so it is
// current even for customers who have not paid recently.
//
// The overdue balance is grouped by payment term (Due on Receipt,
// Net 20, Net 30, Net 60), with Net 60 broken down further by days
// since the invoice date (60-70, 70-80, 80-90, 90+). A pending
// opening balance gets a bucket of its own. Zero-value categories
// are left out of the text entirely.
//
// THE BUG v3.0 EXISTS TO FIX
// The script previously mixed two sources: the GATE read
// contact-level outstanding (which DOES include an opening
// balance) while the BUCKETS came only from GET /invoices (which
// does NOT). A customer carrying only an opening balance was
// therefore written "No overdue" - real pending money reported as
// clean, on the one field collections can see. Same family as the
// FIFO bug in the cash-discount engine: a read that returns
// nothing silently, and code that reads "found nothing" as "there
// is nothing".
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
// ####  BULK OVERDUE AGING V3.0  -  COPY 4 of 4
// ####  Run time 09:00   batchNumber = 4
// ############################################################
// Ready to paste as-is. NOTHING needs editing.
// batchNumber is the ONLY line that differs between the four.
// V3.0 added the pending OPENING BALANCE bucket, the reconciliation
// guard, and the fix for invoices with no due date.
// ############################################################

// ============================================================
// ACME BULK OVERDUE AGING - V3.0
// Create under Customers module. The selected customer is ignored.
//
// Refreshes the "Overdue Aging" field for every customer every
// morning, so it is always current even for customers who did not
// make a payment recently (the per-payment CUSTOMER OVERDUE AGING
// script only updates a customer when THEY pay).
//
// Overdue balance is grouped by payment term (Due on Receipt, Net 20,
// Net 30, Net 60), with Net 60 further broken down by days since the
// invoice date (60-70, 70-80, 80-90, 90+). A pending OPENING BALANCE
// gets a bucket of its own. Zero-value categories are left out of the
// text entirely.
//
// Uses the same 4-batch-of-100 pattern proven safe for
// BULK MINIMUM PAYMENT CHECK (Deluge's 200,000-statement ceiling).
//
// *** V3.0 (2026-08-17) - THE OPENING BALANCE BUG ***
// Found by the owner from a live BATCH 2 log: a customer who has not
// been billed an invoice this year but still carries a pending
// OPENING BALANCE was written "No overdue". Real pending money was
// reported as clean, on the one field collection staff can see.
//
// MEASURED BY PROBE C - OPENING BALANCE GAP, 268 customers:
//    99 customers carry a gap between the contact's own outstanding
//       and the sum of their invoice balances - a material sum in aggregate
//    86 of those were being told "No overdue", about half of that sum
//    13 were not lying outright but UNDERSTATED (DEALER-C
//       showed Rs 79,563 while Rs 51,147 more sat hidden)
//     0 negative gaps, so the arithmetic is exactly consistent
//
// WHY IT HAPPENED - the script mixed two different sources. The GATE
// was contact-level outstanding_receivable_amount, which DOES include
// an opening balance, so the customer was not skipped; the BUCKETS
// came only from GET /invoices. Same family as the FIFO bug: a read
// that returns nothing silently, and code that reads "found nothing"
// as "there is nothing".
//
// THE FACTS THAT MAKE THE FIX POSSIBLE (all from PROBE C, live):
//   1. GET /invoices does NOT return the opening balance. Confirmed
//      on DEALER-A: outstanding Rs 1,70,246, the invoice list
//      accounts for Rs 5,362, and the missing Rs 1,64,884 is the
//      opening balance.
//   2. The opening balance IS readable directly:
//         GET /invoices/<ob_invoice_id>
//      returning status overdue, date 2026-03-31, due_date
//      2026-03-31, total 175884, balance 164884, payment_terms 0.
//   3. ob_invoice_id lives on the contact under "opening_balances".
//   4. *** contact.opening_balance_amount is the ORIGINAL MIGRATED
//      FIGURE, NOT the current unpaid one *** - 175884 against a
//      true 164884. It may be used as a FLAG that an opening balance
//      exists; it must NEVER be used as the amount owed.
//   5. The gap arithmetic agrees to the rupee:
//         170246 - 5362 = 164884
//      so it is kept as the fallback whenever the direct read fails.
//
// THE OPENING BALANCE IS NOT "DUE ON RECEIPT". Its due_date equals
// its date and its payment_terms reads 0, which is exactly what a Due
// on Receipt invoice looks like. Filing it there would be wrong
// twice: it is not a same-day promise, and Due on Receipt carries a
// special meaning in the cash-discount engine. It gets its own
// bucket, aged in plain days from its own date.
//
// *** THE GUARD THAT STOPS THIS CLASS OF BUG COMING BACK ***
// After the buckets are built they are added up and compared with the
// contact's own outstanding balance. Any difference is written into
// the field as UNEXPLAINED rather than hidden. And the words
// "No overdue" are NEVER written while outstanding is positive - it
// now reads "No overdue (not yet due: Rs X)", which distinguishes
// "owes nothing" from "owes, but not yet".
//
// ALSO FIXED - A SECOND DEFECT IN THE SAME FILTER, independent of the
// opening balance: the old code required a non-empty due_date before
// an invoice reached the bucket logic, and the otherOverdue fallback
// only caught a missing INVOICE date. Any invoice with a blank due
// date was therefore dropped silently - not counted, not put in
// Other, not logged. It now goes to Other AND prints a log line.
//
// *** V2.1 (2026-08-17) - THE EXPENSIVE READ IS GONE ***
// V2.0 fetched the full invoice for EVERY overdue invoice just to
// read payment_terms, which the list summary does not return.
// payment_terms is simply due_date minus invoice date, and both are
// already on the list response, so the per-invoice read was removed.
//
// COST, V3.0 against V2.1 - close to neutral:
//   SAVED   one contact read for every customer with no balance. Q5
//           of PROBE C proved the CONTACTS LIST already carries
//           outstanding_receivable_amount, so the gate no longer
//           needs a detail read. BATCH 2 skipped 21 such customers.
//   SPENT   one invoice read per customer that actually has an
//           opening balance - 99 across the whole book, so roughly
//           25 per batch.
// Every run prints its own API CALLS THIS RUN - watch it, and size
// batchSize from that (lesson 13: code 44 comes from CUMULATIVE
// traffic, so spacing between the four runs matters more than size).
// ============================================================
organizationID = organization.get("organization_id");
apiEndPoint = organization.get("api_root_endpoint");
overdueAgingFieldAPIName = "cf_overdue_aging";
runDate = zoho.currentdate;
currencyPrecision = 0;
// Rupee tolerance for the buckets-versus-outstanding reconciliation.
// Anything larger is reported in the field, never swallowed.
reconcileTolerance = 1.0;
// This copy handles batch 1 of 4 (customers 1-100). Change ONLY
// batchNumber and the function name for the other 3 copies.
batchNumber = 4;
batchSize = 100;
pageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50};
apiCallCount = 0;
customersSkippedZeroBalance = 0;
customersUpdated = 0;
customersFailed = 0;
customersBlocked = 0;
customersWithOpeningBalance = 0;
customersOBReadFailed = 0;
customersUnexplained = 0;
openingBalanceRupees = 0.0;
batchStartIndex = (batchNumber - 1) * batchSize;
batchEndIndex = batchStartIndex + batchSize - 1;
contactIndex = 0;
batchComplete = false;
contactsMore = true;
info "========================================";
info "ACME BULK OVERDUE AGING V3.0 - BATCH " + batchNumber + " (size " + batchSize + ")";
info "========================================";
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
							contactStatus = contactSummary.get("status");
							if(contactStatus == "inactive" || customerID == null || customerID == "")
							{
								customersBlocked = customersBlocked + 1;
							}
							else
							{
								// ------------------------------------------------
								// THE GATE, V3.0 - taken from the LIST response.
								// PROBE C Q5 proved outstanding_receivable_amount
								// is on the list, so a customer who owes nothing
								// costs no detail read at all. The fallback is
								// kept in case a future Zoho change drops it.
								// ------------------------------------------------
								outstandingBalance = 0.0;
								gateReadOK = true;
								if(contactSummary.containsKey("outstanding_receivable_amount"))
								{
									if(contactSummary.get("outstanding_receivable_amount") != null)
									{
										outstandingBalance = contactSummary.get("outstanding_receivable_amount").toDecimal();
									}
								}
								else
								{
									gateResp = invokeurl
									[
										url :apiEndPoint + "/contacts/" + customerID + "?organization_id=" + organizationID
										type :GET
										connection:"zerp"
									];
									apiCallCount = apiCallCount + 1;
									if(gateResp != null && gateResp.containsKey("code") && gateResp.get("code") == 0 && gateResp.get("contact") != null)
									{
										gateContact = gateResp.get("contact");
										if(gateContact.get("outstanding_receivable_amount") != null)
										{
											outstandingBalance = gateContact.get("outstanding_receivable_amount").toDecimal();
										}
									}
									else
									{
										gateReadOK = false;
									}
								}
								if(gateReadOK == false)
								{
									customersFailed = customersFailed + 1;
									info "CONTACT READ FAILED : " + customerName;
								}
								else if(outstandingBalance <= 0)
								{
									customersSkippedZeroBalance = customersSkippedZeroBalance + 1;
								}
								else
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
										totalOverdue = 0.0;
										receiptOverdue = 0.0;
										net20Overdue = 0.0;
										net30Overdue = 0.0;
										net60Total = 0.0;
										net60_60to70 = 0.0;
										net60_70to80 = 0.0;
										net60_80to90 = 0.0;
										net60_90plus = 0.0;
										otherOverdue = 0.0;
										allInvoiceBalanceSum = 0.0;
										noDueDateCount = 0;
										customerError = false;
										hasMoreInvoices = true;
										for each  invoicePage in pageList
										{
											if(hasMoreInvoices == true)
											{
												invoiceListResp = invokeurl
												[
													url :apiEndPoint + "/invoices?organization_id=" + organizationID + "&customer_id=" + customerID + "&per_page=200&page=" + invoicePage
													type :GET
													connection:"zerp"
												];
												apiCallCount = apiCallCount + 1;
												if(invoiceListResp != null && invoiceListResp.containsKey("code") && invoiceListResp.get("code") == 0)
												{
													invoiceList = invoiceListResp.get("invoices");
													if(invoiceList != null)
													{
														for each  invoiceItem in invoiceList
														{
															invoiceStatus = invoiceItem.get("status");
															invoiceBalanceValue = invoiceItem.get("balance");
															dueDateStr = invoiceItem.get("due_date");
															invoiceDateStr = invoiceItem.get("date");
															invoiceNumberForLog = invoiceItem.get("invoice_number");
															if(invoiceNumberForLog == null)
															{
																invoiceNumberForLog = "(no number)";
															}
															if(invoiceStatus != "draft" && invoiceStatus != "void" && invoiceBalanceValue != null)
															{
																invoiceBalance = invoiceBalanceValue.toDecimal();
																if(invoiceBalance > 0)
																{
																	// Every open rupee is counted here, due or
																	// not. This total is what the reconciliation
																	// at the end is measured against.
																	allInvoiceBalanceSum = allInvoiceBalanceSum + invoiceBalance;
																	if(dueDateStr == null || dueDateStr == "")
																	{
																		// *** V3.0 - THE SECOND DEFECT ***
																		// This used to be dropped before it reached
																		// any bucket: not counted, not put in Other,
																		// not logged. It cannot be aged without a due
																		// date, so it goes to Other and says so.
																		noDueDateCount = noDueDateCount + 1;
																		totalOverdue = totalOverdue + invoiceBalance;
																		otherOverdue = otherOverdue + invoiceBalance;
																		info "NO DUE DATE : " + customerName + " | " + invoiceNumberForLog + " | Rs " + invoiceBalance.round(currencyPrecision) + " - counted in Other, cannot be aged.";
																	}
																	else
																	{
																		dueDate = dueDateStr.toDate("yyyy-MM-dd");
																		if(dueDate < runDate)
																		{
																			// *** V2.1 (2026-08-17) - NO MORE DETAIL READ ***
																			// This used to fetch the whole invoice just to read
																			// payment_terms, which is not on the list summary - one
																			// extra API call for EVERY overdue invoice, and the
																			// single biggest cost in this script.
																			// It is not needed. payment_terms is simply the gap
																			// between the invoice date and the due date, and BOTH
																			// are already on the list response:
																			//      Net 60 -> dated 17/08, due 16/10  = 60
																			//      Net 30 -> gap of 30
																			//      Due on Receipt -> due date IS the invoice date = 0
																			// Verified on live invoices 2026-08-17, including a Due
																			// on Receipt one that the cash-discount engine reported
																			// as terms 0 the same day.
																			// If a due date was overridden by hand, that gap is
																			// still the term actually applying to that invoice, so
																			// the grouping stays honest.
																			derivedTermDays = -1;
																			if(invoiceDateStr != null && invoiceDateStr != "")
																			{
																				invoiceDateForTerms = invoiceDateStr.toDate("yyyy-MM-dd");
																				derivedTermDays = invoiceDateForTerms.daysbetween(dueDate);
																			}
																			paymentTermsText = derivedTermDays.toString();
																			if(derivedTermDays < 0)
																			{
																				// No invoice date to measure from, so it cannot be
																				// classified - it goes to Other rather than being
																				// silently dropped.
																				totalOverdue = totalOverdue + invoiceBalance;
																				otherOverdue = otherOverdue + invoiceBalance;
																			}
																			else
																			{
																				totalOverdue = totalOverdue + invoiceBalance;
																				if(paymentTermsText == "0")
																				{
																					receiptOverdue = receiptOverdue + invoiceBalance;
																				}
																				else if(paymentTermsText == "20")
																				{
																					net20Overdue = net20Overdue + invoiceBalance;
																				}
																				else if(paymentTermsText == "30")
																				{
																					net30Overdue = net30Overdue + invoiceBalance;
																				}
																				else if(paymentTermsText == "60")
																				{
																					net60Total = net60Total + invoiceBalance;
																					if(invoiceDateStr != null && invoiceDateStr != "")
																					{
																						invoiceDate = invoiceDateStr.toDate("yyyy-MM-dd");
																						daysSinceInvoice = invoiceDate.daysbetween(runDate);
																						if(daysSinceInvoice <= 70)
																						{
																							net60_60to70 = net60_60to70 + invoiceBalance;
																						}
																						else if(daysSinceInvoice <= 80)
																						{
																							net60_70to80 = net60_70to80 + invoiceBalance;
																						}
																						else if(daysSinceInvoice <= 90)
																						{
																							net60_80to90 = net60_80to90 + invoiceBalance;
																						}
																						else
																						{
																							net60_90plus = net60_90plus + invoiceBalance;
																						}
																					}
																				}
																				else
																				{
																					otherOverdue = otherOverdue + invoiceBalance;
																				}
																			}
																		}
																	}
																}
															}
														}
													}
													invoicePageContext = invoiceListResp.get("page_context");
													if(invoicePageContext == null || invoicePageContext.get("has_more_page") != true)
													{
														hasMoreInvoices = false;
													}
												}
												else
												{
													customerError = true;
													hasMoreInvoices = false;
												}
											}
										}
										if(hasMoreInvoices == true)
										{
											customerError = true;
										}
										// ------------------------------------------------
										// *** V3.0 - THE PENDING OPENING BALANCE ***
										// opening_balance_amount is used ONLY as a flag. It
										// holds the ORIGINAL migrated figure (175884 on
										// DEALER-A) and not the current unpaid one
										// (164884), so it must never be reported as owed.
										//
										// The id sits in the nested "opening_balances"
										// object, read the same way this script has always
										// read page_context - a nested JSON object comes
										// back from invokeurl as a Map, which is why
										// invoicePageContext.get("has_more_page") a few
										// lines above has worked for months. PROBE C
										// printed the object in full:
										//   {"opening_balance_amount":175884.0,...,
										//    "ob_invoice_id":"<OPENING_BALANCE_INVOICE_ID>",...}
										// Every step is null-guarded, so a customer with
										// no opening balance, or an odd one, can never
										// abort the whole batch of 100.
										// ------------------------------------------------
										obBalance = 0.0;
										obAgeDays = -1;
										obIsOverdue = false;
										obReadFailed = false;
										obAmountFlagValue = contactData.get("opening_balance_amount");
										if(obAmountFlagValue != null && obAmountFlagValue.toDecimal() > 0)
										{
											obInvoiceID = "";
											obNested = contactData.get("opening_balances");
											if(obNested != null)
											{
												// *** DELUGE TYPE NOTE - 2026-08-17, found at paste time ***
												// obNested.get("ob_invoice_id") DOES NOT COMPILE. Zoho
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
													// obChunk now reads  :"<OPENING_BALANCE_INVOICE_ID>"  with the
													// key's own closing quote in front of it - three
													// punctuation characters to drop at the start, one at the
													// end.
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
														obDueStr = obDoc.get("due_date");
														if(obDateStr != null && obDateStr != "")
														{
															obAgeDays = obDateStr.toDate("yyyy-MM-dd").daysbetween(runDate);
														}
														if(obDueStr != null && obDueStr != "")
														{
															if(obDueStr.toDate("yyyy-MM-dd") < runDate)
															{
																obIsOverdue = true;
															}
														}
														else
														{
															// No due date on an opening balance means it
															// was payable from the day it was migrated.
															obIsOverdue = true;
														}
													}
												}
												else
												{
													obReadFailed = true;
												}
											}
											// FALLBACK, proven exact by PROBE C: the money
											// the invoice list cannot account for IS the
											// opening balance. Used only when the direct read
											// did not work, so a failed read costs the age
											// but never the amount.
											if(obBalance <= 0)
											{
												obGapAmount = outstandingBalance - allInvoiceBalanceSum;
												if(obGapAmount > reconcileTolerance)
												{
													obBalance = obGapAmount;
													obIsOverdue = true;
													obReadFailed = true;
												}
											}
											if(obBalance > 0)
											{
												customersWithOpeningBalance = customersWithOpeningBalance + 1;
												openingBalanceRupees = openingBalanceRupees + obBalance;
											}
											if(obReadFailed == true)
											{
												customersOBReadFailed = customersOBReadFailed + 1;
												info "OPENING BALANCE READ FAILED : " + customerName + " - fell back to the gap arithmetic, Rs " + obBalance.round(currencyPrecision) + ", age unknown.";
											}
										}
										if(obBalance > 0 && obIsOverdue == true)
										{
											totalOverdue = totalOverdue + obBalance;
										}
										if(customerError == true)
										{
											customersFailed = customersFailed + 1;
											info "DATA READ FAILED : " + customerName;
										}
										else
										{
											parts = List();
											if(totalOverdue > 0)
											{
												parts.add("Total: Rs " + totalOverdue.round(currencyPrecision));
											}
											if(obBalance > 0)
											{
												// Its own bucket. It is NOT Due on Receipt, even
												// though its due_date equals its date and its
												// payment_terms reads 0.
												if(obAgeDays >= 0)
												{
													parts.add("Opening Balance: Rs " + obBalance.round(currencyPrecision) + " (" + obAgeDays + "d)");
												}
												else
												{
													parts.add("Opening Balance: Rs " + obBalance.round(currencyPrecision) + " (age unknown)");
												}
											}
											if(receiptOverdue > 0)
											{
												parts.add("Due on Receipt: Rs " + receiptOverdue.round(currencyPrecision));
											}
											if(net20Overdue > 0)
											{
												parts.add("Net 20: Rs " + net20Overdue.round(currencyPrecision));
											}
											if(net30Overdue > 0)
											{
												parts.add("Net 30: Rs " + net30Overdue.round(currencyPrecision));
											}
											if(net60Total > 0)
											{
												net60Parts = List();
												if(net60_60to70 > 0)
												{
													net60Parts.add("60-70d: Rs " + net60_60to70.round(currencyPrecision));
												}
												if(net60_70to80 > 0)
												{
													net60Parts.add("70-80d: Rs " + net60_70to80.round(currencyPrecision));
												}
												if(net60_80to90 > 0)
												{
													net60Parts.add("80-90d: Rs " + net60_80to90.round(currencyPrecision));
												}
												if(net60_90plus > 0)
												{
													net60Parts.add("90+d: Rs " + net60_90plus.round(currencyPrecision));
												}
												net60Detail = "";
												for each  net60Piece in net60Parts
												{
													if(net60Detail == "")
													{
														net60Detail = net60Piece;
													}
													else
													{
														net60Detail = net60Detail + ", " + net60Piece;
													}
												}
												parts.add("Net 60: Rs " + net60Total.round(currencyPrecision) + " (" + net60Detail + ")");
											}
											if(otherOverdue > 0)
											{
												parts.add("Other: Rs " + otherOverdue.round(currencyPrecision));
											}
											// ------------------------------------------------
											// *** V3.0 - THE RECONCILIATION GUARD ***
											// The whole class of bug this version fixes was
											// money that no bucket had heard of. So the
											// buckets are added up and checked against the
											// contact's own outstanding figure, and any
											// difference is PUT IN THE FIELD. If some other
											// kind of receivable turns up in Zoho next year,
											// this says so on its own instead of hiding it.
											// ------------------------------------------------
											accountedFor = allInvoiceBalanceSum + obBalance;
											unexplainedAmount = outstandingBalance - accountedFor;
											if(unexplainedAmount > reconcileTolerance)
											{
												customersUnexplained = customersUnexplained + 1;
												parts.add("UNEXPLAINED: Rs " + unexplainedAmount.round(currencyPrecision));
												info "UNEXPLAINED BALANCE : " + customerName + " | outstanding Rs " + outstandingBalance.round(currencyPrecision) + " | invoices Rs " + allInvoiceBalanceSum.round(currencyPrecision) + " | opening balance Rs " + obBalance.round(currencyPrecision) + " | unaccounted Rs " + unexplainedAmount.round(currencyPrecision);
											}
											else if(unexplainedAmount < (0 - reconcileTolerance))
											{
												// Counted more than the customer owes. Not put
												// in the field - it would only confuse staff -
												// but it must be visible in the log.
												info "OVER-COUNTED : " + customerName + " | outstanding Rs " + outstandingBalance.round(currencyPrecision) + " | buckets add to Rs " + accountedFor.round(currencyPrecision) + " - check for a double count.";
											}
											agingText = "";
											for each  part in parts
											{
												if(agingText == "")
												{
													agingText = part;
												}
												else
												{
													agingText = agingText + " | " + part;
												}
											}
											if(agingText == "")
											{
												// *** NEVER SAY "No overdue" OVER REAL MONEY ***
												// The gate has already proved outstanding > 0 by
												// this point, so there IS a balance - it is just
												// not due yet. Staff need those two cases to
												// look different.
												agingText = "No overdue (not yet due: Rs " + outstandingBalance.round(currencyPrecision) + ")";
											}
											customFieldEntry = Map();
											customFieldEntry.put("api_name",overdueAgingFieldAPIName);
											customFieldEntry.put("value",agingText);
											customFieldList = List();
											customFieldList.add(customFieldEntry);
											updateMap = Map();
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
												info "UPDATED : " + customerName + " | " + agingText;
											}
											else
											{
												customersFailed = customersFailed + 1;
												info "FIELD UPDATE FAILED : " + customerName;
											}
										}
									}
									else
									{
										customersFailed = customersFailed + 1;
										info "CONTACT READ FAILED : " + customerName;
									}
								}
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
			info "ERROR: Customer list read failed.";
		}
	}
}
info "========================================";
info "BATCH " + batchNumber + " COMPLETE";
info "Skipped (zero balance) : " + customersSkippedZeroBalance;
info "Updated : " + customersUpdated;
info "Failed : " + customersFailed;
info "Blocked (inactive) : " + customersBlocked;
info "----------------------------------------";
info "With an opening balance : " + customersWithOpeningBalance + " | Rs " + openingBalanceRupees.round(currencyPrecision);
info "Opening balance read failed (gap fallback used) : " + customersOBReadFailed;
info "Customers with an UNEXPLAINED remainder : " + customersUnexplained;
info "API CALLS THIS RUN : " + apiCallCount;
info "========================================";
