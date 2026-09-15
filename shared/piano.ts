export const PIANO_GAME_ID = "one-note-piano";
export const PIANO_LOW_MIDI = 21; // A0
export const PIANO_HIGH_MIDI = 108; // C8
export const PIANO_CLAIM_TIMEOUT_MS = 45_000;
export const PIANO_PLAY_WINDOW_MS = 2_500;
export const PIANO_MIN_INTERVAL_MS = 80;
export const PIANO_ENSEMBLE_WINDOW_MS = 450;
export const PIANO_MAX_AGENTS = 10;
export const PIANO_SAY_MAX_CHARS = 80;
export const PIANO_SAY_INTERVAL_MS = 1_000;
export const PIANO_SAY_WINDOW_MS = 20_000;
export const PIANO_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const PIANO_COLORS = ["#65f6ff", "#ff4fa3", "#fff36b", "#66ed8a", "#9d72ff", "#ff925c", "#5affd2", "#ef70ff", "#75a3ff", "#d4ff65"];

const FLAT_TO_SHARP: Record<string, string> = {
  DB: "C#",
  EB: "D#",
  GB: "F#",
  AB: "G#",
  BB: "A#",
};

export type PianoKey = {
  note: string;
  midi: number;
  pitchClass: string;
  octave: number;
  black: boolean;
  whiteIndex: number;
};

export function midiToNote(midi: number) {
  const pitchClass = PIANO_NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${pitchClass}${octave}`;
}

export function midiFrequency(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function isBlackMidi(midi: number) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

export function parsePianoNote(input: string): PianoKey | null {
  const trimmed = input.trim().toUpperCase().replace(/\s+/g, "");
  const match = trimmed.match(/^([A-G])([#B]|SHARP|S)?(-?\d)$/);
  if (!match) return null;
  let pitchClass = match[2] === "B" ? `${match[1]}B` : match[1] + (match[2] ? "#" : "");
  if (match[2] === "S" || match[2] === "SHARP") pitchClass = `${match[1]}#`;
  pitchClass = FLAT_TO_SHARP[pitchClass] ?? pitchClass;
  if (pitchClass.endsWith("B") && pitchClass.length === 2 && pitchClass !== "B") return null;
  const octave = Number(match[3]);
  const pitchIndex = PIANO_NOTE_NAMES.indexOf(pitchClass as (typeof PIANO_NOTE_NAMES)[number]);
  if (pitchIndex < 0 || !Number.isInteger(octave)) return null;
  const midi = (octave + 1) * 12 + pitchIndex;
  if (midi < PIANO_LOW_MIDI || midi > PIANO_HIGH_MIDI) return null;
  return pianoKeyFromMidi(midi);
}

export function pianoKeyFromMidi(midi: number): PianoKey {
  const note = midiToNote(midi);
  const pitchClass = PIANO_NOTE_NAMES[((midi % 12) + 12) % 12];
  return {
    note,
    midi,
    pitchClass,
    octave: Math.floor(midi / 12) - 1,
    black: isBlackMidi(midi),
    whiteIndex: 0,
  };
}

export function pianoKeys(): PianoKey[] {
  const keys: PianoKey[] = [];
  let whiteIndex = 0;
  for (let midi = PIANO_LOW_MIDI; midi <= PIANO_HIGH_MIDI; midi++) {
    const key = pianoKeyFromMidi(midi);
    if (!key.black) {
      key.whiteIndex = whiteIndex;
      whiteIndex += 1;
    } else {
      key.whiteIndex = Math.max(0, whiteIndex - 1);
    }
    keys.push(key);
  }
  return keys;
}

export function pianoColorFor(handle: string) {
  let hash = 0;
  for (const char of handle.toLowerCase()) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return PIANO_COLORS[hash % PIANO_COLORS.length];
}

export function parsePianoSay(input: string) {
  const text = input.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, PIANO_SAY_MAX_CHARS);
}

