/**
 * Main Application Controller for MIDI Structure Splitter
 *
 * Coordinates file loading, COSIATEC analysis, auto-optimization,
 * UI rendering, and XML export functionality.
 *
 * @module app
 */

import { MidiParser, midiToNotes } from '../parser/midi-parser.js';
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

/** @type {Worker|null} Web Worker for background computation */
let worker = null;

/** @type {number} Animation frame ID for progress bar pulse */
let progressAnimId = null;

/** @type {ArrayBuffer|null} Raw MIDI file buffer for caching */
let currentFileBuffer = null;

// ---- Analysis Cache ----

/**
 * LRU cache for analysis results keyed by file content hash.
 * Avoids re-analyzing the same file with the same parameters.
 */
class AnalysisCache {
  constructor(maxSize = 8) {
    /** @type {Map<string, {result: object, opts: object}>} */
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Compute a hash from an ArrayBuffer for cache keying.
   * Uses first 4KB of the file for speed.
   * @param {ArrayBuffer} buffer
   * @returns {string} Hex hash string
   */
  getKey(buffer) {
    const sampleLen = Math.min(buffer.byteLength, 4096);
    const sample = new Uint8Array(buffer.slice(0, sampleLen));
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
      hash = ((hash << 5) - hash) + sample[i];
      hash |= 0; // Convert to 32-bit integer
    }
    // Mix in file size for better distribution
    return (hash >>> 0).toString(16) + '_' + buffer.byteLength.toString(16);
  }

  /**
   * Generate a full cache key from buffer + options.
   * @param {ArrayBuffer} buffer
   * @param {object} opts
   * @returns {string}
   */
  getFullKey(buffer, opts) {
    const fileKey = this.getKey(buffer);
    const optStr = JSON.stringify(opts, Object.keys(opts).sort());
    return fileKey + '|' + optStr;
  }

  /**
   * Check if a cached result exists for these inputs.
   * @param {ArrayBuffer} buffer
   * @param {object} opts
   * @returns {object|null} Cached result or null
   */
  get(buffer, opts) {
    const key = this.getFullKey(buffer, opts);
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.result;
    }
    return null;
  }

  /**
   * Store a result in the cache.
   * @param {ArrayBuffer} buffer
   * @param {object} opts
   * @param {object} result
   */
  set(buffer, opts, result) {
    const key = this.getFullKey(buffer, opts);
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { result, opts: { ...opts } });
  }

  /** Clear all cached results. */
  clear() {
    this.cache.clear();
  }
}

/** Global analysis cache instance. */
const analysisCache = new AnalysisCache(8);

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
      // Save raw buffer for caching
      currentFileBuffer = e.target.result;
      const parsed = new MidiParser(currentFileBuffer).parse();
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

// ---- Web Worker Management ----

/**
 * Get or create the Web Worker. Reuses existing worker if available.
 * Uses a URL relative to the current script to handle different deployment paths.
 * @returns {Worker}
 */
function getWorker() {
  if (!worker) {
    // Use import.meta.url to resolve worker path relative to this module
    const workerUrl = new URL('../../../public/worker.js', import.meta.url);
    worker = new Worker(workerUrl.href);
  }
  return worker;
}

/**
 * Terminate and reset the worker.
 */
function killWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

// ---- Analysis ----

/**
 * Run COSIATEC analysis via Web Worker to keep UI responsive.
 * Shows an animated progress bar while computing.
 * Uses cache to avoid re-analyzing same file+params.
 * Supports progressive mode: Stage 1 preview, Stage 2 standard, Stage 3 deep.
 */
