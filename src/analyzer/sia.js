/**
 * SIA / SIATEC — Structure Induction Algorithm for Music Pattern Discovery
 *
 * Implements the core geometric pattern-finding algorithms:
 *   - SIA: Compute Maximal Translatable Patterns (MTPs) via vector tables
 *   - SIATEC: Find all translation vectors for a given pattern in the dataset
 *   - Contiguous segment extraction for whole-passage repetition
 *
 * Based on Meredith, Lemstrom & Wiggins (2002).
 *
 * @module sia
 */

/**
 * Convert note array to points in (time, pitch) space for geometric analysis.
 *
 * @param {object[]} notes - Array of { start, pitch, dur, vel, track, ch }
 * @returns {object[]} Points with id, t, p, d, v, track, ch
 */
export function notesToPoints(notes) {
  return notes.map((n, i) => ({
    id: i,
    t: n.start,
    p: n.pitch,
    d: n.dur,
    v: n.vel,
    track: n.track,
    ch: n.ch,
    raw: n,
  }));
}

/**
 * Compute Maximal Translatable Patterns (MTPs) via the SIA vector-table method.
 *
 * For each ordered pair of points, compute the translation vector (dx, dy).
 * Sort vectors lexicographically; each group of identical vectors defines
 * the set of points that translate onto each other — an MTP.
 *
 * Returns MTPs sorted by size descending (largest pattern first).
 *
 * @param {object[]} points - Points from notesToPoints()
 * @returns {object[]} Array of { vector: {dx, dy}, points: object[] }
 */
export function computeVectorTable(points) {
  const sorted = [...points].sort((a, b) => a.t - b.t || a.p - b.p);
  const n = sorted.length;
  const vectors = [];

  // Compute all pairwise translation vectors
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      vectors.push({
        dx: sorted[j].t - sorted[i].t,
        dy: sorted[j].p - sorted[i].p,
        from: sorted[i],
        to: sorted[j],
      });
    }
  }

  // Sort lexicographically by (dx, dy)
  vectors.sort((a, b) => a.dx - b.dx || a.dy - b.dy);

  // Group identical vectors into MTPs
  const mtps = [];
  if (vectors.length === 0) return mtps;

  let current = {
    dx: vectors[0].dx,
    dy: vectors[0].dy,
    points: new Set(),
  };
  current.points.add(vectors[0].from);
  current.points.add(vectors[0].to);

  for (let i = 1; i < vectors.length; i++) {
    const v = vectors[i];
    if (v.dx === current.dx && v.dy === current.dy) {
      current.points.add(v.from);
      current.points.add(v.to);
    } else {
      mtps.push({
        vector: { dx: current.dx, dy: current.dy },
        points: Array.from(current.points),
      });
      current = { dx: v.dx, dy: v.dy, points: new Set() };
      current.points.add(v.from);
      current.points.add(v.to);
    }
  }
  mtps.push({
    vector: { dx: current.dx, dy: current.dy },
    points: Array.from(current.points),
  });

  // Sort by size descending so largest patterns come first
  mtps.sort((a, b) => b.points.length - a.points.length);

  return mtps;
}

/**
 * SIATEC: Find all translation vectors that map a pattern onto subsets
 * of the full point dataset.
 *
 * Uses a spatial index for O(1) point lookup per check.
 *
 * @param {object[]} patternPoints - Points forming the pattern
 * @param {Map}      spatialIndex  - Map of "t,p" -> [point, ...]
 * @param {number}   pitchTol      - Pitch matching tolerance (semitones)
 * @returns {object[]} Array of { dx, dy } translation vectors (excluding zero)
 */
export function findTranslators(patternPoints, spatialIndex, pitchTol = 0) {
  const translators = [];
  if (patternPoints.length === 0) return translators;

  const first = patternPoints[0];
  const seen = new Set();

  // Iterate through all indexed positions
  for (const [, bucket] of spatialIndex) {
    for (const anchor of bucket) {
      const dx = anchor.t - first.t;
      const dy = anchor.p - first.p;
      if (dx === 0 && dy === 0) continue;

      const key = `${dx},${dy}`;
      if (seen.has(key)) continue;

      let valid = true;
      for (const pt of patternPoints) {
        const bucket2 = spatialIndex.get(`${pt.t + dx},${pt.p + dy}`);
        if (!bucket2 || bucket2.length === 0) {
          // Try with pitch tolerance
          if (pitchTol > 0) {
            let found = false;
            for (let dp = -pitchTol; dp <= pitchTol; dp++) {
              const b = spatialIndex.get(`${pt.t + dx},${pt.p + dy + dp}`);
              if (b && b.length > 0) { found = true; break; }
            }
            if (!found) { valid = false; break; }
          } else {
            valid = false;
            break;
          }
        }
      }

      if (valid) {
        seen.add(key);
        translators.push({ dx, dy });
      }
    }
  }

  return translators;
}

