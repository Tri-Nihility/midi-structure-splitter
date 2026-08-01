/**
 * COSIATEC Web Worker
 *
 * Runs cosiatecCompress in a background thread so the main thread
 * stays responsive. Communicates via postMessage:
 *
 *   Main -> Worker: { type: 'analyze', notes, ppq, opts }
 *   Main -> Worker: { type: 'optimize', notes, ppq, grid, maxTests }
 *   Main -> Worker: { type: 'cancel' }
 *
 *   Worker -> Main: { type: 'progress', phase, detail }
 *   Worker -> Main: { type: 'result', result }
 *   Worker -> Main: { type: 'error', message }
 */

importScripts('../analyzer/sia.js', '../analyzer/cosiatec.js');

// Worker doesn't support ES modules for importScripts in all browsers,
// so we inline the required modules below.

// ---- Inlined sia.js (minimal) ----
const SIA_MODULE = {};
(function(exports) {

function notesToPoints(notes) {
  return notes.map((n, i) => ({
    id: i, t: n.start, p: n.pitch, d: n.dur,
    v: n.vel, track: n.track, ch: n.ch, raw: n,
  }));
}

function computeVectorTable(points) {
  const sorted = [...points].sort((a, b) => a.t - b.t || a.p - b.p);
  const n = sorted.length;
  const vectors = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      vectors.push({ dx: sorted[j].t - sorted[i].t, dy: sorted[j].p - sorted[i].p, from: sorted[i], to: sorted[j] });
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
  mtps.sort((a, b) => b.points.length - a.points.length);
  return mtps;
}

function extractContiguousSegments(mtpPoints, minLen, maxGap) {
  const sorted = [...mtpPoints].sort((a, b) => a.t - b.t || a.p - b.p);
  if (sorted.length < minLen) return [];
  const segments = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].t - sorted[i - 1].t;
    if (gap <= maxGap) { current.push(sorted[i]); }
    else { if (current.length >= minLen) segments.push([...current]); current = [sorted[i]]; }
  }
  if (current.length >= minLen) segments.push([...current]);
  segments.sort((a, b) => b.length - a.length);
  return segments;
}

function findAllOccurrences(segment, allNotes, pitchTol, timeTol) {
  if (segment.length < 2) return [];
  const getT = (sn) => sn.t ?? sn.start;
  const getP = (sn) => sn.p ?? sn.pitch;
  const segFirst = segment[0], segLast = segment[segment.length - 1];
  const segFirstT = getT(segFirst), segFirstP = getP(segFirst), segLastT = getT(segLast);
  const notesByTime = new Map();
  allNotes.forEach((n, i) => { const t = n.start; if (!notesByTime.has(t)) notesByTime.set(t, []); notesByTime.get(t).push({ note: n, idx: i }); });
  const occurrences = [];
  for (let anchorIdx = 0; anchorIdx < allNotes.length; anchorIdx++) {
    const anchor = allNotes[anchorIdx];
    const dx = anchor.start - segFirstT, dy = anchor.pitch - segFirstP;
    if (dx === 0 && dy === 0) continue;
    const lastExpectedT = segLastT + dx;
    if (lastExpectedT > (allNotes[allNotes.length - 1]?.end || 0) + timeTol) continue;
    const matchedIndices = []; let valid = true;
    for (const segNote of segment) {
      const targetT = getT(segNote) + dx, targetP = getP(segNote) + dy;
      let found = false;
      for (let dt = -timeTol; dt <= timeTol && !found; dt++) {
        const bucket = notesByTime.get(targetT + dt);
        if (!bucket) continue;
        for (const { note, idx } of bucket) {
          if (Math.abs(note.pitch - targetP) <= pitchTol) {
            if (!matchedIndices.includes(idx)) { matchedIndices.push(idx); found = true; break; }
          }
        }
      }
      if (!found) { valid = false; break; }
    }
    if (valid && matchedIndices.length === segment.length) {
      occurrences.push({ dx, dy, startIdx: anchorIdx, noteIndices: [...matchedIndices] });
    }
  }
  return occurrences;
}

exports.notesToPoints = notesToPoints;
exports.computeVectorTable = computeVectorTable;
exports.extractContiguousSegments = extractContiguousSegments;
exports.findAllOccurrences = findAllOccurrences;
})(SIA_MODULE);

// ---- Inlined cosiatec.js ----
const { notesToPoints, computeVectorTable, extractContiguousSegments, findAllOccurrences } = SIA_MODULE;

const MAX_NOTES = 5000;
const MAX_MTP_CANDIDATES = 300;

