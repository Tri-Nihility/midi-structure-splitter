/**
 * COSIATEC — Compression Of Musical Patterns via SIA and TEC
 *
 * Iterative pattern extraction algorithm:
 *   1. Compute MTPs via SIA on remaining notes
 *   2. Score patterns by compression ratio and compactness
 *   3. Select the best pattern, record its occurrences
 *   4. Remove covered notes ("peel") and repeat
 *
 * @module cosiatec
 */

import { notesToPoints, computeVectorTable, findTranslators } from './sia.js';

/**
 * Extract a structured pattern from an MTP, including all its translators.
 *
 * @param {object} mtp      - Maximal Translatable Pattern from SIA
 * @param {object[]} points - All points in the current dataset
 * @param {number} pitchTol - Pitch matching tolerance
 * @returns {object|null} Pattern descriptor or null if insufficient
 */
function extractPattern(mtp, points, pitchTol) {
  const pts = mtp.points.sort((a, b) => a.t - b.t || a.p - b.p);
  if (pts.length < 2) return null;

  const translators = findTranslators(pts, points, pitchTol);
  if (translators.length === 0) return null;

  // Compute total unique points covered by all occurrences
  const covered = new Set();
  for (const tr of translators) {
    for (const pt of pts) {
      for (const ap of points) {
        if (ap.t === pt.t + tr.dx && Math.abs(ap.p - (pt.p + tr.dy)) <= pitchTol) {
          covered.add(ap.id);
          break;
        }
      }
    }
  }

  // Include original pattern points
  for (const pt of pts) {
    covered.add(pt.id);
  }

  return {
    points: pts,
    vector: mtp.vector,
    translators,
    coverage: covered.size,
    patternSize: pts.length,
    numTranslators: translators.length,
  };
}

/**
 * Compute compression ratio for a pattern.
 *
 * Ratio = (notes covered) / (pattern template size + number of occurrence references)
 * Higher is better.
 *
 * @param {object} pattern
 * @returns {number}
 */
function compressionRatio(pattern) {
  const cost = pattern.patternSize + pattern.numTranslators;
  if (cost === 0) return 0;
  return pattern.coverage / cost;
}

/**
 * Compute compactness: ratio of pattern points to bounding-box density.
 *
 * @param {object} pattern
 * @returns {number}
 */
function compactness(pattern) {
  const pts = pattern.points;
  if (pts.length < 2) return 1;
  return pattern.patternSize / Math.max(1, pattern.coverage);
}

/**
 * Run the COSIATEC iterative compression algorithm.
 *
 * @param {object[]} notes  - Array of parsed note objects
 * @param {number}   ppq    - Pulses per quarter note
 * @param {object}   opts   - Algorithm options
 * @param {number}   opts.minLen       - Minimum pattern length (notes)
 * @param {number}   opts.maxLen       - Maximum pattern length (notes)
 * @param {number}   opts.minOcc       - Minimum occurrences (including original)
 * @param {number}   opts.pitchTol     - Pitch tolerance (semitones)
 * @param {number}   opts.timeTol      - Time tolerance (ticks)
 * @param {number}   opts.maxPatterns  - Maximum number of patterns to extract
 * @param {number}   opts.minRatio     - Minimum compression ratio threshold
 * @param {boolean}  opts.iterative    - Enable iterative peeling
 * @param {boolean}  opts.detectTrans  - Enable transposition detection
 * @returns {object} Compression result
 */
