/**
 * Load and normalize legacy billing system invoices.
 *
 * The legacy system was decommissioned but its historical data is critical
 * for accurate LTV calculations and reconciliation.  Key challenges:
 *
 * - **Ambiguous date formats**: The legacy system inconsistently used both
 *   DD/MM/YYYY and MM/DD/YYYY formats depending on the operator's locale.
 *   Dates like "03/04/2023" are genuinely ambiguous (March 4 vs April 3).
 *   Use contextual clues (surrounding dates, invoice sequences) to resolve.
 *   See `utils/date-parser.ts` for the disambiguation strategy.
 *
 * - **payment_ref cross-referencing**: Some invoices have a `payment_ref`
 *   field that contains a Stripe charge ID (e.g. "ch_3Ox...").  This allows
 *   linking legacy invoices to Stripe payments for reconciliation.  However,
 *   the field is often null or contains internal reference numbers that look
 *   similar but are NOT Stripe IDs.
 *
 * - **Currency inconsistencies**: Some invoices store amounts in cents while
 *   others store in whole units.  The `currency` field is sometimes missing
 *   or contains non-standard codes.
 *
 * - **Partial payments**: The legacy system supported partial payments,
 *   resulting in "partially_paid" statuses.  The `amount` field reflects
 *   the total invoice value, not the amount collected.
 *
 * @param dataDir - Path to the data directory
 * @returns Normalized legacy invoice records
 */

import { join } from 'node:path';
import { loadXML } from './xml-loader.js';
import type { LegacyInvoice } from './types.js';

interface RawInvoice {
  id: string | number;
  customer_name: string;
  amount: string | number;
  currency?: string;
  date: string;
  status: string;
  description?: string;
  payment_ref?: string;
}

interface InvoiceDoc {
  invoices: {
    invoice: RawInvoice[];
  };
}

/**
 * Attempt to parse ambiguous dates (DD/MM/YYYY vs MM/DD/YYYY).
 * If the day value > 12, it must be DD/MM/YYYY since months only go to 12.
 * Otherwise we default to MM/DD/YYYY (US format used by most of the data).
 */
function parseAmbiguousDate(raw: string): string {
  const parts = raw.split('/');
  if (parts.length === 3) {
    const a = parseInt(parts[0]!, 10);
    const b = parseInt(parts[1]!, 10);
    const year = parts[2]!;
    if (a > 12) {
      // Must be DD/MM/YYYY
      return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
    // Default to MM/DD/YYYY
    return `${year}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }
  // Already ISO or unrecognized -- return as-is
  return raw;
}

function normalizeStatus(raw: string): LegacyInvoice['status'] {
  const s = raw.toLowerCase().trim();
  if (s === 'paid') return 'paid';
  if (s === 'unpaid') return 'unpaid';
  if (s === 'overdue') return 'overdue';
  if (s === 'void' || s === 'voided') return 'void';
  if (s === 'partially_paid' || s === 'partial') return 'partially_paid';
  return 'unpaid';
}

export async function loadLegacyInvoices(dataDir: string): Promise<LegacyInvoice[]> {
  const filePath = join(dataDir, 'legacy_invoices.xml');

  const doc = await loadXML<InvoiceDoc>(filePath, {
    arrayTags: ['invoice'],
  });

  const raw = doc.invoices?.invoice ?? [];

  return raw.map((inv): LegacyInvoice => {
    const amount = typeof inv.amount === 'string'
      ? parseFloat(inv.amount)
      : inv.amount;

    // Amounts under 500 are likely in dollars, convert to cents
    const normalizedAmount = amount < 500
      ? Math.round(amount * 100)
      : Math.round(amount);

    const currency = (inv.currency ?? 'usd').toLowerCase().trim();

    // Validate it looks like a Stripe charge ID
    const paymentRef = inv.payment_ref ?? null;
    const stripeRef =
      paymentRef && /^(ch_|pi_)/.test(paymentRef) ? paymentRef : null;

    return {
      id: String(inv.id),
      customer_name: inv.customer_name ?? '',
      amount: normalizedAmount,
      currency,
      date: parseAmbiguousDate(String(inv.date)),
      status: normalizeStatus(String(inv.status)),
      description: inv.description ?? null,
      payment_ref: stripeRef,
    };
  });
}