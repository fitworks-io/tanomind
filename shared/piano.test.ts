import { describe, expect, it } from "vitest";
import { midiToNote, parsePianoNote, parsePianoSay, pianoKeys, assignHouseSeats, housePianoPlays, nextHouseBeat, playedTogether, togetherCluster, advancePianoTokens, PIANO_HIGH_MIDI, PIANO_LOW_MIDI, PIANO_HOUSE_AGENTS, PIANO_SAY_MAX_CHARS } from "./piano";

describe("piano notes", () => {
  it("covers a full piano, A0 through C8", () => {
    const keys = pianoKeys();
    expect(keys[0]?.note).toBe("A0");
    expect(keys.at(-1)?.note).toBe("C8");
    expect(keys).toHaveLength(88);
    expect(keys).toHaveLength(PIANO_HIGH_MIDI - PIANO_LOW_MIDI + 1);
    expect(keys.filter((key) => !key.black)).toHaveLength(52);
    expect(keys.filter((key) => key.black)).toHaveLength(36);
  });

  it("parses sharp, flat, and casual names", () => {
    expect(parsePianoNote("c4")?.note).toBe("C4");
    expect(parsePianoNote("F#3")?.note).toBe("F#3");
    expect(parsePianoNote("Bb4")?.note).toBe("A#4");
    expect(parsePianoNote("Cs4")?.note).toBe("C#4");
    expect(parsePianoNote("A0")?.note).toBe("A0");
    expect(parsePianoNote("C8")?.note).toBe("C8");
    expect(parsePianoNote("G0")).toBeNull();
    expect(parsePianoNote("C9")).toBeNull();
    expect(parsePianoNote("H4")).toBeNull();
  });

  it("round-trips midi to note names", () => {
    expect(midiToNote(60)).toBe("C4");
    expect(midiToNote(70)).toBe("A#4");
    expect(parsePianoNote("A#4")?.midi).toBe(70);
  });

  it("seats four house agents on free keys and yields taken notes", () => {
    const empty = assignHouseSeats([], 0);
    expect(empty).toHaveLength(4);
    expect(new Set(empty.map((seat) => seat.note)).size).toBe(4);
    expect(empty.map((seat) => seat.note).slice().sort().join()).not.toBe("C3,C4,E3,G3");
    expect(empty.map((seat) => seat.handle)).toEqual(PIANO_HOUSE_AGENTS.map((agent) => agent.handle));

    const moved = assignHouseSeats(["C3", "E3"], 0);
    expect(moved).toHaveLength(4);
    expect(moved.some((seat) => seat.note === "C3" || seat.note === "E3")).toBe(false);

    const full = assignHouseSeats(pianoKeys().map((key) => key.note), 0);
    expect(full).toHaveLength(0);
  });

  it("emits house plays only inside the listen window", () => {
    const now = 20_000;
    const plays = housePianoPlays(now, [], 2_500);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((play) => Date.parse(play.played_at) >= now - 2_500)).toBe(true);
    expect(plays.every((play) => Date.parse(play.played_at) <= now)).toBe(true);
  });

  it("has the house band hop notes on staggered clocks", () => {
    const first = assignHouseSeats([], 0).map((seat) => seat.note);
    const later = assignHouseSeats([], 8_000).map((seat) => seat.note);
    expect(first.join()).not.toBe(later.join());

    const plays = housePianoPlays(12_000, [], 8_000);
    const notes = new Set(plays.map((play) => play.note));
    const times = new Set(plays.map((play) => play.played_at));
    expect(notes.size).toBeGreaterThan(4);
    expect(times.size).toBe(plays.length);
    expect(plays.some((play) => play.note !== "C3" && play.note !== "E3" && play.note !== "G3" && play.note !== "C4")).toBe(true);
  });

  it("scores a strike only when another voice is in the window", () => {
    const now = 10_000;
    const plays = [
      { id: "a", note: "C3", midi: 48, handle: "ivory", name: "Ivory", color: "#fff", velocity: 0.5, played_at: new Date(now - 80).toISOString() },
    ];
    expect(playedTogether(plays, "pip", now)).toBe(true);
    expect(playedTogether(plays, "ivory", now)).toBe(false);
    expect(playedTogether(plays, "pip", now + 2_000)).toBe(false);
    expect(togetherCluster(plays, now).size).toBe(1);
    expect(togetherCluster([...plays, { ...plays[0], id: "b", handle: "pip", note: "G4", played_at: new Date(now).toISOString() }], now).size).toBe(2);
  });

  it("names the next house strike", () => {
    expect(nextHouseBeat(100)).toBe(650);
    expect(nextHouseBeat(650)).toBe(1250);
  });

  it("advances named tokens the same way for every spectator", () => {
    const occupants = assignHouseSeats([], 4_000).map((seat) => ({
      handle: seat.handle,
      name: seat.name,
      color: seat.color,
      note: seat.note,
      black: pianoKeys().find((key) => key.note === seat.note)?.black ?? false,
      whiteIndex: pianoKeys().find((key) => key.note === seat.note)?.whiteIndex ?? 0,
      last_play_at: null,
    }));
    const first = advancePianoTokens({ tokens: [] }, occupants, 1, 4_000);
    const again = advancePianoTokens({ tokens: [] }, occupants, 1, 4_000);
    expect(first.tokens).toHaveLength(4);
    expect(again.tokens).toEqual(first.tokens);
    const later = advancePianoTokens(first, occupants, 0.5, 4_500);
    expect(later.tokens.map((token) => token.handle)).toEqual(first.tokens.map((token) => token.handle));
    expect(later.tokens.some((token, index) => token.x !== first.tokens[index]?.x || token.y !== first.tokens[index]?.y)).toBe(true);
  });

  it("keeps live cues short and readable", () => {
    expect(parsePianoSay("  hit C4 with me  ")).toBe("hit C4 with me");
    expect(parsePianoSay("\nnow\t")).toBe("now");
    expect(parsePianoSay("   ")).toBeNull();
    expect(parsePianoSay("x".repeat(120))?.length).toBe(PIANO_SAY_MAX_CHARS);
  });
});
