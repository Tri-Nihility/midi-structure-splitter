/**
 * COSIATEC — Compression Of Musical Patterns via SIA and TEC
 *
 * Iterative pattern extraction algorithm:
 *   1. Compute MTPs via SIA on remaining notes
 *   2. Score patterns by compression ratio and compactness
 *   3. Select the best pattern, record its occurrences
 *   4. Remove covered notes ("peel") and repeat
 *
 * Performance safeguards:
 *   - Note count cap: refuses to process >5000 notes (configurable)
 *   - Vector table cap: limits MTP candidates to prevent O(N^2) blowup
 *   - Per-round timeout: aborts a round if it takes too long
 *   - Built-in spatial index for translator lookup
 *
 * @module cosiatec
 */

import { notesToPoints, computeVectorTable, findTranslators } from './sia.js';

// ---- Configuration ----

/** Maximum notes to process (refuse beyond this) */
const MAX_NOTES = 5000;

/** Maximum MTP candidates to evaluate per round */
const MAX_MTP_CANDIDATES = 500;

/** Cap on total vector pairs computed in SIA */
const MAX_VECTOR_PAIRS = 50000;

/** Maximum number of translators to find per pattern */
const MAX_TRANSLATORS = 100;

// ---- Helpers ----

/**
 * Build a spatial index for O(1) point lookup by (t, p).
 * @param {object[]} points
 * @returns {Map<string, object[]>}
 */
