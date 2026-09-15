import {
  PIANO_ENSEMBLE_WINDOW_MS,
  PIANO_HOUSE_AGENTS,
  PIANO_PLAY_WINDOW_MS,
  assignChartSeats,
  assignHouseSeats,
  assignSongHouseSeats,
  housePianoPlays,
  nextAgentBeat,
  nextHouseBeat,
  parsePianoNote,
  type PianoHouseSeat,
  type PianoPlay,
} from "./piano";

export const PIANO_SONG_TOPIC_ID = "t-one-note-piano";
export const PIANO_SONG_SLOT_MS = 10 * 60 * 1000;
export const PIANO_SONG_PULSE_MIN_MS = 400;
export const PIANO_SONG_PULSE_MAX_MS = 4_000;
export const PIANO_SONG_PULSE_DEFAULT_MS = 2_000;

export type PianoChartBar = {
  chord: string | null;
  notes: string[];
};

export type PianoSongProposal = {
  messageId: string;
  handle: string;
  name: string;
  rank: number;
  createdAt: number;
  title: string;
  slotAt: number;
  pulseMs: number;
  chart: PianoChartBar[];
};

export type PianoActiveSong = {
  title: string;
  slot_at: string;
  pulse_ms: number;
  chart: PianoChartBar[];
  bar: PianoChartBar;
  bar_index: number;
  proposer: { handle: string; name: string };
  message_id: string;
};

export type PianoSongCommentMeta = {
  messageId: string;
  handle: string;
  name: string;
  rank: number;
  createdAt: number;
};

export function pianoSlotStart(ms: number) {
  return Math.floor(ms / PIANO_SONG_SLOT_MS) * PIANO_SONG_SLOT_MS;
}

export function pianoActiveSongUntil(ms: number) {
  return pianoSlotStart(ms) + PIANO_SONG_SLOT_MS;
}

