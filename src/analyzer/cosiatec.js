/**
 * COSIATEC — Compression Of Musical Patterns via SIA and TEC
 *
 * Improved algorithm for whole-passage repetition discovery:
 *
 *   Phase A — MTP-based: Use SIA to find maximal translatable point sets,
 *             extract contiguous segments, find all DIATECH occurrences.
 *   Phase B — Segment-based: For each possible contiguous segment in the
 *             remaining notes, try to find repeated occurrences directly.
 *             This catches whole-passage repeats that SIA might miss.
 *
 * Iterative peeling: after each round, remove covered notes and repeat.
 *
 * @module cosiatec
 */

import {
  notesToPoints,
  computeVectorTable,
  extractContiguousSegments,
  findAllOccurrences,
} from './sia.js';

// ---- Configuration ----

const MAX_NOTES = 5000;
const MAX_MTP_CANDIDATES = 300;
const MAX_VECTOR_PAIRS = 80000;

// ---- Spatial Index ----

function buildSpatialIndex(points) {
  const index = new Map();
  for (const p of points) {
    const key = `${p.t},${p.p}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  }
  return index;
}

// ---- Main Algorithm ----

/**
 * Run the COSIATEC iterative compression algorithm.
 *
 * Strategy per round:
 *   1. Compute SIA MTPs on remaining notes
 *   2. Extract contiguous segments from top MTPs
 *   3. For each segment, find all DIATECH occurrences
 *   4. Also try segment-based search: scan contiguous blocks directly
 *   5. Score candidates by: coverage (how many notes), compression ratio
 *   6. Pick best, peel, repeat
 *
 * @param {object[]} notes - Parsed note objects
 * @param {number}   ppq   - Pulses per quarter note
 * @param {object}   opts  - Algorithm options
 * @returns {object} Compression result
 */
export function cosiatecCompress(notes, ppq, opts = {}) {
  const minLen = Math.max(2, opts.minLen || 3);
  const maxLen = Math.min(256, opts.maxLen || 128);
  const minOcc = Math.max(2, opts.minOcc || 2);
  const pTol = opts.pitchTol || 0;
  const maxPat = Math.max(1, Math.min(opts.maxPatterns || 8, 20));
  const minRatio = opts.minRatio || 1.5;
  const iterative = opts.iterative !== false;
  const onProgress = opts.onProgress || (() => {});

  if (notes.length > MAX_NOTES) {
    notes = notes.slice(0, MAX_NOTES);
  }

  // Build original index map: (track,start,pitch,ch) -> original note index
  const origIndexMap = new Map();
  notes.forEach((n, i) => {
    const key = `${n.track},${n.start},${n.pitch},${n.ch}`;
    origIndexMap.set(key, i);
  });

  let remainingNotes = [...notes];
  const allPatterns = [];
  let round = 0;

  onProgress('start', { total: notes.length, maxRounds: maxPat });

  while (remainingNotes.length >= minLen && round < maxPat) {
    round++;
    onProgress('round', { round, remaining: remainingNotes.length });

    const points = notesToPoints(remainingNotes);
    const spatialIndex = buildSpatialIndex(points);
    const candidates = [];

    // ---- Phase A: MTP-based discovery ----
    const mtps = computeVectorTable(points);

    // Only examine top MTPs (largest point sets)
    const mtpLimit = Math.min(mtps.length, MAX_MTP_CANDIDATES);
    const seenSegments = new Set();

    for (let mi = 0; mi < mtpLimit; mi++) {
      const mtp = mtps[mi];

      // Extract contiguous segments from this MTP
      const maxGap = Math.max(ppq * 2, 200); // 2 beats or 200 ticks
      const segments = extractContiguousSegments(mtp.points, minLen, maxGap);

      for (const seg of segments) {
        if (seg.length < minLen) continue;

        // For segments that are too large, try progressively smaller
        // sub-segments (prefixes) to find the best pattern size.
        // This is critical: a large MTP segment may contain multiple
        // concatenated pattern instances that should be split.
        const segSizes = [];
        if (seg.length <= maxLen) {
          segSizes.push(seg.length);
        }
        // Also try sub-segment sizes: the first N notes
        // Try sizes from minLen up to min(maxLen, seg.length)
        for (let sz = minLen; sz <= Math.min(maxLen, seg.length); sz += minLen) {
          if (!segSizes.includes(sz)) segSizes.push(sz);
        }

        for (const size of segSizes) {
          const subSeg = seg.slice(0, size);

          // Deduplicate
          const segKey = subSeg.map(p => p.id).sort().join(',');
          if (seenSegments.has(segKey)) continue;
          seenSegments.add(segKey);

          // Find all DIATECH occurrences
          const occs = findAllOccurrences(subSeg, remainingNotes, pTol, opts.timeTol || 6);

          // occurrences + original = total instances
          const totalInstances = occs.length + 1;

          if (totalInstances < minOcc) continue;

          // Coverage: subSeg.length * totalInstances
          const coverage = subSeg.length * totalInstances;

          // Compression ratio
          const cost = subSeg.length + occs.length * 2;
          const ratio = coverage / Math.max(1, cost);

          if (ratio < minRatio) continue;

          // Score: prioritize high coverage (big patterns with many repeats)
          const score = coverage * ratio;

          candidates.push({
            segment: subSeg,
            occurrences: occs,
            totalInstances,
            coverage,
            ratio,
            score,
            round,
            source: 'mtp',
          });
        }
      }
    }

    // ---- Phase B: Direct segment scan ----
    // For smaller datasets, scan contiguous blocks directly.
    // This catches patterns SIA might miss (e.g., when MTPs are fragmented).
    if (remainingNotes.length <= 500) {
      const sortedNotes = [...remainingNotes].sort((a, b) => a.start - b.start);

      // Try segments starting at each note
      for (let startIdx = 0; startIdx < sortedNotes.length; startIdx++) {
        // Build a contiguous segment from this starting point
        const segment = [sortedNotes[startIdx]];
        for (let j = startIdx + 1; j < sortedNotes.length && segment.length < maxLen; j++) {
          const gap = sortedNotes[j].start - segment[segment.length - 1].start;
          if (gap > ppq * 4) break; // max 4 beats gap
          segment.push(sortedNotes[j]);

          if (segment.length >= minLen) {
            const segKey = segment.map(n => sortedNotes.indexOf(n)).sort().join(',');
            if (seenSegments.has(segKey)) continue;
            seenSegments.add(segKey);

            const occs = findAllOccurrences(segment, remainingNotes, pTol, opts.timeTol || 6);
            const totalInstances = occs.length + 1;

            if (totalInstances < minOcc) continue;

            const coverage = segment.length * totalInstances;
            const cost = segment.length + occs.length * 2;
            const ratio = coverage / Math.max(1, cost);

            if (ratio < minRatio) continue;

            const score = coverage * ratio;

            candidates.push({
              segment,
              occurrences: occs,
              totalInstances,
              coverage,
              ratio,
              score,
              round,
              source: 'scan',
            });
          }
        }
      }
    }

    // ---- Select best candidate ----
    if (candidates.length === 0) break;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // ---- Record occurrences ----
    const coveredNoteIndices = new Set();
    const occurrences = [];

    // Original (indices in remainingNotes)
    const origIndices = best.segment.map(segNote => {
      const idx = remainingNotes.findIndex(
        n => n.start === segNote.t && n.pitch === segNote.p
      );
      if (idx >= 0) coveredNoteIndices.add(idx);
      return idx;
    }).filter(i => i >= 0);

    occurrences.push({
      dx: 0,
      dy: 0,
      noteIds: origIndices,
    });

    // Translated occurrences
    for (const occ of best.occurrences) {
      const occIds = occ.noteIndices.filter(id => !coveredNoteIndices.has(id));
      if (occIds.length === best.segment.length) {
        occIds.forEach(id => coveredNoteIndices.add(id));
        occurrences.push({
          dx: occ.dx,
          dy: occ.dy,
          noteIds: occIds,
        });
      }
    }

    if (occurrences.length < minOcc) continue;

    // ---- Store pattern ----
    const templateNotes = best.segment.map(segNote => {
      const match = remainingNotes.find(
        n => n.start === segNote.t && n.pitch === segNote.p
      );
      return match || {
        start: segNote.t, pitch: segNote.p,
        dur: segNote.d, vel: segNote.v,
        track: segNote.track, ch: segNote.ch,
        end: segNote.t + (segNote.d || 0),
      };
    });

    // Convert remainingNotes indices -> original notes indices
    function toOrigIdx(remIdx) {
      const n = remainingNotes[remIdx];
      if (!n) return -1;
      const key = `${n.track},${n.start},${n.pitch},${n.ch}`;
      return origIndexMap.get(key) ?? -1;
    }

    allPatterns.push({
      id: round - 1,
      notes: templateNotes,
      occurrences: occurrences.map((o, i) => ({
        id: i,
        track: remainingNotes[o.noteIds[0]]?.track || 0,
        start: remainingNotes[o.noteIds[0]]?.start || 0,
        end: (remainingNotes[o.noteIds[o.noteIds.length - 1]]?.start || 0) +
             (remainingNotes[o.noteIds[o.noteIds.length - 1]]?.dur || 0),
        transposition: o.dy,
        delay: o.dx,
        // Convert to original note indices for renderer
        noteIds: o.noteIds.map(toOrigIdx).filter(i => i >= 0),
      })),
      coverage: coveredNoteIndices.size,
      score: best.score,
      compressionRatio: best.ratio,
      round,
      source: best.source,
    });

    onProgress('pattern', {
      round,
      patterns: allPatterns.length,
      coverage: coveredNoteIndices.size,
      source: best.source,
    });

    // ---- Peel ----
    if (iterative) {
      const keep = [];
      remainingNotes.forEach((n, i) => {
        if (!coveredNoteIndices.has(i)) keep.push(n);
      });
      remainingNotes = keep;
    } else {
      break;
    }
  }

  // ---- Results ----
  const trunk = remainingNotes;
  const totalNotes = notes.length;
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
    totalNotes,
    patternNotes: coveredByPatterns,
    instanceCount: allPatterns.reduce((s, p) => s + p.occurrences.length, 0),
    rounds: round,
    wasDownsampled: false,
  };
}
