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
 *
 * Optimization v2 (synced from src/analyzer/):
 *   - TypedArray vector storage (Int32Array/Int16Array/Uint32Array)
 *   - Integer key spatial index
 *   - Pre-built O(1) lookup maps
 *   - Phase B prefix quick-check pruning
 *   - Compactness scoring filter
 *   - Chunked SIA for large datasets
 */

// ============================================================
//  Inlined sia.js (optimized v2)
// ============================================================
const SIA_MODULE = {};
(function(exports) {

const MIN_MTP_SIZE = 4;
const MAX_VECTOR_PAIRS = 80000;

// ---- Point Conversion ----

function notesToPoints(notes) {
  return notes.map((n, i) => ({
    id: i, t: n.start, p: n.pitch, d: n.dur,
    v: n.vel, track: n.track, ch: n.ch, raw: n,
  }));
}

// ---- TypedArray-Optimized SIA ----

function computeVectorTableOptimized(points, maxVectors) {
  const n = points.length;
  const totalVectors = (n * (n - 1)) / 2;
  const cap = maxVectors ? Math.min(totalVectors, maxVectors) : totalVectors;

  const sorted = [...points].sort((a, b) => a.t - b.t || a.p - b.p);

  const dxArray = new Int32Array(cap);
  const dyArray = new Int16Array(cap);
  const fromIdx = new Uint32Array(cap);
  const toIdx = new Uint32Array(cap);

  let count = 0;
  for (let i = 0; i < n && count < cap; i++) {
    for (let j = i + 1; j < n && count < cap; j++) {
      dxArray[count] = sorted[j].t - sorted[i].t;
      dyArray[count] = sorted[j].p - sorted[i].p;
      fromIdx[count] = i;
      toIdx[count] = j;
      count++;
    }
  }

  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;

  indices.sort((a, b) => {
    const ddx = dxArray[a] - dxArray[b];
    return ddx !== 0 ? ddx : dyArray[a] - dyArray[b];
  });

  const mtps = [];
  let start = 0;

  for (let i = 1; i <= count; i++) {
    const isLast = i === count;
    const isDiff = !isLast && (
      dxArray[indices[i]] !== dxArray[indices[start]] ||
      dyArray[indices[i]] !== dyArray[indices[start]]
    );

    if (isLast || isDiff) {
      const pointSet = new Set();
      for (let k = start; k < i; k++) {
        pointSet.add(sorted[fromIdx[indices[k]]]);
        pointSet.add(sorted[toIdx[indices[k]]]);
      }
      if (pointSet.size >= MIN_MTP_SIZE) {
        mtps.push({
          vector: { dx: dxArray[indices[start]], dy: dyArray[indices[start]] },
          points: Array.from(pointSet),
        });
      }
      start = i;
    }
  }

  mtps.sort((a, b) => b.points.length - a.points.length);
  return mtps;
}

// ---- Chunked SIA ----

function computeVectorTableChunked(points, maxChunkSize) {
  maxChunkSize = maxChunkSize || 1500;
  const n = points.length;
  if (n <= maxChunkSize) return computeVectorTableOptimized(points);

  const sorted = [...points].sort((a, b) => a.t - b.t || a.p - b.p);
  const allMtps = new Map();

  for (let start = 0; start < n; start += maxChunkSize) {
    const chunk = sorted.slice(start, start + maxChunkSize);
    const chunkMtps = computeVectorTableOptimized(chunk);
    for (const mtp of chunkMtps) {
      const vKey = mtp.vector.dx + ',' + mtp.vector.dy;
      if (!allMtps.has(vKey)) allMtps.set(vKey, new Set());
      for (const p of mtp.points) allMtps.get(vKey).add(p);
    }
  }

  const overlap = Math.floor(maxChunkSize * 0.2);
  for (let i = 0; i < sorted.length - maxChunkSize; i += maxChunkSize) {
    const bStart = i + maxChunkSize - overlap;
    const bEnd = Math.min(bStart + overlap * 2, sorted.length);
    const boundary = sorted.slice(bStart, bEnd);
    const bMtps = computeVectorTableOptimized(boundary);
    for (const mtp of bMtps) {
      const vKey = mtp.vector.dx + ',' + mtp.vector.dy;
      if (!allMtps.has(vKey)) allMtps.set(vKey, new Set());
      for (const p of mtp.points) allMtps.get(vKey).add(p);
    }
  }

  const mtps = [];
  for (const [vKey, pointSet] of allMtps) {
    const [dx, dy] = vKey.split(',').map(Number);
    mtps.push({ vector: { dx, dy }, points: Array.from(pointSet) });
  }
  mtps.sort((a, b) => b.points.length - a.points.length);
  return mtps;
}

function computeVectorTable(points) {
  const n = points.length;
  const totalVectors = (n * (n - 1)) / 2;
  if (totalVectors > MAX_VECTOR_PAIRS) {
    return computeVectorTableChunked(points);
  }
  return computeVectorTableOptimized(points);
}

// ---- SIAR: Sliding Window SIA ----

function estimateWindowSize(sortedPoints) {
  if (sortedPoints.length < 2) return 10;
  const timeSpan = sortedPoints[sortedPoints.length - 1].t - sortedPoints[0].t;
  if (timeSpan <= 0) return 50;
  const density = sortedPoints.length / Math.max(1, timeSpan / 96);
  return Math.ceil(Math.max(10, Math.min(density * 2, 100)));
}

function computeVectorTableSIAR(points, R, maxVectors) {
  const n = points.length;
  if (n < 2) return [];
  const sorted = [...points].sort((a, b) => a.t - b.t || a.p - b.p);
  if (R == null) R = estimateWindowSize(sorted);
  R = Math.max(10, Math.min(R, Math.floor(n * 0.15)));
  const estimatedVectors = Math.min(n * R, (n * (n - 1)) / 2);
  const cap = maxVectors ? Math.min(estimatedVectors, maxVectors) : estimatedVectors;
  const dxArray = new Int32Array(cap);
  const dyArray = new Int16Array(cap);
  const fromIdx = new Uint32Array(cap);
  const toIdx = new Uint32Array(cap);
  var count = 0;
  for (var i = 0; i < n && count < cap; i++) {
    var end = Math.min(i + R + 1, n);
    for (var j = i + 1; j < end && count < cap; j++) {
      dxArray[count] = sorted[j].t - sorted[i].t;
      dyArray[count] = sorted[j].p - sorted[i].p;
      fromIdx[count] = i;
      toIdx[count] = j;
      count++;
    }
  }
  var indices = new Uint32Array(count);
  for (var i2 = 0; i2 < count; i2++) indices[i2] = i2;
  indices.sort(function(a, b) {
    var ddx = dxArray[a] - dxArray[b];
    return ddx !== 0 ? ddx : dyArray[a] - dyArray[b];
  });
  var mtps = [];
  var start = 0;
  for (var i3 = 1; i3 <= count; i3++) {
    var isLast = i3 === count;
    var isDiff = !isLast && (dxArray[indices[i3]] !== dxArray[indices[start]] || dyArray[indices[i3]] !== dyArray[indices[start]]);
    if (isLast || isDiff) {
      var pointSet = new Set();
      for (var k = start; k < i3; k++) {
        pointSet.add(sorted[fromIdx[indices[k]]]);
        pointSet.add(sorted[toIdx[indices[k]]]);
      }
      if (pointSet.size >= MIN_MTP_SIZE) {
        mtps.push({ vector: { dx: dxArray[indices[start]], dy: dyArray[indices[start]] }, points: Array.from(pointSet) });
      }
      start = i3;
    }
  }
  mtps.sort(function(a, b) { return b.points.length - a.points.length; });
  return mtps;
}

// ---- Integer Key Spatial Index ----

function buildSpatialIndex(points, timeBits, pitchBits) {
  timeBits = timeBits || 20;
  pitchBits = pitchBits || 8;
  const index = new Map();
  for (const p of points) {
    const key = p.t + ':' + p.p;
    let bucket = index.get(key);
    if (!bucket) { bucket = []; index.set(key, bucket); }
    bucket.push(p);
  }
  return { index, timeBits, pitchBits };
}

function lookupSpatialIndex(spatialIndex, t, p) {
  return spatialIndex.index.get(t + ':' + p);
}

// ---- Contiguous Segments ----

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

// ---- DIATECH: Find All Occurrences ----

function findAllOccurrences(segment, allNotes, pitchTol, timeTol, notesByTime) {
  if (segment.length < 2) return [];
  const getT = (sn) => sn.t ?? sn.start;
  const getP = (sn) => sn.p ?? sn.pitch;
  const segFirst = segment[0], segLast = segment[segment.length - 1];
  const segFirstT = getT(segFirst), segFirstP = getP(segFirst), segLastT = getT(segLast);
  // Use pre-built time index if provided, otherwise build one
  if (!notesByTime) {
    notesByTime = new Map();
    allNotes.forEach((n, i) => { const t = n.start; if (!notesByTime.has(t)) notesByTime.set(t, []); notesByTime.get(t).push({ note: n, idx: i }); });
  }
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

// ---- Compactness Scoring ----

function calculateCompactness(segment) {
  if (segment.length < 2) return 1;
  let minT = Infinity, maxT = -Infinity, minP = Infinity, maxP = -Infinity;
  for (const n of segment) {
    const t = n.t ?? n.start, p = n.p ?? n.pitch;
    minT = Math.min(minT, t); maxT = Math.max(maxT, t);
    minP = Math.min(minP, p); maxP = Math.max(maxP, p);
  }
  const area = (maxT - minT + 1) * (maxP - minP + 1);
  return area > 0 ? segment.length / area : 1;
}

exports.notesToPoints = notesToPoints;
exports.computeVectorTable = computeVectorTable;
exports.computeVectorTableSIAR = computeVectorTableSIAR;
exports.extractContiguousSegments = extractContiguousSegments;
exports.findAllOccurrences = findAllOccurrences;
exports.buildSpatialIndex = buildSpatialIndex;
exports.lookupSpatialIndex = lookupSpatialIndex;
exports.calculateCompactness = calculateCompactness;
})(SIA_MODULE);

// ============================================================
//  Inlined cosiatec.js (optimized v2)
// ============================================================
const {
  notesToPoints, computeVectorTable, computeVectorTableSIAR,
  extractContiguousSegments,
  findAllOccurrences, buildSpatialIndex, lookupSpatialIndex, calculateCompactness,
} = SIA_MODULE;

const MAX_NOTES = 5000;
const MAX_MTP_CANDIDATES = 300;
const MAX_VECTOR_PAIRS_WORKER = 80000;
const SIAR_THRESHOLD = 3000;

// ---- Fast Lookup Maps ----

function buildFastLookup(notes) {
  const indexMap = new Map();
  notes.forEach((n, i) => {
    const key = n.track + ':' + n.start + ':' + n.pitch;
    indexMap.set(key, i);
  });
  return indexMap;
}

function fastLookupIndex(lookup, note) {
  const key = note.track + ':' + (note.t ?? note.start) + ':' + (note.p ?? note.pitch);
  return lookup.get(key) ?? -1;
}

// ---- Repeat Potential Pre-check ----

function computeRepeatPotential(sortedNotes, minLen, pTol, timeTol) {
  const n = sortedNotes.length;
  const hasPotential = new Array(n).fill(false);
  const prefixLen = Math.min(3, minLen);
  // Pre-build time index for all findAllOccurrences calls
  var nbt = new Map();
  sortedNotes.forEach(function(n2, i) {
    if (!nbt.has(n2.start)) nbt.set(n2.start, []);
    nbt.get(n2.start).push({ note: n2, idx: i });
  });
  for (let i = 0; i <= n - prefixLen; i++) {
    const prefix = sortedNotes.slice(i, i + prefixLen);
    const prefixOccs = findAllOccurrences(prefix, sortedNotes, pTol, timeTol, nbt);
    hasPotential[i] = prefixOccs.length > 0;
  }
  return hasPotential;
}

// ---- Candidate Scoring ----

function scoreCandidate(candidate, opts) {
  opts = opts || {};
  const { coverage, ratio, segment } = candidate;
  const minCompactness = opts.minCompactness != null ? opts.minCompactness : 0.1;
  const compactness = calculateCompactness(segment);
  if (compactness < minCompactness) return -Infinity;
  return coverage * ratio * (1 + compactness * 2);
}

// ---- RRT: Redundant Translator Removal ----

function removeRedundantTranslators(occurrences) {
  if (occurrences.length <= 1) return occurrences;
  var essential = [];
  var coveredSets = new Map();
  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    var sig = occ.noteIds.slice().sort(function(a,b){return a-b;}).join(',');
    var existing = coveredSets.get(sig);
    if (!existing) {
      coveredSets.set(sig, { occurrence: occ, noteCount: occ.noteIds.length });
      essential.push(occ);
    } else if (occ.noteIds.length > existing.noteCount) {
      var idx = essential.indexOf(existing.occurrence);
      if (idx >= 0) essential[idx] = occ;
      coveredSets.set(sig, { occurrence: occ, noteCount: occ.noteIds.length });
    }
  }
  return essential;
}

