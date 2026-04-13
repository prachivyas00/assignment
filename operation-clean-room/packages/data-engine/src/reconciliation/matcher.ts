import type { MatchResult, MatchConfidence } from './types.js';

/**
 * Fuzzy matching engine for cross-system entity resolution.
 *
 * Must handle variant company names, different ID schemes, and partial
 * matches.  The matcher should use a combination of:
 *
 * - **Exact ID matching**: When external IDs (stripe_customer_id,
 *   chargebee_customer_id) are present and valid, these are the strongest
 *   signals.
 *
 * - **Domain matching**: If both entities have a website/domain field,
 *   matching domains are a very strong signal.
 *
 * - **Fuzzy name matching**: Company names vary across systems
 *   ("Acme Corp" vs "ACME Corporation Ltd." vs "acme").  Use normalized
 *   string comparison with techniques such as:
 *   - Case folding
 *   - Stripping common suffixes (Corp, Inc, Ltd, LLC, GmbH, etc.)
 *   - Token-based similarity (Jaccard, Sørensen-Dice)
 *   - Edit distance (Levenshtein)
 *
 * - **Composite scoring**: Combine signals from multiple fields into
 *   a single confidence score using configurable weights.
 *
 * @module reconciliation/matcher
 */

/** Options for controlling the entity matching process. */
export interface MatchOptions {
  /** Minimum confidence score (0-1) to consider a match. Defaults to 0.6. */
  threshold?: number;
  /** Weight for exact ID matches. Defaults to 1.0. */
  idWeight?: number;
  /** Weight for domain matches. Defaults to 0.9. */
  domainWeight?: number;
  /** Weight for name similarity. Defaults to 0.7. */
  nameWeight?: number;
  /** Whether to allow many-to-one matches. Defaults to false. */
  allowMultipleMatches?: boolean;
}

// Common company suffixes to strip before comparing names
const SUFFIXES = [
  'corporation', 'incorporated', 'limited', 'corp', 'inc',
  'ltd', 'llc', 'gmbh', 'co', 'company',
];

/**
 * Normalize a company name for comparison- lowercase, strip punctuation, remove common suffixes, trim whitespace
 */
function normalizeName(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const tokens = n.split(/\s+/);
  const filtered = tokens.filter(t => !SUFFIXES.includes(t));
  return (filtered.length > 0 ? filtered : tokens).join(' ');
}

/**
 * Jaccard similarity between two strings based on word tokens.
 * Returns a value between 0 (no overlap) and 1 (identical)
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = new Set([...setA].filter(t => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Calculate the confidence score for a potential match between two entities
 */
export async function calculateConfidence(
  entityA: Record<string, unknown>,
  entityB: Record<string, unknown>,
): Promise<MatchConfidence> {
  const matchedFields: string[] = [];
  const unmatchedFields: string[] = [];
  let score = 0;

  // --- Domain matching (weight: 0.5) ---
  const domainA = typeof entityA.domain === 'string' ? entityA.domain.toLowerCase().trim() : null;
  const domainB = typeof entityB.domain === 'string' ? entityB.domain.toLowerCase().trim() : null;

  if (domainA && domainB) {
    if (domainA === domainB) {
      score += 0.5;
      matchedFields.push('domain');
    } else {
      unmatchedFields.push('domain');
    }
  }

  // --- Name matching (weight: 0.5) ---
  const nameA = typeof entityA.name === 'string' ? normalizeName(entityA.name) : null;
  const nameB = typeof entityB.name === 'string' ? normalizeName(entityB.name) : null;

  if (nameA && nameB) {
    const nameSimilarity = jaccardSimilarity(nameA, nameB);
    score += nameSimilarity * 0.5;
    if (nameSimilarity > 0.5) {
      matchedFields.push('name');
    } else {
      unmatchedFields.push('name');
    }
  }

  return { score, matchedFields, unmatchedFields };
}

/**
 * Match entities across two data sources using fuzzy matching
 */
export async function matchEntities(
  sourceA: Record<string, unknown>[],
  sourceB: Record<string, unknown>[],
  options?: MatchOptions,
): Promise<MatchResult[]> {
  const threshold = options?.threshold ?? 0.6;
  const results: MatchResult[] = [];

  for (const entityA of sourceA) {
    let bestMatch: MatchResult | null = null;

    for (const entityB of sourceB) {
      const confidence = await calculateConfidence(entityA, entityB);
      if (confidence.score >= threshold) {
        if (!bestMatch || confidence.score > bestMatch.confidence.score) {
          bestMatch = {
            entityA: {
              id: String(entityA.id ?? ''),
              source: String(entityA.source ?? ''),
              ...entityA,
            },
            entityB: {
              id: String(entityB.id ?? ''),
              source: String(entityB.source ?? ''),
              ...entityB,
            },
            confidence,
          };
        }
      }
    }

    if (bestMatch) {
      results.push(bestMatch);
    }
  }

  return results;
}