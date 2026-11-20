import { describe, it, expect } from "vitest";
import {
  type TopicRecord,
  DEFAULT_RECORD,
  DEMOTE_AFTER_MISSES,
  NEW_TOPIC_MOMENTUM,
  PRACTICE_MOMENTUM,
  TOPIC_PROGRESSION,
  advanceRecord,
  dayKey,
  isDue,
  maxTierFor,
  nextMomentum,
  normalizeRecords,
  selectTopic,
  stretchShare,
  tickTopics,
  topicTier,
  unlockedTopics,
} from "./spaceMathSchedule";

// Deterministic PRNG so the simulations below are repeatable
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const learnedRecord: TopicRecord = { ...DEFAULT_RECORD, correct: 10, attempts: 10, streak: 10, interval: 16, learned: true };
const practicingRecord: TopicRecord = { ...DEFAULT_RECORD, correct: 1, attempts: 2, interval: 1 };

// Noon local time, day 0, and helpers to move the clock
const DAY0 = new Date(2026, 0, 5, 12, 0, 0).getTime();
const day = (n: number, hour = 12) => new Date(2026, 0, 5 + n, hour, 0, 0).getTime();

function answer(r: TopicRecord, results: boolean[], now: number): TopicRecord {
  return results.reduce((rec, c) => advanceRecord(rec, c, now), r);
}

// First ten topics learned, the next one being practiced, the one after untouched
function midwayRecords(): Record<string, TopicRecord> {
  const records: Record<string, TopicRecord> = {};
  TOPIC_PROGRESSION.slice(0, 10).forEach((t) => (records[t.key] = { ...learnedRecord }));
  records[TOPIC_PROGRESSION[10].key] = { ...practicingRecord };
  return records;
}

describe("momentum", () => {
  it("climbs by one per correct answer and resets on a miss", () => {
    expect(nextMomentum(0, true)).toBe(1);
    expect(nextMomentum(5, true)).toBe(6);
    expect(nextMomentum(5, false)).toBe(0);
  });

  it("unlocks harder tiers in order", () => {
    expect(maxTierFor(0)).toBe(0);
    expect(maxTierFor(PRACTICE_MOMENTUM - 1)).toBe(0);
    expect(maxTierFor(PRACTICE_MOMENTUM)).toBe(1);
    expect(maxTierFor(NEW_TOPIC_MOMENTUM)).toBe(2);
  });

  it("gives stretch material a growing, capped share", () => {
    expect(stretchShare(0)).toBe(0);
    let prev = 0;
    for (let m = PRACTICE_MOMENTUM; m < 20; m++) {
      expect(stretchShare(m)).toBeGreaterThanOrEqual(prev);
      expect(stretchShare(m)).toBeLessThanOrEqual(0.8);
      prev = stretchShare(m);
    }
  });
});

describe("selectTopic", () => {
  it("only asks review questions at the start of a round and right after a miss", () => {
    const records = midwayRecords();
    const rng = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      for (let m = 0; m < PRACTICE_MOMENTUM; m++) {
        const t = selectTopic(records, null, m, rng);
        expect(topicTier(records, t.key)).toBe(0);
      }
    }
  });

  it("never introduces a brand-new topic before NEW_TOPIC_MOMENTUM", () => {
    const records = midwayRecords();
    const rng = mulberry32(2);
    for (let i = 0; i < 500; i++) {
      for (let m = 0; m < NEW_TOPIC_MOMENTUM; m++) {
        const t = selectTopic(records, null, m, rng);
        expect(topicTier(records, t.key)).not.toBe(2);
      }
    }
  });

  it("asks more stretch questions the longer the streak", () => {
    const records = midwayRecords();
    const rng = mulberry32(3);
    const stretchRate = (m: number) => {
      let n = 0;
      for (let i = 0; i < 2000; i++) if (topicTier(records, selectTopic(records, null, m, rng).key) > 0) n++;
      return n / 2000;
    };
    const low = stretchRate(PRACTICE_MOMENTUM);
    const high = stretchRate(12);
    expect(low).toBeGreaterThan(0.2);
    expect(high).toBeGreaterThan(low + 0.25);
  });

  it("starts a first-time learner on the first topic", () => {
    expect(selectTopic({}, null, 0, mulberry32(4)).key).toBe(TOPIC_PROGRESSION[0].key);
  });

  it("keeps a first-time learner on what they've tried until momentum builds", () => {
    const records = { [TOPIC_PROGRESSION[0].key]: { ...practicingRecord } };
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      expect(selectTopic(records, null, 0, rng).key).toBe(TOPIC_PROGRESSION[0].key);
    }
  });
});

