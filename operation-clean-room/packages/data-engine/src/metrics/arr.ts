/**
 * Annual Recurring Revenue (ARR) calculation.
 *
 * ARR is the annualized value of all active recurring subscriptions.
 * Calculation must handle several edge cases:
 *
 * - **Trials**: Subscriptions in trial status should be excluded by default
 *   (configurable via options).  Trials that convert mid-month need careful
 *   handling -- the ARR should reflect only the post-conversion period.
 *
 * - **Multi-year deals**: Some subscriptions are billed annually or multi-
 *   annually.  The ARR for a 2-year deal at $24,000 is $12,000 (annualized),
 *   not $24,000.  Use the plan's billing period to normalize.
 *
 * - **Prorations**: Mid-month plan changes create prorated invoices.  ARR
 *   should reflect the *current* plan rate, not the prorated amount.
 *
 * - **FX conversion**: Non-USD subscriptions must be converted using the
 *   FX rate as of the calculation date.  This means ARR can fluctuate even
 *   with no subscription changes if exchange rates move.
 *
 * - **Addons**: Recurring addons contribute to ARR and should be included.
 *
 * - **Discounts**: Active coupons reduce the effective ARR.  Expired coupons
 *   mean the customer's ARR increases to the list price.
 *
 * - **Paused subscriptions**: Typically excluded from ARR but may be included
 *   if the pause is temporary and the customer is expected to resume.
 *
 * @param date - The as-of date for the ARR calculation
 * @param options - Calculation options (segmentation, exclusions, etc.)
 * @returns ARR result with total and breakdowns
 */

import type { ARRResult, ARRBreakdown, MetricOptions } from './types.js';
import { loadChargebeeSubscriptions } from '../ingestion/chargebee.js';
import { convertToUSD } from '../utils/fx.js';
import { loadCSV } from '../ingestion/csv-loader.js';
import type { FXRate } from '../ingestion/types.js';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), '../../data');
// console.log('DATA DIR', DATA_DIR);

// console.log('ARR Loading from-', DATA_DIR);

export async function calculateARR(
  date: Date,
  options?: MetricOptions,
): Promise<ARRResult> {
  const [subscriptions, fxRates] = await Promise.all([
    loadChargebeeSubscriptions(DATA_DIR),
    loadCSV<FXRate>(join(DATA_DIR, 'fx_rates.csv'), {
      transform: (row) => ({
        date: row['date'] ?? '',
        eur_usd: parseFloat(row['eur_usd'] ?? '1'),
        gbp_usd: parseFloat(row['gbp_usd'] ?? '1'),
        jpy_usd: parseFloat(row['jpy_usd'] ?? '1'),
        aud_usd: parseFloat(row['aud_usd'] ?? '1'),
      }),
    }).catch(() => [] as FXRate[]),
  ]);

  // console.log('ARR Subscriptions loaded-', subscriptions.length);
// console.log('ARR Sample subs-', JSON.stringify(subscriptions[0], null, 2));  // ADD THIS LINE

  const dateStr = date.toISOString().split('T')[0]!;

  // Accumulators keyed by label
  const planMap = new Map<string, { arr: number; count: number }>();
  const regionMap = new Map<string, { arr: number; count: number }>();
  const segmentMap = new Map<string, { arr: number; count: number }>();
  const cohortMap = new Map<string, { arr: number; count: number }>();
  const arrPerCustomer: number[] = [];

  let totalARR = 0;
  let totalCustomers = 0;

  for (const sub of subscriptions) {
    if (sub.status === 'cancelled' || sub.status === 'paused') continue;
    if (options?.excludeTrials !== false && sub.status === 'in_trial') continue;
    // if (sub.current_term_end && sub.current_term_end < dateStr) continue;
    // if (sub.current_term_start > dateStr) continue;

    const mrrDollars = sub.mrr / 100;
    let mrrUSD: number;
    try {
      mrrUSD = convertToUSD(mrrDollars, sub.plan.currency, date, fxRates);
    } catch {
      mrrUSD = mrrDollars;
    }

    const arr = mrrUSD * 12;
    totalARR += arr;
    totalCustomers++;
    arrPerCustomer.push(arr);

    // Plan breakdown
    const planLabel = sub.plan?.plan_name ?? sub.plan?.plan_id ?? 'Unknown';
    const planEntry = planMap.get(planLabel) ?? { arr: 0, count: 0 };
    planMap.set(planLabel, { arr: planEntry.arr + arr, count: planEntry.count + 1 });

    // Region breakdown
    const region = sub.customer.billing_address?.country ?? 'Unknown';
    const regionEntry = regionMap.get(region) ?? { arr: 0, count: 0 };
    regionMap.set(region, { arr: regionEntry.arr + arr, count: regionEntry.count + 1 });

    // Segment breakdown (from plan name)
    const label = planLabel.toLowerCase();
const segment = label.includes('enterprise')
  ? 'Enterprise'
  : label.includes('pro')
  ? 'Mid-Market'
  : 'SMB';
    const segEntry = segmentMap.get(segment) ?? { arr: 0, count: 0 };
    segmentMap.set(segment, { arr: segEntry.arr + arr, count: segEntry.count + 1 });

    // Cohort breakdown (signup month)
    const cohort = sub.created_at.slice(0, 7);
    const cohortEntry = cohortMap.get(cohort) ?? { arr: 0, count: 0 };
    cohortMap.set(cohort, { arr: cohortEntry.arr + arr, count: cohortEntry.count + 1 });
  }

  // Convert maps to ARR breakdown arrays
  function toBreakdown(map: Map<string, { arr: number; count: number }>): ARRBreakdown[] {
    return Array.from(map.entries()).map(([label, { arr, count }]) => ({
      label,
      arr: Math.round(arr * 100) / 100,
      customerCount: count,
      percentOfTotal: totalARR > 0 ? Math.round((arr / totalARR) * 10000) / 100 : 0,
    }));
  }

  // Median calculation
  const sorted = [...arrPerCustomer].sort((a, b) => a - b);
  const median = sorted.length > 0
    ? (sorted.length % 2 === 0
      ? ((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2)
      : sorted[Math.floor(sorted.length / 2)]!)
    : 0;

  return {
    total: Math.round(totalARR * 100) / 100,
    asOfDate: dateStr,
    totalCustomers,
    avgARRPerCustomer: totalCustomers > 0 ? Math.round((totalARR / totalCustomers) * 100) / 100 : 0,
    medianARRPerCustomer: Math.round(median * 100) / 100,
    byPlan: toBreakdown(planMap),
    byRegion: toBreakdown(regionMap),
    bySegment: toBreakdown(segmentMap),
    byCohort: toBreakdown(cohortMap),
  };
}