export function cosiatecCompress(notes, ppq, opts = {}) {
  const minLen = Math.max(2, opts.minLen || 4);
  const maxLen = Math.min(256, opts.maxLen || 64);
  const minOcc = Math.max(2, opts.minOcc || 2);
  const pTol = opts.pitchTol || 0;
  const tTol = opts.timeTol || 6;
  const maxPat = Math.max(1, opts.maxPatterns || 6);
  const minRatio = opts.minRatio || 2.0;
  const iterative = opts.iterative !== false;

  let remainingNotes = [...notes];
  const allPatterns = [];
  let round = 0;

  while (remainingNotes.length >= minLen && round < maxPat) {
    round++;
    const points = notesToPoints(remainingNotes);

    // Step 1: Compute MTPs via SIA
    const mtps = computeVectorTable(points);

    // Step 2: Filter and score candidate patterns
    const candidates = [];
    for (const mtp of mtps) {
      if (mtp.points.length < minLen || mtp.points.length > maxLen) continue;

      const pattern = extractPattern(mtp, points, pTol);
      if (!pattern) continue;
      if (pattern.translators.length + 1 < minOcc) continue;

      const ratio = compressionRatio(pattern);
      if (ratio < minRatio) continue;

      const comp = compactness(pattern);
      const score = ratio * (1 + comp);

      candidates.push({ ...pattern, score, round });
    }

    if (candidates.length === 0) break;

    // Step 3: Select best pattern (highest score)
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Step 4: Record pattern occurrences
    const coveredIds = new Set();
    const occurrences = [];

    // Original occurrence
    const origPoints = [];
    for (const pt of best.points) {
      for (const ap of points) {
        if (ap.t === pt.t && ap.p === pt.p) {
          origPoints.push(ap);
          coveredIds.add(ap.id);
          break;
        }
      }
    }
    occurrences.push({ dx: 0, dy: 0, points: origPoints });

    // Translated occurrences
    for (const tr of best.translators) {
      const occPoints = [];
      let valid = true;

      for (const pt of best.points) {
        let found = false;
        for (const ap of points) {
          if (
            ap.t === pt.t + tr.dx &&
            Math.abs(ap.p - (pt.p + tr.dy)) <= pTol &&
            !coveredIds.has(ap.id)
          ) {
            occPoints.push(ap);
            coveredIds.add(ap.id);
            found = true;
            break;
          }
        }
        if (!found) {
          valid = false;
          break;
        }
      }

      if (valid && occPoints.length === best.points.length) {
        occurrences.push({ dx: tr.dx, dy: tr.dy, points: occPoints });
      }
    }

    if (occurrences.length < minOcc) continue;

    // Store pattern
    allPatterns.push({
      id: round - 1,
      notes: best.points.map((pt) => {
        const match = remainingNotes.find(
          (n) => n.start === pt.t && n.pitch === pt.p
        );
        return match || pt;
      }),
      occurrences: occurrences.map((o, i) => ({
        id: i,
        track: o.points[0]?.track || 0,
        start: o.points[0]?.t || 0,
        end:
          (o.points[o.points.length - 1]?.t || 0) +
          (o.points[o.points.length - 1]?.d || 0),
        transposition: o.dy,
        delay: o.dx,
        noteIds: o.points.map((p) => p.id),
      })),
      coverage: best.coverage,
      score: best.score,
      compressionRatio: compressionRatio(best),
      round,
    });

    // Step 5: Peel covered notes (if iterative)
    if (iterative) {
      remainingNotes = remainingNotes.filter((_, i) => !coveredIds.has(i));
    } else {
      break;
    }
  }

  // Build trunk from remaining notes
  const trunk = remainingNotes;

  // Calculate compression statistics
  const totalNotes = notes.length;
  const coveredByPatterns = totalNotes - trunk.length;
  const patternDefSize = allPatterns.reduce((s, p) => s + p.notes.length, 0);
  const instanceRefSize = allPatterns.reduce(
    (s, p) => s + p.occurrences.length,
    0
  );
  const compressedSize = trunk.length + patternDefSize + instanceRefSize * 2;
  const compressionRate =
    totalNotes > 0 ? (1 - compressedSize / totalNotes) * 100 : 0;

  return {
    patterns: allPatterns,
    trunk,
    compressionRate,
    coverage: totalNotes > 0 ? coveredByPatterns / totalNotes : 0,
    totalNotes,
    patternNotes: coveredByPatterns,
    instanceCount: allPatterns.reduce((s, p) => s + p.occurrences.length, 0),
    rounds: round,
  };
}