// A learner who almost always gets learned skills right, gets anything newer
// right 60% of the time at first and better with practice, playing one
// 25-correct round a day
describe("simulated rounds", () => {
  function play(seed: number) {
    const rng = mulberry32(seed);
    // One round a day

    let records: Record<string, TopicRecord> = {};
    let lastKey: string | null = null;
    const afterMiss: number[] = []; // tier of each question asked right after a miss
    const byPosition: number[][] = Array.from({ length: 25 }, () => []);
    const seen: Record<string, number> = {};

    for (let round = 0; round < 30; round++) {
      const now = day(round);
      let momentum = 0;
      let correctCount = 0;
      let asked = 0;
      let lastWasMiss = false;
      while (correctCount < 25 && asked < 200) {
        const topic = selectTopic(records, lastKey, momentum, rng, now);
        const tier = topicTier(records, topic.key);
        const anyLearned = Object.values(records).some((r) => r.learned);
        if (lastWasMiss && anyLearned) afterMiss.push(tier);
        if (asked < 25) byPosition[asked].push(tier > 0 ? 1 : 0);
        seen[topic.key] = (seen[topic.key] ?? 0) + 1;
        const correct = rng() < (tier === 0 ? 0.97 : Math.min(0.95, 0.6 + 0.05 * seen[topic.key]));
        const updated = advanceRecord(records[topic.key] ?? DEFAULT_RECORD, correct, now);
        records = tickTopics({ ...records, [topic.key]: updated }, topic.key);
        momentum = nextMomentum(momentum, correct);
        lastKey = topic.key;
        lastWasMiss = !correct;
        if (correct) correctCount++;
        asked++;
      }
    }
    return { records, afterMiss, byPosition };
  }

  it("follows a miss with a review question once anything is learned", () => {
    const { afterMiss } = play(11);
    expect(afterMiss.length).toBeGreaterThan(20);
    const stretchAfterMiss = afterMiss.filter((t) => t > 0).length / afterMiss.length;
    expect(stretchAfterMiss).toBeLessThan(0.05);
  });

  it("gets harder through a round: more stretch late than early", () => {
    const { byPosition } = play(12);
    const share = (rows: number[][]) => {
      const flat = rows.flat();
      return flat.reduce((a, b) => a + b, 0) / flat.length;
    };
    expect(share(byPosition.slice(15, 25))).toBeGreaterThan(share(byPosition.slice(0, 3)) + 0.2);
  });

  it("still makes progress up the ladder", () => {
    const { records } = play(13);
    const learned = Object.values(records).filter((r) => r.learned).length;
    expect(learned).toBeGreaterThan(10);
  });
});

