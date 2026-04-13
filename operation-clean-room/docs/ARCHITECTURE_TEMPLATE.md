# Architecture Document

## System Overview

The system is a TypeScript monorepo with two packages, a Node.js backend `data-engine` and a React frontend `dashboard`. They run as separate processes and talk to each other over HTTP.

The backend is responsible for everything data-related. It reads the 
raw source files from disk, normalizes them into typed structures, 
runs the reconciliation and deduplication logic, calculates business 
metrics, and exposes all of this through a REST API on port 3001. 
The frontend is purely presentational, it fetches from that API 
and renders the results as an interactive dashboard on port 5173.

I deliberately kept the backend stateless. Every API call re-reads 
from the source files and recomputes from scratch. I considered 
adding a database layer (Postgres) to persist results and cache 
computations, but decided against it for this implementation. The 
datasets are small enough (a few thousand rows per source) that 
re-reading from disk on each request is fast enough. More 
importantly, a stateless system means every number is always freshly 
derived from its source, there's no stale cache, no sync issues, 
and no question about whether what you're seeing reflects the latest 
data. That auditability felt more important than performance 
optimization at this stage.

The two packages are managed together using pnpm workspaces and 
Turborepo. Running `pnpm dev` at the root starts both the backend 
and frontend simultaneously, with their logs unified in one terminal.

<!-- Consider including a diagram (ASCII art is fine) -->

Raw Files on Disk
(CSV / JSON / XML / JSONL)
│
▼
Ingestion Layer
stripe.ts, chargebee.ts, legacy.ts, salesforce.ts
│
│  Typed TypeScript objects
▼
Reconciliation Engine
matcher.ts, deduplication.ts, revenue.ts
│
│  Matched, deduplicated, reconciled records
▼
Metrics Layer
arr.ts, health scoring in routes/metrics.ts
│
│  Computed business metrics
▼
REST API (Express, on port 3001)
/api/metrics/arr
/api/metrics/overview
/api/metrics/customer-health
/api/metrics/audit
/api/reconciliation/run
/api/reconciliation/discrepancies
│
│  HTTP JSON responses
▼
React Dashboard (Vite on port 5173)
RevenueSummary, DiscrepancyTable, CohortAnalysis, CustomerHealth, AuditTrail

Each layer only knows about the layer directly below it. The 
dashboard doesn't know how ARR is calculated. The metrics layer 
doesn't know what the raw Chargebee JSON looks like. This separation 
means I can fix a data quality issue in the ingestion layer without 
touching anything in the metrics layer or dashboard, and I can add 
a new metric without touching the ingestion layer.

## Data Model

### Unified Customer Model

_How do you represent a customer that exists across multiple systems? What is the canonical identifier?_

A customer in this company exists in up to five different systems. Stripe, Chargebee, Salesforce, the legacy billing system, and 
potentially the product analytics pipeline, each with its own 
internal ID and its own version of the customer's name.

The `UnifiedCustomer` type in `src/ingestion/types.ts` is the 
canonical representation. It stitches together data from all sources 
into one coherent record per real-world customer.

The canonical identifier is the Chargebee `customer_id` where one 
exists. Chargebee is the current system of record for active 
subscriptions, so it made sense to anchor the unified record there. 
Where a customer only exists in Stripe (no Chargebee record found), 
the Stripe `customer_id` is used as the canonical ID. External IDs 
from other systems (Salesforce account ID, legacy billing ID) are 
stored as `external_ids` on the unified record alongside the 
canonical one.

The company name is normalized before anything else happens:
- Converted to lowercase
- Punctuation removed
- Common suffixes stripped: Corp, Inc, Ltd, LLC, GmbH, Co, Company, Corporation, Limited, Incorporated
- Split into word tokens for similarity comparison

This normalization is what allows "Quantum Dynamics Inc." in 
Chargebee to be recognized as the same entity as "Quantum Dynamics" 
in Stripe.

