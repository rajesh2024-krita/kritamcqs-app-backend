import { DailyTestSettings, LearningSession, SessionAttempt } from "@api/db";

export type PerformanceTier = "low" | "medium" | "high" | "mixed";

export type DifficultyRatio = {
  easy: number;
  moderate: number;
  hard: number;
};

export type AdaptiveTestConfig = {
  adaptiveModeEnabled: boolean;
  repeatLookbackSessions: number;
  maxRepeatedQuestions: number;
  lowRatio: DifficultyRatio;
  mediumRatio: DifficultyRatio;
  highRatio: DifficultyRatio;
  mixedRatio: DifficultyRatio;
};

const DEFAULT_ADAPTIVE_CONFIG: AdaptiveTestConfig = {
  adaptiveModeEnabled: true,
  repeatLookbackSessions: 5,
  maxRepeatedQuestions: 2,
  lowRatio: { easy: 70, moderate: 20, hard: 10 },
  mediumRatio: { easy: 40, moderate: 40, hard: 20 },
  highRatio: { easy: 15, moderate: 45, hard: 40 },
  mixedRatio: { easy: 34, moderate: 33, hard: 33 },
};

export function detectDifficultyBucket(question: any): "easy" | "moderate" | "hard" | "other" {
  const raw = String(question?.difficulty || question?.difficultyLevel || "").toLowerCase();
  if (raw.includes("easy")) return "easy";
  if (raw.includes("hard")) return "hard";
  if (raw.includes("moderate") || raw.includes("medium")) return "moderate";
  return "other";
}

export function shuffleList<T>(list: T[]) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
}

function normalizeRatio(raw: any, fallback: DifficultyRatio): DifficultyRatio {
  const easy = Number(raw?.easy ?? fallback.easy);
  const moderate = Number(raw?.moderate ?? fallback.moderate);
  const hard = Number(raw?.hard ?? fallback.hard);
  const total = easy + moderate + hard;
  if (total <= 0) return fallback;
  return {
    easy: Math.round((easy / total) * 100),
    moderate: Math.round((moderate / total) * 100),
    hard: Math.max(0, 100 - Math.round((easy / total) * 100) - Math.round((moderate / total) * 100)),
  };
}

export async function getAdaptiveTestConfig(): Promise<AdaptiveTestConfig> {
  const settings = await DailyTestSettings.findOne({});
  if (!settings) return DEFAULT_ADAPTIVE_CONFIG;

  return {
    adaptiveModeEnabled: settings.adaptiveModeEnabled !== false,
    repeatLookbackSessions: Math.max(1, Number(settings.repeatLookbackSessions ?? DEFAULT_ADAPTIVE_CONFIG.repeatLookbackSessions)),
    maxRepeatedQuestions: Math.max(0, Number(settings.maxRepeatedQuestions ?? DEFAULT_ADAPTIVE_CONFIG.maxRepeatedQuestions)),
    lowRatio: normalizeRatio(settings.lowPerformanceRatio, DEFAULT_ADAPTIVE_CONFIG.lowRatio),
    mediumRatio: normalizeRatio(settings.mediumPerformanceRatio, DEFAULT_ADAPTIVE_CONFIG.mediumRatio),
    highRatio: normalizeRatio(settings.highPerformanceRatio, DEFAULT_ADAPTIVE_CONFIG.highRatio),
    mixedRatio: normalizeRatio(settings.mixedModeRatio, DEFAULT_ADAPTIVE_CONFIG.mixedRatio),
  };
}

export async function evaluateUserPerformanceTier(userId: string): Promise<{
  tier: PerformanceTier;
  accuracy: number;
  trend: number;
  averageSecondsPerQuestion: number;
}> {
  const attempts = await SessionAttempt.find({ userId, completedAt: { $ne: null } })
    .sort({ createdAt: -1 })
    .limit(20)
    .select("accuracy timeTaken totalQuestions");

  if (!attempts.length) {
    return {
      tier: "mixed",
      accuracy: 0,
      trend: 0,
      averageSecondsPerQuestion: 0,
    };
  }

  const withAccuracy = attempts
    .map((item: any) => Number(item?.accuracy ?? 0))
    .filter((value) => Number.isFinite(value));
  const accuracy = withAccuracy.length
    ? withAccuracy.reduce((sum, value) => sum + value, 0) / withAccuracy.length
    : 0;

  const recent = withAccuracy.slice(0, 5);
  const previous = withAccuracy.slice(5, 10);
  const recentAvg = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : accuracy;
  const previousAvg = previous.length ? previous.reduce((sum, value) => sum + value, 0) / previous.length : recentAvg;
  const trend = recentAvg - previousAvg;

  const timingValues = attempts
    .map((item: any) => {
      const totalQuestions = Number(item?.totalQuestions ?? 0);
      const timeTaken = Number(item?.timeTaken ?? 0);
      if (!totalQuestions || totalQuestions <= 0 || !Number.isFinite(timeTaken)) return null;
      return Math.max(0, timeTaken / totalQuestions);
    })
    .filter((value: number | null): value is number => value !== null);
  const averageSecondsPerQuestion = timingValues.length
    ? timingValues.reduce((sum, value) => sum + value, 0) / timingValues.length
    : 0;

  let tier: PerformanceTier = "medium";
  if (accuracy < 45 || trend <= -8 || (averageSecondsPerQuestion > 120 && accuracy < 55)) {
    tier = "low";
  } else if (accuracy >= 75 && trend >= -3) {
    tier = "high";
  }

  return {
    tier,
    accuracy,
    trend,
    averageSecondsPerQuestion,
  };
}

