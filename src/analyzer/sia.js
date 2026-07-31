/**
 * SIA / SIATEC — Structure Induction Algorithm for Music Pattern Discovery
 *
 * Implements the core geometric pattern-finding algorithms:
 *   - SIA: Compute Maximal Translatable Patterns (MTPs) via vector tables
 *   - SIATEC: Find all translation vectors for a given pattern in the dataset
 *
 * Based on Meredith, Lemström & Wiggins (2002).
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
 * Generate a unique key for a note.
 * @param {object} note
 * @returns {string}
 */
export function noteKey(note) {
  return `${note.track}-${note.start}-${note.pitch}`;
}

/**
 * Compute Maximal Translatable Patterns (MTPs) via the SIA vector-table method.
 *
 * For each ordered pair of points, compute the translation vector (dx, dy).
 * Sort vectors lexicographically; each group of identical vectors defines
 * the set of points that translate onto each other — an MTP.
 *
 * Complexity: O(N² log N) where N = number of points.
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

  // Push final group
  mtps.push({
    vector: { dx: current.dx, dy: current.dy },
    points: Array.from(current.points),
  });

  return mtps;
}

/**
 * SIATEC: Find all translation vectors that map a pattern onto subsets
 * of the full point dataset.
 *
 * Uses the intersection method — for each point in the dataset, compute
 * the translation vector needed to align the pattern's first point onto it,
 * then verify all other pattern points also have matches.
 *
 * @param {object[]} patternPoints - Points forming the pattern
 * @param {object[]} allPoints     - All points in the dataset
 * @param {number}   pitchTol      - Pitch matching tolerance (semitones)
 * @returns {object[]} Array of { dx, dy } translation vectors
 */
export function findTranslators(patternPoints, allPoints, pitchTol = 0) {
  const translators = [];
  if (patternPoints.length === 0) return translators;

  const first = patternPoints[0];
  const seen = new Set();

  for (const anchor of allPoints) {
    const dx = anchor.t - first.t;
    const dy = anchor.p - first.p;

    // Skip zero vector (original position)
    if (dx === 0 && dy === 0) continue;

    const key = `${dx},${dy}`;
    if (seen.has(key)) continue;

    // Verify all pattern points have matches under this translation
    let valid = true;
    for (const pt of patternPoints) {
      const targetT = pt.t + dx;
      const targetP = pt.p + dy;
      let found = false;

      for (const ap of allPoints) {
        if (ap.t === targetT && Math.abs(ap.p - targetP) <= pitchTol) {
          found = true;
          break;
        }
      }

      if (!found) {
        valid = false;
        break;
      }
    }

    if (valid) {
      seen.add(key);
      translators.push({ dx, dy });
    }
  }

  return translators;
}