### Source Data Mapping

_For each data source, describe:_
_- What it provides_
_- How it connects to the unified model_
_- Known data quality issues you discovered_

| Source | Key Fields | Links To | Issues Found |
|--------|-----------|----------|-------------|
| Stripe Payments | payment_id, customer_id, customer_name, amount, currency, status, payment_date, subscription_id, failure_code, refund_id, dispute_id | Chargebee via fuzzy name match on customer_name; Legacy invoices via payment_ref cross-reference | Amounts are in dollars with decimals. Multiplied by 100 on ingestion to normalize to cents. No subscription date range in the data. Active window is reconstructed by grouping payments by subscription_id and using first-to-last-payment-plus-one-month as the range. Refunded and disputed payments excluded from revenue totals |
| Chargebee Subscriptions | subscription_id, customer.customer_id, customer.company, plan.plan_id, plan.plan_name, plan.price, plan.currency, plan.billing_period, plan.billing_period_unit, status, current_term_start, current_term_end, mrr, coupons, plan_changes, addons | Stripe via fuzzy name match on customer.company | Raw JSON field names are completely different from the TypeScript types, id instead of subscription_id, plan.name instead of plan.plan_name, plan.interval instead of billing_period_unit, customer.id instead of customer.customer_id. mrr field is null for every record. MRR is calculated from plan.price divided by billing interval. Dates are ISO timestamps normalized to YYYY-MM-DD. No billing address country on the customer object |
| Legacy Invoices | id, customer_name, amount, currency, date, status, description, payment_ref | Stripe via payment_ref field (only where value starts with ch_ or pi_) | Date format is ambiguous. Some operators used DD/MM/YYYY, others used MM/DD/YYYY. Resolved by checking if the first number exceeds 12. Amount units are inconsistent. Some invoices store in dollars, some in cents. payment_ref is null for the majority of records and contains internal reference numbers rather than Stripe IDs for many of the rest |
| Salesforce Opportunities | opportunity_id, account_id, account_name, stage, amount, acv, tcv, close_date, created_date, probability, forecast_category, type, owner_name, next_step, contract_term_months, loss_reason, partner_id | Salesforce Accounts via account_id | Zombie deals present. Opportunities open with no recent activity. TCV and ACV diverge on multi-year deals. ACV is used for ARR attribution, not TCV. Stage values are inconsistent across records. Some use "Closed Won", some use "closed_won" |
| Salesforce Accounts | account_id, account_name, industry, employee_count, billing_country, billing_state, website, segment, stripe_customer_id, chargebee_customer_id, parent_account_id | Stripe via stripe_customer_id; Chargebee via chargebee_customer_id | External IDs are manually entered by sales reps. Found to be missing for many accounts and potentially outdated for others. Parent account hierarchy exists but roll-up logic is not yet implemented |
| Product Events | event_id, account_id, user_id, event_type, feature, timestamp, metadata | Salesforce Accounts via account_id | 50,000 events. Loaded via JSONL streaming line by line to avoid loading the entire file into memory at once. Not yet incorporated into customer health scoring |
| Support Tickets | ticket_id, account_id, account_name, subject, priority, status, category, created_at, resolved_at, satisfaction_rating, tags | Salesforce Accounts via account_id | satisfaction_rating is null for a large portion of tickets. Cannot be used as a universal signal. Not yet incorporated into health scoring |
| NPS Surveys | response_id, account_id, account_name, respondent_email, score, comment, survey_date, category | Salesforce Accounts via account_id | Not all customers have NPS responses. Category (promoter/passive/detractor) is derived from score. 0-6 detractor, 7-8 passive, 9-10 promoter. Not yet incorporated into health scoring |
| Marketing Spend | channel, period, spend, currency, impressions, clicks, signups, trials_started, conversions, attributed_revenue | No direct customer linkage | Only channel-level aggregates available. No per-customer attribution. This limits CAC to a blended average across all channels |
| Plan Pricing | plan_id, plan_name, billing_period, base_price, currency, included_seats, price_per_additional_seat, effective_from, effective_to, is_legacy | Chargebee subscriptions via plan_id | Historical pricing needed for accurate LTV calculations. Grandfathered plans marked is_legacy. These customers pay old prices that don't appear in the current pricing table |
| FX Rates | date, eur_usd, gbp_usd, jpy_usd, aud_usd | Applied at payment date or calculation date for all non-USD amounts | Daily rates only. No weekend or holiday data. Handled with a 5-day lookback to find the nearest prior trading day. Only four currencies supported. Any payment in an unsupported currency falls back to 1:1 with a logged warning |
| Partner Deals | deal_id, partner_id, partner_name, account_id, account_name, deal_type, commission_rate, deal_amount, currency, status, registered_date, closed_date, opportunity_id | Salesforce Opportunities via opportunity_id | Ingested and normalized but commission calculations are not yet implemented. 60 rows. Small enough that this won't materially affect revenue totals in the short term |