function applyRRTToResult(patterns) {
  return patterns.map(function(p) {
    var origOcc = null;
    var transOccs = [];
    for (var i = 0; i < p.occurrences.length; i++) {
      var o = p.occurrences[i];
      if (o.dx === 0 && o.dy === 0) origOcc = o;
      else transOccs.push(o);
    }
    var dedupedTrans = removeRedundantTranslators(transOccs);
    var result = origOcc ? [origOcc].concat(dedupedTrans) : dedupedTrans;
    return Object.assign({}, p, { occurrences: result });
  });
}

// ---- Rhythmic Fingerprint (SIARCT-CFP) ----

function computeRhythmicFingerprint(notes) {
  if (notes.length < 2) return [];
  var sorted = notes.slice().sort(function(a,b){return a.start - b.start;});
  var iois = [];
  for (var i = 1; i < sorted.length; i++) {
    iois.push(sorted[i].start - sorted[i-1].start);
  }
  var base = iois[0] || 1;
  return iois.map(function(ioi){return Math.round((ioi/base)*100)/100;});
}

function fingerprintsMatch(fp1, fp2, tolerance) {
  tolerance = tolerance || 0.15;
  if (fp1.length !== fp2.length) return false;
  for (var i = 0; i < fp1.length; i++) {
    if (Math.abs(fp1[i] - fp2[i]) > tolerance) return false;
  }
  return true;
}

