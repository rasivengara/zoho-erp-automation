# Zoho Finance Automation & Credit Risk Suite

Production Zoho Deluge automations that run the receivables side of a B2B LED-lighting distribution business on Zoho Books / Zoho Inventory — dynamic credit limits, early-payment discounts, overdue aging, and quarterly turnover rebates.

These scripts replaced a set of manual, spreadsheet-driven decisions across a book of roughly 270 dealers. They are event-driven and scheduled backend functions that talk to the Zoho REST API, not UI macros.

> **Language note:** files carry a `.js` extension purely so GitHub renders syntax highlighting. The language is **Zoho Deluge**, which is C-like but not JavaScript.

---

## The problem

In high-volume B2B distribution, a credit limit set by hand becomes a guess within weeks. Discounts get calculated by memory at the counter. Overdue aging is only as fresh as the last person who ran a report. Quarterly rebates get paid to dealers who technically qualified and shouldn't have.

Every one of those is a small error that repeats a few hundred times a quarter.

## The approach

One measured number drives everything: **APD**, the average number of days a dealer actually takes to settle money owed.

```
paidAPD     amount-weighted (last_payment_date - invoice_date)
            over bills FULLY SETTLED in a rolling closure window

pendingAPD  amount-weighted age of everything still owed,
            including a pending opening balance

riskAPD  =  max(paidAPD, pendingAPD)
```

Both halves are measurements taken from documents. An earlier version computed APD as `outstanding balance / payment velocity` — a DSO ratio, which a single large cheque could move by twenty days without any change in behaviour, and which *punished* a good dealer for placing a large order. The `max()` is what closes the remaining loophole: clearing small new bills quickly while a large old one rots no longer reads as good payment behaviour.

The same APD is computed identically in the credit engine, the quote check and the rebate scheme, so a dealer is never judged by two different numbers.

---

## Scripts

### `credit-risk/`

| File | Type | Trigger |
|---|---|---|
| [`AUTO_CREDIT_LIMIT_ENGINE.js`](credit-risk/AUTO_CREDIT_LIMIT_ENGINE.js) | Workflow function | Customer Payment — created / edited / deleted |
| [`SCHEDULED_CREDIT_LIMIT_BATCH.js`](credit-risk/SCHEDULED_CREDIT_LIMIT_BATCH.js) | Scheduled, 4 batches | Nightly, whole book |
| [`AUTO_QUOTE_CREDIT_CHECK.js`](credit-risk/AUTO_QUOTE_CREDIT_CHECK.js) | Workflow function | Quote — on create |

**Credit limit engine.** Recalculates a dealer's limit from measured payment behaviour every time they pay. `riskAPD` maps through a continuous target-days curve — no band cliffs — multiplied by the dealer's own rolling payment velocity and constrained by a portfolio concentration cap. Minimum Payment Today is solved by bisection from the same inputs, so the limit and the payment ask cannot disagree. **Stateless:** the existing limit is never an input, so a bad run cannot compound.

**Scheduled batch.** The same core methodology across every customer overnight, so dealers who *haven't* paid recently don't keep a stale limit. It doubles as the calibration tool: run it with `dryRun = true` and it prints the weighted-average target days the current curve produces — that figure *is* the resting DSO of the whole book, so the curve is designable rather than guessable.

**Quote credit check.** Answers one question at the counter: can this quote be billed, and if not, what is the *smallest* payment that would let it be? It offers two routes and quotes whichever is cheaper for the dealer — the full recovery solve, or an "express" route that bills this order plus a slice of the old balance, where the slice is a factor read off the dealer's own APD. Express is safe by construction: the money coming in always exceeds the goods going out, so exposure falls by exactly the surcharge on every express bill.

### `receivables/`

| File | Type | Trigger |
|---|---|---|
| [`AUTO_CASH_DISCOUNT_UNIFIED.js`](receivables/AUTO_CASH_DISCOUNT_UNIFIED.js) | Workflow function | Customer Payment — created / edited / deleted |
| [`AUTO_INVOICE_EVENT_HANDLER.js`](receivables/AUTO_INVOICE_EVENT_HANDLER.js) | Workflow function | Invoice — created / edited / deleted |
| [`SCHEDULED_OVERDUE_AGING_BATCH.js`](receivables/SCHEDULED_OVERDUE_AGING_BATCH.js) | Scheduled, 4 batches | Nightly, whole book |

**Cash discount, unified.** Three workflow rules point at one function. Zoho does not tell a function which event fired, so the script never asks — it asks whether the payment still *exists*. If it does, it recomputes what the discount should be right now and converges on that state: create it, correct it, remove it, or leave it alone. If it doesn't, it reverses. Because it always recomputes from the invoice's real state, a payment can be edited any number of times in any order and still land correctly — the design is immune to event ordering and to log replays. A FIFO guard withholds the discount when older unpaid debt exists.

