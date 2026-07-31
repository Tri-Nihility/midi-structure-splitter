/**
 * Main Application Controller for MIDI Structure Splitter
 *
 * Coordinates file loading, COSIATEC analysis, UI rendering,
 * and XML export functionality.
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
 * Run COSIATEC compression analysis with current parameters.
 */
function analyze() {
  if (!currentData) return;

  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true;
  btn.textContent = 'COSIATEC分析中...';
  setProgress(10);

  // Use setTimeout to allow UI update before heavy computation
  setTimeout(() => {
    try {
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
      };

      setProgress(40);
      currentResult = cosiatecCompress(
        currentData.notes,
        currentData.ppq,
        opts
      );
      setProgress(80);

      // Update statistics panel
      updateStatistics(currentResult);

      // Update compression bar
      const cov = Math.round(currentResult.compressionRate);
      document.getElementById('fitRate').textContent = cov + '%';
      document.getElementById('fitFill').style.width =
        Math.min(100, cov) + '%';

      // Render all views
      renderReconstruction(currentData, currentResult);
      renderPatterns(currentResult);
      renderTrunk(currentResult, currentData);
      renderTimeline(currentData, currentResult);
      renderXML(currentData, currentResult);

      setProgress(100);
      showStatus(
        `COSIATEC完成: ${currentResult.patterns.length} 模式, 压缩 ${cov}%`,
        'success'
      );
    } catch (err) {
      showStatus('分析失败: ' + err.message, 'error');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔍 压缩分析';
    }
  }, 100);
}

// ---- Statistics ----

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
    0x00, 0x60, 0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x14, 0x00, 0xff,
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
  // Drag-and-drop
  const dropzone = document.getElementById('dropzone');
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

  // File input
  document.getElementById('fileInput').addEventListener('change', (e) => {
    if (e.target.files.length) processFile(e.target.files[0]);
  });

  // Analyze button
  document.getElementById('btnAnalyze').addEventListener('click', analyze);

  // Export button
  document.getElementById('btnExport').addEventListener('click', exportAll);

  // Tab switching
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', function (event) {
      window._lastTabEvent = event;
      switchTab(this.textContent.includes('重建')
        ? 'recon'
        : this.textContent.includes('模式')
          ? 'patterns'
          : this.textContent.includes('主干')
            ? 'trunk'
            : this.textContent.includes('时间轴')
              ? 'timeline'
              : 'xml');
    });
  });

  // XML toolbar buttons
  document.querySelectorAll('#panel-xml .btn-secondary').forEach((btn) => {
    if (btn.textContent.includes('重建XML')) {
      btn.addEventListener('click', () => downloadXML('recon'));
    } else if (btn.textContent.includes('拆分XML')) {
      btn.addEventListener('click', () => downloadXML('split'));
    } else if (btn.textContent.includes('复制')) {
      btn.addEventListener('click', copyXML);
    }
  });

  // Demo button
  document
    .querySelector('header .btn-secondary')
    ?.addEventListener('click', loadDemo);
}

export { processFile, analyze, switchTab, exportAll, downloadXML, copyXML, loadDemo };
