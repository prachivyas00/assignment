/**
 * Cross-system duplicate detection.
 *
 * Identifies accounts and subscriptions that exist in multiple billing
 * systems (Stripe and Chargebee) with overlapping active periods.  This
 * is a critical reconciliation step because:
 *
 * - **Double-counting revenue**: If the same customer has active
 *   subscriptions in both Stripe and Chargebee, ARR will be overstated
 *   unless duplicates are identified and de-duplicated.
 *
 * - **Migration artifacts**: When customers were migrated from one billing
 *   system to another, the old subscription may not have been properly
 *   cancelled, resulting in a "ghost" subscription that inflates metrics.
 *
 * - **Intentional dual subscriptions**: In rare cases a customer may
 *   legitimately have subscriptions in both systems (e.g., different
 *   products or business units).  The deduplication engine should flag
 *   these but allow classification.
 *
 * The classifier should distinguish between:
 * - `true_duplicate`: Same customer, overlapping active periods, same product.
 * - `migration`: Same customer, sequential subscriptions with a gap,
 *   indicating a system migration.
 * - `uncertain`: Cannot be definitively classified; needs human review.
 *
 * @module reconciliation/deduplication
 */

import type { DuplicateResult } from './types.js';
import type { StripePayment, ChargebeeSubscription } from '../ingestion/types.js';
import { calculateConfidence } from './matcher.js';

/** Options for duplicate detection. */
export interface DeduplicationOptions {
  /** Name match confidence threshold (0-1). Defaults to 0.7. */
  nameThreshold?: number;
  /** Maximum gap in days between subscriptions to consider a migration. Defaults to 30. */
  migrationGapDays?: number;
  /** Whether to include cancelled subscriptions. Defaults to true. */
  includeCancelled?: boolean;
}

/** Summarise all payments for one Stripe subscription into a date range. */
interface StripeSubscriptionSummary {
  customerId: string;
  customerName: string;
  subscriptionId: string;
  firstPaymentDate: Date;
  lastPaymentDate: Date;
  mrr: number;
  status: string;
}

/** Group individual Stripe payment rows by subscription id */
function groupStripeBySubscription(
  payments: StripePayment[],
): StripeSubscriptionSummary[] {
  const map = new Map<string, StripeSubscriptionSummary>();

  for (const payment of payments) {
    const subId = payment.subscription_id;
    if (!subId) continue;

    const paymentDate = new Date(payment.payment_date);

    if (!map.has(subId)) {
      map.set(subId, {
        customerId: payment.customer_id,
        customerName: payment.customer_name,
        subscriptionId: subId,
        firstPaymentDate: paymentDate,
        lastPaymentDate: paymentDate,
        mrr: payment.amount / 100,
        status: payment.status,
      });
    } else {
      const existing = map.get(subId)!;
      if (paymentDate < existing.firstPaymentDate) existing.firstPaymentDate = paymentDate;
      if (paymentDate > existing.lastPaymentDate) existing.lastPaymentDate = paymentDate;
    }
  }

  return Array.from(map.values());
}

/** Add N months to a date */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Return the number of overlapping days between two date ranges */
function calcOverlapDays(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): number {
  const overlapStart = new Date(Math.max(startA.getTime(), startB.getTime()));
  const overlapEnd = new Date(Math.min(endA.getTime(), endB.getTime()));
  if (overlapEnd <= overlapStart) return 0;
  return Math.round(
    (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Detect potential duplicates across Stripe and Chargebee.
 */
export async function detectDuplicates(
  stripeData: StripePayment[],
  chargebeeData: ChargebeeSubscription[],
  options?: DeduplicationOptions,
): Promise<DuplicateResult[]> {
  const nameThreshold = options?.nameThreshold ?? 0.5;
  const results: DuplicateResult[] = [];

  const stripeSubscriptions = groupStripeBySubscription(stripeData);

  for (const stripeSub of stripeSubscriptions) {
    // first payment to last payment + 1 month
    const stripeStart = stripeSub.firstPaymentDate;
    const stripeEnd = addMonths(stripeSub.lastPaymentDate, 1);

    for (const cbSub of chargebeeData) {
      if (
        !options?.includeCancelled &&
        cbSub.status === 'cancelled'
      ) continue;

      // Fuzzy name match between Stripe customer name and Chargebee company name
      const confidence = await calculateConfidence(
        { id: stripeSub.customerId, name: stripeSub.customerName },
        { id: cbSub.customer.customer_id, name: cbSub.customer.company ?? '' },
      );

      if (confidence.score < nameThreshold) continue;

      const cbStart = new Date(cbSub.current_term_start);
      const cbEnd = cbSub.current_term_end
        ? new Date(cbSub.current_term_end)
        : new Date('2099-12-31');

      const overlapDays = calcOverlapDays(stripeStart, stripeEnd, cbStart, cbEnd);
      const hasOverlap = overlapDays > 0;

      const result: DuplicateResult = {
        stripeRecord: {
          customerId: stripeSub.customerId,
          customerName: stripeSub.customerName,
          subscriptionId: stripeSub.subscriptionId,
          status: stripeSub.status,
          startDate: stripeStart.toISOString().split('T')[0]!,
          endDate: stripeEnd.toISOString().split('T')[0]!,
          mrr: stripeSub.mrr,
        },
        chargebeeRecord: {
          customerId: cbSub.customer.customer_id,
          customerName: cbSub.customer.company ?? '',
          subscriptionId: cbSub.subscription_id,
          status: cbSub.status,
          startDate: cbSub.current_term_start,
          endDate: cbSub.current_term_end,
          mrr: cbSub.mrr / 100,
        },
        confidence,
        hasOverlap,
        overlapDays,
        classification: 'uncertain',
      };

      result.classification = classifyDuplicate(result);
      results.push(result);
    }
  }

  return results;
}

/**
 * Classify a detected duplicate as true_duplicate, migration, uncertain.
 */
export function classifyDuplicate(
  duplicate: DuplicateResult,
): 'true_duplicate' | 'migration' | 'uncertain' {
  // Overlapping active periods = true duplicate
  if (duplicate.hasOverlap && duplicate.overlapDays > 7) {
    return 'true_duplicate';
  }

  // Sequential subscriptions with a small gap = migration
  const stripeEnd = duplicate.stripeRecord.endDate
    ? new Date(duplicate.stripeRecord.endDate)
    : null;
  const cbStart = new Date(duplicate.chargebeeRecord.startDate);

  if (stripeEnd) {
    const gapDays = Math.round(
      (cbStart.getTime() - stripeEnd.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (gapDays >= 0 && gapDays <= 30) {
      return 'migration';
    }
  }

  return 'uncertain';
}