function checkPitchContour(seq1, seq2, pitchTol) {
  pitchTol = pitchTol || 0;
  if (seq1.length !== seq2.length) return false;
  for (var i = 1; i < seq1.length; i++) {
    var p1 = seq1[i].p ?? seq1[i].pitch;
    var p0 = seq1[i-1].p ?? seq1[i-1].pitch;
    var q1 = seq2[i].p ?? seq2[i].pitch;
    var q0 = seq2[i-1].p ?? seq2[i-1].pitch;
    var d1 = p1 - p0;
    var d2 = q1 - q0;
    if (Math.sign(d1) !== Math.sign(d2)) return false;
    if (Math.abs(Math.abs(d1) - Math.abs(d2)) > pitchTol) return false;
  }
  return true;
}

function findOccurrencesByFingerprint(pattern, allNotes, pitchTol, timeScaleTol) {
  pitchTol = pitchTol || 0;
  timeScaleTol = timeScaleTol || 0.2;
  if (pattern.length < 2) return [];
  var patternFp = computeRhythmicFingerprint(pattern);
  if (patternFp.length === 0) return [];
  var occurrences = [];
  var sortedAll = allNotes.slice().sort(function(a,b){return a.start - b.start;});
  for (var i = 0; i <= sortedAll.length - pattern.length; i++) {
    var candidate = sortedAll.slice(i, i + pattern.length);
    if (!checkPitchContour(pattern, candidate, pitchTol)) continue;
    var candidateFp = computeRhythmicFingerprint(candidate);
    if (!fingerprintsMatch(patternFp, candidateFp, timeScaleTol)) continue;
    var dx = candidate[0].start - (pattern[0].start ?? pattern[0].t ?? 0);
    var dy = (candidate[0].pitch ?? candidate[0].p) - (pattern[0].pitch ?? pattern[0].p ?? 0);
    var noteIndices = [];
    for (var j = 0; j < candidate.length; j++) noteIndices.push(i + j);
    occurrences.push({ dx: dx, dy: dy, startIdx: i, noteIndices: noteIndices });
  }
  return occurrences;
}