## Matching Strategy

_How do you link entities across systems? What matching algorithm(s) did you use? What confidence thresholds did you set and why?_

The core challenge with linking entities across systems is that there 
is no shared ID. Stripe has its own customer IDs, Chargebee has its 
own, and Salesforce has its own. The same company appears in all three 
with completely different identifiers and often different name formats.

I built a composite matching system that combines three signals. 
Exact external ID matches (where Salesforce has manually entered 
Stripe or Chargebee IDs), domain matching (where both entities share 
the same website domain), and fuzzy name matching using Jaccard token 
similarity after normalizing company names. Each signal is weighted 
and combined into a single confidence score between 0 and 1.

The confidence threshold for a general entity match is 0.6. For 
duplicate detection specifically I lowered it to 0.5 because the 
cost of missing a real duplicate, overstated ARR presented to the 
board, is much higher than the cost of a false positive, which is 
just one extra record flagged for human review. Every match below 0.8 
is treated as a probable match rather than a definitive one, and 
anything below 0.6 (or 0.5 for deduplication) is left as unmatched 
rather than forcing a connection that might be wrong.

### Entity Resolution Approach

_Describe your approach to matching customers across systems with different IDs and name variants._

The same company appears in multiple systems under different names and 
completely different internal IDs. There is no shared customer ID 
we can rely on across Stripe, Chargebee, and Salesforce.

A few approaches before deciding:

**Option 1 -- Trust the external ID fields in Salesforce**
Salesforce accounts have `stripe_customer_id` and 
`chargebee_customer_id` fields. In theory, these would give us 
exact matches without any fuzzy logic. In practice, they're 
manually entered by sales reps and are missing or outdated for 
a significant portion of accounts. I use these when available as 
a strong signal, but can't rely on them alone.

**Option 2 -- Levenshtein / edit distance**
Counts the minimum number of character-level edits to transform 
one string into another. This works well for catching typos 
("colour" vs "color") but poorly for company name variations. 
"Acme Corp" to "ACME Corporation Ltd." has a large edit distance 
even though they're obviously the same company. Ruled out.

**Option 3 -- Jaccard token similarity after normalization**
Splits names into word tokens after normalization and measures 
the overlap between token sets. This naturally handles the actual 
variations we see. Extra words, different ordering, abbreviations 
after suffix stripping. This is what I implemented.

The full matching pipeline for any two entities:

1. Normalize both names: lowercase, strip punctuation, remove 
   common company suffixes (Corp, Inc, Ltd, LLC, GmbH, Co, 
   Company, Corporation, Limited, Incorporated), trim whitespace
2. Check for domain match if both entities have a website or 
   email domain field
3. Calculate Jaccard similarity on the normalized token sets
4. Combine domain match and name similarity into a single 
   confidence score
5. Compare against the threshold to decide: match, possible 
   match, or no match