function analyze() {
  if (!currentData) return;

  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true;
  btn.textContent = '分析中...';

  // Kill any previous worker
  killWorker();

  // Collect current parameter options
  const opts = {
    minLen: parseInt(document.getElementById('minLen').value),
    maxLen: parseInt(document.getElementById('maxLen').value),
    maxOcc: parseInt(document.getElementById('minOcc').value),
    minOcc: parseInt(document.getElementById('minOcc').value),
    pitchTol: parseInt(document.getElementById('pitchTol').value),
    timeTol: parseInt(document.getElementById('timeTol').value),
    maxPatterns: parseInt(document.getElementById('maxPatterns').value),
    minRatio: parseFloat(document.getElementById('minRatio').value),
    detectTrans: document.getElementById('detectTrans').checked,
    iterative: document.getElementById('iterative').checked,
    algorithm: document.getElementById('fastMode')?.checked ? 'siateccompress' : 'cosiatec',
    useFingerprint: document.getElementById('useFingerprint')?.checked || false,
    useRRT: true,
  };

  // Check cache first
  if (currentFileBuffer) {
    const cached = analysisCache.get(currentFileBuffer, opts);
    if (cached) {
      currentResult = cached;
      finishAnalysis(cached, btn);
      showStatus('缓存命中 — 秒出结果', 'success');
      return;
    }
  }

  // Show animated progress bar
  startProgressAnimation();

  const w = getWorker();

  // Determine analysis mode: progressive for larger files, direct for small
  const useProgressive = currentData.notes.length > 500;
  const msgType = useProgressive ? 'analyze-progressive' : 'analyze';

  w.onmessage = (e) => {
    const { type, phase, detail, result, stage } = e.data;

    // Progressive: stage transitions
    if (type === 'progressive-stage') {
      if (stage === 'preview') {
        updateProgress(5);
        btn.textContent = '预览中...';
      } else if (stage === 'preview-done') {
        updateProgress(25);
        var info = e.data.previewInfo || {};
        btn.textContent = '标准分析中...';
        showStatus('预览: 发现约 ' + (info.foundCount || 0) + ' 个潜在模式, 覆盖 ' + (info.totalCoverage || 0) + ' 音符', 'success');
      } else if (stage === 'standard') {
        updateProgress(30);
        btn.textContent = '标准分析中...';
      } else if (stage === 'deep') {
        updateProgress(70);
        btn.textContent = '深度分析中...';
      }
    }

    // Progressive: intermediate results (standard stage only)
    if (type === 'progressive-result') {
      if (stage === 'standard') {
        updateProgress(65);
        currentResult = result;
        requestAnimationFrame(() => {
          updateStatistics(result);
          const cov = Math.round(result.compressionRate);
          document.getElementById('fitRate').textContent = cov + '%';
          document.getElementById('fitFill').style.width = Math.min(100, cov) + '%';
          renderReconstruction(currentData, result);
          renderPatterns(result);
          renderTrunk(result, currentData);
          renderTimeline(currentData, result);
          renderXML(currentData, result);
        });
      } else if (stage === 'deep') {
        updateProgress(90);
      }
    }

    // Progressive: progress within a stage
    if (type === 'progressive-progress') {
      if (phase === 'round') {
        const base = stage === 'standard' ? 35 : 75;
        updateProgress(base + Math.min(20, detail.round * 5));
      }
    }

    // Progressive: all done
    if (type === 'progressive-done') {
      stopProgressAnimation();
      setProgress(100);

      // Cache the final (standard) result
      if (currentFileBuffer && currentResult) {
        analysisCache.set(currentFileBuffer, opts, currentResult);
      }

      const cov = Math.round(currentResult.compressionRate);
      let msg = `COSIATEC完成: ${currentResult.patterns.length} 模式, 压缩 ${cov}%`;
      if (currentResult.wasDownsampled) msg += ' (已启用采样优化)';
      showStatus(msg, 'success');

      btn.disabled = false;
      btn.textContent = '压缩分析';
    }

    // Direct (non-progressive) analysis
    if (type === 'progress' && msgType === 'analyze') {
      if (phase === 'start') {
        updateProgress(15);
      } else if (phase === 'round') {
        updateProgress(15 + Math.min(60, detail.round * 15));
        btn.textContent = `轮次 ${detail.round}...`;
      } else if (phase === 'pattern') {
        updateProgress(60 + detail.round * 5);
      }
    }

    if (type === 'result') {
      stopProgressAnimation();
      setProgress(100);
      currentResult = result;

      // Cache the result
      if (currentFileBuffer) {
        analysisCache.set(currentFileBuffer, opts, result);
      }

      finishAnalysis(result, btn);
    }

    if (type === 'error') {
      stopProgressAnimation();
      setProgress(0);
      showStatus('分析失败: ' + e.data.message, 'error');
      btn.disabled = false;
      btn.textContent = '压缩分析';
    }
  };

  w.onerror = (err) => {
    stopProgressAnimation();
    setProgress(0);
    showStatus('Worker 错误', 'error');
    btn.disabled = false;
    btn.textContent = '压缩分析';
    console.error('Worker error:', err);
  };

  w.postMessage({
    type: msgType,
    notes: currentData.notes,
    ppq: currentData.ppq,
    opts,
    deep: useProgressive, // Enable deep analysis for larger files
  });
}