// ---- Main COSIATEC ----

function cosiatecCompress(notes, ppq, opts) {
  opts = opts || {};
  const minLen = Math.max(2, opts.minLen || 3);
  const maxLen = Math.min(256, opts.maxLen || 128);
  const minOcc = Math.max(2, opts.minOcc || 2);
  const pTol = opts.pitchTol || 0;
  const maxPat = Math.max(1, Math.min(opts.maxPatterns || 8, 20));
  const minRatio = opts.minRatio || 1.5;
  const iterative = opts.iterative !== false;
  const onProgress = opts.onProgress || (function(){});
  const minCompactness = opts.minCompactness != null ? opts.minCompactness : 0.1;

  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);

  onProgress('start', { total: notes.length, maxRounds: maxPat });

  const origIndexMap = new Map();
  notes.forEach((n, i) => { origIndexMap.set(n.track + ',' + n.start + ',' + n.pitch + ',' + n.ch, i); });

  let remainingNotes = notes.slice();
  let noteLookup = buildFastLookup(remainingNotes);
  const allPatterns = [];
  let round = 0;

  while (remainingNotes.length >= minLen && round < maxPat) {
    round++;
    onProgress('round', { round, remaining: remainingNotes.length });

    // Pre-build time index for findAllOccurrences (shared across all Phase A/B/C calls)
    var notesByTimeW = new Map();
    remainingNotes.forEach(function(n, i) {
      if (!notesByTimeW.has(n.start)) notesByTimeW.set(n.start, []);
      notesByTimeW.get(n.start).push({ note: n, idx: i });
    });

    const points = notesToPoints(remainingNotes);
    const spatialIndex = buildSpatialIndex(points);
    const candidates = [];
    const useSIAR = remainingNotes.length > SIAR_THRESHOLD;
    const mtps = useSIAR
      ? computeVectorTableSIAR(points, null, MAX_VECTOR_PAIRS_WORKER)
      : computeVectorTable(points);
    const mtpLimit = Math.min(mtps.length, MAX_MTP_CANDIDATES);
    const seenSegments = new Set();

    // ---- Phase A: MTP-based ----
    for (let mi = 0; mi < mtpLimit; mi++) {
      const mtp = mtps[mi];
      const maxGap = Math.max(ppq * 2, 200);
      const segments = extractContiguousSegments(mtp.points, minLen, maxGap);
      for (const seg of segments) {
        if (seg.length < minLen) continue;
        const segSizes = [];
        if (seg.length <= maxLen) segSizes.push(seg.length);
        for (let sz = minLen; sz <= Math.min(maxLen, seg.length); sz += minLen) {
          if (segSizes.indexOf(sz) === -1) segSizes.push(sz);
        }
        for (const size of segSizes) {
          const subSeg = seg.slice(0, size);
          const segKey = subSeg.map(function(p){return p.id;}).sort().join(',');
          if (seenSegments.has(segKey)) continue;
          seenSegments.add(segKey);
          const occs = findAllOccurrences(subSeg, remainingNotes, pTol, opts.timeTol || 6, notesByTimeW);
          const totalInstances = occs.length + 1;
          if (totalInstances < minOcc) continue;
          const coverage = subSeg.length * totalInstances;
          const cost = subSeg.length + occs.length * 2;
          const ratio = coverage / Math.max(1, cost);
          if (ratio < minRatio) continue;
          const candidate = { segment: subSeg, occurrences: occs, totalInstances, coverage, ratio, score: 0, round, source: 'mtp' };
          candidate.score = scoreCandidate(candidate, { minCompactness: minCompactness });
          if (candidate.score > -Infinity) candidates.push(candidate);
        }
      }
    }

    // ---- Phase B: Direct scan with pruning ----
    if (remainingNotes.length <= 500) {
      const sortedNotes = remainingNotes.slice().sort((a, b) => a.start - b.start);

      // Pre-build O(1) note-to-index map to avoid O(n) indexOf
      const noteToIndex = new Map();
      sortedNotes.forEach((n, i) => noteToIndex.set(n, i));

      const hasPotential = computeRepeatPotential(sortedNotes, minLen, pTol, opts.timeTol || 6);
      for (let startIdx = 0; startIdx < sortedNotes.length; startIdx++) {
        if (!hasPotential[startIdx]) continue;  // Prune 70-90%
        const segment = [sortedNotes[startIdx]];
        for (let j = startIdx + 1; j < sortedNotes.length && segment.length < maxLen; j++) {
          const gap = sortedNotes[j].start - segment[segment.length - 1].start;
          if (gap > ppq * 4) break;
          segment.push(sortedNotes[j]);
          if (segment.length >= minLen) {
            const segKey = segment.map(function(n){return noteToIndex.get(n);}).sort(function(a,b){return a-b;}).join(',');
            if (seenSegments.has(segKey)) continue;
            seenSegments.add(segKey);
            // Prefix quick-check: prune branch if short prefix doesn't repeat
            const prefixLen = Math.min(segment.length, 4);
            const prefixCheck = findAllOccurrences(segment.slice(0, prefixLen), remainingNotes, pTol, opts.timeTol || 6, notesByTimeW);
            if (prefixCheck.length === 0) break;
            const occs = findAllOccurrences(segment, remainingNotes, pTol, opts.timeTol || 6, notesByTimeW);
            const totalInstances = occs.length + 1;
            if (totalInstances < minOcc) continue;
            const coverage = segment.length * totalInstances;
            const cost = segment.length + occs.length * 2;
            const ratio = coverage / Math.max(1, cost);
            if (ratio < minRatio) continue;
            const candidate = { segment, occurrences: occs, totalInstances, coverage, ratio, score: 0, round, source: 'scan' };
            candidate.score = scoreCandidate(candidate, { minCompactness: minCompactness });
            if (candidate.score > -Infinity) candidates.push(candidate);
          }
        }
      }
    }

    // ---- Phase C: Fingerprint-based discovery ----
    if (round === 1 && opts.useFingerprint && remainingNotes.length >= minLen * 2) {
      var sortedNotesFp = remainingNotes.slice().sort(function(a,b){return a.start - b.start;});
      var fpNoteToIndex = new Map();
      sortedNotesFp.forEach(function(n, i) { fpNoteToIndex.set(n, i); });
      var maxFingerprintScans = Math.min(sortedNotesFp.length, 100);
      for (var fpIdx = 0; fpIdx < maxFingerprintScans; fpIdx++) {
        var fpSegment = [sortedNotesFp[fpIdx]];
        for (var fpJ = fpIdx + 1; fpJ < sortedNotesFp.length && fpSegment.length < maxLen; fpJ++) {
          var fpGap = sortedNotesFp[fpJ].start - fpSegment[fpSegment.length - 1].start;
          if (fpGap > ppq * 4) break;
          fpSegment.push(sortedNotesFp[fpJ]);
          if (fpSegment.length >= minLen) {
            var fpSegKey = fpSegment.map(function(n){return fpNoteToIndex.get(n);}).sort(function(a,b){return a-b;}).join(',');
            if (seenSegments.has(fpSegKey)) continue;
            seenSegments.add(fpSegKey);
            var fpOccs = findOccurrencesByFingerprint(fpSegment, remainingNotes, pTol, 0.2);
            var fpTotalInstances = fpOccs.length + 1;
            if (fpTotalInstances < minOcc) continue;
            var fpCoverage = fpSegment.length * fpTotalInstances;
            var fpCost = fpSegment.length + fpOccs.length * 2;
            var fpRatio = fpCoverage / Math.max(1, fpCost);
            if (fpRatio < minRatio) continue;
            var fpCandidate = { segment: fpSegment, occurrences: fpOccs, totalInstances: fpTotalInstances, coverage: fpCoverage, ratio: fpRatio, score: 0, round: round, source: 'fingerprint' };
            fpCandidate.score = scoreCandidate(fpCandidate, { minCompactness: minCompactness });
            if (fpCandidate.score > -Infinity) candidates.push(fpCandidate);
          }
        }
      }
    }

    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    const coveredNoteIndices = new Set();
    const occurrences = [];

    // Use fast O(1) lookup instead of findIndex
    const origIndices = best.segment.map(function(segNote) {
      const idx = fastLookupIndex(noteLookup, segNote);
      if (idx >= 0) coveredNoteIndices.add(idx);
      return idx;
    }).filter(function(i){return i >= 0;});
    occurrences.push({ dx: 0, dy: 0, noteIds: origIndices });

    for (const occ of best.occurrences) {
      const occIds = occ.noteIndices.filter(function(id){return !coveredNoteIndices.has(id);});
      if (occIds.length === best.segment.length) {
        occIds.forEach(function(id){coveredNoteIndices.add(id);});
        occurrences.push({ dx: occ.dx, dy: occ.dy, noteIds: occIds });
      }
    }
    if (occurrences.length < minOcc) continue;

    const templateNotes = best.segment.map(function(segNote) {
      const idx = fastLookupIndex(noteLookup, segNote);
      if (idx >= 0) return remainingNotes[idx];
      return {
        start: segNote.t ?? segNote.start, pitch: segNote.p ?? segNote.pitch,
        dur: segNote.d ?? segNote.dur, vel: segNote.v ?? segNote.vel,
        track: segNote.track, ch: segNote.ch,
        end: (segNote.t ?? segNote.start) + ((segNote.d ?? segNote.dur) || 0),
      };
    });

    function toOrigIdx(remIdx) {
      const n = remainingNotes[remIdx];
      if (!n) return -1;
      return origIndexMap.get(n.track + ',' + n.start + ',' + n.pitch + ',' + n.ch) ?? -1;
    }

    allPatterns.push({
      id: round - 1,
      notes: templateNotes,
      occurrences: occurrences.map(function(o, i) {
        return {
          id: i,
          track: remainingNotes[o.noteIds[0]]?.track || 0,
          start: remainingNotes[o.noteIds[0]]?.start || 0,
          end: (remainingNotes[o.noteIds[o.noteIds.length - 1]]?.start || 0) + (remainingNotes[o.noteIds[o.noteIds.length - 1]]?.dur || 0),
          transposition: o.dy,
          delay: o.dx,
          noteIds: o.noteIds.map(toOrigIdx).filter(function(i){return i >= 0;}),
        };
      }),
      coverage: coveredNoteIndices.size,
      score: best.score,
      compressionRatio: best.ratio,
      round,
      source: best.source,
    });

    if (iterative) {
      const keep = [];
      remainingNotes.forEach(function(n, i) { if (!coveredNoteIndices.has(i)) keep.push(n); });
      remainingNotes = keep;
      noteLookup = buildFastLookup(remainingNotes);
    } else { break; }
  }

  const trunk = remainingNotes;

  // Apply RRT
  var finalPatterns = allPatterns;
  if (opts.useRRT !== false) {
    finalPatterns = applyRRTToResult(allPatterns);
  }

  const totalNotes = notes.length;
  const coveredByPatterns = totalNotes - trunk.length;
  const patternDefSize = finalPatterns.reduce(function(s, p) { return s + p.notes.length; }, 0);
  const instanceRefSize = finalPatterns.reduce(function(s, p) { return s + p.occurrences.length; }, 0);
  const compressedSize = trunk.length + patternDefSize + instanceRefSize * 2;
  const compressionRate = totalNotes > 0 ? (1 - compressedSize / totalNotes) * 100 : 0;

  return {
    patterns: finalPatterns, trunk, compressionRate,
    coverage: totalNotes > 0 ? coveredByPatterns / totalNotes : 0,
    totalNotes, patternNotes: coveredByPatterns,
    instanceCount: finalPatterns.reduce(function(s, p) { return s + p.occurrences.length; }, 0),
    rounds: round, wasDownsampled: false,
  };
}