function buildSpatialIndex(points) {
  const index = new Map();
  for (const p of points) { const key = `${p.t},${p.p}`; if (!index.has(key)) index.set(key, []); index.get(key).push(p); }
  return index;
}

function cosiatecCompress(notes, ppq, opts = {}) {
  const minLen = Math.max(2, opts.minLen || 3);
  const maxLen = Math.min(256, opts.maxLen || 128);
  const minOcc = Math.max(2, opts.minOcc || 2);
  const pTol = opts.pitchTol || 0;
  const maxPat = Math.max(1, Math.min(opts.maxPatterns || 8, 20));
  const minRatio = opts.minRatio || 1.5;
  const iterative = opts.iterative !== false;
  const onProgress = opts.onProgress || (() => {});

  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);

  onProgress('start', { total: notes.length, maxRounds: maxPat });

  const origIndexMap = new Map();
  notes.forEach((n, i) => { origIndexMap.set(`${n.track},${n.start},${n.pitch},${n.ch}`, i); });

  let remainingNotes = [...notes];
  const allPatterns = [];
  let round = 0;

  while (remainingNotes.length >= minLen && round < maxPat) {
    round++;
    onProgress('round', { round, remaining: remainingNotes.length });
    const points = notesToPoints(remainingNotes);
    const candidates = [];
    const mtps = computeVectorTable(points);
    const mtpLimit = Math.min(mtps.length, MAX_MTP_CANDIDATES);
    const seenSegments = new Set();

    // Phase A: MTP-based
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
          const occs = findAllOccurrences(subSeg, remainingNotes, pTol, opts.timeTol || 6);
          const totalInstances = occs.length + 1;
          if (totalInstances < minOcc) continue;
          const coverage = subSeg.length * totalInstances;
          const cost = subSeg.length + occs.length * 2;
          const ratio = coverage / Math.max(1, cost);
          if (ratio < minRatio) continue;
          candidates.push({ segment: subSeg, occurrences: occs, totalInstances, coverage, ratio, score: coverage * ratio, round, source: 'mtp' });
        }
      }
    }

    // Phase B: Direct segment scan
    if (remainingNotes.length <= 500) {
      const sortedNotes = [...remainingNotes].sort((a, b) => a.start - b.start);
      for (let startIdx = 0; startIdx < sortedNotes.length; startIdx++) {
        const segment = [sortedNotes[startIdx]];
        for (let j = startIdx + 1; j < sortedNotes.length && segment.length < maxLen; j++) {
          const gap = sortedNotes[j].start - segment[segment.length - 1].start;
          if (gap > ppq * 4) break;
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
            candidates.push({ segment, occurrences: occs, totalInstances, coverage, ratio, score: coverage * ratio, round, source: 'scan' });
          }
        }
      }
    }

    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    const coveredNoteIndices = new Set();
    const occurrences = [];
    const origIndices = best.segment.map(segNote => {
      const idx = remainingNotes.findIndex(n => n.start === (segNote.t ?? segNote.start) && n.pitch === (segNote.p ?? segNote.pitch));
      if (idx >= 0) coveredNoteIndices.add(idx);
      return idx;
    }).filter(i => i >= 0);
    occurrences.push({ dx: 0, dy: 0, noteIds: origIndices });
    for (const occ of best.occurrences) {
      const occIds = occ.noteIndices.filter(id => !coveredNoteIndices.has(id));
      if (occIds.length === best.segment.length) {
        occIds.forEach(id => coveredNoteIndices.add(id));
        occurrences.push({ dx: occ.dx, dy: occ.dy, noteIds: occIds });
      }
    }
    if (occurrences.length < minOcc) continue;

    const templateNotes = best.segment.map(segNote => {
      const match = remainingNotes.find(n => n.start === (segNote.t ?? segNote.start) && n.pitch === (segNote.p ?? segNote.pitch));
      return match || { start: segNote.t ?? segNote.start, pitch: segNote.p ?? segNote.pitch, dur: segNote.d ?? segNote.dur, vel: segNote.v ?? segNote.vel, track: segNote.track, ch: segNote.ch, end: (segNote.t ?? segNote.start) + ((segNote.d ?? segNote.dur) || 0) };
    });

    function toOrigIdx(remIdx) {
      const n = remainingNotes[remIdx];
      if (!n) return -1;
      return origIndexMap.get(`${n.track},${n.start},${n.pitch},${n.ch}`) ?? -1;
    }

    allPatterns.push({
      id: round - 1,
      notes: templateNotes,
      occurrences: occurrences.map((o, i) => ({
        id: i,
        track: remainingNotes[o.noteIds[0]]?.track || 0,
        start: remainingNotes[o.noteIds[0]]?.start || 0,
        end: (remainingNotes[o.noteIds[o.noteIds.length - 1]]?.start || 0) + (remainingNotes[o.noteIds[o.noteIds.length - 1]]?.dur || 0),
        transposition: o.dy,
        delay: o.dx,
        noteIds: o.noteIds.map(toOrigIdx).filter(i => i >= 0),
      })),
      coverage: coveredNoteIndices.size,
      score: best.score,
      compressionRatio: best.ratio,
      round,
      source: best.source,
    });

    if (iterative) {
      const keep = [];
      remainingNotes.forEach((n, i) => { if (!coveredNoteIndices.has(i)) keep.push(n); });
      remainingNotes = keep;
    } else { break; }
  }

  const trunk = remainingNotes;
  const totalNotes = notes.length;
  const coveredByPatterns = totalNotes - trunk.length;
  const patternDefSize = allPatterns.reduce((s, p) => s + p.notes.length, 0);
  const instanceRefSize = allPatterns.reduce((s, p) => s + p.occurrences.length, 0);
  const compressedSize = trunk.length + patternDefSize + instanceRefSize * 2;
  const compressionRate = totalNotes > 0 ? (1 - compressedSize / totalNotes) * 100 : 0;

  return {
    patterns: allPatterns, trunk, compressionRate,
    coverage: totalNotes > 0 ? coveredByPatterns / totalNotes : 0,
    totalNotes, patternNotes: coveredByPatterns,
    instanceCount: allPatterns.reduce((s, p) => s + p.occurrences.length, 0),
    rounds: round, wasDownsampled: false,
  };
}

