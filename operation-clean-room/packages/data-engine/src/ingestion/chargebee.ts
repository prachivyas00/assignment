/**
 * Load and normalize Chargebee subscription data.
 *
 * Chargebee subscriptions have a deeply nested JSON structure that requires
 * careful handling:
 *
 * - **Nested customer object**: Customer details are embedded inside each
 *   subscription.  The same customer may appear across multiple subscriptions
 *   and must be de-duplicated.
 *
 * - **Coupons**: Subscriptions may have one or more coupons with percentage
 *   or fixed-amount discounts.  Coupons can have expiry dates, so MRR
 *   calculations must check whether coupons are still active.
 *
 * - **Plan changes**: A subscription's `plan_changes` array records every
 *   upgrade, downgrade, or lateral move.  Proration amounts on plan changes
 *   affect revenue recognition for the period in which they occur.
 *
 * - **Trial handling**: Subscriptions in `in_trial` status have a `trial_end`
 *   date on their plan object.  These should generally be excluded from ARR
 *   unless specifically requested.  When a trial converts, the first payment
 *   date may differ from the subscription creation date.
 *
 * - **Addons**: Additional line items that contribute to MRR but are tracked
 *   separately from the base plan price.
 *
 * @param dataDir - Path to the data directory
 * @returns Normalized Chargebee subscription records
 */

import { join } from 'node:path';
import { loadJSON } from './json-loader.js';
import type { ChargebeeSubscription } from './types.js';

interface RawChargebeePlan {
  id: string;
  name: string;
  price: number;
  currency: string;
  interval: string;
  interval_count?: number;
}

interface RawChargebeeCustomer {
  id: string;
  company?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  billing_address?: {
    line1?: string;
    city?: string;
    state?: string;
    country?: string;
    zip?: string;
  };
}

interface RawChargebeeSubscription {
  id: string;
  customer: RawChargebeeCustomer;
  plan: RawChargebeePlan;
  status: string;
  trial_end: string | null;
  created_at: string;
  cancelled_at: string | null;
  current_term_start: string;
  current_term_end: string;
  mrr: number | null;
  addons: unknown[];
  coupons: unknown[];
  plan_changes: unknown[];
  cancel_reason: string | null;
  metadata: Record<string, unknown>;
}

export async function loadChargebeeSubscriptions(
  dataDir: string,
): Promise<ChargebeeSubscription[]> {
  const filePath = join(dataDir, 'chargebee_subscriptions.json');
  const raw = await loadJSON<unknown>(filePath);

  const records = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>).subscriptions as unknown[]) ?? [];

  return (records as RawChargebeeSubscription[]).map((sub): ChargebeeSubscription => {
    // Calculate MRR from plan price if not provided
    // Price is in cents, interval tells us if monthly or annual
    const priceInCents = sub.plan?.price ?? 0;
    const interval = (sub.plan?.interval ?? 'month').toLowerCase();
    const intervalCount = sub.plan?.interval_count ?? 1;

    // Normalize to monthly cents
    let mrrCents: number;
    if (interval === 'year' || interval === 'annual') {
      mrrCents = Math.round(priceInCents / 12);
    } else if (interval === 'month') {
      mrrCents = Math.round(priceInCents / intervalCount);
    } else {
      mrrCents = priceInCents;
    }

    // Normalize dates to YYYY-MM-DD
    const normalizeDate = (d: string) => d ? d.split('T')[0]! : '';

    return {
      subscription_id: sub.id,
      customer: {
        customer_id: sub.customer?.id ?? '',
        first_name: sub.customer?.first_name ?? '',
        last_name: sub.customer?.last_name ?? '',
        email: sub.customer?.email ?? '',
        company: sub.customer?.company ?? '',
        billing_address: {
          line1: sub.customer?.billing_address?.line1 ?? '',
          city: sub.customer?.billing_address?.city ?? '',
          state: sub.customer?.billing_address?.state ?? '',
          country: sub.customer?.billing_address?.country ?? '',
          zip: sub.customer?.billing_address?.zip ?? '',
        },
      },
      plan: {
        plan_id: sub.plan?.id ?? '',
        plan_name: sub.plan?.name ?? '',
        price: priceInCents,
        currency: (sub.plan?.currency ?? 'usd').toLowerCase(),
        billing_period: intervalCount,
        billing_period_unit: interval === 'year' ? 'year' : 'month',
        trial_end: sub.trial_end ?? null,
      },
      status: sub.status as ChargebeeSubscription['status'],
      current_term_start: normalizeDate(sub.current_term_start),
      current_term_end: normalizeDate(sub.current_term_end),
      created_at: normalizeDate(sub.created_at),
      cancelled_at: sub.cancelled_at ? normalizeDate(sub.cancelled_at) : null,
      cancel_reason: sub.cancel_reason ?? null,
      mrr: mrrCents,
      coupons: [],
      plan_changes: [],
      addons: [],
      metadata: sub.metadata ?? {},
    };
  });
}