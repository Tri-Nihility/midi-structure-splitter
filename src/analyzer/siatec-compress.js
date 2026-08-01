/**
 * SIATECCOMPRESS — Single-Pass Pattern Compression
 *
 * Unlike COSIATEC (which iteratively runs SIA+SIATEC and peels notes),
 * SIATECCOMPRESS runs SIA and SIATEC just once on ALL notes, then uses
 * a greedy set cover to select the best TECs that maximize coverage.
 *
 * This makes it 3-6x faster than COSIATEC at the cost of slightly lower
 * compression rates. TECs may have overlapping covered sets.
 *
 * Based on Meredith (2013/2015), "COSIATEC and SIATECCOMPRESS".
 *
 * @module siatec-compress
 */

import {
  notesToPoints,
  computeVectorTable,
  computeVectorTableSIAR,
  extractContiguousSegments,
  findAllOccurrences,
  buildSpatialIndex,
  calculateCompactness,
} from './sia.js';
import { applyRRTToResult } from './rrt.js';

// ---- Configuration ----

const MAX_NOTES = 5000;
const MAX_MTP_CANDIDATES = 300;
const MAX_VECTOR_PAIRS = 80000;
const SIAR_THRESHOLD = 3000;

// ---- Candidate Building ----

/**
 * Build TEC candidates from MTPs in a single pass.
 *
 * @param {object[]} notes     - All notes
 * @param {number}   ppq       - Pulses per quarter note
 * @param {object}   opts      - Options
 * @returns {object[]} Array of TEC candidates
 */
function buildTECandidates(notes, ppq, opts) {
  const points = notesToPoints(notes);
  const spatialIndex = buildSpatialIndex(points);

  const useSIAR = points.length > SIAR_THRESHOLD;
  const mtps = useSIAR
    ? computeVectorTableSIAR(points, null, MAX_VECTOR_PAIRS)
    : computeVectorTable(points);

  const mtpLimit = Math.min(mtps.length, MAX_MTP_CANDIDATES);
  const seenSegments = new Set();
  const tecs = [];

  const minLen = opts.minLen || 3;
  const maxLen = opts.maxLen || 128;
  const minOcc = opts.minOcc || 2;
  const pTol = opts.pitchTol || 0;
  const timeTol = opts.timeTol || 6;

  // Pre-build time index for findAllOccurrences
  const notesByTime = new Map();
  notes.forEach((n, i) => {
    if (!notesByTime.has(n.start)) notesByTime.set(n.start, []);
    notesByTime.get(n.start).push({ note: n, idx: i });
  });
  const minRatio = opts.minRatio || 1.5;
  const minCompactness = opts.minCompactness ?? 0.1;

  for (let mi = 0; mi < mtpLimit; mi++) {
    const mtp = mtps[mi];
    const maxGap = Math.max(ppq * 2, 200);
    const segments = extractContiguousSegments(mtp.points, minLen, maxGap);

    for (const seg of segments) {
      if (seg.length < minLen) continue;

      const segSizes = [];
      if (seg.length <= maxLen) segSizes.push(seg.length);
      for (let sz = minLen; sz <= Math.min(maxLen, seg.length); sz += minLen) {
        if (!segSizes.includes(sz)) segSizes.push(sz);
      }

      for (const size of segSizes) {
        const subSeg = seg.slice(0, size);
        const segKey = subSeg.map(p => p.id).sort().join(',');
        if (seenSegments.has(segKey)) continue;
        seenSegments.add(segKey);

        const occs = findAllOccurrences(subSeg, notes, pTol, timeTol, notesByTime);
        const totalInstances = occs.length + 1;

        if (totalInstances < minOcc) continue;

        const coverage = subSeg.length * totalInstances;
        const cost = subSeg.length + occs.length * 2;
        const ratio = coverage / Math.max(1, cost);

        if (ratio < minRatio) continue;

        const compactness = calculateCompactness(subSeg);
        if (compactness < minCompactness) continue;

        tecs.push({
          segment: subSeg,
          occurrences: occs,
          totalInstances,
          coverage,
          ratio,
          compactness,
          score: coverage * ratio * (1 + compactness * 2),
          vector: mtp.vector,
        });
      }
    }
  }

  return tecs;
}

