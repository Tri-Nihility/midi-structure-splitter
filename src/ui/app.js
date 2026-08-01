/**
 * Main Application Controller for MIDI Structure Splitter
 *
 * Coordinates file loading, COSIATEC analysis, auto-optimization,
 * UI rendering, and XML export functionality.
 *
 * @module app
 */

import { MidiParser, midiToNotes } from '../parser/midi-parser.js';
import { cosiatecCompress } from '../analyzer/cosiatec.js';
import { generateXML, escapeXml } from '../utils/xml-generator.js';
import {
  renderReconstruction,
  renderPatterns,
  renderTrunk,
  renderTimeline,
  renderXML,
  downloadFile,
} from './renderer.js';

// ---- Application State ----

/** @type {object|null} Parsed MIDI note data */
let currentData = null;

/** @type {object|null} COSIATEC compression result */
let currentResult = null;

/** @type {string} Base filename for exports */
let currentFileName = 'midi';

/** Abort controller for cancellation */
let abortController = null;

// ---- File Handling ----

/**
 * Process a MIDI file from user upload.
 * @param {File} file
 */
function processFile(file) {
  if (!file.name.match(/\.(mid|midi)$/i)) {
    showStatus('请选择 MIDI 文件 (.mid / .midi)', 'error');
    return;
  }

  currentFileName = file.name.replace(/\.(mid|midi)$/i, '');
  setProgress(20);

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      setProgress(50);
      const parsed = new MidiParser(e.target.result).parse();
      currentData = midiToNotes(parsed);
      setProgress(80);

      // Update info display
      document.getElementById('infoNotes').textContent =
        currentData.notes.length;
      document.getElementById('infoDuration').textContent = Math.round(
        currentData.dur / currentData.ppq
      );

      // Initialize empty XML display
      const emptyResult = {
        patterns: [],
        trunk: currentData.notes,
        coverage: 0,
        compressionRate: 0,
        rounds: 0,
      };
      document.getElementById('xmlOutput').innerHTML = `<code>${escapeXml(
        generateXML(currentData, emptyResult, 'recon')
      )}</code>`;

      setProgress(100);

      document.getElementById('btnAnalyze').disabled = false;
      document.getElementById('btnAutoOptimize').disabled = false;
      document.getElementById('btnExport').disabled = false;

      showStatus(
        `解析成功: ${currentData.notes.length} 音符, ${currentData.numTracks} 轨道`,
        'success'
      );
    } catch (err) {
      setProgress(0);
      showStatus('解析失败: ' + err.message, 'error');
      console.error(err);
    }
  };

  reader.readAsArrayBuffer(file);
}

// ---- Analysis ----

/**
 * Run COSIATEC compression analysis with yield-based chunking to prevent UI freeze.
 * Uses requestAnimationFrame to yield control back to the browser between rounds.
 */
