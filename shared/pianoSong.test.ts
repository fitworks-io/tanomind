import { describe, expect, it } from "vitest";
import { assignChartSeats, pianoKeys, PIANO_ENSEMBLE_WINDOW_MS } from "./piano";
import {
  formatPianoSlot,
  houseChartPlays,
  parsePianoSongComment,
  pickActivePianoSong,
  pianoActiveSongUntil,
  pianoChartBarAt,
  pianoSlotStart,
  pianoSongLive,
  PIANO_SONG_SLOT_MS,
  songEnsembleWindow,
  type PianoSongProposal,
} from "./pianoSong";

function proposal(overrides: Partial<PianoSongProposal> & { body?: string }): PianoSongProposal {
  const body = overrides.body ?? "SONG: Night Wire | SLOT: 2026-09-15T12:20Z | CHART: Am A3+E4+C5 / F F3+A3+C5 | PULSE: 2000ms";
  const parsed = parsePianoSongComment(body, {
    messageId: overrides.messageId ?? "m1",
    handle: overrides.handle ?? "arcadekeeper",
    name: overrides.name ?? "ArcadeKeeper",
    rank: overrides.rank ?? 0,
    createdAt: overrides.createdAt ?? Date.parse("2026-09-15T12:21:00Z"),
  });
  if (!parsed) throw new Error("expected proposal");
  return { ...parsed, ...overrides };
}

describe("piano song comments", () => {
  it("parses a SONG line with slot, chart, and pulse", () => {
    const song = parsePianoSongComment(
      "SONG: Night Wire | SLOT: 2026-09-15T12:20Z | CHART: Am A3+E4+C5 / F F3+A3+C5 / C G3+C4+E4 | PULSE: 2000ms",
      { messageId: "tm-1", handle: "arcadekeeper", name: "ArcadeKeeper", rank: 12, createdAt: Date.parse("2026-09-15T12:21:00Z") },
    );
    expect(song?.title).toBe("Night Wire");
    expect(song?.slotAt).toBe(Date.parse("2026-09-15T12:20:00Z"));
    expect(song?.pulseMs).toBe(2000);
    expect(song?.chart).toEqual([
      { chord: "Am", notes: ["A3", "E4", "C5"] },
      { chord: "F", notes: ["F3", "A3", "C5"] },
      { chord: "C", notes: ["G3", "C4", "E4"] },
    ]);
  });

  it("accepts PROPOSE and SONG_START, and ignores protocol text that does not start with SONG", () => {
    const proposed = parsePianoSongComment(
      "PROPOSE: Drift | SONG_START: 2026-09-15T12:30:00Z | CHART: C4+E4 | PULSE: 800",
      { messageId: "tm-2", handle: "pip", name: "Pip", rank: 3, createdAt: Date.parse("2026-09-15T12:10:00Z") },
    );
    expect(proposed?.title).toBe("Drift");
    expect(proposed?.slotAt).toBe(Date.parse("2026-09-15T12:30:00Z"));
    expect(proposed?.pulseMs).toBe(800);
    expect(parsePianoSongComment(
      "Songs live in the comments.\n\nSONG: Night Wire | SLOT: 2026-09-15T12:20Z | CHART: Am A3+E4+C5 | PULSE: 2000ms",
      { messageId: "tm-protocol", handle: "arcadekeeper", name: "ArcadeKeeper", rank: 0, createdAt: Date.parse("2026-09-15T12:00:00Z") },
    )).toBeNull();
  });

  it("picks the latest started slot and keeps it when nothing newer has started", () => {
    const older = proposal({
      messageId: "old",
      createdAt: Date.parse("2026-09-15T12:00:00Z"),
      body: "SONG: Keep | SLOT: 2026-09-15T12:00Z | CHART: C4 | PULSE: 2000ms",
    });
    const newer = proposal({
      messageId: "new",
      rank: 1,
      createdAt: Date.parse("2026-09-15T12:11:00Z"),
      body: "SONG: Switch | SLOT: 2026-09-15T12:10Z | CHART: E4 | PULSE: 2000ms",
    });
    const queued = proposal({
      messageId: "queued",
      createdAt: Date.parse("2026-09-15T12:05:00Z"),
      body: "SONG: Later | SLOT: 2026-09-15T12:20Z | CHART: G4 | PULSE: 2000ms",
    });
    expect(pickActivePianoSong([older, newer, queued], Date.parse("2026-09-15T12:14:00Z"))?.title).toBe("Switch");
    expect(pickActivePianoSong([older], Date.parse("2026-09-15T12:18:00Z"))?.title).toBe("Keep");
    expect(pickActivePianoSong([queued], Date.parse("2026-09-15T12:14:00Z"))).toBeNull();
  });

  it("breaks a same-minute tie with proposer rank, not who may play notes", () => {
    const low = proposal({
      messageId: "low",
      handle: "low",
      rank: 2,
      createdAt: Date.parse("2026-09-15T12:20:40Z"),
      body: "SONG: Low | SLOT: 2026-09-15T12:20Z | CHART: C4 | PULSE: 2000ms",
    });
    const high = proposal({
      messageId: "high",
      handle: "high",
      rank: 40,
      createdAt: Date.parse("2026-09-15T12:20:10Z"),
      body: "SONG: High | SLOT: 2026-09-15T12:20Z | CHART: E4 | PULSE: 2000ms",
    });
    expect(pickActivePianoSong([low, high], Date.parse("2026-09-15T12:21:00Z"))?.title).toBe("High");
  });

  it("walks chart bars on the shared pulse and seats house on leftover notes", () => {
    const song = proposal({
      body: "SONG: Night Wire | SLOT: 2026-09-15T12:20Z | CHART: Am A3+E4+C5 / F F3+A3+C5 | PULSE: 2000ms",
    });
    const origin = song.slotAt;
    expect(pianoChartBarAt(song, origin).bar.chord).toBe("Am");
    expect(pianoChartBarAt(song, origin + 2000).bar.chord).toBe("F");
    const seats = assignChartSeats(["E4"], pianoChartBarAt(song, origin).bar.notes, song.pulseMs, origin);
    expect(seats.map((seat) => seat.note)).toEqual(["A3", "C5"]);
    expect(seats[0]?.intervalMs).toBe(2000);
    const crowded = assignChartSeats(
      pianoKeys().filter((key) => !key.black).slice(0, 9).map((key) => key.note),
      pianoChartBarAt(song, origin).bar.notes,
      song.pulseMs,
      origin,
    );
    expect(crowded).toHaveLength(1);
    const plays = houseChartPlays(origin + 100, [], song, 500);
    expect(plays.map((play) => play.note).sort()).toEqual(["A3", "C5", "E4"]);
    expect(plays.every((play) => play.played_at === new Date(origin).toISOString())).toBe(true);
  });

  it("widens the ensemble window with pulse and names the 10 minute flip", () => {
    expect(songEnsembleWindow(2000)).toBe(700);
    expect(songEnsembleWindow(400)).toBe(PIANO_ENSEMBLE_WINDOW_MS);
    const now = Date.parse("2026-09-15T12:24:00Z");
    expect(pianoSlotStart(now)).toBe(Date.parse("2026-09-15T12:20:00Z"));
    expect(pianoActiveSongUntil(now)).toBe(Date.parse("2026-09-15T12:20:00Z") + PIANO_SONG_SLOT_MS);
    expect(formatPianoSlot(now)).toBe("2026-09-15T12:20:00Z");
    const live = pianoSongLive(now, [], proposal({}));
    expect(live.ensembleWindow).toBe(700);
    expect(live.nextBeat).toBeGreaterThan(now);
  });
});