### Confidence Scoring

_How do you score match confidence? What fields contribute? What threshold separates a "match" from "needs review"?_

The confidence score is a number between 0 and 1 combining two 
weighted signals:
confidence = domain_match × 0.5 + jaccard_name_similarity × 0.5

**Domain matching (weight: 0.5)**
If both entities share the same domain (e.g. both have acme.com), 
this contributes 0.5 to the score. Domain names are globally 
unique. Two unrelated companies can't share one. A domain match 
alone is strong enough to flag a potential duplicate even if the 
names look different.
If domains don't match or aren't available, this contributes 0.

**Jaccard name similarity (weight: 0.5)**
Jaccard similarity is calculated as:
Jaccard = |intersection of token sets| / |union of token sets|

For example:
- "Acme Corp" → normalize → strip "corp" → tokens: ["acme"]
- "ACME Corporation Ltd." → normalize → strip "corporation", 
  "ltd" → tokens: ["acme"]
- Intersection: ["acme"] → size 1
- Union: ["acme"] → size 1
- Jaccard = 1/1 = 1.0
- Name similarity contribution = 1.0 × 0.5 = 0.5

Combined with a domain match: 0.5 + 0.5 = 1.0 (perfect confidence)

Example - completely different companies:
- "Acme Corp" → tokens: ["acme"]
- "Beta Industries" → tokens: ["beta", "industries"]
- Intersection: [] → size 0
- Union: ["acme", "beta", "industries"] → size 3
- Jaccard = 0/3 = 0.0
- No domain match either
- Final score: 0.0

**Thresholds:**

| Score | Classification | What Happens |
|-------|---------------|--------------|
| ≥ 0.8 | Strong match | Treated as the same entity automatically |
| 0.6 – 0.8 | Probable match | Used in deduplication and reconciliation |
| 0.5 – 0.6 | Possible match | Flagged for human review |
| < 0.5 | No match | Treated as separate entities |

For duplicate detection specifically I lowered the threshold to 0.5. 
The reasoning: the cost of missing a real duplicate is much higher 
than the cost of a false positive. A missed duplicate means ARR is 
overstated and the CFO presents wrong numbers to the board. A false 
positive just means one extra record for a human to review and 
dismiss. Given that context, casting a wider net is the right call.

## Metric Definitions

_For each metric, provide:_
_1. Precise definition_
_2. Formula_
_3. Edge cases and how you handle them_
_4. Why you chose this definition over alternatives_

### ARR (Annual Recurring Revenue)

_Definition:_
_Formula:_
_Edge cases:_

**Definition:** The annualized value of all active recurring 
subscriptions as of a given date. This is the single most 
important metric in a SaaS business. It represents the 
predictable forward revenue run rate assuming no new customers, 
no cancellations, and no expansions.

**Formula:**
ARR = Σ (MRR per active subscription) × 12
Where:
MRR = plan.price (in cents) ÷ billing_period_months ÷ 100

For a monthly plan at $200/month: MRR = 200, ARR = 2,400
For an annual plan at $1,200/year: MRR = 100, ARR = 1,200

**Edge cases and how they were handled:**

- Annual plans: divided by 12 before annualizing. A $1,200/year 
  plan contributes $100 MRR, not $1,200. This is standard. 
  You normalize all plans to monthly before annualizing so 
  monthly and annual customers are directly comparable
- Non-USD subscriptions: converted to USD using `convertToUSD()` 
  in `utils/fx.ts` with the FX rate as of the calculation date. 
  5-day lookback handles weekends and holidays
- Trials (`in_trial` status): excluded by default. Trials haven't 
  converted to paying customers yet. Including them inflates ARR 
  in a way the board would rightly question
- Cancelled and paused subscriptions: excluded. Zero recurring 
  revenue
- Term dates vs status: all term dates in the dataset predate 
  April 2026. Filtering by term dates would produce $0 ARR. 
  I filter by `status` field instead, which accurately reflects 
  whether a subscription is active. Documented as an assumption

