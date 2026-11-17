export type FuzzyMatchResult = {
  score: number;
  indices: number[];
};

/**
 * Subsequence fuzzy match with scoring.
 * Returns null if the query is not a subsequence of the text.
 * Scoring bonuses: consecutive characters, word-start matches.
 * Penalty: length difference.
 */
export function fuzzyMatch(
  text: string,
  query: string
): FuzzyMatchResult | null {
  if (!query) return { score: 0, indices: [] };
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerQuery.length > lowerText.length) return null;

  const indices: number[] = [];
  let textIndex = 0;

  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const found = lowerText.indexOf(lowerQuery[qi]!, textIndex);
    if (found < 0) return null;
    indices.push(found);
    textIndex = found + 1;
  }

  let score = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!;
    // Consecutive bonus
    if (i > 0 && idx === indices[i - 1]! + 1) {
      score += 3;
    }
    // Word-start bonus (first char or preceded by separator)
    if (idx === 0 || /[\s_\-./]/.test(text[idx - 1]!)) {
      score += 2;
    }
    // Exact case bonus
    if (text[idx] === query[i]) {
      score += 1;
    }
  }

  // Length penalty — prefer shorter texts for the same query
  score -= (text.length - query.length) * 0.1;

  return { score, indices };
}

/**
 * Multi-field fuzzy match — returns the best score across fields.
 */
export function fuzzyMatchMultiField(
  fields: string[],
  query: string
): FuzzyMatchResult | null {
  let best: FuzzyMatchResult | null = null;
  for (const field of fields) {
    const result = fuzzyMatch(field, query);
    if (result && (best === null || result.score > best.score)) {
      best = result;
    }
  }
  return best;
}