// ---- Parameter Grid for Auto-Optimize ----

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
  const values = keys.map(function(k) { return PARAM_GRID[k]; });
  function* cartesian(idx, current) {
    if (idx === keys.length) { yield Object.assign({}, current); return; }
    for (var vi = 0; vi < values[idx].length; vi++) {
      current[keys[idx]] = values[idx][vi];
      yield* cartesian(idx + 1, current);
    }
  }
  yield* cartesian(0, {});
}

// ---- Quick Preview (for progressive analysis Stage 1) ----

/**
 * Run a quick preview scan to estimate pattern count.
 * Returns a lightweight summary only (not full pattern objects).
 */
function quickPreview(notes, ppq, opts) {
  const points = notesToPoints(notes);
  // Limit to top 500 notes for speed
  const sample = points.length > 500 ? points.slice(0, 500) : points;
  const mtps = computeVectorTable(sample);

  // Only examine top 10 MTPs
  const topMtps = mtps.slice(0, 10);
  var foundCount = 0;
  var totalCoverage = 0;
  const seenSegments = new Set();

  for (var mi = 0; mi < topMtps.length; mi++) {
    const mtp = topMtps[mi];
    const maxGap = Math.max(ppq * 2, 200);
    const segments = extractContiguousSegments(mtp.points, opts.minLen || 4, maxGap);

    for (var si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (seg.length < (opts.minLen || 4)) continue;

      const segKey = seg.map(function(p){return p.id;}).sort().join(',');
      if (seenSegments.has(segKey)) continue;
      seenSegments.add(segKey);

      // Only check the first few prefix sizes for speed
      var maxCheck = Math.min(seg.length, (opts.maxLen || 64));
      for (var sz = (opts.minLen || 4); sz <= maxCheck; sz += (opts.minLen || 4)) {
        const subSeg = seg.slice(0, sz);
        const occs = findAllOccurrences(subSeg, notes, opts.pitchTol || 0, opts.timeTol || 6);
        if (occs.length >= (opts.minOcc || 2) - 1) {
          foundCount++;
          totalCoverage += subSeg.length * (occs.length + 1);
          break; // Found a match for this segment, move on
        }
      }
    }
  }

  return { foundCount: foundCount, totalCoverage: totalCoverage };
}

