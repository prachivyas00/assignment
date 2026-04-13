/**
 * Load and normalize Stripe payment data.
 *
 * Raw Stripe payments need normalization:
 * - Currency amounts may need FX conversion
 * - Failed payments with retries should be linked
 * - Refunds may appear as negative amounts or separate rows
 * - Dispute payments need special handling
 *
 * @param dataDir - Path to the data directory
 * @returns Normalized Stripe payment records
 */

import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import type { StripePayment } from './types.js';

export async function loadStripePayments(dataDir: string): Promise<StripePayment[]> {
  const filePath = join(dataDir, 'stripe_payments.csv');

  return loadCSV<StripePayment>(filePath, {
    transform: (row) => ({
      payment_id: row['payment_id'] ?? '',
      customer_id: row['customer_id'] ?? '',
      customer_name: row['customer_name'] ?? '',
      amount: Math.round(parseFloat(row['amount'] ?? '0') * 100),
      currency: (row['currency'] ?? 'usd').toLowerCase(),
      status: row['status'] ?? 'succeeded',
      payment_date: row['payment_date'] ?? '',
      subscription_id: row['subscription_id'] || null,
      description: row['description'] || null,
      failure_code: row['failure_code'] || null,
      refund_id: row['refund_id'] || null,
      dispute_id: row['dispute_id'] || null,
    }),
  });
}