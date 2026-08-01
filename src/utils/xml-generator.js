/**
 * XML Generator for MIDI Structure Splitter
 *
 * Generates structured XML output describing the pattern decomposition:
 *   - "recon" mode: patterns → template + instances + trunk + statistics
 *   - "split" mode: all notes annotated with pattern/trunk membership
 *
 * @module xml-generator
 */

/**
 * Escape XML special characters.
 * @param {string} s
 * @returns {string}
 */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate XML representation of the compression result.
 *
 * @param {object} noteData - Original note data ({ notes, ppq, bpm, dur, format, numTracks })
 * @param {object} result   - COSIATEC compression result ({ patterns, trunk, ... })
 * @param {'recon'|'split'} mode - Output mode
 * @returns {string} XML string
 */
export function generateXML(noteData, result, mode = 'recon') {
  const esc = escapeXml;
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<midi xmlns="http://example.org/midi-xml" version="2.0">\n';
  xml += '  <header>\n';
  xml += `    <format>${noteData.format}</format>\n`;
  xml += `    <tracks>${noteData.numTracks}</tracks>\n`;
  xml += `    <division>${noteData.ppq}</division>\n`;
  xml += `    <bpm>${noteData.bpm}</bpm>\n`;
  xml += `    <durationTicks>${noteData.dur}</durationTicks>\n`;
  xml += '  </header>\n';

  if (mode === 'recon') {
    // Reconstruction view: patterns + trunk
    xml += `  <patterns count="${result.patterns.length}">\n`;
    result.patterns.forEach((p, pi) => {
      xml += `    <pattern id="${pi}" name="Pattern_${pi + 1}" length="${p.notes.length}" occurrences="${p.occurrences.length}" compressionRatio="${p.compressionRatio.toFixed(2)}">\n`;
      xml += '      <template>\n';
      p.notes.forEach((n, ni) => {
        xml += `        <note index="${ni}" relPitch="${ni > 0 ? n.pitch - p.notes[0].pitch : 0}" relStart="${ni > 0 ? n.start - p.notes[0].start : 0}" duration="${n.dur}" velocity="${n.vel}"/>\n`;
      });
      xml += '      </template>\n';
      xml += '      <instances>\n';
      p.occurrences.forEach((o, oi) => {
        xml += `        <instance id="${oi}" track="${o.track}" delay="${o.delay}" transposition="${o.transposition}" end="${o.end}" noteCount="${o.noteIds.length}"/>\n`;
      });
      xml += '      </instances>\n';
      xml += '    </pattern>\n';
    });
    xml += '  </patterns>\n';

    xml += `  <trunk count="${result.trunk.length}">\n`;
    result.trunk.forEach((n, i) => {
      xml += `    <note id="${i}" track="${n.track}" channel="${n.ch}" pitch="${n.pitch}" velocity="${n.vel}" start="${n.start}" duration="${n.dur}" end="${n.end}"/>\n`;
    });
    xml += '  </trunk>\n';

    xml += `  <statistics coverage="${(result.coverage * 100).toFixed(1)}%" compression="${result.compressionRate.toFixed(1)}%" rounds="${result.rounds}"/>\n`;
  } else {
    // Split view: all notes annotated
    xml += `  <notes count="${noteData.notes.length}">\n`;
    noteData.notes.forEach((n, i) => {
      const inTrunk = result.trunk.some(
        (t) => t.track === n.track && t.start === n.start && t.pitch === n.pitch
      );
      let patId = -1;
      let instId = -1;
      result.patterns.forEach((p) => {
        p.occurrences.forEach((o, oi) => {
          if (o.noteIds.includes(i)) {
            patId = p.id;
            instId = oi;
          }
        });
      });
      xml += `    <note id="${i}" track="${n.track}" channel="${n.ch}" pitch="${n.pitch}" velocity="${n.vel}" start="${n.start}" duration="${n.dur}" end="${n.end}" segment="${inTrunk ? 'trunk' : 'pattern'}" patternId="${patId}" instanceId="${instId}"/>\n`;
    });
    xml += '  </notes>\n';
  }

  xml += '</midi>';
  return xml;
}
