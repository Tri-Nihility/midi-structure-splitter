/**
 * MIDI Binary Parser
 *
 * Parses raw MIDI binary data (.mid / .midi) into structured note events.
 * Supports Format 0/1/2, running status, variable-length values, and meta events.
 *
 * @module midi-parser
 */

/**
 * Parse raw MIDI binary buffer into structured format.
 */
export class MidiParser {
  /**
   * @param {ArrayBuffer} buf - Raw MIDI file buffer
   */
  constructor(buf) {
    this.data = new Uint8Array(buf);
    this.pos = 0;
  }

  /**
   * Parse the full MIDI file.
   * @returns {{ header: object, tracks: object[] }}
   */
  parse() {
    const header = this.readHeader();
    const tracks = [];
    for (let i = 0; i < header.numTracks; i++) {
      tracks.push(this.readTrack());
    }
    return { header, tracks };
  }

  /**
   * Read MIDI header chunk.
   * @returns {{ format: number, numTracks: number, division: number }}
   */
  readHeader() {
    if (this.readString(4) !== 'MThd') {
      throw new Error('Invalid MIDI file: missing MThd header');
    }
    this.readUint32(); // chunk length (always 6)
    return {
      format: this.readUint16(),
      numTracks: this.readUint16(),
      division: this.readInt16(),
    };
  }

  /**
   * Read a single MIDI track chunk.
   * @returns {{ events: object[] }}
   */
  readTrack() {
    if (this.readString(4) !== 'MTrk') {
      throw new Error('Invalid MIDI track: missing MTrk marker');
    }
    const len = this.readUint32();
    const end = this.pos + len;
    const events = [];
    let runningStatus = 0;

    while (this.pos < end) {
      const deltaTime = this.readVarLen();
      let status = this.data[this.pos];

      if (status < 0x80) {
        // Running status: reuse previous status byte
        status = runningStatus;
      } else {
        this.pos++;
        if (status < 0xF0) {
          runningStatus = status;
        }
      }

      events.push({ deltaTime, ...this.readEvent(status) });
    }

    return { events };
  }

  /**
   * Read a single MIDI event.
   * @param {number} status - MIDI status byte
   * @returns {object}
   */
  readEvent(status) {
    const type = status & 0xF0;
    const channel = status & 0x0F;

    if (type === 0x80) {
      return { type: 'noteOff', channel, note: this.r1(), vel: this.r1() };
    }

    if (type === 0x90) {
      const note = this.r1();
      const vel = this.r1();
      return vel === 0
        ? { type: 'noteOff', channel, note, vel }
        : { type: 'noteOn', channel, note, vel };
    }

    if (type === 0xB0) {
      return { type: 'ctrl', channel, ctrl: this.r1(), val: this.r1() };
    }

    if (type === 0xC0) {
      return { type: 'pgm', channel, pgm: this.r1() };
    }

    if (type === 0xE0) {
      return { type: 'bend', channel, val: (this.r1() << 7) | this.r1() };
    }

    if (status === 0xFF) {
      return this.readMetaEvent();
    }

    // Unknown event type — skip
    return { type: 'skip' };
  }

  /**
   * Read a MIDI meta event (status 0xFF).
   * @returns {object}
   */
  readMetaEvent() {
    const metaType = this.r1();
    const len = this.readVarLen();
    const data = this.rb(len);

    const event = { type: 'meta', metaType, data };

    if (metaType === 0x51 && len === 3) {
      // Tempo (microseconds per quarter note)
      event.bpm = Math.round(60000000 / ((data[0] << 16) | (data[1] << 8) | data[2]));
    }

    if (metaType === 0x58 && len === 4) {
      // Time signature
      event.num = data[0];
      event.den = 1 << data[1];
    }

    if (metaType === 0x03 || metaType === 0x01) {
      // Track name or text event
      try {
        event.text = new TextDecoder().decode(data);
      } catch (_) {
        // Ignore decode errors
      }
    }

    if (metaType === 0x2F) {
      // End of track
      event.endOfTrack = true;
    }

    return event;
  }

  // ---- Low-level binary read helpers ----

  readString(n) {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += String.fromCharCode(this.data[this.pos++]);
    }
    return s;
  }

  readUint32() {
    return (this.r1() << 24) | (this.r1() << 16) | (this.r1() << 8) | this.r1();
  }

  readUint16() {
    return (this.r1() << 8) | this.r1();
  }

  readInt16() {
    const v = this.readUint16();
    return v > 0x7FFF ? v - 0x10000 : v;
  }

  r1() {
    return this.data[this.pos++];
  }

  rb(n) {
    const slice = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readVarLen() {
    let value = 0;
    let b;
    do {
      b = this.r1();
      value = (value << 7) | (b & 0x7F);
    } while (b & 0x80);
    return value;
  }
}

/**
 * Convert parsed MIDI tracks into a flat array of note objects.
 *
 * @param {{ header: object, tracks: object[] }} parsed - Result from MidiParser.parse()
 * @returns {{ notes: object[], ppq: number, bpm: number, dur: number, format: number, numTracks: number }}
 */
export function midiToNotes(parsed) {
  const notes = [];
  const active = {};
  let bpm = 120;
  const ppq = Math.abs(parsed.header.division);

  parsed.tracks.forEach((track, trackIdx) => {
    let tick = 0;

    track.events.forEach((event) => {
      tick += event.deltaTime;

      if (event.type === 'meta') {
        if (event.bpm) bpm = event.bpm;
        return;
      }

      if (event.type === 'noteOn') {
        const key = `${trackIdx}-${event.channel}-${event.note}`;
        // Handle overlapping notes: if a note with the same key is already
        // active (NoteOn before previous NoteOff), close the old note first
        // to prevent silent note loss.
        if (active[key]) {
          const oldNote = active[key];
          notes.push({ ...oldNote, end: tick, dur: tick - oldNote.start });
        }
        active[key] = {
          track: trackIdx,
          ch: event.channel,
          pitch: event.note,
          vel: event.vel,
          start: tick,
        };
      }

      if (event.type === 'noteOff') {
        const key = `${trackIdx}-${event.channel}-${event.note}`;
        if (active[key]) {
          const note = active[key];
          notes.push({ ...note, end: tick, dur: tick - note.start });
          delete active[key];
        }
      }
    });
  });

  // Sort by onset time, then pitch
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const dur = notes.length
    ? Math.max(...notes.map((n) => n.end))
    : 0;

  return {
    notes,
    ppq,
    bpm,
    dur,
    format: parsed.header.format,
    numTracks: parsed.header.numTracks,
  };
}

/**
 * Convert a MIDI note number to a human-readable name (e.g., "C4").
 * @param {number} pitch - MIDI pitch value (0–127)
 * @returns {string}
 */
export function noteName(pitch) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[pitch % 12] + (Math.floor(pitch / 12) - 1);
}