// ---- Greedy Set Cover ----

/**
 * Select TECs using greedy set cover to maximize note coverage.
 *
 * TECs are sorted by score. Each TEC is selected only if it covers
 * a minimum number of new (not-yet-covered) notes.
 *
 * @param {object[]} tecs  - TEC candidates from buildTECandidates()
 * @param {object[]} notes - All notes
 * @param {number}   maxPat - Maximum patterns to select
 * @param {number}   minLen - Minimum new coverage per TEC
 * @returns {object} { patterns, coveredNoteIndices }
 */
function greedySetCover(tecs, notes, maxPat, minLen) {
  // Sort by score descending
  tecs.sort((a, b) => b.score - a.score);

  // Build note identity -> index map
  const noteIdMap = new Map();
  notes.forEach((n, i) => {
    const key = `${n.track},${n.start},${n.pitch},${n.ch}`;
    noteIdMap.set(key, i);
  });

  const covered = new Set();
  const selected = [];

  for (const tec of tecs) {
    if (selected.length >= maxPat) break;

    // Calculate new coverage
    const newCovered = new Set();

    // Original occurrence
    for (const p of tec.segment) {
      const key = `${p.track},${p.t},${p.p},${p.ch ?? 0}`;
      const idx = noteIdMap.get(key);
      if (idx !== undefined && !covered.has(idx)) newCovered.add(idx);
    }

    // Translated occurrences
    for (const occ of tec.occurrences) {
      for (const p of tec.segment) {
        const tt = (p.t ?? p.start) + occ.dx;
        const tp = (p.p ?? p.pitch) + occ.dy;
        const key = `${p.track},${tt},${tp},${p.ch ?? 0}`;
        const idx = noteIdMap.get(key);
        if (idx !== undefined && !covered.has(idx)) newCovered.add(idx);
      }
    }

    // Only select if it covers enough new notes
    if (newCovered.size >= minLen) {
      selected.push({ tec, newCovered: Array.from(newCovered) });
      for (const idx of newCovered) covered.add(idx);
    }
  }

  return { selected, covered };
}

// ---- Main Entry Point ----

/**
 * SIATECCOMPRESS: Single-pass pattern compression.
 *
 * Runs SIA + DIATECH once, then uses greedy set cover to select the
 * best TECs. 3-6x faster than COSIATEC, with slightly lower compression.
 *
 * @param {object[]} notes - All note objects
 * @param {number}   ppq   - Pulses per quarter note
 * @param {object}   opts  - Algorithm options
 * @returns {object} Compression result (same format as cosiatecCompress)
 */