**Invoice event handler.** Refreshes credit limit, Minimum Payment Today and aging the moment a bill is raised, instead of leaving them stale until morning — by *invoking* the real engines, never by copying them. It deliberately does nothing on payment events (already handled in real time) and nothing on drafts. Its one unique job is pulling back a cash discount when an invoice is voided or deleted.

**Overdue aging batch.** Rewrites the single aging field collections staff actually read, for every customer, every morning. Balance is bucketed by payment term, with the longest term broken down further by age, and a pending opening balance given a bucket of its own.

### `rebates/`

| File | Type | Trigger |
|---|---|---|
| [`QUARTERLY_TOD_SCHEME.js`](rebates/QUARTERLY_TOD_SCHEME.js) | Workflow / on-demand | Customer |

Calculates a dealer's quarterly turnover discount and posts it as a credit note inside a fixed posting window — preview before it, expired after it, so the same script cannot double-pay. Net eligible purchases are gross sales minus returns, filtered at **line-item level** to eligible brands and paginated across the quarter. If more data exists than the page cap allows, posting is **blocked** rather than calculated on partial data. Eligibility is OR logic (`APD < 75` **or** nothing aged past 75 days), and the rebate is auto-allocated to the oldest outstanding invoices.

---

## Engineering notes

**Fail closed, not quietly.** The recurring bug class in this project was a read that returns nothing silently, and code that treats "found nothing" as "there is nothing". `GET /invoices` does not return a customer's opening balance at all — so a dealer whose entire debt *was* an opening balance read as clean on the aging field, and read as having no old debt to the FIFO guard. Every script now reads the opening balance explicitly, and an incomplete read aborts the write instead of writing a number derived from partial data.

**One measurement, one implementation.** An early version of the rebate script carried its own copy of the APD calculation and kept a fixed-window bug for four versions after it had been fixed everywhere else. Copies of a measurement drift. The invoice handler therefore calls the real engines rather than caching their logic, and the shared credit methodology sits between `CORE START` / `CORE END` markers that must stay byte-identical across the credit scripts.

**Rate limits are an organisation-wide resource.** Zoho throttles on cumulative org traffic, so a batch that succeeds alone can still take down every other automation. Batches are sized from measured call counts (each run prints its own), paginate at `per_page=200`, and are spaced 30 minutes apart — spacing matters more than batch size.

**`dryRun` everywhere.** Every write-capable script decides everything and logs exactly what it *would* do without touching the books. Each one was shadow-run beside the script it replaced before being allowed to write.

---

## Running these

1. Create a Zoho OAuth **connection** with Books/Inventory scopes. These scripts reference it as `zerp` — rename to match yours.
2. Create the custom fields the scripts write to: `cf_average_payment_days`, `cf_min_payment_today`, `cf_overdue_aging` (contacts) and `cf_credit_check` (quotes).
3. Replace the placeholders described below with your own values.
4. Attach each script per the trigger table above. Scheduled scripts are created under the Customers module; the selected customer is ignored.
5. **Leave `dryRun = true`, run, and read the logs before changing it.** The credit curve in particular must be re-fitted against your own book before it writes.

## Sanitization

This is a public copy of production code. Replaced with placeholders:

| Placeholder | Was |
|---|---|
| `ACME DISTRIBUTION` | company name |
| `DEALER-A` … `DEALER-J` | real customer names in worked examples |
| `BRAND_ONE`, `BRAND_TWO` | eligible product brands |
| `<TOD_DISCOUNT_ACCOUNT_ID>`, `<OPENING_BALANCE_INVOICE_ID>`, `<LEGACY_PAYMENT_ID>` | Zoho record IDs |

Whole-book financial totals have been removed or expressed as multiples of monthly sales. Rupee figures that remain are illustrative examples, not live company data. `dryRun` ships as `true` in every copy here.

## On AI assistance

These scripts were designed, written and debugged with heavy use of LLMs, and I'd rather say so than not. What that did and didn't cover is worth being precise about: AI scaffolded API structures, pagination loops and Deluge syntax quickly, and was a fast sounding board for algorithm shape. It did not find the opening-balance bug, decide that a DSO ratio was the wrong risk measure, or know that a rebate could be bought with a well-timed cheque. Those came from reading live logs against a real book and from knowing the business. The judgment about what to measure was mine; the speed of getting it into production was not mine alone.

## Contact

Mohamed Rasi P — [linkedin.com/in/mohamedrasip](https://linkedin.com/in/mohamedrasip)