/**
 * Finalize analysis: update stats, render views, re-enable button.
 */
function finishAnalysis(result, btn) {
  updateStatistics(result);

  const cov = Math.round(result.compressionRate);
  document.getElementById('fitRate').textContent = cov + '%';
  document.getElementById('fitFill').style.width = Math.min(100, cov) + '%';

  requestAnimationFrame(() => {
    renderReconstruction(currentData, result);
    renderPatterns(result);
    renderTrunk(result, currentData);
    renderTimeline(currentData, result);
    renderXML(currentData, result);

    let msg = `COSIATEC完成: ${result.patterns.length} 模式, 压缩 ${cov}%`;
    if (result.wasDownsampled) msg += ' (已启用采样优化)';
    showStatus(msg, 'success');
  });

  btn.disabled = false;
  btn.textContent = '压缩分析';
}

// ---- Auto-Optimization ----

/** Hard cap on total tests. */
const MAX_TESTS = 200;

/**
 * Auto-optimize: scan parameter grid for best compression.
 * Runs entirely in Web Worker; main thread just updates the progress bar.
 */
function autoOptimize() {
  if (!currentData) {
    showStatus('请先上传 MIDI 文件', 'error');
    return;
  }

  const btnAnalyze = document.getElementById('btnAnalyze');
  const btnAuto = document.getElementById('btnAutoOptimize');
  const btnCancel = document.getElementById('btnCancel');
  btnAnalyze.disabled = true;
  btnAuto.disabled = true;
  btnAuto.textContent = '优化中...';
  btnCancel.style.display = 'block';

  killWorker();
  startProgressAnimation();

  showStatus('开始自动优化（后台计算，页面不会卡死）', 'success');

  const w = getWorker();

  w.onmessage = (e) => {
    const { type, tested, total, bestRate, bestParams, result } = e.data;

    if (type === 'optimize-progress') {
      const pct = Math.round((tested / total) * 100);
      updateProgress(pct);
      btnAuto.textContent = `${tested}/${total} (最佳 ${bestRate.toFixed(1)}%)`;
    }

    if (type === 'optimize-done') {
      stopProgressAnimation();
      setProgress(100);
      currentResult = result;

      // Update parameter inputs to best values
      document.getElementById('minLen').value = bestParams.minLen;
      document.getElementById('maxLen').value = bestParams.maxLen;
      document.getElementById('minOcc').value = bestParams.minOcc;
      document.getElementById('pitchTol').value = bestParams.pitchTol;
      document.getElementById('maxPatterns').value = bestParams.maxPatterns;
      document.getElementById('minRatio').value = bestParams.minRatio;

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

      showStatus(
        `优化完成: ${tested} 组合, 最佳 ${cov}% (minLen=${bestParams.minLen} maxLen=${bestParams.maxLen})`,
        'success'
      );

      btnAnalyze.disabled = false;
      btnAuto.disabled = false;
      btnAuto.textContent = '自动优化';
      btnCancel.style.display = 'none';
    }

    if (type === 'error') {
      stopProgressAnimation();
      showStatus('优化失败: ' + e.data.message, 'error');
      btnAnalyze.disabled = false;
      btnAuto.disabled = false;
      btnAuto.textContent = '自动优化';
      btnCancel.style.display = 'none';
    }
  };

  w.onerror = (err) => {
    stopProgressAnimation();
    showStatus('Worker 错误', 'error');
    btnAnalyze.disabled = false;
    btnAuto.disabled = false;
    btnAuto.textContent = '自动优化';
    btnCancel.style.display = 'none';
    console.error('Worker error:', err);
  };

  w.postMessage({
    type: 'optimize',
    notes: currentData.notes,
    ppq: currentData.ppq,
    opts: {
      timeTol: parseInt(document.getElementById('timeTol').value),
      detectTrans: document.getElementById('detectTrans').checked,
      iterative: document.getElementById('iterative').checked,
      algorithm: document.getElementById('fastMode')?.checked ? 'siateccompress' : 'cosiatec',
      useFingerprint: document.getElementById('useFingerprint')?.checked || false,
      useRRT: true,
    },
    maxTests: MAX_TESTS,
  });
}

