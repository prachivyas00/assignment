/**
 * Load and normalize Salesforce CRM data (Opportunities and Accounts).
 *
 * Salesforce data introduces several reconciliation challenges:
 *
 * - **TCV vs ACV**: Opportunities have both `tcv` (Total Contract Value) and
 *   `acv` (Annual Contract Value) fields.  For multi-year deals the TCV is
 *   a multiple of ACV, but discounts and ramp deals may cause mismatches.
 *   ARR calculations should use ACV, not TCV.
 *
 * - **Opportunity stages**: The pipeline includes stages from "Prospecting"
 *   through "Closed Won" and "Closed Lost".  Only "Closed Won" opportunities
 *   should map to actual revenue, but "Commit" and "Best Case" stages are
 *   used for forecasting.  Zombie deals (open opportunities with no activity
 *   for 90+ days) are a common data quality issue.
 *
 * - **Account hierarchy**: Some accounts have a `parent_account_id` linking
 *   them in a corporate hierarchy.  Revenue roll-ups for enterprise customers
 *   must aggregate across child accounts.
 *
 * - **External ID mapping**: Accounts may have `stripe_customer_id` and/or
 *   `chargebee_customer_id` fields that map to billing systems.  These are
 *   manually entered and may be missing, outdated, or incorrect.
 *
 * - **Duplicate accounts**: The same company may appear as multiple Salesforce
 *   accounts with slightly different names (e.g., "Acme Corp" vs "ACME Inc.").
 *
 * @param dataDir - Path to the data directory
 * @returns Tuple of [opportunities, accounts]
 */

import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import type { SalesforceOpportunity, SalesforceAccount } from './types.js';

export async function loadSalesforceData(
  dataDir: string,
): Promise<[SalesforceOpportunity[], SalesforceAccount[]]> {
  const [opportunities, accounts] = await Promise.all([
    loadCSV<SalesforceOpportunity>(join(dataDir, 'salesforce_opportunities.csv'), {
      transform: (row) => ({
        opportunity_id: row['opportunity_id'] ?? '',
        account_id: row['account_id'] ?? '',
        account_name: row['account_name'] ?? '',
        opportunity_name: row['opportunity_name'] ?? '',
        stage: row['stage'] ?? '',
        amount: parseFloat(row['amount'] ?? '0'),
        currency: (row['currency'] ?? 'usd').toLowerCase(),
        close_date: row['close_date'] ?? '',
        created_date: row['created_date'] ?? '',
        probability: parseFloat(row['probability'] ?? '0'),
        forecast_category: row['forecast_category'] ?? 'pipeline',
        type: row['type'] ?? 'new_business',
        owner_name: row['owner_name'] ?? '',
        owner_email: row['owner_email'] ?? '',
        next_step: row['next_step'] || null,
        tcv: parseFloat(row['tcv'] ?? '0'),
        acv: parseFloat(row['acv'] ?? '0'),
        contract_term_months: parseInt(row['contract_term_months'] ?? '12', 10),
        competitor: row['competitor'] || null,
        loss_reason: row['loss_reason'] || null,
        partner_id: row['partner_id'] || null,
      }),
    }),
    loadCSV<SalesforceAccount>(join(dataDir, 'salesforce_accounts.csv'), {
      transform: (row) => ({
        account_id: row['account_id'] ?? '',
        account_name: row['account_name'] ?? '',
        industry: row['industry'] ?? '',
        employee_count: parseInt(row['employee_count'] ?? '0', 10),
        annual_revenue: parseFloat(row['annual_revenue'] ?? '0'),
        billing_country: row['billing_country'] ?? '',
        billing_state: row['billing_state'] ?? '',
        website: row['website'] ?? '',
        owner_name: row['owner_name'] ?? '',
        owner_email: row['owner_email'] ?? '',
        created_date: row['created_date'] ?? '',
        segment: row['segment'] ?? 'smb',
        parent_account_id: row['parent_account_id'] || null,
        stripe_customer_id: row['stripe_customer_id'] || null,
        chargebee_customer_id: row['chargebee_customer_id'] || null,
      }),
    }),
  ]);

  return [opportunities, accounts];
}