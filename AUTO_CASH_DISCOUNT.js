dryRun = false;
cdSameDay = 3.0;
cdWithin8 = 2.5;
cdWithin15 = 1.5;
cdWithin30 = 1.0;
cdWithin45 = 0.5;
roundingTolerance = 1.00;
currencyPrecision = 0;
fifoIgnoresDueOnReceipt = true;
showFifoNoteOnCN = true;
cnPageList = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
cdDetailReadCap = 40;
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
info "AUTO CASH DISCOUNT - UNIFIED ENGINE V5.2";
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
							cdNewRefMap.put(cnID,cnReference);
							cdNumberMap.put(cnID,cnNumber);
						}
						else
						{
							headerText = cnReason + " ~ " + cnReference;
							if(headerText.contains("AUTO-CD-"))
							{
								cdLegacyMap.put(cnID,headerText);
								cdNumberMap.put(cnID,cnNumber);
							}
							else if(cdDetailReadsUsed >= cdDetailReadCap)
							{
								cdIndexIncomplete = true;
							}
							else
							{
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
	if(cdOBReadFailed == true)
	{
		info "OPENING BALANCE : could not be read. FIFO cannot see it this run - treat any discount created now as unverified.";
	}
	else if(cdOBBalance > 0)
	{
		info "OPENING BALANCE : Rs " + cdOBBalance + " open, dated " + cdOBDateStr + " - counts for FIFO.";
	}
	else
	{
		info "OPENING BALANCE : none open for this customer.";
	}
}
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
			info "LEGACY CASH DISCOUNT PRESENT : " + legacyCNNumber;
			info "This invoice already carries an old-format cash discount that has been sent to the customer. It is left completely untouched, and no new discount is created beside it. Review by hand if it genuinely needs correcting.";
		}
		else if(paymentStillExists == false)
		{
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
							readFailed = true;
							info "MANUAL REVIEW NEEDED: could not read the credits applied to invoice " + invoiceNumber + ". Nothing was changed.";
						}
					}
					effectiveBalance = liveBalance + ourCreditApplied;
					if(readFailed == false)
					{
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
						cdDescription = "Against Invoice " + invoiceNumber;
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
info "AUTO CASH DISCOUNT - UNIFIED ENGINE END";
info "========================================";