// ---- Message Handler ----

self.onmessage = function(e) {
  const { type, notes, ppq, opts, maxTests } = e.data;

  // Progressive analysis: 3-stage pipeline
  if (type === 'analyze-progressive') {
    try {
      // Stage 1: Quick preview (top 500 notes, top 10 MTPs, non-iterative)
      self.postMessage({ type: 'progressive-stage', stage: 'preview', message: '快速预览中...' });
      var previewInfo = quickPreview(notes, ppq, opts);
      self.postMessage({
        type: 'progressive-stage',
        stage: 'preview-done',
        message: '预览完成',
        previewInfo: previewInfo,
      });

      // Stage 2: Standard analysis (full notes, limited rounds)
      self.postMessage({ type: 'progressive-stage', stage: 'standard', message: '标准分析中...' });
      var standardResult = cosiatecCompress(notes, ppq, {
        minLen: opts.minLen || 4,
        maxLen: Math.min(opts.maxLen || 64, 64),
        minOcc: opts.minOcc || 2,
        pitchTol: opts.pitchTol || 0,
        timeTol: opts.timeTol || 6,
        maxPatterns: Math.min(opts.maxPatterns || 6, 6),
        minRatio: opts.minRatio || 1.5,
        iterative: opts.iterative !== false,
        useFingerprint: opts.useFingerprint || false,
        useRRT: opts.useRRT !== false,
        onProgress: (function() {
          var _lastProg = 0;
          return function(phase, detail) {
            var now = performance.now();
            if (now - _lastProg > 150) {
              self.postMessage({ type: 'progressive-progress', stage: 'standard', phase: phase, detail: detail });
              _lastProg = now;
            }
          };
        })(),
      });
      standardResult.stage = 'standard';
      self.postMessage({ type: 'progressive-result', stage: 'standard', result: standardResult });

      // Stage 3: Deep analysis (recursive on trunk, if enough notes remain)
      if (opts.deep && standardResult.trunk.length > (opts.minLen || 4) * 3) {
        self.postMessage({ type: 'progressive-stage', stage: 'deep', message: '深度分析中...' });
        var deepResult = cosiatecCompress(standardResult.trunk, ppq, {
          minLen: Math.max(2, (opts.minLen || 4) - 1),
          maxLen: Math.min(opts.maxLen || 64, 128),
          minOcc: 2,
          pitchTol: opts.pitchTol || 0,
          timeTol: opts.timeTol || 6,
          maxPatterns: Math.min(opts.maxPatterns || 4, 4),
          minRatio: 1.3,
          iterative: true,
          onProgress: (function() {
            var _lastDeepProg = 0;
            return function(phase, detail) {
              var now = performance.now();
              if (now - _lastDeepProg > 150) {
                self.postMessage({ type: 'progressive-progress', stage: 'deep', phase: phase, detail: detail });
                _lastDeepProg = now;
              }
            };
          })(),
        });
        deepResult.stage = 'deep';
        self.postMessage({ type: 'progressive-result', stage: 'deep', result: deepResult });
      }

      self.postMessage({ type: 'progressive-done' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  if (type === 'analyze') {
    try {
      // SIATECCOMPRESS fast mode: single non-iterative pass
      var analyzeOpts = {
        minLen: opts.minLen,
        maxLen: opts.maxLen,
        minOcc: opts.minOcc,
        pitchTol: opts.pitchTol,
        timeTol: opts.timeTol || 6,
        maxPatterns: opts.maxPatterns,
        minRatio: opts.minRatio,
        detectTrans: opts.detectTrans,
        iterative: opts.algorithm === 'siateccompress' ? false : opts.iterative,
        useFingerprint: opts.useFingerprint || false,
        useRRT: opts.useRRT !== false,
        onProgress: (function() {
          var _lastProgress = 0;
          return function(phase, detail) {
            var now = performance.now();
            if (now - _lastProgress > 150) {
              self.postMessage({ type: 'progress', phase: phase, detail: detail });
              _lastProgress = now;
            }
          };
        })(),
      };
      const result = cosiatecCompress(notes, ppq, analyzeOpts);
      // Tag result with algorithm
      if (opts.algorithm === 'siateccompress') result.algorithm = 'siateccompress';
      self.postMessage({ type: 'result', result: result });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  if (type === 'optimize') {
    const MAX_TESTS = maxTests || 200;
    var bestResult = null;
    var tested = 0;

    try {
      var comboIter = generateParamCombos();
      var combo = comboIter.next();
      while (!combo.done && tested < MAX_TESTS) {
        var params = combo.value;
        var result = cosiatecCompress(notes, ppq, {
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
          bestResult = { params: Object.assign({}, params), compressionRate: result.compressionRate };
        }

        self.postMessage({
          type: 'optimize-progress',
          tested: tested,
          total: MAX_TESTS,
          bestRate: bestResult.compressionRate,
          bestParams: bestResult.params,
        });

        combo = comboIter.next();
      }

      // Run final analysis with best params
      var finalResult = cosiatecCompress(notes, ppq, {
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
        tested: tested,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