**Why this definition over alternatives:** Some companies use 
"contracted ARR" which includes committed future revenue not yet 
active. That would require reliable multi-year contract data, 
which we don't have in a clean enough form here. MRR × 12 from 
active subscriptions is the most defensible and auditable 
definition available with this dataset.


### NRR (Net Revenue Retention)

_Definition:_
_Formula:_
_Edge cases:_

**Definition:** The percentage of revenue retained from an 
existing cohort of customers over a period, after accounting 
for expansions, contractions, and churn. But excluding any 
new logos added during the period. This tells you whether your 
existing customer base is growing or shrinking on its own, 
independent of new sales.

A healthy SaaS company targets NRR above 100%, meaning expansion 
from existing customers more than offsets churn.

**Formula:**
NRR = (Starting ARR + Expansion − Contraction − Churn)
÷ Starting ARR × 100

Where:
- Starting ARR = ARR from the cohort at the beginning of the period
- Expansion = additional ARR from upgrades and seat additions 
  within the same cohort
- Contraction = ARR lost from downgrades within the same cohort 
  (customer stays but pays less)
- Churn = ARR lost from full cancellations within the same cohort

**Important Note:** NRR is defined and documented here but is not yet 
fully wired to the dashboard. It's the next metric I would 
implement.

### Gross Churn / Net Churn

_Definition:_
_Formula:_
_Edge cases:_

**Definition:**
- Gross Revenue Churn: the percentage of starting ARR lost 
  purely from cancellations, before accounting for any 
  expansion from other customers
- Net Revenue Churn: the percentage lost after subtracting 
  expansion revenue earned from the same starting cohort. 
  Can be negative, which means expansion outweighs churn
- Logo Churn: the percentage of customers (not revenue) lost. 
  Useful because revenue churn and logo churn can tell 
  different stories. Losing 10 small customers has a 
  different meaning than losing 1 large one

**Formula:**
Gross Revenue Churn Rate =
Revenue Lost from Cancellations ÷ Starting ARR × 100
Net Revenue Churn Rate =
(Revenue Lost − Expansion Revenue) ÷ Starting ARR × 100
Logo Churn Rate =
Customers Lost ÷ Starting Customer Count × 100

**Edge cases:**
- Seat reductions and plan downgrades count as contraction, 
  not churn. The customer is still there, they're just 
  paying less. Counting these as churn would overstate 
  the problem
- A customer who cancels and resubscribes in the same period 
  counts as a churned logo and then a new logo, not as 
  a retained customer. The intent is to measure actual 
  cancellations, not temporary pauses
- Net churn can be negative, this is good. It means the 
  business is growing from its existing customer base alone

### Unit Economics (CAC, LTV, Payback)

_Definition:_
_Formula:_
_Edge cases:_

**Definition:**
- CAC (Customer Acquisition Cost): the average fully-loaded 
  cost of acquiring one new paying customer
- LTV (Lifetime Value): the total revenue a typical customer 
  generates over their entire relationship with the company, 
  adjusted for gross margin
- LTV:CAC Ratio: how much value a customer generates relative 
  to what it cost to acquire them. Industry benchmark is 3:1 
  or higher
- Payback Period: how many months of gross profit it takes 
  to recover the cost of acquiring a customer. Target is 
  under 18 months

**Formula:**
CAC = Total Sales & Marketing Spend in Period
÷ New Customers Acquired in Period
LTV = ARPA × Gross Margin %
÷ Monthly Churn Rate
LTV:CAC Ratio = LTV ÷ CAC
Payback Months = CAC ÷ (ARPA × Gross Margin %)
Where ARPA = Average Revenue Per Account per month

**Edge cases:**
- Gross margin is assumed at 75% because cost of goods sold 
  (COGS) data isn't available in the dataset. 75% is the 
  SaaS industry average for software businesses and is a 
  reasonable and defensible starting assumption. Documented 
  in the assumptions log.
