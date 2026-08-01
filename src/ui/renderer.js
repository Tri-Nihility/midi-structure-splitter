/**
 * UI Renderer for MIDI Structure Splitter
 *
 * Handles all DOM-based visualization:
 *   - Reconstruction view (color-coded piano roll)
 *   - Pattern cards with visual preview (virtual scrolling for 20+ patterns)
 *   - Trunk timeline
 *   - Timeline view per track
 *
 * @module renderer
 */

import { noteName } from '../parser/midi-parser.js';
import { generateXML, escapeXml } from '../utils/xml-generator.js';

/** Color palette for distinguishing patterns. */
export const PALETTE = [
  '#00d4aa', '#ff6b6b', '#ffd166', '#118ab2',
  '#ef476f', '#06d6a0', '#9b5de5', '#f15bb5',
  '#00bbf9', '#fee440',
];

// ---- Virtual List for Pattern Library ----

/**
 * Virtual scrolling list that only renders visible items.
 * Eliminates DOM bottleneck when displaying 50+ pattern cards.
 */
class VirtualList {
  /**
   * @param {HTMLElement} container  - Scrollable container element
   * @param {number}      itemHeight - Estimated height per item in px
   * @param {Function}    renderFn   - (item, index) => HTML string
   */
  constructor(container, itemHeight, renderFn) {
    this.container = container;
    this.itemHeight = itemHeight;
    this.renderFn = renderFn;
    this.items = [];
    this.visibleCount = 0;

    // Create inner content wrapper
    this.contentEl = document.createElement('div');
    this.contentEl.style.position = 'relative';
    this.container.appendChild(this.contentEl);

    // Debounced scroll handler
    this._scrollTicking = false;
    this._onScrollBound = this._onScroll.bind(this);
    this.container.addEventListener('scroll', this._onScrollBound);
  }

  /**
   * Replace all items and re-render.
   * @param {any[]} items
   */
  setItems(items) {
    this.items = items;
    this.visibleCount = Math.ceil(this.container.clientHeight / this.itemHeight) + 3;
    this.contentEl.style.height = `${items.length * this.itemHeight}px`;
    this._render();
  }

  /** Clean up event listeners. */
  destroy() {
    this.container.removeEventListener('scroll', this._onScrollBound);
    this.contentEl.innerHTML = '';
  }

  /** Scroll event handler (debounced via requestAnimationFrame). */
  _onScroll() {
    if (!this._scrollTicking) {
      this._scrollTicking = true;
      requestAnimationFrame(() => {
        this._render();
        this._scrollTicking = false;
      });
    }
  }

  /** Render only visible items. */
  _render() {
    const scrollTop = this.container.scrollTop;
    const startIdx = Math.max(0, Math.floor(scrollTop / this.itemHeight) - 1);
    const endIdx = Math.min(this.items.length, startIdx + this.visibleCount + 2);

    // Build HTML for visible range
    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
      const top = i * this.itemHeight;
      html += `<div style="position:absolute;top:${top}px;left:0;right:0">${this.renderFn(this.items[i], i)}</div>`;
    }
    this.contentEl.innerHTML = html;
  }
}

/** Active virtual list instance (recreated per render). */
let patternVirtualList = null;

/**
 * Render reconstruction view — auto-switches to Canvas for large datasets (>2000 notes)
 * to avoid DOM node explosion.
 *
 * @param {object} data   - Original note data
 * @param {object} result - Compression result
 */
export function renderReconstruction(data, result) {
  // Auto-switch to Canvas for >2000 notes to avoid DOM explosion
  if (data.notes.length > 2000) {
    return renderReconstructionCanvas(data, result);
  }
  return renderReconstructionDOM(data, result);
}

/**
 * Canvas-based reconstruction view for large datasets (>2000 notes).
 * Renders the piano roll using Canvas 2D instead of DOM divs,
 * eliminating the DOM node explosion problem.
 *
 * @param {object} data   - Original note data
 * @param {object} result - Compression result
 */
