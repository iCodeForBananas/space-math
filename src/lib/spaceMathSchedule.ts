// What Space Math asks next. Three layers:
//
// 1. Learning a skill: a question-count ladder (INTERVAL_STEPS). A right
//    answer moves the skill up the ladder, a miss knocks it down two rungs,
//    so a skill being learned comes back every few questions and then less
//    often as it firms up.
//
// 2. Mastering a skill takes all of: climbing to LEARNED_INTERVAL, right
//    answers on at least MASTERY_DAYS different days, and at least
//    MASTERY_ACCURACY over the last RECENT_WINDOW answers. A skill can't be
//    mastered in one sitting. Once mastered, reviews are spaced by calendar
//    days (REVIEW_DAYS: tomorrow, then 3 days, a week, ...) instead of by
//    questions, so a skill is checked again after real time has passed.
//    Missing a mastered skill brings its review forward; missing it
//    DEMOTE_AFTER_MISSES times in a row sends it back to practicing.
//    Mastered skills plus the next few unmastered ones are "unlocked".
//
// 3. Within a round, momentum: the number of questions in a row answered
//    right. Each question gets one answer. It starts at zero every round and
//    drops back to zero on any miss. Momentum decides how hard the next
//    question is allowed to be:
//
//      momentum 0-1   review only: skills already learned, the solid ones first
//      momentum 2-3   plus skills already being practiced
//      momentum 4+    plus brand-new skills
//
//    and once stretch material is allowed, its share of the questions grows
//    with each further correct answer. So every round warms up on things the
//    learner can do and climbs toward new material, and a miss pulls them back
//    to solid ground for a couple of questions before feeding the harder
//    material back in.
//
// Functions that depend on the date take `now` (epoch ms) so tests and
// simulations can move the clock.

import { type ProblemType, SKILLS } from "./spaceMathSkills";

export interface TopicRecord {
  correct: number;
  attempts: number;
  streak: number; // consecutive correct answers
  interval: number; // while learning: questions to wait before this topic comes back
  dueIn: number; // while learning: countdown to next appearance
  learned: boolean; // mastered right now (can be lost, see DEMOTE_AFTER_MISSES)
  recent: boolean[]; // last RECENT_WINDOW answers, oldest first
  correctDays: string[]; // distinct days ("YYYY-MM-DD", local) with a right answer while learning
  lastDay: string; // day this topic was last answered
  reviewStage: number; // once learned: index into REVIEW_DAYS
  reviewDueAt: number; // once learned: epoch ms when the next review is due
  missesInRow: number; // once learned: consecutive misses
}

export interface TopicDef {
  key: string;
  type: ProblemType;
  min: number;
  max: number;
}

// While learning, how many questions until a topic comes back. High rungs
// let a firming-up skill fade back within a session.
export const INTERVAL_STEPS = [1, 2, 4, 8, 16, 32, 60];

// The learning-ladder rung a topic must reach (three right in a row from a
// fresh start) before it can count as mastered.
export const LEARNED_INTERVAL = 8;

// Mastery also needs right answers on this many different days...
export const MASTERY_DAYS = 2;

// ...and this accuracy over the last RECENT_WINDOW answers (at least
// MIN_RECENT of them).
export const MASTERY_ACCURACY = 0.8;
export const RECENT_WINDOW = 10;
export const MIN_RECENT = 5;

// Once mastered, days until each review. A right answer on a due review
// moves one step along; a miss steps back.
export const REVIEW_DAYS = [1, 3, 7, 14, 30, 60];

// Misses in a row on a mastered skill that send it back to practicing.
export const DEMOTE_AFTER_MISSES = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// How many not-yet-learned topics may be unlocked at once. New material is
// only handed out when the learner is under this many, which keeps the
// progression linear instead of dumping the whole syllabus in at once.
export const LEARNING_CAP = 3;

// Momentum needed before skills still being practiced come back into the mix.
export const PRACTICE_MOMENTUM = 2;

// Momentum needed before a brand-new skill is introduced.
export const NEW_TOPIC_MOMENTUM = 4;