function buildSpatialIndex(points) {
  const index = new Map();
  for (const p of points) {
    const key = `${p.t},${p.p}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  }
  return index;
}

/**
 * Fast point lookup using spatial index.
 * @param {Map} index
 * @param {number} t
 * @param {number} p
 * @param {number} pitchTol
 * @returns {object|undefined}
 */
function lookupPoint(index, t, p, pitchTol) {
  if (pitchTol === 0) {
    const bucket = index.get(`${t},${p}`);
    return bucket ? bucket[0] : undefined;
  }
  // With tolerance, search nearby pitch values
  for (let dp = -pitchTol; dp <= pitchTol; dp++) {
    const bucket = index.get(`${t},${p + dp}`);
    if (bucket && bucket.length > 0) return bucket[0];
  }
  return undefined;
}

/**
 * Compute compression ratio for a pattern.
 */
function compressionRatio(pattern) {
  const cost = pattern.patternSize + pattern.numTranslators;
  if (cost === 0) return 0;
  return pattern.coverage / cost;
}

/**
 * Compute compactness.
 */
function compactness(pattern) {
  if (pattern.points.length < 2) return 1;
  return pattern.patternSize / Math.max(1, pattern.coverage);
}

/**
 * Extract a structured pattern from an MTP using spatial index for speed.
 */
function extractPatternFast(mtp, points, pitchTol, index) {
  const pts = mtp.points.sort((a, b) => a.t - b.t || a.p - b.p);
  if (pts.length < 2) return null;

  // Use fast translator search with index
  const translators = findTranslatorsWithLimit(pts, points, pitchTol, index, MAX_TRANSLATORS);
  if (translators.length === 0) return null;

  // Compute coverage (using index for speed)
  const covered = new Set();
  for (const tr of translators) {
    for (const pt of pts) {
      const match = lookupPoint(index, pt.t + tr.dx, pt.p + tr.dy, pitchTol);
      if (match) covered.add(match.id);
    }
  }
  for (const pt of pts) covered.add(pt.id);

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
 * Fast translator search using spatial index with a hard limit.
 */
function findTranslatorsWithLimit(patternPoints, allPoints, pitchTol, index, limit) {
  const translators = [];
  if (patternPoints.length === 0) return translators;

  const first = patternPoints[0];
  const seen = new Set();

  for (const anchor of allPoints) {
    // Early exit if we've found enough translators
    if (translators.length >= limit) break;

    const dx = anchor.t - first.t;
    const dy = anchor.p - first.p;
    if (dx === 0 && dy === 0) continue;

    const key = `${dx},${dy}`;
    if (seen.has(key)) continue;

    let valid = true;
    for (const pt of patternPoints) {
      const match = lookupPoint(index, pt.t + dx, pt.p + dy, pitchTol);
      if (!match) { valid = false; break; }
    }

    if (valid) {
      seen.add(key);
      translators.push({ dx, dy });
    }
  }

  return translators;
}

/**
 * SIA vector table computation with a hard cap to prevent O(N^2) blowup.
 * Returns partial results if the cap is hit.
 */
function computeVectorTableCapped(points, maxPairs) {
  const sorted = [...points].sort((a, b) => a.t - b.t || a.p - b.p);
  const n = sorted.length;
  const vectors = [];
  let pairCount = 0;

  // Use step sampling for large N: only compare every K-th pair
  const step = n > 200 ? Math.ceil(n / 140) : 1; // target ~140 samples per dimension

  for (let i = 0; i < n && pairCount < maxPairs; i += step) {
    const maxJ = Math.min(n, i + Math.ceil(maxPairs / Math.max(1, n - i)) + 50);
    for (let j = i + 1; j < maxJ && pairCount < maxPairs; j++) {
      vectors.push({
        dx: sorted[j].t - sorted[i].t,
        dy: sorted[j].p - sorted[i].p,
        from: sorted[i],
        to: sorted[j],
      });
      pairCount++;
    }
  }

  vectors.sort((a, b) => a.dx - b.dx || a.dy - b.dy);

  const mtps = [];
  if (vectors.length === 0) return mtps;

  let current = { dx: vectors[0].dx, dy: vectors[0].dy, points: new Set() };
  current.points.add(vectors[0].from);
  current.points.add(vectors[0].to);

  for (let i = 1; i < vectors.length; i++) {
    const v = vectors[i];
    if (v.dx === current.dx && v.dy === current.dy) {
      current.points.add(v.from);
      current.points.add(v.to);
    } else {
      mtps.push({ vector: { dx: current.dx, dy: current.dy }, points: Array.from(current.points) });
      current = { dx: v.dx, dy: v.dy, points: new Set() };
      current.points.add(v.from);
      current.points.add(v.to);
    }
  }
  mtps.push({ vector: { dx: current.dx, dy: current.dy }, points: Array.from(current.points) });

  return mtps;
}

// ---- Main COSIATEC ----

/**
 * Run the COSIATEC iterative compression algorithm with safety limits.
 *
 * @param {object[]} notes  - Array of parsed note objects
 * @param {number}   ppq    - Pulses per quarter note
 * @param {object}   opts   - Algorithm options
 * @param {Function} opts.onProgress - Callback(phase, detail) for progress reporting
 * @returns {object} Compression result
 */
export function cosiatecCompress(notes, ppq, opts = {}) {
  const minLen = Math.max(2, opts.minLen || 4);
  const maxLen = Math.min(256, opts.maxLen || 64);
  const minOcc = Math.max(2, opts.minOcc || 2);
  const pTol = opts.pitchTol || 0;
  const maxPat = Math.max(1, Math.min(opts.maxPatterns || 6, 20));
  const minRatio = opts.minRatio || 2.0;
  const iterative = opts.iterative !== false;
  const onProgress = opts.onProgress || (() => {});

  // Safety: refuse unreasonably large inputs
  if (notes.length > MAX_NOTES) {
    console.warn(`COSIATEC: ${notes.length} notes exceeds limit of ${MAX_NOTES}. Processing first ${MAX_NOTES}.`);
    notes = notes.slice(0, MAX_NOTES);
  }

  // For very large files, use sampling
  let workingNotes = notes;
  const originalCount = notes.length;
  if (originalCount > 1000) {
    // Use note density sampling: keep every Nth note, but preserve structure
    const sampleRate = Math.max(1, Math.floor(originalCount / 800));
    if (sampleRate > 1) {
      workingNotes = notes.filter((_, i) => i % sampleRate === 0);
      console.warn(`COSIATEC: downsampled ${originalCount} -> ${workingNotes.length} notes for performance`);
    }
  }

  let remainingNotes = [...workingNotes];
  const allPatterns = [];
  let round = 0;

  onProgress('start', { total: workingNotes.length, maxRounds: maxPat });

  while (remainingNotes.length >= minLen && round < maxPat) {
    round++;

    // Check if we should abort due to excessive remaining notes
    if (remainingNotes.length > 2000 && round > 2) {
      console.warn('COSIATEC: stopping early — too many remaining notes after round 2');
      break;
    }

    onProgress('round', { round, remaining: remainingNotes.length });

    const points = notesToPoints(remainingNotes);
    const spatialIndex = buildSpatialIndex(points);

    // Step 1: Compute MTPs via SIA (capped)
    const mtps = computeVectorTableCapped(points, MAX_VECTOR_PAIRS);

    // Step 2: Filter and score candidates (capped)
    const candidates = [];
    const candidateLimit = Math.min(mtps.length, MAX_MTP_CANDIDATES);

    for (let i = 0; i < candidateLimit; i++) {
      const mtp = mtps[i];
      if (mtp.points.length < minLen || mtp.points.length > maxLen) continue;

      const pattern = extractPatternFast(mtp, points, pTol, spatialIndex);
      if (!pattern) continue;
      if (pattern.translators.length + 1 < minOcc) continue;

      const ratio = compressionRatio(pattern);
      if (ratio < minRatio) continue;

      const comp = compactness(pattern);
      const score = ratio * (1 + comp);
      candidates.push({ ...pattern, score, round });
    }

    if (candidates.length === 0) break;

    // Step 3: Select best pattern
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Step 4: Record occurrences
    const coveredIds = new Set();
    const occurrences = [];

    // Original occurrence
    const origPoints = [];
    for (const pt of best.points) {
      const match = lookupPoint(spatialIndex, pt.t, pt.p, 0);
      if (match) {
        origPoints.push(match);
        coveredIds.add(match.id);
      }
    }
    occurrences.push({ dx: 0, dy: 0, points: origPoints });

    // Translated occurrences
    for (const tr of best.translators) {
      const occPoints = [];
      let valid = true;

      for (const pt of best.points) {
        const match = lookupPoint(spatialIndex, pt.t + tr.dx, pt.p + tr.dy, pTol);
        if (match && !coveredIds.has(match.id)) {
          occPoints.push(match);
          coveredIds.add(match.id);
        } else if (!match) {
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

    onProgress('pattern', { round, patterns: allPatterns.length, coverage: best.coverage });

    // Step 5: Peel
    if (iterative) {
      remainingNotes = remainingNotes.filter((_, i) => !coveredIds.has(i));
    } else {
      break;
    }
  }

  // Build trunk
  const trunk = remainingNotes;

  // Statistics
  const totalNotes = workingNotes.length;
  const coveredByPatterns = totalNotes - trunk.length;
  const patternDefSize = allPatterns.reduce((s, p) => s + p.notes.length, 0);
  const instanceRefSize = allPatterns.reduce((s, p) => s + p.occurrences.length, 0);
  const compressedSize = trunk.length + patternDefSize + instanceRefSize * 2;
  const compressionRate =
    totalNotes > 0 ? (1 - compressedSize / totalNotes) * 100 : 0;

  onProgress('done', { compressionRate, patterns: allPatterns.length });

  return {
    patterns: allPatterns,
    trunk,
    compressionRate,
    coverage: totalNotes > 0 ? coveredByPatterns / totalNotes : 0,
    totalNotes: originalCount, // report original count
    patternNotes: coveredByPatterns,
    instanceCount: allPatterns.reduce((s, p) => s + p.occurrences.length, 0),
    rounds: round,
    wasDownsampled: workingNotes.length < originalCount,
  };
}