export function renderReconstructionCanvas(data, result) {
  const container = document.getElementById('reconContainer');
  if (!result.patterns.length && !result.trunk.length) {
    container.innerHTML =
      '<div class="empty-state"><div class="icon">[=]</div><p>无重建数据</p></div>';
    return;
  }

  const maxT = Math.max(...data.notes.map((n) => n.end), 1);
  const minP = Math.min(...data.notes.map((n) => n.pitch));
  const maxP = Math.max(...data.notes.map((n) => n.pitch));
  const pRange = maxP - minP || 1;

  // Build coverage map (same as DOM version)
  const coveredBy = new Map();
  result.patterns.forEach((p, pi) => {
    p.occurrences.forEach((o) => {
      o.noteIds.forEach((id) => {
        const n = data.notes[id];
        if (n) coveredBy.set(`${n.track}-${n.start}-${n.pitch}`, pi);
      });
    });
  });

  // Build legend HTML (kept as DOM for accessibility)
  let legendHtml = '<div class="recon-legend">';
  legendHtml += `<div class="recon-legend-item"><div class="recon-dot" style="background:var(--trunk)"></div>主干 (${result.trunk.length})</div>`;
  result.patterns.forEach((p, i) => {
    legendHtml += `<div class="recon-legend-item"><div class="recon-dot" style="background:${PALETTE[i % PALETTE.length]}"></div>模式 #${i + 1} (${p.occurrences.length}次)</div>`;
  });
  legendHtml += `<div class="recon-legend-item" style="margin-left:auto"><span style="color:var(--text2)">压缩 ${result.compressionRate.toFixed(1)}%</span></div>`;
  legendHtml += '</div>';

  // Create or reuse Canvas
  let canvas = container.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '400px';
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const cw = rect.width || 800;
  const ch = 400;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Clear
  ctx.clearRect(0, 0, cw, ch);

  // Draw piano roll background grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 0.5;
  for (let p = minP; p <= maxP; p++) {
    if (p % 12 === 0) { // Octave lines
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    }
    const y = ch - ((p - minP) / pRange) * (ch - 60) - 30;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
  }

  // Draw notes
  const noteH = Math.max(2, (ch - 60) / pRange);
  data.notes.forEach((n) => {
    const x = (n.start / maxT) * cw;
    const w = Math.max(1, (n.dur / maxT) * cw);
    const y = ch - ((n.pitch - minP) / pRange) * (ch - 60) - 30;

    const key = `${n.track}-${n.start}-${n.pitch}`;
    const patId = coveredBy.get(key);
    ctx.fillStyle = patId !== undefined
      ? PALETTE[patId % PALETTE.length]
      : 'var(--trunk)';

    // Resolve CSS variable for trunk color
    if (patId === undefined) {
      const trunkColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--trunk').trim() || '#555';
      ctx.fillStyle = trunkColor;
    }

    ctx.fillRect(x, y, w, noteH);
  });

  // Set container content
  container.innerHTML = legendHtml;
  container.appendChild(canvas);
}

/**
 * Render reconstruction view — auto-switches to Canvas for large datasets.
 *
 * @param {object} data   - Original note data
 * @param {object} result - Compression result
 */
/**
 * DOM-based reconstruction view (for small datasets ≤2000 notes).
 * @param {object} data   - Original note data
 * @param {object} result - Compression result
 */
function renderReconstructionDOM(data, result) {
  const container = document.getElementById('reconContainer');
  if (!result.patterns.length && !result.trunk.length) {
    container.innerHTML =
      '<div class="empty-state"><div class="icon">[=]</div><p>无重建数据</p></div>';
    return;
  }

  const maxT = Math.max(...data.notes.map((n) => n.end), 1);
  const scale = 100 / maxT;
  const minP = Math.min(...data.notes.map((n) => n.pitch));
  const maxP = Math.max(...data.notes.map((n) => n.pitch));
  const pRange = maxP - minP || 1;

  // Build coverage map
  const coveredBy = new Map();
  result.patterns.forEach((p, pi) => {
    p.occurrences.forEach((o) => {
      o.noteIds.forEach((id) => {
        const n = data.notes[id];
        if (n) {
          const key = `${n.track}-${n.start}-${n.pitch}`;
          coveredBy.set(key, pi);
        }
      });
    });
  });

  let html = '<div class="recon-legend">';
  html += `<div class="recon-legend-item"><div class="recon-dot" style="background:var(--trunk)"></div>主干 (${result.trunk.length})</div>`;
  result.patterns.forEach((p, i) => {
    html += `<div class="recon-legend-item"><div class="recon-dot" style="background:${PALETTE[i % PALETTE.length]}"></div>模式 #${i + 1} (${p.occurrences.length}次)</div>`;
  });
  html += `<div class="recon-legend-item" style="margin-left:auto"><span style="color:var(--text2)">压缩 ${result.compressionRate.toFixed(1)}%</span></div>`;
  html += '</div>';

  html += '<div class="recon-canvas"><div class="recon-inner">';
  data.notes.forEach((n) => {
    const left = n.start * scale;
    const width = Math.max(0.3, n.dur * scale);
    const bottom = ((n.pitch - minP) / pRange) * 85 + 5;
    const key = `${n.track}-${n.start}-${n.pitch}`;
    const patId = coveredBy.get(key);
    const color =
      patId !== undefined
        ? PALETTE[patId % PALETTE.length]
        : 'var(--trunk)';
    const isPattern = patId !== undefined;
    html += `<div class="recon-note ${isPattern ? '' : 'trunk'}" style="left:${left}%;width:${width}%;bottom:${bottom}%;height:5px;background:${color}" title="${noteName(n.pitch)} T${n.track} @${n.start} ${isPattern ? '模式#' + (patId + 1) : '主干'}"></div>`;
  });
  html += '</div></div>';

  container.innerHTML = html;
}