/**
 * Extract contiguous (time-contiguous) segments from a set of MTP points.
 *
 * The key insight: an MTP contains points that share the same translation vector,
 * but they may be scattered. A "good" pattern should be a contiguous block
 * of notes in time. This function groups MTP points into contiguous segments.
 *
 * @param {object[]} mtpPoints - Points from an MTP (unsorted)
 * @param {number}   minLen    - Minimum segment length
 * @param {number}   maxGap    - Maximum time gap between consecutive notes to be "contiguous"
 * @returns {object[]} Array of segment point arrays, sorted by size descending
 */
export function extractContiguousSegments(mtpPoints, minLen = 3, maxGap = 200) {
  const sorted = [...mtpPoints].sort((a, b) => a.t - b.t || a.p - b.p);
  if (sorted.length < minLen) return [];

  const segments = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].t - sorted[i - 1].t;
    if (gap <= maxGap) {
      current.push(sorted[i]);
    } else {
      if (current.length >= minLen) {
        segments.push([...current]);
      }
      current = [sorted[i]];
    }
  }

  if (current.length >= minLen) {
    segments.push([...current]);
  }

  // Sort by size descending
  segments.sort((a, b) => b.length - a.length);
  return segments;
}

/**
 * Find ALL occurrences of a contiguous note segment in the original note array
 * using DIATECH: for each possible start position, check if all notes match
 * under a translation (dx, dy).
 *
 * This is much more robust than the SIA vector-table approach for
 * whole-passage repetition detection.
 *
 * @param {object[]} segment    - Contiguous segment of notes (with original indices)
 * @param {object[]} allNotes   - All notes (sorted by start time)
 * @param {number}   pitchTol   - Pitch tolerance
 * @param {number}   timeTol    - Time tolerance in ticks
 * @returns {object[]} Array of { startIdx, dx, dy, noteIndices }
 */
export function findAllOccurrences(segment, allNotes, pitchTol = 0, timeTol = 6) {
  if (segment.length < 2) return [];

  // Normalize segment notes to have consistent {t, p} accessors.
  // Points from MTP have .t/.p; raw notes from Phase B have .start/.pitch.
  const getT = (sn) => sn.t ?? sn.start;
  const getP = (sn) => sn.p ?? sn.pitch;

  const occurrences = [];
  const segLen = segment.length;
  const segFirst = segment[0];
  const segLast = segment[segLen - 1];
  const segFirstT = getT(segFirst);
  const segFirstP = getP(segFirst);
  const segLastT = getT(segLast);

  // Build a time-based lookup: for each note, record its index
  const notesByTime = new Map();
  allNotes.forEach((n, i) => {
    const t = n.start;
    if (!notesByTime.has(t)) notesByTime.set(t, []);
    notesByTime.get(t).push({ note: n, idx: i });
  });

  // For each note in the dataset, try it as the anchor (first note of an occurrence)
  for (let anchorIdx = 0; anchorIdx < allNotes.length; anchorIdx++) {
    const anchor = allNotes[anchorIdx];
    const dx = anchor.start - segFirstT;
    const dy = anchor.pitch - segFirstP;

    // Skip zero translation (it's the original occurrence)
    if (dx === 0 && dy === 0) continue;

    // Quick reject: the last note of the segment must fit in the data range
    const lastExpectedT = segLastT + dx;
    const maxEnd = allNotes[allNotes.length - 1]?.end || 0;
    if (lastExpectedT > maxEnd + timeTol) continue;

    // Verify all segment notes exist at translated positions
    const matchedIndices = [];
    let valid = true;

    for (const segNote of segment) {
      const targetT = getT(segNote) + dx;
      const targetP = getP(segNote) + dy;

      // Find a note at (targetT ± timeTol, targetP ± pitchTol)
      let found = false;
      for (let dt = -timeTol; dt <= timeTol && !found; dt++) {
        const bucket = notesByTime.get(targetT + dt);
        if (!bucket) continue;
        for (const { note, idx } of bucket) {
          if (Math.abs(note.pitch - targetP) <= pitchTol) {
            if (!matchedIndices.includes(idx)) {
              matchedIndices.push(idx);
              found = true;
              break;
            }
          }
        }
      }

      if (!found) {
        valid = false;
        break;
      }
    }

    if (valid && matchedIndices.length === segLen) {
      occurrences.push({
        dx,
        dy,
        startIdx: anchorIdx,
        noteIndices: [...matchedIndices],
      });
    }
  }

  return occurrences;
}