// One linear ladder of skills, easiest first, derived from SKILLS.
export const TOPIC_PROGRESSION: TopicDef[] = SKILLS.map(({ key, type, min, max }) => ({ key, type, min, max }));

export const DEFAULT_RECORD: TopicRecord = {
  correct: 0,
  attempts: 0,
  streak: 0,
  interval: 1,
  dueIn: 0,
  learned: false,
  recent: [],
  correctDays: [],
  lastDay: "",
  reviewStage: 0,
  reviewDueAt: 0,
  missesInRow: 0,
};

// Local calendar day, so "tomorrow" means after the learner's midnight.
export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Midnight starting the day `days` after today: a review due "in 1 day" is
// due from the start of tomorrow, whatever time it was answered today.
function daysFromToday(now: number, days: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

// Fill in fields older saves didn't have, and drop keys no longer on the ladder
export function normalizeRecords(raw: unknown): Record<string, TopicRecord> {
  const out: Record<string, TopicRecord> = {};
  if (!raw || typeof raw !== "object") return out;
  const saved = raw as Record<string, Partial<TopicRecord>>;
  for (const t of TOPIC_PROGRESSION) {
    const r = saved[t.key];
    if (!r) continue;
    const interval = typeof r.interval === "number" ? r.interval : 1;
    out[t.key] = {
      correct: r.correct ?? 0,
      attempts: r.attempts ?? 0,
      streak: r.streak ?? 0,
      interval,
      dueIn: r.dueIn ?? 0,
      learned: r.learned ?? interval >= LEARNED_INTERVAL,
      recent: Array.isArray(r.recent) ? r.recent.slice(-RECENT_WINDOW) : [],
      correctDays: Array.isArray(r.correctDays) ? r.correctDays : [],
      lastDay: r.lastDay ?? "",
      reviewStage: r.reviewStage ?? 0,
      // Saves from before calendar reviews: a mastered skill is due now, so
      // the first review checks that the older, easier mastery still holds.
      reviewDueAt: r.reviewDueAt ?? 0,
      missesInRow: r.missesInRow ?? 0,
    };
  }
  return out;
}

function stepUp(interval: number): number {
  return INTERVAL_STEPS.find((s) => s > interval) ?? INTERVAL_STEPS[INTERVAL_STEPS.length - 1];
}

// A miss drops the topic two rungs rather than all the way back, so one slip
// on a solid skill turns into a check-in, not a drill
function stepDown(interval: number): number {
  const idx = INTERVAL_STEPS.findIndex((s) => s >= interval);
  const from = idx === -1 ? INTERVAL_STEPS.length - 1 : idx;
  return INTERVAL_STEPS[Math.max(0, from - 2)];
}

// Climbed the learning ladder but not yet confirmed on a second day.
export function awaitingConfirmation(r: TopicRecord | undefined): boolean {
  return !!r && !r.learned && r.interval >= LEARNED_INTERVAL;
}

// Everything the learner has reached so far: all learned topics plus the next
// few still being learned. Up to LEARNING_CAP topics that are only waiting
// for their second-day check don't hold a learning slot, so a strong first
// day keeps opening new material instead of cycling the same three skills.
export function unlockedTopics(records: Record<string, TopicRecord>): TopicDef[] {
  const out: TopicDef[] = [];
  let learning = 0;
  let waiting = 0;
  for (const t of TOPIC_PROGRESSION) {
    out.push(t);
    const r = records[t.key];
    if (r?.learned) continue;
    if (awaitingConfirmation(r) && waiting < LEARNING_CAP) {
      waiting++;
      continue;
    }
    learning++;
    if (learning >= LEARNING_CAP) break;
  }
  return out;
}

// 0 = learned (review), 1 = being practiced, 2 = never tried
export function topicTier(records: Record<string, TopicRecord>, key: string): 0 | 1 | 2 {
  const r = records[key];
  if (r?.learned) return 0;
  return (r?.attempts ?? 0) > 0 ? 1 : 2;
}

// Hardest tier the current momentum allows
export function maxTierFor(momentum: number): 0 | 1 | 2 {
  if (momentum >= NEW_TOPIC_MOMENTUM) return 2;
  if (momentum >= PRACTICE_MOMENTUM) return 1;
  return 0;
}

// Chance the next question is stretch material (practiced or new) rather than
// review, once stretch material is allowed at all. Climbs with each correct
// answer in a row: 35% at the threshold, up to 80%.
export function stretchShare(momentum: number): number {
  if (momentum < PRACTICE_MOMENTUM) return 0;
  return Math.min(0.8, 0.35 + 0.1 * (momentum - PRACTICE_MOMENTUM));
}

function accuracyOf(r: TopicRecord): number {
  return r.attempts > 0 ? r.correct / r.attempts : 0.5;
}

function weightedPick<T>(items: T[], weights: number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = rng() * total;
  for (let i = 0; i < items.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Whether a topic is up for another look: a mastered one when its calendar
// review is due, one being learned when its question countdown has run out
// or it hasn't been seen yet today.
export function isDue(r: TopicRecord, now: number): boolean {
  if (r.learned) return now >= r.reviewDueAt;
  return r.dueIn <= 0 || r.lastDay !== dayKey(now);
}

// How far past due, as a weight: 1 exactly at due, more the longer overdue.
function ripenessOf(r: TopicRecord, now: number): number {
  if (r.learned) {
    const span = REVIEW_DAYS[Math.min(r.reviewStage, REVIEW_DAYS.length - 1)] * DAY_MS;
    return 1 + (now - r.reviewDueAt) / span;
  }
  if (r.lastDay && r.lastDay !== dayKey(now)) return 1.5;
  const interval = Math.max(r.interval, 1);
  return (interval - r.dueIn) / interval;
}

// Spaced-repetition pick: due topics first, weighted toward overdue, shaky and
// brand-new ones
function pickBySchedule(
  candidates: TopicDef[],
  records: Record<string, TopicRecord>,
  lastKey: string | null,
  rng: () => number,
  now: number,
): TopicDef {
  const due = candidates.filter((t) => isDue(records[t.key] ?? DEFAULT_RECORD, now));
  const pool = due.length > 0 ? due : candidates;
  const weights = pool.map((t) => {
    const r = records[t.key] ?? DEFAULT_RECORD;
    const need = 1.5 - accuracyOf(r); // shaky topics get a bigger share
    const fresh = r.attempts === 0 ? 2 : 1;
    const repeat = t.key === lastKey ? 0.15 : 1; // avoid back-to-back repeats
    return Math.max(ripenessOf(r, now), 0.02) ** 2 * need * fresh * repeat;
  });
  return weightedPick(pool, weights, rng);
}

// Confidence pick, for warming up and recovering after a miss: favor the
// skills answered most reliably, and among those the more advanced ones, so
// the learner lands on solid ground that is still close to where they are.
function pickForConfidence(
  candidates: TopicDef[],
  records: Record<string, TopicRecord>,
  lastKey: string | null,
  rng: () => number,
): TopicDef {
  const weights = candidates.map((t, i) => {
    const r = records[t.key] ?? DEFAULT_RECORD;
    const accuracy = accuracyOf(r);
    const nearFrontier = 0.5 + (i + 1) / candidates.length; // ladder order, 0.5..1.5
    const repeat = t.key === lastKey ? 0.15 : 1;
    return Math.max(accuracy, 0.05) ** 3 * nearFrontier * repeat;
  });
  return weightedPick(candidates, weights, rng);
}

// Pick the next topic for a learner with this much momentum in the round.
export function selectTopic(
  records: Record<string, TopicRecord>,
  lastKey: string | null,
  momentum: number,
  rng: () => number = Math.random,
  now: number = Date.now(),
): TopicDef {
  const pool = unlockedTopics(records);
  const review = pool.filter((t) => topicTier(records, t.key) === 0);
  const maxTier = maxTierFor(momentum);
  const stretch = pool.filter((t) => {
    const tier = topicTier(records, t.key);
    return tier >= 1 && tier <= maxTier;
  });

  if (stretch.length > 0 && (review.length === 0 || rng() < stretchShare(momentum))) {
    return pickBySchedule(stretch, records, lastKey, rng, now);
  }
  if (review.length > 0) {
    return momentum < PRACTICE_MOMENTUM
      ? pickForConfidence(review, records, lastKey, rng)
      : pickBySchedule(review, records, lastKey, rng, now);
  }

  // Nothing learned yet and nothing stretch allowed: a first-time learner.
  // Stay on the easiest material available, preferring skills already tried.
  const practiced = pool.filter((t) => topicTier(records, t.key) === 1);
  if (practiced.length > 0) return pickBySchedule(practiced, records, lastKey, rng, now);
  return pool[0];
}

// Share right over the recent window, or null until there are enough answers.
export function accuracyOfRecent(r: TopicRecord): number | null {
  return r.recent.length >= MIN_RECENT ? r.recent.filter(Boolean).length / r.recent.length : null;
}

// Record one answer. While learning, the question ladder moves and mastery is
// checked; once mastered, the calendar review schedule moves instead.
export function advanceRecord(record: TopicRecord, correct: boolean, now: number = Date.now()): TopicRecord {
  const today = dayKey(now);
  const base: TopicRecord = {
    ...record,
    correct: record.correct + (correct ? 1 : 0),
    attempts: record.attempts + 1,
    streak: correct ? record.streak + 1 : 0,
    recent: [...record.recent, correct].slice(-RECENT_WINDOW),
    lastDay: today,
  };

  if (record.learned) {
    if (correct) {
      // Only a review that was actually due moves the schedule on; an early
      // warm-up question on a solid skill doesn't count as the review.
      if (!isDue(record, now)) return { ...base, missesInRow: 0 };
      const stage = Math.min(record.reviewStage + 1, REVIEW_DAYS.length - 1);
      return { ...base, missesInRow: 0, reviewStage: stage, reviewDueAt: daysFromToday(now, REVIEW_DAYS[stage]) };
    }
    const missesInRow = record.missesInRow + 1;
    if (missesInRow >= DEMOTE_AFTER_MISSES) {
      // Back to practicing: it has to be re-earned, on more than one day.
      return {
        ...base,
        learned: false,
        interval: INTERVAL_STEPS[0],
        dueIn: INTERVAL_STEPS[0],
        correctDays: [],
        reviewStage: 0,
        reviewDueAt: 0,
        missesInRow: 0,
      };
    }
    // One miss: due again right away, with shorter spacing after that.
    return { ...base, missesInRow, reviewStage: Math.max(0, record.reviewStage - 1), reviewDueAt: now };
  }

  const interval = correct ? stepUp(record.interval) : stepDown(record.interval);
  const correctDays =
    correct && !record.correctDays.includes(today) ? [...record.correctDays, today].slice(-MASTERY_DAYS) : record.correctDays;
  const next: TopicRecord = { ...base, interval, dueIn: interval, correctDays };
  const accuracy = accuracyOfRecent(next);
  const mastered =
    correct &&
    interval >= LEARNED_INTERVAL &&
    correctDays.length >= MASTERY_DAYS &&
    accuracy !== null &&
    accuracy >= MASTERY_ACCURACY;
  if (!mastered) return next;
  return { ...next, learned: true, reviewStage: 0, reviewDueAt: daysFromToday(now, REVIEW_DAYS[0]), missesInRow: 0 };
}

// Tick down dueIn for every topic except the one just answered
export function tickTopics(records: Record<string, TopicRecord>, exceptKey: string): Record<string, TopicRecord> {
  const out: Record<string, TopicRecord> = {};
  for (const [k, v] of Object.entries(records)) {
    out[k] = k === exceptKey ? v : { ...v, dueIn: Math.max(0, v.dueIn - 1) };
  }
  return out;
}

// Momentum after an answer: a correct answer adds one, a miss resets it.
export function nextMomentum(momentum: number, correct: boolean): number {
  return correct ? momentum + 1 : 0;
}