export function commandTime(value: string) {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

export type PianoHouseAgent = {
  handle: string;
  name: string;
  color: string;
  intervalMs: number;
  phaseMs: number;
};

export const PIANO_HOUSE_AGENTS: PianoHouseAgent[] = [
  { handle: "ivory", name: "Ivory", color: "#fff36b", intervalMs: 1600, phaseMs: 0 },
  { handle: "hammer", name: "Hammer", color: "#ff925c", intervalMs: 1900, phaseMs: 650 },
  { handle: "felt", name: "Felt", color: "#9d72ff", intervalMs: 2100, phaseMs: 1250 },
  { handle: "pedal", name: "Pedal", color: "#65f6ff", intervalMs: 2300, phaseMs: 1850 },
];

export function pianoHouseQuota(liveCount: number) {
  return Math.max(0, Math.min(PIANO_HOUSE_AGENTS.length, PIANO_MAX_AGENTS - liveCount));
}

export type PianoHouseSeat = PianoHouseAgent & { note: string; midi: number };

export type PianoPlay = {
  id: string;
  note: string;
  midi: number;
  handle: string;
  name: string;
  color: string;
  velocity: number;
  played_at: string;
};

export function assignHouseSeats(takenNotes: Iterable<string>, now = 0): PianoHouseSeat[] {
  const taken = new Set(takenNotes);
  const used = new Set<string>();
  const seats: PianoHouseSeat[] = [];
  const quota = pianoHouseQuota(taken.size);
  for (const [index, agent] of PIANO_HOUSE_AGENTS.entries()) {
    if (seats.length >= quota) break;
    const free = pianoKeys().filter((key) => !taken.has(key.note) && !used.has(key.note));
    if (!free.length) break;
    const beat = Math.max(0, Math.floor((now - agent.phaseMs) / agent.intervalMs));
    const key = free[(index * 5 + beat * 3) % free.length];
    used.add(key.note);
    seats.push({ ...agent, note: key.note, midi: key.midi });
  }
  return seats;
}

export function assignChartSeats(takenNotes: Iterable<string>, notes: Iterable<string>, pulseMs: number, originMs: number): PianoHouseSeat[] {
  const taken = new Set(takenNotes);
  const free: string[] = [];
  const seen = new Set<string>();
  for (const raw of notes) {
    const parsed = parsePianoNote(raw);
    if (!parsed || taken.has(parsed.note) || seen.has(parsed.note)) continue;
    seen.add(parsed.note);
    free.push(parsed.note);
  }
  const seats: PianoHouseSeat[] = [];
  const quota = pianoHouseQuota(taken.size);
  for (const [index, agent] of PIANO_HOUSE_AGENTS.entries()) {
    if (seats.length >= quota) break;
    const note = free[index];
    if (!note) break;
    const key = parsePianoNote(note);
    if (!key) continue;
    seats.push({ ...agent, note: key.note, midi: key.midi, intervalMs: pulseMs, phaseMs: originMs });
  }
  return seats;
}

export function houseLastPlayAt(now: number, seat: PianoHouseSeat) {
  const beat = seat.phaseMs + Math.floor((now - seat.phaseMs) / seat.intervalMs) * seat.intervalMs;
  return new Date(beat).toISOString();
}

export function housePianoPlays(now: number, takenNotes: Iterable<string>, windowMs: number): PianoPlay[] {
  const taken = [...takenNotes];
  const start = now - windowMs;
  const plays: PianoPlay[] = [];
  for (const agent of PIANO_HOUSE_AGENTS) {
    const first = agent.phaseMs + Math.ceil((start - agent.phaseMs) / agent.intervalMs) * agent.intervalMs;
    for (let t = first; t <= now; t += agent.intervalMs) {
      if (t < start) continue;
      const seat = assignHouseSeats(taken, t).find((row) => row.handle === agent.handle);
      if (!seat) continue;
      plays.push({
        id: `house-${seat.handle}-${t}`,
        note: seat.note,
        midi: seat.midi,
        handle: seat.handle,
        name: seat.name,
        color: seat.color,
        velocity: 0.52,
        played_at: new Date(t).toISOString(),
      });
    }
  }
  return plays.sort((a, b) => a.played_at.localeCompare(b.played_at) || a.handle.localeCompare(b.handle));
}

export function nextAgentBeat(now: number, phaseMs: number, intervalMs: number) {
  return phaseMs + Math.floor((now - phaseMs) / intervalMs) * intervalMs + intervalMs;
}

export function nextHouseBeat(now: number) {
  return Math.min(...PIANO_HOUSE_AGENTS.map((agent) => nextAgentBeat(now, agent.phaseMs, agent.intervalMs)));
}

export function togetherCluster(plays: PianoPlay[], now: number, windowMs = PIANO_ENSEMBLE_WINDOW_MS) {
  const recent = plays.filter((play) => {
    const at = commandTime(play.played_at);
    return Number.isFinite(at) && now - at <= windowMs && now - at >= 0;
  });
  const byHandle = new Map<string, PianoPlay>();
  for (const play of recent) byHandle.set(play.handle, play);
  const voices = [...byHandle.values()];
  return {
    size: voices.length,
    notes: voices.map((play) => play.note).sort(),
    handles: voices.map((play) => play.handle),
  };
}

export function playedTogether(plays: PianoPlay[], handle: string, at: number, windowMs = PIANO_ENSEMBLE_WINDOW_MS) {
  return plays.some((play) => {
    if (play.handle === handle) return false;
    const t = commandTime(play.played_at);
    return Number.isFinite(t) && Math.abs(t - at) <= windowMs;
  });
}

export type PianoOccupant = {
  handle: string;
  name: string;
  color: string;
  note: string;
  black: boolean;
  whiteIndex: number;
  last_play_at: string | null;
};

export type PianoToken = {
  handle: string;
  name: string;
  color: string;
  note: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  playing: boolean;
};

export type PianoTokenWorld = { tokens: PianoToken[] };

export function pianoHandleHash(handle: string) {
  let hash = 0;
  for (const char of handle) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return hash;
}

export function pianoKeyAnchor(key: { black: boolean; whiteIndex: number }) {
  const top = 10;
  const bottom = 84;
  const whites = pianoKeys().filter((row) => !row.black).length;
  const height = (bottom - top) / whites;
  return {
    x: key.black ? 70 : 34,
    y: bottom - (key.whiteIndex + 0.5) * height,
  };
}

function spawnPianoToken(occupant: PianoOccupant): PianoToken {
  const seed = pianoHandleHash(occupant.handle);
  return {
    handle: occupant.handle,
    name: occupant.name,
    color: occupant.color,
    note: occupant.note,
    x: 12 + (seed % 76),
    y: 16 + ((seed >> 5) % 58),
    vx: ((seed % 9) - 4) * 1.1 || 0.9,
    vy: (((seed >> 3) % 9) - 4) * 1.1 || -0.8,
    playing: false,
  };
}

export function advancePianoTokens(world: PianoTokenWorld, occupants: PianoOccupant[], elapsedSeconds: number, now: number): PianoTokenWorld {
  const present = new Map(occupants.map((occupant) => [occupant.handle, occupant]));
  const tokens = world.tokens.filter((token) => present.has(token.handle)).map((token) => ({ ...token }));
  for (const occupant of occupants) {
    if (tokens.some((token) => token.handle === occupant.handle)) continue;
    tokens.push(spawnPianoToken(occupant));
  }
  let left = Math.min(Math.max(elapsedSeconds, 0), 8);
  while (left > 0) {
    const dt = Math.min(0.05, left);
    left -= dt;
    const simTime = now - left * 1000;
    for (const token of tokens) {
      const occupant = present.get(token.handle);
      if (!occupant) continue;
      token.name = occupant.name;
      token.color = occupant.color;
      token.note = occupant.note;
      const playing = Boolean(occupant.last_play_at && simTime - commandTime(occupant.last_play_at) < 500);
      token.playing = playing;
      const anchor = pianoKeyAnchor(occupant);
      const seed = pianoHandleHash(token.handle);
      if (playing) {
        token.vx += (anchor.x - token.x) * dt * 9;
        token.vy += (anchor.y - token.y) * dt * 9;
        token.vx *= 0.82;
        token.vy *= 0.82;
      } else {
        token.vx += Math.sin(simTime * 0.0017 + seed) * 12 * dt;
        token.vy += Math.cos(simTime * 0.0013 + seed * 0.7) * 12 * dt;
        token.vx *= 0.996;
        token.vy *= 0.996;
      }
      token.x += token.vx * dt * 18;
      token.y += token.vy * dt * 18;
      if (token.x < 8) { token.x = 8; token.vx = Math.abs(token.vx); }
      if (token.x > 92) { token.x = 92; token.vx = -Math.abs(token.vx); }
      if (token.y < 12) { token.y = 12; token.vy = Math.abs(token.vy); }
      if (token.y > 78) { token.y = 78; token.vy = -Math.abs(token.vy); }
    }
  }
  return { tokens };
}
