/**
 * RRT — Removal of Redundant Translators
 *
 * A post-processing step that analyses each TEC (Translationally Equivalent Class)
 * and removes as many occurrences as possible without reducing the TEC's covered set.
 *
 * Based on Meredith (2023), "Understanding and compressing music with
 * maximal transformable patterns", LNCS 14035, pp. 309-325.
 *
 * When combined with RECURSIA, can improve compression by +12.5%.
 *
 * @module rrt
 */

/**
 * Remove redundant translators from a TEC's occurrence list.
 *
 * A translator is redundant if another translator already covers the exact
 * same set of notes (or a superset). This reduces the number of stored
 * occurrence references without losing any coverage.
 *
 * @param {object[]} occurrences - Array of { dx, dy, noteIds }
 * @returns {object[]} Occurrences with redundant translators removed
 */
export function removeRedundantTranslators(occurrences) {
  if (occurrences.length <= 1) return occurrences;

  const essential = [];
  const coveredSets = new Map(); // signature -> { occurrence, noteCount }

  for (const occ of occurrences) {
    // Create a canonical signature from sorted note IDs
    const sig = occ.noteIds.slice().sort((a, b) => a - b).join(',');

    const existing = coveredSets.get(sig);
    if (!existing) {
      // First translator covering this exact set
      coveredSets.set(sig, { occurrence: occ, noteCount: occ.noteIds.length });
      essential.push(occ);
    } else if (occ.noteIds.length > existing.noteCount) {
      // This translator covers a superset — replace the previous one
      const idx = essential.indexOf(existing.occurrence);
      if (idx >= 0) essential[idx] = occ;
      coveredSets.set(sig, { occurrence: occ, noteCount: occ.noteIds.length });
    }
    // else: this translator covers a subset or same set → skip (redundant)
  }

  return essential;
}

/**
 * Apply RRT to all patterns in a COSIATEC result.
 *
 * For each pattern, removes redundant occurrence translators.
 * The original pattern (dx=0, dy=0) is always preserved.
 *
 * @param {object[]} patterns - Array of { notes, occurrences, ... }
 * @returns {object[]} Patterns with redundant translators removed
 */
export function applyRRTToResult(patterns) {
  return patterns.map(p => {
    const origOcc = p.occurrences.find(o => o.dx === 0 && o.dy === 0);
    const transOccs = p.occurrences.filter(o => !(o.dx === 0 && o.dy === 0));

    // Remove redundant translators among translated occurrences
    const dedupedTrans = removeRedundantTranslators(transOccs);

    // Always keep the original occurrence
    const result = origOcc ? [origOcc, ...dedupedTrans] : dedupedTrans;

    return { ...p, occurrences: result };
  });
}

/**
 * Calculate the compression improvement from RRT.
 *
 * @param {object[]} patternsBefore - Patterns before RRT
 * @param {object[]} patternsAfter  - Patterns after RRT
 * @returns {{ removed: number, reductionPercent: number }}
 */
export function rrtSavings(patternsBefore, patternsAfter) {
  const before = patternsBefore.reduce((s, p) => s + p.occurrences.length, 0);
  const after = patternsAfter.reduce((s, p) => s + p.occurrences.length, 0);
  return {
    removed: before - after,
    reductionPercent: before > 0 ? ((before - after) / before * 100) : 0,
  };
}