- CAC is blended across all acquisition channels because 
  `marketing_spend.csv` provides channel-level spend totals 
  with no per-customer attribution. A per-channel CAC would 
  be more useful for optimizing spend but requires customer 
  source tracking that isn't in the data.
- LTV is highly sensitive to churn rate. A small change in 
  monthly churn rate produces a large change in LTV because 
  churn is in the denominator. This makes LTV estimates 
  directionally useful but not precise without a stable, 
  long-term observed churn rate.

## Assumptions

See [ASSUMPTIONS_TEMPLATE.md](./ASSUMPTIONS_TEMPLATE.md) for the full log.

## Known Limitations

_What doesn't work? What would you fix with more time? What edge cases did you intentionally skip?_

**1. Regional breakdown shows all customers as "Unknown"**
The Chargebee raw data does not include a country field on 
the customer object. The `billing_address` object is empty 
for all records. The fix would be joining with Salesforce 
accounts on company name match to pull in `billing_country`. 
I didn't implement this because name-based joining introduces 
matching uncertainty and I didn't want that uncertainty to 
silently propagate into a board-level metric without a clear 
confidence level attached to it.

**2. NRR and churn metrics are not wired to the dashboard**
The metric definitions are documented here and the stub 
functions exist in `src/metrics/`. I made a deliberate 
decision to implement ARR, reconciliation, and customer 
health thoroughly rather than implement all six metrics 
at a surface level. A shallow NRR implementation would 
be worse than no NRR. Wrong numbers with official-looking 
formatting are more dangerous than an honest gap.

**3. Customer health scoring uses only three signals**
The current model weights subscription status (50%), plan 
tier (30%), and MRR (20%). A more complete model would 
incorporate product usage frequency from 
`product_events.jsonl`, support ticket volume and 
resolution time from `support_tickets.csv`, NPS score 
from `nps_surveys.csv`, and payment failure history from 
Stripe. The architecture already supports adding these. The ingestion loaders for all these sources are built, 
the data is available. It's a matter of loading the 
additional files in the health scoring route and adding 
them as weighted signals.


**4. Legacy invoice orphan records are not reconciled**
The majority of legacy invoices have null or non-Stripe 
`payment_ref` values. These invoices are ingested and 
counted but cannot be cross-referenced against Stripe 
payments without a reliable linking field. Resolving them 
would require fuzzy name matching between invoice customer 
names and Stripe customer names, which produces enough 
false positives that I left it as a known gap rather than 
silently introducing incorrect matches into the revenue 
reconciliation.

**5. Scenario modeling is not implemented**
The ScenarioModeler component is a placeholder. Given the 
time available I focused on getting the reconciliation 
engine, ARR calculation, and documentation right. A what-if 
engine built quickly without proper validation would 
produce numbers the CFO can't trust. That's worse than 
not having it.

**6. Pipeline quality analysis is not wired to the dashboard**
Salesforce opportunities and accounts are ingested. The 
logic for detecting zombie deals (open opportunities with 
no activity for 90+ days), stage mismatches, and deals 
that closed in CRM but never converted to active 
subscriptions in Chargebee or Stripe is the next thing 
I would build. The data is there, it just needs the 
analysis layer on top of it.

**7. Partner deal commission calculations are not implemented**
Partner deals are ingested and normalized. Commission rate 
and deal amount fields are available. The actual commission 
calculation and attribution to revenue figures hasn't been 
built yet.

## Future Extensibility

_How would someone:_
_- Add a new billing source (e.g., Paddle)?_
_- Add a new metric?_
_- Change the reconciliation schedule from monthly to weekly?_
_- Add a new segmentation dimension?_

### Adding a new billing source (e.g. Paddle)