// ---- Parameter grid ----
const PARAM_GRID = {
  minLen:       [4, 6, 8],
  maxLen:       [16, 32, 64],
  minOcc:       [2, 3],
  pitchTol:     [0, 2],
  maxPatterns:  [4, 6, 8],
  minRatio:     [1.5, 2.0],
};

function* generateParamCombos() {
  const keys = Object.keys(PARAM_GRID);
  const values = keys.map(k => PARAM_GRID[k]);
  function* cartesian(idx, current) {
    if (idx === keys.length) { yield { ...current }; return; }
    for (const v of values[idx]) { current[keys[idx]] = v; yield* cartesian(idx + 1, current); }
  }
  yield* cartesian(0, {});
}

// ---- Message handler ----
self.onmessage = function(e) {
  const { type, notes, ppq, opts, maxTests } = e.data;

  if (type === 'analyze') {
    try {
      const result = cosiatecCompress(notes, ppq, {
        ...opts,
        onProgress: (phase, detail) => {
          self.postMessage({ type: 'progress', phase, detail });
        },
      });
      self.postMessage({ type: 'result', result });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  if (type === 'optimize') {
    const MAX_TESTS = maxTests || 200;
    let bestResult = null;
    let tested = 0;

    try {
      for (const params of generateParamCombos()) {
        if (tested >= MAX_TESTS) break;

        const result = cosiatecCompress(notes, ppq, {
          minLen: params.minLen,
          maxLen: params.maxLen,
          minOcc: params.minOcc,
          pitchTol: params.pitchTol,
          timeTol: opts.timeTol || 6,
          maxPatterns: params.maxPatterns,
          minRatio: params.minRatio,
          detectTrans: opts.detectTrans,
          iterative: opts.iterative,
        });

        tested++;
        if (!bestResult || result.compressionRate > bestResult.compressionRate) {
          bestResult = { ...result, params: { ...params } };
        }

        self.postMessage({
          type: 'optimize-progress',
          tested,
          total: MAX_TESTS,
          bestRate: bestResult.compressionRate,
          bestParams: bestResult.params,
        });
      }

      // Run final analysis with best params
      const finalResult = cosiatecCompress(notes, ppq, {
        minLen: bestResult.params.minLen,
        maxLen: bestResult.params.maxLen,
        minOcc: bestResult.params.minOcc,
        pitchTol: bestResult.params.pitchTol,
        timeTol: opts.timeTol || 6,
        maxPatterns: bestResult.params.maxPatterns,
        minRatio: bestResult.params.minRatio,
        detectTrans: opts.detectTrans,
        iterative: opts.iterative,
      });

      self.postMessage({
        type: 'optimize-done',
        result: finalResult,
        bestParams: bestResult.params,
        tested,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