export function getAdaptiveRatio(config: AdaptiveTestConfig, tier: PerformanceTier): DifficultyRatio {
  if (!config.adaptiveModeEnabled) return config.mixedRatio;
  if (tier === "low") return config.lowRatio;
  if (tier === "high") return config.highRatio;
  if (tier === "medium") return config.mediumRatio;
  return config.mixedRatio;
}

function countTargets(total: number, ratio: DifficultyRatio) {
  const easy = Math.round((total * Number(ratio.easy || 0)) / 100);
  const moderate = Math.round((total * Number(ratio.moderate || 0)) / 100);
  const hard = Math.max(0, total - easy - moderate);
  return { easy, moderate, hard };
}

function takeUnique(
  targetList: any[],
  source: any[],
  count: number,
  selectedIds: Set<string>,
) {
  if (count <= 0 || source.length === 0) return;
  const shuffled = shuffleList(source);
  for (const item of shuffled) {
    const id = String(item?._id ?? item?.id ?? "");
    if (!id || selectedIds.has(id)) continue;
    targetList.push(item);
    selectedIds.add(id);
    if (targetList.length >= count) return;
  }
}

export function selectAdaptiveQuestionSet({
  questions,
  total,
  ratio,
  recentQuestionIds,
  maxRepeatedQuestions,
}: {
  questions: any[];
  total: number;
  ratio: DifficultyRatio;
  recentQuestionIds?: Set<string>;
  maxRepeatedQuestions?: number;
}) {
  const cleanQuestions = questions.filter(Boolean);
  if (!cleanQuestions.length || total <= 0) return [];

  const targets = countTargets(total, ratio);
  const selected: any[] = [];
  const selectedIds = new Set<string>();

  const buckets = {
    easy: [] as any[],
    moderate: [] as any[],
    hard: [] as any[],
    other: [] as any[],
  };

  cleanQuestions.forEach((question) => {
    buckets[detectDifficultyBucket(question)].push(question);
  });

  const recent = recentQuestionIds ?? new Set<string>();
  const nonRepeatBucket = {
    easy: buckets.easy.filter((item) => !recent.has(String(item?._id ?? item?.id ?? ""))),
    moderate: buckets.moderate.filter((item) => !recent.has(String(item?._id ?? item?.id ?? ""))),
    hard: buckets.hard.filter((item) => !recent.has(String(item?._id ?? item?.id ?? ""))),
    other: buckets.other.filter((item) => !recent.has(String(item?._id ?? item?.id ?? ""))),
  };

  takeUnique(selected, nonRepeatBucket.easy, targets.easy, selectedIds);
  takeUnique(selected, nonRepeatBucket.moderate, targets.moderate, selectedIds);
  takeUnique(selected, nonRepeatBucket.hard, targets.hard, selectedIds);

  if (selected.length < total) {
    const fallbackNonRepeat = [
      ...nonRepeatBucket.easy,
      ...nonRepeatBucket.moderate,
      ...nonRepeatBucket.hard,
      ...nonRepeatBucket.other,
    ];
    takeUnique(selected, fallbackNonRepeat, total, selectedIds);
  }

  const repeatBudget = Math.max(0, Number(maxRepeatedQuestions ?? Number.POSITIVE_INFINITY));
  if (selected.length < total && repeatBudget > 0) {
    const repeatPool = cleanQuestions.filter((item) => recent.has(String(item?._id ?? item?.id ?? "")));
    const repeatSelection: any[] = [];
    takeUnique(repeatSelection, repeatPool, repeatBudget, selectedIds);
    for (const item of repeatSelection) {
      if (selected.length >= total) break;
      selected.push(item);
    }
  }

  if (selected.length < total) {
    takeUnique(selected, cleanQuestions, total, selectedIds);
  }

  return selected.slice(0, total);
}

export async function getRecentSessionQuestionIds({
  userId,
  origin,
  sourceSessionId,
  lookback,
}: {
  userId: string;
  origin?: string;
  sourceSessionId?: string;
  lookback: number;
}) {
  const filter: Record<string, unknown> = { userId };
  if (origin) filter.origin = origin;
  if (sourceSessionId) filter.sourceSessionId = sourceSessionId;

  const sessions = await LearningSession.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.max(1, lookback))
    .select("questionIds");

  const recentSet = new Set<string>();
  const sequences: string[][] = [];
  sessions.forEach((session: any) => {
    const ids = Array.isArray(session?.questionIds) ? session.questionIds.map(String).filter(Boolean) : [];
    if (!ids.length) return;
    sequences.push(ids);
    ids.forEach((id) => recentSet.add(id));
  });

  return { recentSet, sequences };
}

function isSameSequence(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function avoidRecentSequences(questionIds: string[], recentSequences: string[][]) {
  if (questionIds.length <= 1 || !recentSequences.length) return questionIds;
  let candidate = [...questionIds];
  let attempts = 0;
  while (attempts < 6 && recentSequences.some((sequence) => isSameSequence(candidate, sequence))) {
    candidate = shuffleList(candidate);
    attempts += 1;
  }
  return candidate;
}