/**
 * Render the pattern library view.
 *
 * Uses virtual scrolling when there are 20+ patterns to avoid
 * DOM performance bottlenecks.
 *
 * @param {object} result - Compression result
 */
export function renderPatterns(result) {
  const container = document.getElementById('patternsContainer');

  if (!result.patterns.length) {
    container.innerHTML =
      '<div class="empty-state"><div class="icon">[~]</div><p>未检测到重复模式</p></div>';
    return;
  }

  // Destroy previous virtual list
  if (patternVirtualList) {
    patternVirtualList.destroy();
    patternVirtualList = null;
  }

  // Build pattern card render function
  const renderCard = (p, i) => {
    const color = PALETTE[i % PALETTE.length];
    const pitches = p.notes.map((n) => n.pitch);
    const minRP = Math.min(...pitches);
    const maxRP = Math.max(...pitches);
    const range = maxRP - minRP || 1;

    return `<div class="pattern-card" style="border-left:3px solid ${color}">
      <div class="pattern-card-header">
        <span class="pattern-card-title" style="color:${color}">模式 #${i + 1} (COSIATEC轮次 ${p.round})</span>
        <span class="pattern-card-meta">
          <span>${p.notes.length} 音符模板</span>
          <span>${p.occurrences.length} 实例</span>
          <span>压缩比 ${p.compressionRatio.toFixed(2)}</span>
        </span>
      </div>
      <div class="pattern-visual">
        ${p.notes
          .map((n) => {
            const h = Math.max(3, ((n.pitch - minRP) / range) * 24 + 3);
            return `<div class="pattern-bar" style="height:${h}px;background:${color}"></div>`;
          })
          .join('')}
      </div>
      <div style="font-size:.65rem;color:var(--text2);margin:.2rem 0">实例排布 (delay=起始偏移, trans=移调):</div>
      <div>
        ${p.occurrences
          .map(
            (o, oi) =>
              `<span class="occ-chip" style="background:${color}22;color:${color};border:1px solid ${color}44">#${oi + 1} T${o.track} d=${o.delay} t=${o.transposition}</span>`
          )
          .join('')}
      </div>
    </div>`;
  };

  // Use virtual scrolling for 20+ patterns, direct render for fewer
  if (result.patterns.length >= 20) {
    // Set up container for virtual scrolling
    container.style.maxHeight = '70vh';
    container.style.overflowY = 'auto';
    container.style.position = 'relative';

    patternVirtualList = new VirtualList(container, 110, renderCard);
    patternVirtualList.setItems(result.patterns);
  } else {
    // Direct DOM render for small pattern counts
    container.style.maxHeight = '';
    container.style.overflowY = '';
    let html = '';
    result.patterns.forEach((p, i) => {
      html += renderCard(p, i);
    });
    container.innerHTML = html;
  }
}

/**
 * Render the trunk (uncovered notes) view.
 *
 * @param {object} result    - Compression result
 * @param {object} noteData  - Original note data (for ppq reference)
 */
export function renderTrunk(result, noteData) {
  const container = document.getElementById('trunkContainer');
  if (!result.trunk.length) {
    container.innerHTML =
      '<div class="empty-state"><div class="icon">[#]</div><p>所有音符都被模式覆盖，无主干</p></div>';
    return;
  }

  const maxT = Math.max(...result.trunk.map((n) => n.end), 1);
  const scale = 100 / maxT;
  const minP = Math.min(...result.trunk.map((n) => n.pitch));
  const maxP = Math.max(...result.trunk.map((n) => n.pitch));
  const pRange = maxP - minP || 1;

  let html = `<div style="font-size:.8rem;color:var(--text2);margin-bottom:.4rem">${result.trunk.length} 个独立音符 (${((result.trunk.length / result.totalNotes) * 100).toFixed(1)}%)</div>`;
  html += '<div class="trunk-timeline">';
  result.trunk.forEach((n) => {
    const left = n.start * scale;
    const width = Math.max(0.2, n.dur * scale);
    const bottom = ((n.pitch - minP) / pRange) * 80 + 10;
    html += `<div class="trunk-note" style="left:${left}%;width:${width}%;bottom:${bottom}%;height:4px" title="${noteName(n.pitch)} T${n.track} @${n.start}"></div>`;
  });
  html += '</div>';

  // Per-track trunk breakdown
  const byTrack = {};
  result.trunk.forEach((n) => {
    if (!byTrack[n.track]) byTrack[n.track] = [];
    byTrack[n.track].push(n);
  });

  html += '<div style="margin-top:.6rem">';
  Object.entries(byTrack).forEach(([tid, arr]) => {
    html += `<div style="font-size:.75rem;color:var(--text2);margin:.3rem 0">轨道 ${tid}: ${arr.length} 音符</div>`;
    html += '<div style="display:flex;flex-wrap:wrap;gap:.15rem">';
    arr.forEach((n) => {
      html += `<span style="font-size:.65rem;background:var(--panel);padding:.1rem .3rem;border-radius:3px;color:var(--trunk2)">${noteName(n.pitch)}@${Math.round(n.start / (noteData?.ppq || 96))}</span>`;
    });
    html += '</div>';
  });
  html += '</div>';

  container.innerHTML = html;
}

/**
 * Render the timeline view showing pattern occurrences along time.
 *
 * @param {object} data   - Original note data
 * @param {object} result - Compression result
 */
export function renderTimeline(data, result) {
  const container = document.getElementById('timelineContainer');
  const maxT = Math.max(...data.notes.map((n) => n.end), 1);
  const scale = 100 / maxT;

  const tracks = [...new Set(data.notes.map((n) => n.track))].sort(
    (a, b) => a - b
  );

  let html = '';

  // Per-track timelines
  tracks.forEach((tid) => {
    html += `<div class="card" style="margin-bottom:.5rem">
      <div style="font-size:.8rem;font-weight:600;margin-bottom:.3rem">轨道 ${tid}</div>
      <div style="position:relative;height:40px;background:#0d0d14;border-radius:6px;overflow:hidden">`;

    const trunkNotes = result.trunk
      .filter((n) => n.track === tid)
      .sort((a, b) => a.start - b.start);

    let lastEnd = 0;
    trunkNotes.forEach((n) => {
      if (n.start > lastEnd) {
        const left = lastEnd * scale;
        const width = (n.start - lastEnd) * scale;
        html += `<div style="position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:repeating-linear-gradient(45deg,#1e1e30,#1e1e30 3px,#151520 3px,#151520 6px);opacity:.6" title="间隙"></div>`;
      }
      const left = n.start * scale;
      const width = Math.max(0.3, n.dur * scale);
      html += `<div style="position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:var(--trunk);opacity:.7" title="主干"></div>`;
      lastEnd = Math.max(lastEnd, n.end);
    });

    result.patterns.forEach((p, pi) => {
      p.occurrences
        .filter((o) => o.track === tid)
        .forEach((o) => {
          const left = o.start * scale;
          const width = Math.max(0.3, (o.end - o.start) * scale);
          html += `<div style="position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${PALETTE[pi % PALETTE.length]};opacity:.75;border:1px solid rgba(255,255,255,.1);border-radius:2px" title="模式#${pi + 1} 拍${Math.round(o.start / data.ppq)}-${Math.round(o.end / data.ppq)}"></div>`;
        });
    });

    html += '</div></div>';
  });

  // Overall timeline
  html += `<div class="card">
    <div style="font-size:.8rem;font-weight:600;margin-bottom:.3rem">整体时间轴</div>
    <div style="position:relative;height:50px;background:#0d0d14;border-radius:6px;overflow:hidden">`;
  result.patterns.forEach((p, pi) => {
    p.occurrences.forEach((o) => {
      const left = o.start * scale;
      const width = Math.max(0.3, (o.end - o.start) * scale);
      const top = (o.track % 4) * 25;
      html += `<div style="position:absolute;left:${left}%;width:${width}%;top:${top}%;height:23%;background:${PALETTE[pi % PALETTE.length]};opacity:.8;border-radius:2px" title="模式#${pi + 1} T${o.track}"></div>`;
    });
  });
  html += '</div></div>';

  container.innerHTML = html;
}

/**
 * Render the XML output panel.
 *
 * @param {object} data   - Original note data
 * @param {object} result - Compression result
 */
export function renderXML(data, result) {
  const xml = generateXML(data, result, 'recon');
  document.getElementById('xmlOutput').innerHTML = `<code>${escapeXml(xml)}</code>`;
}

/**
 * Generate a download of the given content.
 *
 * @param {string} content  - File content
 * @param {string} filename - Download filename
 * @param {string} mimeType - MIME type
 */
export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}