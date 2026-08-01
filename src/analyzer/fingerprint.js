/**
 * Rhythmic Fingerprint Matching (SIARCT-CFP)
 *
 * Based on Collins et al.'s SIARCT-CFP algorithm which combines SIAR,
 * SIACT, and a Categorisation + Fingerprinting (CFP) technique.
 *
 * Fingerprints capture the rhythmic identity of a pattern as ratios
 * of inter-onset intervals, making them invariant to absolute tempo
 * (augmentation/diminution). This enables discovery of time-scaled
 * pattern variants that rigid translation would miss.
 *
 * @module fingerprint
 */

/**
 * Compute a rhythmic fingerprint from a sequence of notes.
 *
 * The fingerprint is the sequence of inter-onset interval (IOI) ratios,
 * normalized against the first IOI. This makes it invariant to tempo:
 * a pattern played at 2x speed has the same fingerprint.
 *
 * @param {object[]} notes - Notes with {start} (sorted by start time)
 * @returns {number[]} Array of IOI ratios, or empty array if <2 notes
 */
export function computeRhythmicFingerprint(notes) {
  if (notes.length < 2) return [];

  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const iois = [];

  for (let i = 1; i < sorted.length; i++) {
    iois.push(sorted[i].start - sorted[i - 1].start);
  }

  // Normalize to ratios relative to the first IOI
  const base = iois[0] || 1;
  return iois.map(ioi => Math.round((ioi / base) * 100) / 100);
}

/**
 * Compare two rhythmic fingerprints with tolerance.
 *
 * @param {number[]} fp1       - First fingerprint
 * @param {number[]} fp2       - Second fingerprint
 * @param {number}   tolerance - Ratio tolerance (e.g., 0.15 = 15%)
 * @returns {boolean} Whether fingerprints match within tolerance
 */
export function fingerprintsMatch(fp1, fp2, tolerance = 0.15) {
  if (fp1.length !== fp2.length) return false;
  return fp1.every((v, i) => Math.abs(v - fp2[i]) <= tolerance);
}

/**
 * Check if two note sequences have matching pitch contours.
 *
 * A contour match means the sequence of interval directions
 * (up/down/same) is identical, and interval sizes match within
 * pitch tolerance. This is more robust than exact pitch matching
 * for detecting transposed variants.
 *
 * @param {object[]} seq1     - First note sequence
 * @param {object[]} seq2     - Second note sequence
 * @param {number}   pitchTol - Pitch interval tolerance
 * @returns {boolean}
 */
export function checkPitchContour(seq1, seq2, pitchTol = 0) {
  if (seq1.length !== seq2.length) return false;

  for (let i = 1; i < seq1.length; i++) {
    const p1 = seq1[i].p ?? seq1[i].pitch;
    const p0 = seq1[i - 1].p ?? seq1[i - 1].pitch;
    const q1 = seq2[i].p ?? seq2[i].pitch;
    const q0 = seq2[i - 1].p ?? seq2[i - 1].pitch;

    const d1 = p1 - p0;
    const d2 = q1 - q0;

    // Direction must match (up/down/same)
    if (Math.sign(d1) !== Math.sign(d2)) return false;

    // Interval size must match within tolerance
    if (Math.abs(Math.abs(d1) - Math.abs(d2)) > pitchTol) return false;
  }

  return true;
}

/**
 * Find occurrences of a pattern by rhythmic fingerprint.
 *
 * This catches time-scaled variants (augmentation/diminution) that
 * rigid translation-based DIATECH would miss. It checks both pitch
 * contour and rhythmic fingerprint.
 *
 * @param {object[]} pattern     - Template notes
 * @param {object[]} allNotes    - All notes in dataset (sorted by start)
 * @param {number}   pitchTol    - Pitch tolerance
 * @param {number}   timeScaleTol - IOI ratio tolerance (e.g., 0.2)
 * @returns {object[]} Occurrences { dx, dy, startIdx, noteIndices }
 */
export function findOccurrencesByFingerprint(
  pattern, allNotes, pitchTol = 0, timeScaleTol = 0.2
) {
  if (pattern.length < 2) return [];

  const patternFp = computeRhythmicFingerprint(pattern);
  if (patternFp.length === 0) return [];

  const occurrences = [];
  const sortedAll = [...allNotes].sort((a, b) => a.start - b.start);

  for (let i = 0; i <= sortedAll.length - pattern.length; i++) {
    const candidate = sortedAll.slice(i, i + pattern.length);

    // Check pitch contour match
    if (!checkPitchContour(pattern, candidate, pitchTol)) continue;

    // Check rhythmic fingerprint match
    const candidateFp = computeRhythmicFingerprint(candidate);
    if (!fingerprintsMatch(patternFp, candidateFp, timeScaleTol)) continue;

    // Compute translation vector
    const dx = candidate[0].start - (pattern[0].start ?? pattern[0].t ?? 0);
    const dy = (candidate[0].pitch ?? candidate[0].p) -
               (pattern[0].pitch ?? pattern[0].p ?? 0);

    occurrences.push({
      dx,
      dy,
      startIdx: i,
      noteIndices: candidate.map((_, idx) => i + idx),
    });
  }

  return occurrences;
}

/**
 * Compute a pitch fingerprint (pitch-class profile) of a note sequence.
 *
 * The fingerprint is an array of pitch-class counts (0-11), normalized
 * to ratios. This captures harmonic identity regardless of octave.
 *
 * @param {object[]} notes - Notes with {pitch} or {p}
 * @returns {number[]} Array of 12 pitch-class ratios
 */
export function computePitchFingerprint(notes) {
  const pc = new Array(12).fill(0);
  for (const n of notes) {
    const p = n.pitch ?? n.p ?? 60;
    pc[p % 12]++;
  }
  const total = pc.reduce((a, b) => a + b, 0) || 1;
  return pc.map(c => Math.round((c / total) * 100) / 100);
}