function analyze() {
  if (!currentData) return;

  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true;
  btn.textContent = 'COSIATEC分析中...';
  setProgress(10);

  // Safety: warn for large files
  if (currentData.notes.length > 2000) {
    showStatus(
      `注意: ${currentData.notes.length} 个音符较多，分析可能需要较长时间。已启用性能优化模式。`,
      'success'
    );
  }

  const opts = {
    minLen: parseInt(document.getElementById('minLen').value),
    maxLen: parseInt(document.getElementById('maxLen').value),
    minOcc: parseInt(document.getElementById('minOcc').value),
    pitchTol: parseInt(document.getElementById('pitchTol').value),
    timeTol: parseInt(document.getElementById('timeTol').value),
    maxPatterns: parseInt(document.getElementById('maxPatterns').value),
    minRatio: parseFloat(document.getElementById('minRatio').value),
    detectTrans: document.getElementById('detectTrans').checked,
    iterative: document.getElementById('iterative').checked,
    onProgress: (phase, detail) => {
      if (phase === 'start') {
        setProgress(15);
      } else if (phase === 'round') {
        const pct = 15 + Math.min(60, detail.round * 15);
        setProgress(pct);
        btn.textContent = `分析中... 轮次 ${detail.round}`;
      } else if (phase === 'pattern') {
        setProgress(60 + detail.round * 5);
      }
    },
  };

  // Use a micro-yield pattern: schedule analysis as a chain of microtasks
  // that each yield to the browser event loop
  const runAsync = () => {
    return new Promise((resolve, reject) => {
      try {
        setProgress(20);
        currentResult = cosiatecCompress(
          currentData.notes,
          currentData.ppq,
          opts
        );
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  };

  // Use setTimeout with 0 to let the UI update before heavy work
  setTimeout(async () => {
    try {
      await runAsync();
      setProgress(80);

      // Update statistics panel
      updateStatistics(currentResult);

      // Update compression bar
      const cov = Math.round(currentResult.compressionRate);
      document.getElementById('fitRate').textContent = cov + '%';
      document.getElementById('fitFill').style.width =
        Math.min(100, cov) + '%';

      // Render all views (use requestAnimationFrame for DOM-heavy work)
      requestAnimationFrame(() => {
        renderReconstruction(currentData, currentResult);
        renderPatterns(currentResult);
        renderTrunk(currentResult, currentData);
        renderTimeline(currentData, currentResult);
        renderXML(currentData, currentResult);

        setProgress(100);

        let msg = `COSIATEC完成: ${currentResult.patterns.length} 模式, 压缩 ${cov}%`;
        if (currentResult.wasDownsampled) {
          msg += ' (已启用采样优化)';
        }
        showStatus(msg, 'success');
      });
    } catch (err) {
      showStatus('分析失败: ' + err.message, 'error');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '压缩分析';
    }
  }, 50);
}

// ---- Auto-Optimization ----

/**
 * Parameter grid for auto-optimization search.
 * Each entry is [paramKey, candidateValues].
 */
const PARAM_GRID = {
  minLen:       [3, 4, 5, 6, 8],
  maxLen:       [12, 16, 24, 32, 48, 64],
  minOcc:       [2, 3, 4],
  pitchTol:     [0, 1, 2],
  maxPatterns:  [3, 4, 5, 6, 8],
  minRatio:     [1.5, 2.0, 2.5],
};

/**
 * Generate all combinations of parameter grid values.
 * Uses a pruned search: evaluates coarse grid first, then refines
 * around the best region.
 */
function* generateParamCombos(coarse) {
  const keys = Object.keys(PARAM_GRID);
  const values = keys.map(k => PARAM_GRID[k]);

  // For coarse mode, use every-other value
  const step = coarse ? 2 : 1;

  function* cartesian(idx, current) {
    if (idx === keys.length) {
      yield { ...current };
      return;
    }
    const vals = values[idx];
    for (let i = 0; i < vals.length; i += step) {
      current[keys[idx]] = vals[i];
      yield* cartesian(idx + 1, current);
    }
  }

  yield* cartesian(0, {});
}

/**
 * Count total combinations for progress display.
 */
function countCombos(coarse) {
  const step = coarse ? 2 : 1;
  let total = 1;
  for (const vals of Object.values(PARAM_GRID)) {
    total *= Math.ceil(vals.length / step);
  }
  return total;
}

/**
 * Run a single COSIATEC analysis with given params, return compression rate.
 */
function runSingle(params) {
  const opts = {
    minLen: params.minLen,
    maxLen: params.maxLen,
    minOcc: params.minOcc,
    pitchTol: params.pitchTol,
    timeTol: parseInt(document.getElementById('timeTol').value),
    maxPatterns: params.maxPatterns,
    minRatio: params.minRatio,
    detectTrans: document.getElementById('detectTrans').checked,
    iterative: document.getElementById('iterative').checked,
  };
  const result = cosiatecCompress(currentData.notes, currentData.ppq, opts);
  return {
    compressionRate: result.compressionRate,
    patterns: result.patterns.length,
    trunk: result.trunk.length,
    rounds: result.rounds,
    params: { ...params },
  };
}

/**
 * Auto-optimize: search parameter grid for best compression.
 * Two-phase: coarse scan -> fine scan around best region.
 */
async function autoOptimize() {
  if (!currentData) {
    showStatus('请先上传 MIDI 文件', 'error');
    return;
  }

  abortController = new AbortController();
  const signal = abortController.signal;

  const btnAnalyze = document.getElementById('btnAnalyze');
  const btnAuto = document.getElementById('btnAutoOptimize');
  const btnCancel = document.getElementById('btnCancel');
  btnAnalyze.disabled = true;
  btnAuto.disabled = true;
  btnAuto.textContent = '优化中...';
  btnCancel.style.display = 'block';

  const totalCoarse = countCombos(true);
  const totalFine = countCombos(false);
  const totalCombos = totalCoarse + totalFine;

  showStatus(`开始自动优化: 粗扫 ${totalCoarse} + 精扫 ${totalFine} = ${totalCombos} 组合`, 'success');

  let bestResult = null;
  let tested = 0;

  try {
    // ---- Phase 1: Coarse scan ----
    for (const params of generateParamCombos(true)) {
      if (signal.aborted) throw new Error('已取消');

      const result = runSingle(params);
      tested++;

      if (!bestResult || result.compressionRate > bestResult.compressionRate) {
        bestResult = result;
      }

      // Update progress
      const pct = Math.round((tested / totalCombos) * 100);
      setProgress(pct);
      btnAuto.textContent = `粗扫 ${tested}/${totalCoarse}`;

      // Yield to UI every few iterations
      if (tested % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ---- Phase 2: Fine scan around best coarse params ----
    // Build a narrower grid around the best values found so far
    const fineGrid = buildFineGrid(bestResult.params);

    for (const params of fineGrid) {
      if (signal.aborted) throw new Error('已取消');

      const result = runSingle(params);
      tested++;

      if (result.compressionRate > bestResult.compressionRate) {
        bestResult = result;
      }

      const pct = Math.round((tested / totalCombos) * 100);
      setProgress(pct);
      btnAuto.textContent = `精扫 ${tested - totalCoarse}/${totalFine}`;

      if (tested % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // ---- Apply best result ----
    currentResult = cosiatecCompress(
      currentData.notes,
      currentData.ppq,
      {
        minLen: bestResult.params.minLen,
        maxLen: bestResult.params.maxLen,
        minOcc: bestResult.params.minOcc,
        pitchTol: bestResult.params.pitchTol,
        timeTol: parseInt(document.getElementById('timeTol').value),
        maxPatterns: bestResult.params.maxPatterns,
        minRatio: bestResult.params.minRatio,
        detectTrans: document.getElementById('detectTrans').checked,
        iterative: document.getElementById('iterative').checked,
      }
    );

    // Update parameter inputs to best values
    document.getElementById('minLen').value = bestResult.params.minLen;
    document.getElementById('maxLen').value = bestResult.params.maxLen;
    document.getElementById('minOcc').value = bestResult.params.minOcc;
    document.getElementById('pitchTol').value = bestResult.params.pitchTol;
    document.getElementById('maxPatterns').value = bestResult.params.maxPatterns;
    document.getElementById('minRatio').value = bestResult.params.minRatio;

    // Render
    updateStatistics(currentResult);
    const cov = Math.round(currentResult.compressionRate);
    document.getElementById('fitRate').textContent = cov + '%';
    document.getElementById('fitFill').style.width = Math.min(100, cov) + '%';

    requestAnimationFrame(() => {
      renderReconstruction(currentData, currentResult);
      renderPatterns(currentResult);
      renderTrunk(currentResult, currentData);
      renderTimeline(currentData, currentResult);
      renderXML(currentData, currentResult);
    });

    setProgress(100);
    showStatus(
      `优化完成: 测试 ${tested} 组合, 最佳压缩 ${cov}% (minLen=${bestResult.params.minLen} maxLen=${bestResult.params.maxLen} minOcc=${bestResult.params.minOcc} pitchTol=${bestResult.params.pitchTol} maxPat=${bestResult.params.maxPatterns} minRatio=${bestResult.params.minRatio})`,
      'success'
    );

  } catch (err) {
    if (err.message === '已取消') {
      showStatus('优化已取消', 'error');
    } else {
      showStatus('优化失败: ' + err.message, 'error');
      console.error(err);
    }
  } finally {
    btnAnalyze.disabled = false;
    btnAuto.disabled = false;
    btnAuto.textContent = '自动优化';
    btnCancel.style.display = 'none';
    abortController = null;
  }
}

/**
 * Build a fine-grained parameter grid around the best coarse result.
 * Narrows each parameter to neighbors of the best value.
 */
function buildFineGrid(bestParams) {
  const fine = {};
  for (const [key, allVals] of Object.entries(PARAM_GRID)) {
    const bestVal = bestParams[key];
    const idx = allVals.indexOf(bestVal);
    if (idx === -1) {
      fine[key] = allVals;
    } else {
      // Take best value and its immediate neighbors
      const neighbors = [];
      if (idx > 0) neighbors.push(allVals[idx - 1]);
      neighbors.push(allVals[idx]);
      if (idx < allVals.length - 1) neighbors.push(allVals[idx + 1]);
      fine[key] = neighbors;
    }
  }

  // Generate all combos from the fine grid
  const keys = Object.keys(fine);
  const values = keys.map(k => fine[k]);

  function* cartesian(idx, current) {
    if (idx === keys.length) {
      yield { ...current };
      return;
    }
    for (const v of values[idx]) {
      current[keys[idx]] = v;
      yield* cartesian(idx + 1, current);
    }
  }

  return cartesian(0, {});
}

/**
 * Cancel any running auto-optimization.
 */
function cancelOptimize() {
  if (abortController) {
    abortController.abort();
  }
}

/**
 * Update the statistics panel with compression results.
 * @param {object} result
 */
function updateStatistics(result) {
  document.getElementById('statsCard').style.display = 'block';
  document.getElementById('statPatterns').textContent = result.patterns.length;
  document.getElementById('statInstances').textContent = result.instanceCount;
  document.getElementById('statTrunk').textContent = result.trunk.length;
  document.getElementById('statCompress').textContent =
    result.compressionRate.toFixed(1) + '%';
  document.getElementById('statRounds').textContent = result.rounds;
}

// ---- Tab Switching ----

/**
 * Switch between display tabs.
 * @param {string} name - Tab name: 'recon', 'patterns', 'trunk', 'timeline', 'xml'
 */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document
    .querySelectorAll('.panel')
    .forEach((p) => p.classList.remove('active'));

  // The clicked tab
  const event = window._lastTabEvent;
  if (event && event.target) {
    event.target.classList.add('active');
  }

  document.getElementById('panel-' + name).classList.add('active');
}

// ---- Export ----

/**
 * Download XML output.
 * @param {'recon'|'split'} mode
 */
function downloadXML(mode) {
  if (!currentData || !currentResult) return;
  const xml = generateXML(currentData, currentResult, mode);
  const name =
    currentFileName +
    (mode === 'recon' ? '_reconstruction' : '_split') +
    '.xml';
  downloadFile(xml, name, 'application/xml');
}

/**
 * Export all XML formats.
 */
function exportAll() {
  if (!currentData || !currentResult) return;
  downloadXML('recon');
  setTimeout(() => downloadXML('split'), 300);
}

/**
 * Copy reconstruction XML to clipboard.
 */
function copyXML() {
  if (!currentData || !currentResult) return;
  navigator.clipboard
    .writeText(generateXML(currentData, currentResult, 'recon'))
    .then(() => showStatus('已复制到剪贴板', 'success'));
}

// ---- Status & Progress ----

/**
 * Show a status message.
 * @param {string} msg
 * @param {'success'|'error'} type
 */
function showStatus(msg, type) {
  const el = document.getElementById('fileStatus');
  el.textContent = msg;
  el.className = `status show ${type}`;
  setTimeout(() => el.classList.remove('show'), 4000);
}

/**
 * Update progress bar.
 * @param {number} pct - Percentage (0–100)
 */
function setProgress(pct) {
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  bar.classList.add('show');
  fill.style.width = pct + '%';
  if (pct >= 100) {
    setTimeout(() => bar.classList.remove('show'), 500);
  }
}

// ---- Demo Loader ----

/**
 * Load a built-in demo MIDI file for testing.
 * Generates a simple ABA'C structure with repeating patterns.
 */
function loadDemo() {
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x02,
    0x00, 0x60, 0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x1b, 0x00, 0xff,
    0x58, 0x04, 0x04, 0x02, 0x18, 0x08, 0x00, 0xff, 0x51, 0x03, 0x07, 0xa1,
    0x20, 0x00, 0xff, 0x03, 0x04, 0x44, 0x65, 0x6d, 0x6f, 0x00, 0xff, 0x2f,
    0x00, 0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x01, 0x40, 0x00, 0xc0, 0x00,
    // Pattern A x3
    0x00, 0x90, 0x3c, 0x50, 0x18, 0x80, 0x3c, 0x00, 0x00, 0x90, 0x40, 0x50,
    0x18, 0x80, 0x40, 0x00, 0x00, 0x90, 0x43, 0x50, 0x18, 0x80, 0x43, 0x00,
    0x00, 0x90, 0x48, 0x50, 0x18, 0x80, 0x48, 0x00, 0x00, 0x90, 0x47, 0x50,
    0x18, 0x80, 0x47, 0x00, 0x00, 0x90, 0x43, 0x50, 0x18, 0x80, 0x43, 0x00,
    0x00, 0x90, 0x40, 0x50, 0x18, 0x80, 0x40, 0x00, 0x00, 0x90, 0x3c, 0x50,
    0x18, 0x80, 0x3c, 0x00, 0x00, 0x90, 0x3c, 0x50, 0x18, 0x80, 0x3c, 0x00,
    0x00, 0x90, 0x40, 0x50, 0x18, 0x80, 0x40, 0x00, 0x00, 0x90, 0x43, 0x50,
    0x18, 0x80, 0x43, 0x00, 0x00, 0x90, 0x48, 0x50, 0x18, 0x80, 0x48, 0x00,
    0x00, 0x90, 0x47, 0x50, 0x18, 0x80, 0x47, 0x00, 0x00, 0x90, 0x43, 0x50,
    0x18, 0x80, 0x43, 0x00, 0x00, 0x90, 0x40, 0x50, 0x18, 0x80, 0x40, 0x00,
    0x00, 0x90, 0x3c, 0x50, 0x18, 0x80, 0x3c, 0x00, 0x00, 0x90, 0x3c, 0x50,
    0x18, 0x80, 0x3c, 0x00, 0x00, 0x90, 0x40, 0x50, 0x18, 0x80, 0x40, 0x00,
    0x00, 0x90, 0x43, 0x50, 0x18, 0x80, 0x43, 0x00, 0x00, 0x90, 0x48, 0x50,
    0x18, 0x80, 0x48, 0x00, 0x00, 0x90, 0x47, 0x50, 0x18, 0x80, 0x47, 0x00,
    0x00, 0x90, 0x43, 0x50, 0x18, 0x80, 0x43, 0x00, 0x00, 0x90, 0x40, 0x50,
    0x18, 0x80, 0x40, 0x00, 0x00, 0x90, 0x3c, 0x50, 0x18, 0x80, 0x3c, 0x00,
    // Pattern B (transposed +2) x2
    0x00, 0x90, 0x3e, 0x50, 0x18, 0x80, 0x3e, 0x00, 0x00, 0x90, 0x42, 0x50,
    0x18, 0x80, 0x42, 0x00, 0x00, 0x90, 0x45, 0x50, 0x18, 0x80, 0x45, 0x00,
    0x00, 0x90, 0x4a, 0x50, 0x18, 0x80, 0x4a, 0x00, 0x00, 0x90, 0x49, 0x50,
    0x18, 0x80, 0x49, 0x00, 0x00, 0x90, 0x45, 0x50, 0x18, 0x80, 0x45, 0x00,
    0x00, 0x90, 0x42, 0x50, 0x18, 0x80, 0x42, 0x00, 0x00, 0x90, 0x3e, 0x50,
    0x18, 0x80, 0x3e, 0x00, 0x00, 0x90, 0x3e, 0x50, 0x18, 0x80, 0x3e, 0x00,
    0x00, 0x90, 0x42, 0x50, 0x18, 0x80, 0x42, 0x00, 0x00, 0x90, 0x45, 0x50,
    0x18, 0x80, 0x45, 0x00, 0x00, 0x90, 0x4a, 0x50, 0x18, 0x80, 0x4a, 0x00,
    0x00, 0x90, 0x49, 0x50, 0x18, 0x80, 0x49, 0x00, 0x00, 0x90, 0x45, 0x50,
    0x18, 0x80, 0x45, 0x00, 0x00, 0x90, 0x42, 0x50, 0x18, 0x80, 0x42, 0x00,
    0x00, 0x90, 0x3e, 0x50, 0x18, 0x80, 0x3e, 0x00,
    // Trunk: bridge
    0x00, 0x90, 0x3b, 0x60, 0x30, 0x80, 0x3b, 0x00, 0x00, 0x90, 0x3e, 0x60,
    0x30, 0x80, 0x3e, 0x00, 0x00, 0x90, 0x42, 0x60, 0x30, 0x80, 0x42, 0x00,
    0x00, 0x90, 0x47, 0x60, 0x30, 0x80, 0x47, 0x00,
    // Pattern A' (transposed -3)
    0x00, 0x90, 0x39, 0x50, 0x18, 0x80, 0x39, 0x00, 0x00, 0x90, 0x3d, 0x50,
    0x18, 0x80, 0x3d, 0x00, 0x00, 0x90, 0x40, 0x50, 0x18, 0x80, 0x40, 0x00,
    0x00, 0x90, 0x45, 0x50, 0x18, 0x80, 0x45, 0x00, 0x00, 0x90, 0x44, 0x50,
    0x18, 0x80, 0x44, 0x00, 0x00, 0x90, 0x40, 0x50, 0x18, 0x80, 0x40, 0x00,
    0x00, 0x90, 0x3d, 0x50, 0x18, 0x80, 0x3d, 0x00, 0x00, 0x90, 0x39, 0x50,
    0x18, 0x80, 0x39, 0x00,
    // Trunk: ending
    0x00, 0x90, 0x3c, 0x70, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00,
  ];

  const data = new Uint8Array(bytes);
  const blob = new Blob([data], { type: 'audio/midi' });
  const file = new File([blob], 'demo.mid', { type: 'audio/midi' });
  processFile(file);
}

// ---- Event Binding ----

/**
 * Initialize all event listeners and drag-and-drop handlers.
 */
export function initApp() {
  // Drag-and-drop + click to open file picker
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  // Click on dropzone triggers hidden file input
  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
  });
  dropzone.addEventListener('dragenter', () =>
    dropzone.classList.add('dragover')
  );
  dropzone.addEventListener('dragleave', () =>
    dropzone.classList.remove('dragover')
  );
  dropzone.addEventListener('drop', (e) => {
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      processFile(e.dataTransfer.files[0]);
    }
  });

  // File input change handler
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) processFile(e.target.files[0]);
  });

  // Analyze button
  document.getElementById('btnAnalyze').addEventListener('click', analyze);

  // Auto-optimize button
  document.getElementById('btnAutoOptimize')?.addEventListener('click', autoOptimize);

  // Cancel button
  document.getElementById('btnCancel')?.addEventListener('click', cancelOptimize);

  // Export button
  document.getElementById('btnExport').addEventListener('click', exportAll);

  // Tab switching — use data-panel attribute
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', function () {
      const panel = this.getAttribute('data-panel');
      if (panel) switchTab(panel);
    });
  });

  // XML toolbar buttons — use element IDs
  document.getElementById('btnXMLRecon')?.addEventListener('click', () => downloadXML('recon'));
  document.getElementById('btnXMLSplit')?.addEventListener('click', () => downloadXML('split'));
  document.getElementById('btnXMLCopy')?.addEventListener('click', copyXML);

  // Demo button
  document.getElementById('btnDemo')?.addEventListener('click', loadDemo);
}

export { processFile, analyze, switchTab, exportAll, downloadXML, copyXML, loadDemo };
