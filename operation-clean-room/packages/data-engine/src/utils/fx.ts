import type { FXRate } from '../ingestion/types.js';

export function convertToUSD(
  amount: number,
  currency: string,
  date: Date,
  rates: FXRate[],
): number {
  const curr = currency.toLowerCase().trim();
  if (curr === 'usd') return amount;

  const key = `${curr}_usd` as keyof FXRate;

  // Try exact date first, then up to 5 days back
  for (let i = 0; i <= 5; i++) {
    const lookup = new Date(date);
    lookup.setDate(lookup.getDate() - i);
    const dateStr = lookup.toISOString().split('T')[0]!;

    const rate = rates.find(r => r.date === dateStr);
    if (rate && key in rate) {
      return amount * (rate[key] as number);
    }
  }

  // Fallback: use closest available rate
  const sorted = [...rates].sort((a, b) => b.date.localeCompare(a.date));
  const dateStr = date.toISOString().split('T')[0]!;
  const closest = sorted.find(r => r.date <= dateStr);

  if (closest && key in closest) {
    return amount * (closest[key] as number);
  }

  throw new Error(`No FX rate found for ${currency} on ${dateStr}`);
}