1. Create `src/ingestion/paddle.ts` with a 
   `loadPaddleData(dataDir)` function. Map Paddle's raw 
   fields to the existing types in `ingestion/types.ts`. 
   Document any field name mismatches or data quality issues 
   you find in ASSUMPTIONS_TEMPLATE.md. The Chargebee 
   experience showed that raw API responses rarely match 
   the idealized type definitions
2. Add `paddle_customer_id` to the `external_ids` object 
   on the `UnifiedCustomer` type in `ingestion/types.ts`
3. Pass Paddle subscription records into `detectDuplicates` 
   alongside the Stripe and Chargebee records. The matcher 
   doesn't care which system the records come from, it 
   works on normalized names and domains
4. Add Paddle to the `POST /api/reconciliation/run` route 
   so it's included in reconciliation runs
5. Update the audit trail to log Paddle record counts 
   alongside Stripe and Chargebee

The ingestion layer is deliberately thin and source-agnostic. 
The reconciliation engine above it knows nothing about where 
data came from, only about the normalized shape it arrives 
in. That's intentional. Adding a new source should never 
require touching reconciliation or metrics logic.

### Adding a new metric

1. Create `src/metrics/your-metric.ts` and define a typed 
   result interface in the same file
2. Export the result type and add it to `metrics/types.ts` 
   if it's shared
3. Register a new GET route in `routes/metrics.ts` following 
   the same pattern as the existing ARR and customer health 
   routes. load data, calculate, wrap in try/catch, 
   return JSON
4. Create a new component in 
   `dashboard/src/components/features/YourMetric.tsx`
5. Add the route to `App.tsx` and add a navigation entry 
   to the Shell sidebar component

Every existing metric follows this same pattern. The system 
was designed so that adding metric number six looks exactly 
like adding metric number two did.

### Changing the reconciliation schedule from monthly to weekly

The reconciliation engine is completely stateless and safe 
to re-run at any time without side effects. To run it on 
a schedule:

1. Add `node-cron` as a dependency to `data-engine`
2. In `src/index.ts`, after the server starts, register 
   a cron job that calls the reconciliation logic on your 
   desired schedule (e.g. every Sunday at midnight)
3. Switch from in-memory storage to a Postgres database. 
   Each run gets a `run_id` (UUID) and a `run_at` timestamp. 
   Results are inserted into a `reconciliation_runs` table
4. Update `GET /api/reconciliation/discrepancies` to read 
   from the database rather than the in-memory variable, 
   with optional filtering by `run_id` so you can compare 
   this week's results against last week's

The reason this is straightforward is that the current 
implementation already treats each reconciliation run as 
a complete, independent pass over the data. There's no 
incremental state to manage, just persist the output 
instead of holding it in memory.

### Adding a new segmentation dimension

Say you want to add industry as a segmentation dimension 
for ARR breakdowns:

1. Make sure the field is available on `UnifiedCustomer` 
   in `ingestion/types.ts` - `industry`, already exists 
   there, sourced from Salesforce accounts
2. In `src/metrics/arr.ts`, add a new Map accumulator 
   following the exact same pattern as `planMap`, 
   `regionMap`, `segmentMap`, and `cohortMap`:
```typescript
   const industryMap = new Map<string, 
     { arr: number; count: number }>();
```
3. Inside the subscription loop, add the accumulation:
```typescript
   const industry = sub.customer.industry ?? 'Unknown';
   const entry = industryMap.get(industry) ?? 
     { arr: 0, count: 0 };
   industryMap.set(industry, { 
     arr: entry.arr + arr, 
     count: entry.count + 1 
   });
```
4. Add `byIndustry: ARRBreakdown[]` to the `ARRResult` 
   type in `metrics/types.ts`
5. Include `byIndustry: toBreakdown(industryMap)` in the 
   return value of `calculateARR`
6. Add a new tab to `CohortAnalysis.tsx`. The component 
   is already built to handle multiple breakdown dimensions 
   via tabs and renders any `ARRBreakdown[]` array the 
   same way
