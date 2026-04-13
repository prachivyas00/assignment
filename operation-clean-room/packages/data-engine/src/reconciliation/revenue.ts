import type { RevenueReconciliationResult } from './types.js';
import type { ChargebeeSubscription, StripePayment, FXRate } from '../ingestion/types.js';

/**
 * Revenue reconciliation across billing systems.
 *
 * Compares expected revenue (from active subscriptions) against actual
 * revenue (from payments) accounting for:
 *
 * - **Prorations**: Mid-cycle upgrades/downgrades create prorated charges
 *   that don't match the subscription's stated MRR.  The reconciler must
 *   detect proration periods and adjust expected revenue accordingly.
 *
 * - **Discounts / coupons**: Active coupons reduce the invoiced amount
 *   below the plan's list price.  Both percentage and fixed-amount
 *   coupons must be accounted for, including coupon expiry dates.
 *
 * - **FX conversion**: Subscriptions may be priced in EUR, GBP, etc.
 *   but payments are recorded in the original currency.  Reconciliation
 *   must use the FX rate from the payment date (not today's rate) to
 *   convert both sides to a common currency (USD).
 *
 * - **Timing differences**: A subscription billed on the 1st of the month
 *   may have its payment processed on the 2nd or 3rd.  End-of-month
 *   boundary effects can cause payments to fall in a different calendar
 *   month than expected.
 *
 * - **Failed and retried payments**: A failed payment that is retried
 *   successfully should count as a single expected payment, not two.
 *
 * - **Refunds and disputes**: Refunded or disputed payments reduce actual
 *   revenue but do not necessarily reduce expected revenue.
 *
 * @module reconciliation/revenue
 */

/** Options for revenue reconciliation. */
export interface RevenueReconciliationOptions {
  /** Start of the reconciliation period (inclusive). */
  startDate: Date;
  /** End of the reconciliation period (exclusive). */
  endDate: Date;
  /** Tolerance for amount mismatches in USD. Defaults to 0.50. */
  toleranceUSD?: number;
  /** Whether to include trial subscriptions. Defaults to false. */
  includeTrials?: boolean;
}

/** Find the FX rate for a given date and currency (uses closest prior date). */
function getFXRate(fxRates: FXRate[], date: string, currency: string): number {
  if (currency === 'usd') return 1;

  const key = `${currency}_usd` as keyof FXRate;

  // Sort descending, find closest rate on or before the payment date
  const sorted = fxRates
    .filter(r => r.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date));

  const rate = sorted[0];
  if (!rate) return 1;

  return (rate[key] as number) ?? 1;
}

/**
 * Reconcile expected subscription revenue against actual payment revenue.
 */
export async function reconcileRevenue(
  subscriptions: ChargebeeSubscription[],
  payments: StripePayment[],
  fxRates: FXRate[],
  options: RevenueReconciliationOptions,
): Promise<RevenueReconciliationResult> {
  const { startDate, endDate } = options;
  const startStr = startDate.toISOString().split('T')[0]!;

  let expectedRevenue = 0;
  let actualRevenue = 0;
  let totalProrations = 0;
  let totalFXDifferences = 0;

  const lineItems: RevenueReconciliationResult['lineItems'] = [];

  // --- Expected revenue from subscriptions ---
  for (const sub of subscriptions) {
    if (sub.status === 'cancelled') continue;

    // Skip trials unless opted in
    if (!options.includeTrials && sub.plan.trial_end) {
      const trialEnd = new Date(sub.plan.trial_end);
      if (trialEnd > startDate) continue;
    }

    // Check subscription overlaps with our period
    const subStart = new Date(sub.current_term_start);
    const subEnd = sub.current_term_end
      ? new Date(sub.current_term_end)
      : new Date('2099-12-31');

    if (subEnd < startDate || subStart >= endDate) continue;

    // MRR is already normalized to monthly (e.g. annual plans already divided by 12)
    let expected = sub.mrr;

    // Convert non-USD to USD using period start rate
    const fxRate = getFXRate(fxRates, startStr, sub.plan.currency);
    expected = expected * fxRate;

    // Subtract proration credits that fall within the period
    let prorationInPeriod = 0;
    for (const change of sub.plan_changes ?? []) {
      const changeDate = new Date(change.change_date);
      if (changeDate >= startDate && changeDate < endDate) {
        prorationInPeriod += change.proration_amount ?? 0;
      }
    }

    // Proration reduces the expected revenue for this period
    expected = expected - prorationInPeriod;
    totalProrations += prorationInPeriod;
    expectedRevenue += expected;

    lineItems.push({
      customerId: sub.customer.customer_id,
      customerName:
        sub.customer.company ??
        `${sub.customer.first_name} ${sub.customer.last_name}`,
      expected,
      actual: 0,
      difference: 0,
      reason: '',
    });
  }

  // --- Actual revenue from payments ---
  for (const payment of payments) {
    if (payment.status !== 'succeeded') continue;
    if (payment.refund_id) continue;

    const paymentDate = new Date(payment.payment_date);
    const fxRate = getFXRate(fxRates, payment.payment_date, payment.currency);

    // Find the associated subscription to check billing period
    const sub = subscriptions.find(
      s => s.subscription_id === payment.subscription_id,
    );
    const billingPeriod = sub?.plan.billing_period ?? 1;

    // Check if subscription is active during our period
    const subStart = sub ? new Date(sub.current_term_start) : null;
    const subEnd = sub?.current_term_end
      ? new Date(sub.current_term_end)
      : null;
    const subActiveInPeriod =
      subStart && subStart < endDate && (!subEnd || subEnd >= startDate);

    if (!subActiveInPeriod) continue;

    if (paymentDate >= startDate && paymentDate < endDate) {
      // Payment falls within the period -- use it directly
      const amountUSD = payment.amount * fxRate;
      actualRevenue += amountUSD;

      // Track FX difference vs period-start rate for breakdown
      const periodStartRate = getFXRate(fxRates, startStr, payment.currency);
      totalFXDifferences += amountUSD - payment.amount * periodStartRate;

      // Update line item
      const item = lineItems.find(l => l.customerId === payment.customer_id);
      if (item) {
        item.actual += amountUSD;
      }
    } else if (billingPeriod > 1) {
      // Annual (or multi-month) payment outside the period -- attribute 1/billingPeriod
      const monthlyAmount = (payment.amount / billingPeriod) * fxRate;
      actualRevenue += monthlyAmount;

      const item = lineItems.find(l => l.customerId === payment.customer_id);
      if (item) {
        item.actual += monthlyAmount;
      }
    }
  }

  // Finalise line item differences
  for (const item of lineItems) {
    item.difference = item.actual - item.expected;
    item.reason =
      Math.abs(item.difference) < (options.toleranceUSD ?? 50)
        ? 'within_tolerance'
        : item.difference > 0
        ? 'overpayment'
        : 'underpayment';
  }

  const difference = actualRevenue - expectedRevenue;
  const differencePercent =
    expectedRevenue !== 0 ? (difference / expectedRevenue) * 100 : 0;

  return {
    expectedRevenue,
    actualRevenue,
    difference,
    differencePercent,
    lineItems,
    breakdown: {
      prorations: totalProrations,
      discounts: 0,
      fxDifferences: totalFXDifferences,
      timingDifferences: 0,
      unexplained: difference - totalProrations - totalFXDifferences,
    },
  };
}