export function siatecCompress(notes, ppq, opts = {}) {
  const minLen = Math.max(2, opts.minLen || 3);
  const maxPat = Math.max(1, Math.min(opts.maxPatterns || 8, 20));
  const useRRT = opts.useRRT !== false;
  const onProgress = opts.onProgress || (() => {});

  if (notes.length > MAX_NOTES) {
    notes = notes.slice(0, MAX_NOTES);
  }

  onProgress('start', { total: notes.length, maxRounds: 1 });

  // Step 1: Build all TEC candidates (single SIA run)
  onProgress('round', { round: 1, remaining: notes.length, phase: 'sia' });
  const tecs = buildTECandidates(notes, ppq, opts);

  onProgress('round', { round: 1, remaining: notes.length, phase: 'cover', tecCount: tecs.length });

  // Step 2: Greedy set cover
  const { selected, covered } = greedySetCover(tecs, notes, maxPat, minLen);

  // Step 3: Build patterns in COSIATEC-compatible format
  const origIndexMap = new Map();
  notes.forEach((n, i) => {
    origIndexMap.set(`${n.track},${n.start},${n.pitch},${n.ch}`, i);
  });

  const patterns = selected.map((sel, pi) => {
    const tec = sel.tec;

    // Build template notes
    const templateNotes = tec.segment.map(segNote => {
      const key = `${segNote.track},${segNote.t ?? segNote.start},${segNote.p ?? segNote.pitch},${segNote.ch ?? 0}`;
      const idx = origIndexMap.get(key);
      if (idx !== undefined) return notes[idx];
      return {
        start: segNote.t ?? segNote.start,
        pitch: segNote.p ?? segNote.pitch,
        dur: segNote.d ?? segNote.dur,
        vel: segNote.v ?? segNote.vel,
        track: segNote.track,
        ch: segNote.ch,
        end: (segNote.t ?? segNote.start) + ((segNote.d ?? segNote.dur) || 0),
      };
    });

    // Build occurrences
    const occurrences = [];

    // Original
    const origNoteIds = tec.segment.map(segNote => {
      const key = `${segNote.track},${segNote.t ?? segNote.start},${segNote.p ?? segNote.pitch},${segNote.ch ?? 0}`;
      return origIndexMap.get(key) ?? -1;
    }).filter(i => i >= 0);

    occurrences.push({
      id: 0,
      track: templateNotes[0]?.track || 0,
      start: templateNotes[0]?.start || 0,
      end: (templateNotes[templateNotes.length - 1]?.start || 0) +
           (templateNotes[templateNotes.length - 1]?.dur || 0),
      transposition: 0,
      delay: 0,
      noteIds: origNoteIds,
    });

    // Translated
    for (let oi = 0; oi < tec.occurrences.length; oi++) {
      const occ = tec.occurrences[oi];
      const occNoteIds = occ.noteIndices
        .filter(id => covered.has(id))
        .filter(id => id >= 0);

      if (occNoteIds.length >= tec.segment.length) {
        const firstNote = notes[occNoteIds[0]];
        const lastNote = notes[occNoteIds[occNoteIds.length - 1]];
        occurrences.push({
          id: oi + 1,
          track: firstNote?.track || 0,
          start: firstNote?.start || 0,
          end: (lastNote?.start || 0) + (lastNote?.dur || 0),
          transposition: occ.dy,
          delay: occ.dx,
          noteIds: occNoteIds,
        });
      }
    }

    return {
      id: pi,
      notes: templateNotes,
      occurrences,
      coverage: sel.newCovered.length,
      score: tec.score,
      compressionRatio: tec.ratio,
      round: 1,
      source: 'siateccompress',
    };
  });

  // Apply RRT
  const finalPatterns = useRRT ? applyRRTToResult(patterns) : patterns;

  // Build trunk
  const trunk = notes.filter((_, i) => !covered.has(i));

  // Statistics
  const totalNotes = notes.length;
  const coveredByPatterns = totalNotes - trunk.length;
  const patternDefSize = finalPatterns.reduce((s, p) => s + p.notes.length, 0);
  const instanceRefSize = finalPatterns.reduce((s, p) => s + p.occurrences.length, 0);
  const compressedSize = trunk.length + patternDefSize + instanceRefSize * 2;
  const compressionRate =
    totalNotes > 0 ? (1 - compressedSize / totalNotes) * 100 : 0;

  onProgress('done', { compressionRate, patterns: finalPatterns.length });

  return {
    patterns: finalPatterns,
    trunk,
    compressionRate,
    coverage: totalNotes > 0 ? coveredByPatterns / totalNotes : 0,
    totalNotes,
    patternNotes: coveredByPatterns,
    instanceCount: finalPatterns.reduce((s, p) => s + p.occurrences.length, 0),
    rounds: 1,
    wasDownsampled: false,
    algorithm: 'siateccompress',
  };
}