/**
 * Cancel running auto-optimization or analysis.
 */
function cancelOptimize() {
  killWorker();
  stopProgressAnimation();
  setProgress(0);

  const btnAnalyze = document.getElementById('btnAnalyze');
  const btnAuto = document.getElementById('btnAutoOptimize');
  const btnCancel = document.getElementById('btnCancel');
  btnAnalyze.disabled = false;
  btnAuto.disabled = false;
  btnAuto.textContent = '自动优化';
  btnCancel.style.display = 'none';

  showStatus('已取消', 'error');
}

// ---- Status Messages ----

/**
 * Show a temporary status message.
 * @param {string} msg
 * @param {'success'|'error'} type
 */
function showStatus(msg, type) {
  const el = document.getElementById('fileStatus');
  el.textContent = msg;
  el.className = `status show ${type}`;
  setTimeout(() => el.classList.remove('show'), 5000);
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
 * @param {string}  name       - Tab name: 'recon', 'patterns', 'trunk', 'timeline', 'xml'
 * @param {Element} [clickedEl] - The clicked tab element (optional)
 */
function switchTab(name, clickedEl) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document
    .querySelectorAll('.panel')
    .forEach((p) => p.classList.remove('active'));

  // Highlight the clicked tab if provided
  if (clickedEl) {
    clickedEl.classList.add('active');
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

// ---- Progress Bar ----

/**
 * Start the progress bar. Shows the bar and adds a subtle pulsing glow
 * to indicate background computation is in progress.
 */
function startProgressAnimation() {
  const bar = document.getElementById('progressBar');
  bar.classList.add('show', 'computing');
  document.getElementById('progressFill').style.width = '5%';
}

/**
 * Update the progress bar to a specific percentage.
 * CSS transition handles smooth animation.
 * @param {number} pct - 0-100
 */
function updateProgress(pct) {
  document.getElementById('progressFill').style.width = Math.min(100, Math.max(0, pct)) + '%';
}

/**
 * Finish: jump to 100%, remove pulsing, hide after delay.
 */
function stopProgressAnimation() {
  const bar = document.getElementById('progressBar');
  bar.classList.remove('computing');
  document.getElementById('progressFill').style.width = '100%';
  setTimeout(() => {
    bar.classList.remove('show');
  }, 800);
}

/**
 * Legacy setProgress — show bar and snap to value.
 */
function setProgress(pct) {
  const bar = document.getElementById('progressBar');
  bar.classList.add('show');
  document.getElementById('progressFill').style.width = pct + '%';
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
      if (panel) switchTab(panel, this);
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