describe("mastery", () => {
  it("can't be reached in one day, however many right answers", () => {
    const r = answer(DEFAULT_RECORD, Array(20).fill(true), DAY0);
    expect(r.learned).toBe(false);
    expect(r.interval).toBeGreaterThanOrEqual(8);
  });

  it("is reached on a second day once the skill has climbed the ladder", () => {
    let r = answer(DEFAULT_RECORD, [true, true, true, true], DAY0);
    expect(r.learned).toBe(false);
    r = advanceRecord(r, true, day(1));
    expect(r.learned).toBe(true);
  });

  it("needs 80% over the recent answers, not just a lucky streak", () => {
    // 4 right, 4 wrong on day 0, then three right on day 1: 7 of 11 recent... window is 10
    let r = answer(DEFAULT_RECORD, [true, false, true, false, true, false, true, false], DAY0);
    r = answer(r, [true, true, true], day(1));
    // recent window: [true,false,true,false,true,false,true,false,true,true] minus oldest -> 6/10
    expect(r.learned).toBe(false);
    r = answer(r, [true, true, true, true], day(1));
    expect(r.learned).toBe(true);
  });

  it("schedules the first review for tomorrow, then 3 days after that", () => {
    let r = answer(DEFAULT_RECORD, [true, true, true, true], DAY0);
    r = advanceRecord(r, true, day(1, 20));
    expect(r.learned).toBe(true);
    expect(isDue(r, day(1, 23))).toBe(false);
    expect(isDue(r, day(2, 0))).toBe(true);

    r = advanceRecord(r, true, day(2, 9));
    expect(r.reviewStage).toBe(1);
    expect(isDue(r, day(4, 23))).toBe(false);
    expect(isDue(r, day(5, 0))).toBe(true);
  });

  it("doesn't count a right answer before the review is due", () => {
    let r = answer(DEFAULT_RECORD, [true, true, true, true], DAY0);
    r = advanceRecord(r, true, day(1));
    const before = r.reviewDueAt;
    r = advanceRecord(r, true, day(1, 18));
    expect(r.reviewStage).toBe(0);
    expect(r.reviewDueAt).toBe(before);
  });

  it("brings a review forward after one miss and takes mastery back after two", () => {
    let r = answer(DEFAULT_RECORD, [true, true, true, true], DAY0);
    r = advanceRecord(r, true, day(1));
    r = advanceRecord(r, false, day(3));
    expect(r.learned).toBe(true);
    expect(isDue(r, day(3))).toBe(true);

    r = answer(r, Array(DEMOTE_AFTER_MISSES - 1).fill(false), day(3));
    expect(r.learned).toBe(false);
    expect(r.correctDays).toEqual([]);
    expect(topicTier({ k: r }, "k")).toBe(1);
  });

  it("a right answer between misses resets the demotion count", () => {
    let r = answer(DEFAULT_RECORD, [true, true, true, true], DAY0);
    r = advanceRecord(r, true, day(1));
    r = answer(r, [false, true, false], day(3));
    expect(r.learned).toBe(true);
  });
});

describe("unlockedTopics", () => {
  it("opens new skills on day one once earlier ones are only waiting for day two", () => {
    const ready = answer(DEFAULT_RECORD, [true, true, true], DAY0);
    const records: Record<string, TopicRecord> = {};
    TOPIC_PROGRESSION.slice(0, 3).forEach((t) => (records[t.key] = { ...ready }));
    expect(unlockedTopics(records).length).toBe(6);
  });

  it("still caps how many skills wait for confirmation at once", () => {
    const ready = answer(DEFAULT_RECORD, [true, true, true], DAY0);
    const records: Record<string, TopicRecord> = {};
    TOPIC_PROGRESSION.slice(0, 10).forEach((t) => (records[t.key] = { ...ready }));
    // 3 waiting don't count, the other 7 do and fill the 3 learning slots
    expect(unlockedTopics(records).length).toBe(6);
  });
});

describe("normalizeRecords", () => {
  it("keeps mastery from older saves but makes its review due now", () => {
    const key = TOPIC_PROGRESSION[0].key;
    const out = normalizeRecords({ [key]: { correct: 5, attempts: 5, streak: 5, interval: 16, dueIn: 3, learned: true } });
    expect(out[key].learned).toBe(true);
    expect(out[key].recent).toEqual([]);
    expect(isDue(out[key], DAY0)).toBe(true);
  });
});

describe("dayKey", () => {
  it("uses the local calendar day", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 0, 6, 0, 1).getTime())).toBe("2026-01-06");
  });
});