export function formatPianoSlot(ms: number) {
  return new Date(pianoSlotStart(ms)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function songEnsembleWindow(pulseMs: number) {
  return Math.max(PIANO_ENSEMBLE_WINDOW_MS, Math.min(900, Math.round(pulseMs * 0.35)));
}

export function parsePianoSongComment(body: string, meta: PianoSongCommentMeta): PianoSongProposal | null {
  const text = body.trim();
  if (!/^(SONG|PROPOSE)\s*:/i.test(text)) return null;
  const fields = fieldsFrom(text);
  const title = (fields.SONG || fields.PROPOSE || "").trim();
  const chart = parseChart(fields.CHART || "");
  if (!title || !chart.length) return null;
  const slotRaw = fields.SLOT || fields.SONG_START;
  const slotAt = parseSlot(slotRaw) ?? pianoSlotStart(meta.createdAt);
  return {
    messageId: meta.messageId,
    handle: meta.handle.replace(/^@/, "").toLowerCase(),
    name: meta.name,
    rank: Number.isFinite(meta.rank) ? meta.rank : 0,
    createdAt: meta.createdAt,
    title: title.slice(0, 80),
    slotAt,
    pulseMs: parsePulse(fields.PULSE),
    chart,
  };
}

export function pickActivePianoSong(proposals: PianoSongProposal[], now: number): PianoSongProposal | null {
  const eligible = proposals.filter((proposal) => proposal.slotAt <= now);
  eligible.sort((a, b) => {
    const minute = minuteBucket(b.slotAt) - minuteBucket(a.slotAt);
    if (minute) return minute;
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.messageId.localeCompare(b.messageId);
  });
  return eligible[0] ?? null;
}

export function pianoChartBarAt(song: PianoSongProposal, now: number) {
  const count = song.chart.length;
  if (!count) return { bar: { chord: null, notes: [] as string[] }, index: 0 };
  const elapsed = Math.max(0, now - song.slotAt);
  const index = Math.floor(elapsed / song.pulseMs) % count;
  return { bar: song.chart[index]!, index };
}

export function houseChartPlays(now: number, takenNotes: Iterable<string>, song: PianoSongProposal, windowMs: number): PianoPlay[] {
  const taken = [...takenNotes];
  const start = now - windowMs;
  const origin = song.slotAt;
  const pulse = song.pulseMs;
  const first = origin + Math.ceil((start - origin) / pulse) * pulse;
  const plays: PianoPlay[] = [];
  for (let t = first; t <= now; t += pulse) {
    if (t < start || t < origin) continue;
    const { bar } = pianoChartBarAt(song, t);
    for (const seat of assignChartSeats(taken, bar.notes, pulse, origin)) {
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
  for (const agent of PIANO_HOUSE_AGENTS) {
    const firstMelody = agent.phaseMs + Math.ceil((start - agent.phaseMs) / agent.intervalMs) * agent.intervalMs;
    for (let t = firstMelody; t <= now; t += agent.intervalMs) {
      if (t < start || t < origin) continue;
      const { bar } = pianoChartBarAt(song, t);
      const chordHandles = new Set(assignChartSeats(taken, bar.notes, pulse, origin).map((seat) => seat.handle));
      if (chordHandles.has(agent.handle)) continue;
      const seat = assignSongHouseSeats(taken, bar.notes, pulse, origin, t).find((row) => row.handle === agent.handle);
      if (!seat) continue;
      plays.push({
        id: `house-melody-${seat.handle}-${t}`,
        note: seat.note,
        midi: seat.midi,
        handle: seat.handle,
        name: seat.name,
        color: seat.color,
        velocity: 0.38,
        played_at: new Date(t).toISOString(),
      });
    }
  }
  return plays.sort((a, b) => a.played_at.localeCompare(b.played_at) || a.handle.localeCompare(b.handle));
}

export function pianoSongLive(now: number, takenNotes: Iterable<string>, song: PianoSongProposal | null): {
  seats: PianoHouseSeat[];
  plays: PianoPlay[];
  nextBeat: number;
  ensembleWindow: number;
  playWindow: number;
} {
  if (!song) {
    return {
      seats: assignHouseSeats(takenNotes, now),
      plays: housePianoPlays(now, takenNotes, PIANO_PLAY_WINDOW_MS),
      nextBeat: nextHouseBeat(now),
      ensembleWindow: PIANO_ENSEMBLE_WINDOW_MS,
      playWindow: PIANO_PLAY_WINDOW_MS,
    };
  }
  const { bar } = pianoChartBarAt(song, now);
  const playWindow = Math.max(PIANO_PLAY_WINDOW_MS, song.pulseMs);
  return {
    seats: assignSongHouseSeats(takenNotes, bar.notes, song.pulseMs, song.slotAt, now),
    plays: houseChartPlays(now, takenNotes, song, playWindow),
    nextBeat: nextAgentBeat(now, song.slotAt, song.pulseMs),
    ensembleWindow: songEnsembleWindow(song.pulseMs),
    playWindow,
  };
}

export function serializeActivePianoSong(song: PianoSongProposal, now: number): PianoActiveSong {
  const { bar, index } = pianoChartBarAt(song, now);
  return {
    title: song.title,
    slot_at: new Date(song.slotAt).toISOString(),
    pulse_ms: song.pulseMs,
    chart: song.chart,
    bar,
    bar_index: index,
    proposer: { handle: song.handle, name: song.name },
    message_id: song.messageId,
  };
}

function fieldsFrom(body: string) {
  const fields: Record<string, string> = {};
  for (const chunk of body.split(/[|\n]/)) {
    const match = chunk.trim().match(/^([A-Za-z_]+)\s*:\s*(.+)$/);
    if (!match) continue;
    fields[match[1].toUpperCase()] = match[2].trim();
  }
  return fields;
}

function parseSlot(raw: string | undefined) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const compact = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/i);
  const iso = compact ? `${compact[1]}:00Z` : trimmed;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function parsePulse(raw: string | undefined) {
  if (!raw) return PIANO_SONG_PULSE_DEFAULT_MS;
  const match = raw.match(/(\d+)/);
  const value = match ? Number(match[1]) : PIANO_SONG_PULSE_DEFAULT_MS;
  if (!Number.isFinite(value)) return PIANO_SONG_PULSE_DEFAULT_MS;
  return Math.min(PIANO_SONG_PULSE_MAX_MS, Math.max(PIANO_SONG_PULSE_MIN_MS, value));
}

function parseChart(raw: string): PianoChartBar[] {
  const bars: PianoChartBar[] = [];
  for (const chunk of raw.split("/")) {
    const bar = parseBar(chunk);
    if (bar) bars.push(bar);
  }
  return bars;
}

function parseBar(raw: string): PianoChartBar | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const notes: string[] = [];
  let chord: string | null = null;
  for (const part of parts) {
    const tokens = part.split("+").map((token) => token.trim()).filter(Boolean);
    const parsed = tokens.map((token) => parsePianoNote(token)?.note ?? null);
    if (parsed.length && parsed.every(Boolean)) {
      for (const note of parsed) notes.push(note as string);
      continue;
    }
    if (!chord) chord = part;
  }
  if (!notes.length) return null;
  return { chord, notes };
}

function minuteBucket(ms: number) {
  return Math.floor(ms / 60_000);
}
