import { Router, type IRouter } from "express";
import {
  ChapterPerformance,
  Chapter,
  DailyTest,
  DailyPlanConfig,
  DailyTestSettings,
  LearningSession,
  Mistake,
  MistakeBook,
  Performance,
  Question,
  QuestionAttempt,
  SessionAttempt,
  Subject,
  User,
  Year,
} from "@api/db";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { createLearningSession, getLearningSourceInfo, getSessionAttemptNumber } from "../lib/learning";
import { normalizeQuestionDocument, resolveQuestionYearFields } from "../lib/question-framework";
import { buildStrictQuestionExamModeQuery, getMixedSubjectIdsForExamMode, normalizeQuestionSubject } from "../lib/subjects";
import {
  avoidRecentSequences,
  evaluateUserPerformanceTier,
  getAdaptiveRatio,
  getAdaptiveTestConfig,
  getRecentSessionQuestionIds,
  selectAdaptiveQuestionSet,
  shuffleList,
} from "../lib/adaptive-testing";
import { shuffleQuestionOptionsForDelivery } from "../lib/question-randomization";

const router: IRouter = Router();

const DEFAULT_DAILY_TEST_CONFIG = {
  totalQuestions: 20,
  newQuestions: 10,
  weakQuestions: 5,
  revisionQuestions: 5,
  easyPercentage: 30,
  moderatePercentage: 40,
  hardPercentage: 30,
  enabled: true,
  examType: "BOTH" as SupportedExamMode,
  allowBothExamsSameDay: false,
  subjectDistribution: {
    NEET: { Biology: 0, Chemistry: 0, Physics: 0 },
    JEE: { Mathematics: 0, Chemistry: 0, Physics: 0 },
  },
  adaptiveModeEnabled: true,
  repeatLookbackSessions: 5,
  maxRepeatedQuestions: 2,
  lowPerformanceRatio: { easy: 70, moderate: 20, hard: 10 },
  mediumPerformanceRatio: { easy: 40, moderate: 40, hard: 20 },
  highPerformanceRatio: { easy: 15, moderate: 45, hard: 40 },
  mixedModeRatio: { easy: 34, moderate: 33, hard: 33 },
};

type SupportedExamMode = "NEET" | "JEE" | "BOTH";

function normalizeRequestedExamMode(value: unknown, fallback: SupportedExamMode = "NEET"): SupportedExamMode {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized.startsWith("NEET")) return "NEET";
  if (normalized.startsWith("JEE")) return "JEE";
  if (normalized === "BOTH" || normalized === "ALL" || normalized === "MIXED") return "BOTH";
  return fallback;
}

function getRequestExamMode(req: AuthenticatedRequest): SupportedExamMode {
  const userMode = normalizeRequestedExamMode(req.user?.examMode, "NEET");
  const requestedMode = normalizeRequestedExamMode(req.query.mode ?? req.query.examMode ?? req.query.examType, userMode);
  if (userMode === "BOTH" && requestedMode === "BOTH") return "NEET";
  if (userMode !== "BOTH" && requestedMode !== userMode) return userMode;
  return requestedMode;
}

function buildQuestionModeFilter(mode: SupportedExamMode) {
  return buildStrictQuestionExamModeQuery(mode);
}

function buildFlexibleFieldMatch(field: "chapterId" | "subjectId" | "topicId", ids?: Array<string | number>) {
  const normalizedIds = ids?.map((value) => String(value)).filter(Boolean) ?? [];
  if (normalizedIds.length === 0) return undefined;
  return { $expr: { $in: [{ $toString: `$${field}` }, normalizedIds] } };
}

const SubmitDailyTestBody = z.object({
  sessionId: z.string().optional(),
  dailyTestId: z.string().optional(),
  answers: z.array(
    z.object({
      questionId: z.union([z.string(), z.number()]),
      selectedOption: z.enum(["A", "B", "C", "D"]).optional(),
      selectedOptions: z.array(z.enum(["A", "B", "C", "D"])).optional(),
      numericAnswer: z.string().optional(),
      timeSpent: z.number().optional(),
      skipped: z.boolean().optional(),
    }),
  ),
  timeTaken: z.number(),
});

function getTodayRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

function buildDailyExamLockMessage(completedMode: SupportedExamMode, requestedMode: SupportedExamMode) {
  return `You have already completed today's ${completedMode} test. You can attend the ${requestedMode} test tomorrow.`;
}

async function getCompletedOtherDailyExam(userId: string, requestedMode: SupportedExamMode, start: Date, end: Date) {
  const completedTests = await DailyTest.find({
    userId,
    completed: true,
    testDate: { $gte: start, $lte: end },
  }).sort({ updatedAt: -1 }).limit(5);
  const completed = completedTests.find((test: any) => normalizeRequestedExamMode(test.examMode, "NEET") !== requestedMode);

  if (!completed) return null;
  const completedMode = normalizeRequestedExamMode(completed.examMode, "NEET");
  return {
    completedMode,
    requestedMode,
    message: buildDailyExamLockMessage(completedMode, requestedMode),
    dailyTest: completed,
  };
}

function pickRandom<T>(list: T[], count: number) {
  return shuffleList(list).slice(0, Math.max(0, count));
}

function buildDifficultyMix(questions: any[]) {
  const mix = { easy: 0, medium: 0, hard: 0, mixed: 0 };
  questions.forEach((question) => {
    const level = String(question?.difficulty || "mixed").toLowerCase();
    if (level.includes("easy")) mix.easy += 1;
    else if (level.includes("hard")) mix.hard += 1;
    else if (level.includes("medium") || level.includes("moderate")) mix.medium += 1;
    else mix.mixed += 1;
  });
  return mix;
}

function getRequiredDailySubjects(examMode: SupportedExamMode) {
  if (examMode === "JEE") return ["Mathematics", "Physics", "Chemistry"];
  return ["Biology", "Physics", "Chemistry"];
}

function getDailySubjectName(question: any, subjectNameById: Map<string, string>) {
  const subjectId = String(question?.subjectId ?? "");
  return normalizeQuestionSubject(subjectNameById.get(subjectId) || question?.subject || question?.subjectName);
}

function enforceRequiredDailySubjects({
  selectedQuestions,
  candidateQuestions,
  subjectNameById,
  examMode,
  totalQuestions,
}: {
  selectedQuestions: any[];
  candidateQuestions: any[];
  subjectNameById: Map<string, string>;
  examMode: SupportedExamMode;
  totalQuestions: number;
}) {
  const requiredSubjects = getRequiredDailySubjects(examMode);
  const selected = [...selectedQuestions];
  const selectedIds = new Set(selected.map((question) => String(question?._id)).filter(Boolean));
  const candidatesBySubject = new Map<string, any[]>();

  candidateQuestions.forEach((question) => {
    const subject = getDailySubjectName(question, subjectNameById);
    if (!subject || !requiredSubjects.includes(subject)) return;
    const list = candidatesBySubject.get(subject) ?? [];
    list.push(question);
    candidatesBySubject.set(subject, list);
  });

  for (const subject of requiredSubjects) {
    const alreadySelected = selected.some((question) => getDailySubjectName(question, subjectNameById) === subject);
    if (alreadySelected) continue;

    const replacement = (candidatesBySubject.get(subject) ?? []).find((question) => !selectedIds.has(String(question?._id)));
    if (!replacement) continue;

    if (selected.length < totalQuestions) {
      selected.push(replacement);
      selectedIds.add(String(replacement._id));
      continue;
    }

    const subjectCounts = new Map<string, number>();
    selected.forEach((question) => {
      const currentSubject = getDailySubjectName(question, subjectNameById);
      if (currentSubject) subjectCounts.set(currentSubject, (subjectCounts.get(currentSubject) ?? 0) + 1);
    });

    let replaceIndex = -1;
    let highestCount = 0;
    selected.forEach((question, index) => {
      const currentSubject = getDailySubjectName(question, subjectNameById);
      const currentCount = currentSubject ? subjectCounts.get(currentSubject) ?? 0 : 0;
      if (!currentSubject || (currentSubject !== subject && currentCount > 1 && currentCount > highestCount)) {
        replaceIndex = index;
        highestCount = currentCount;
      }
    });

    if (replaceIndex >= 0) {
      selectedIds.delete(String(selected[replaceIndex]?._id));
      selected[replaceIndex] = replacement;
      selectedIds.add(String(replacement._id));
    }
  }

  return selected.slice(0, totalQuestions);
}

function getConfiguredSubjectDistribution(config: any, examMode: SupportedExamMode) {
  const distribution = config?.subjectDistribution?.[examMode] || {};
  const entries = Object.entries(distribution)
    .map(([subject, count]) => [subject, Math.max(0, Number(count || 0))] as const)
    .filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return null;
  return new Map(entries);
}

function getSubjectDistributionTotal(config: any, examMode?: SupportedExamMode) {
  if (examMode) {
    const distribution = getConfiguredSubjectDistribution(config, examMode);
    return distribution ? [...distribution.values()].reduce((sum, count) => sum + Number(count || 0), 0) : 0;
  }
  return (["NEET", "JEE"] as SupportedExamMode[])
    .map((mode) => getSubjectDistributionTotal(config, mode))
    .reduce((sum, count) => sum + count, 0);
}

function getQuestionSubjectFieldValues(subject: string) {
  if (subject === "Mathematics") return ["Mathematics", "Maths", "Math"];
  return [subject];
}

function buildDistributedSubjectQuery({
  poolFilter,
  subject,
  subjectIds,
  excludedIds,
}: {
  poolFilter: Record<string, any>;
  subject: string;
  subjectIds: string[];
  excludedIds?: string[];
}) {
  const filters: Record<string, any>[] = [poolFilter];
  const subjectMatches: Record<string, any>[] = [
    { subject: { $in: getQuestionSubjectFieldValues(subject) } },
    { subjectName: { $in: getQuestionSubjectFieldValues(subject) } },
  ];
  const subjectIdFilter = buildFlexibleFieldMatch("subjectId", subjectIds);
  if (subjectIdFilter) subjectMatches.push(subjectIdFilter);
  filters.push({ $or: subjectMatches });
  if (excludedIds?.length) filters.push({ _id: { $nin: excludedIds } });
  return { $and: filters };
}

async function selectQuestionsForSubjectDistribution({
  poolFilter,
  subjectDocs,
  distribution,
  existingQuestions,
  subjectNameById,
}: {
  poolFilter: Record<string, any>;
  subjectDocs: any[];
  distribution: Map<string, number>;
  existingQuestions: any[];
  subjectNameById: Map<string, string>;
}) {
  const selected: any[] = [];
  const selectedIds = new Set<string>();
  const subjectIdsByName = new Map<string, string[]>();

  subjectDocs.forEach((subject: any) => {
    const normalizedSubject = normalizeQuestionSubject(subject?.name);
    if (!normalizedSubject) return;
    const ids = subjectIdsByName.get(normalizedSubject) ?? [];
    ids.push(String(subject._id ?? subject.id));
    subjectIdsByName.set(normalizedSubject, ids);
  });

  for (const [subject, count] of distribution.entries()) {
    const subjectIds = subjectIdsByName.get(subject) ?? [];
    const existingMatches = shuffleList(existingQuestions)
      .filter((question) => getDailySubjectName(question, subjectNameById) === subject)
      .filter((question) => {
        const id = String(question?._id);
        return id && !selectedIds.has(id);
      });

    const existingForSubject = existingMatches.slice(0, count);
    for (const question of existingForSubject) {
      selected.push(question);
      selectedIds.add(String(question._id));
    }

    const remaining = count - existingForSubject.length;
    if (remaining <= 0) continue;

    const backfill = await Question.find(buildDistributedSubjectQuery({
      poolFilter,
      subject,
      subjectIds,
      excludedIds: [...selectedIds],
    }))
      .populate("questionTypeId")
      .limit(Math.max(remaining * 8, remaining + 50));

    for (const question of shuffleList(backfill as any[])) {
      const id = String(question?._id);
      if (!id || selectedIds.has(id)) continue;
      selected.push(question);
      selectedIds.add(id);
      if (selected.filter((item) => getDailySubjectName(item, subjectNameById) === subject).length >= count) break;
    }
  }

  return selected;
}

function selectBySubjectDistribution({
  questions,
  subjectNameById,
  distribution,
  totalQuestions,
}: {
  questions: any[];
  subjectNameById: Map<string, string>;
  distribution: Map<string, number>;
  totalQuestions: number;
}) {
  const selected: any[] = [];
  const selectedIds = new Set<string>();
  const shuffled = shuffleList(questions);

  distribution.forEach((count, subject) => {
    const subjectMatches = shuffled.filter((question) => getDailySubjectName(question, subjectNameById) === subject);
    for (const question of subjectMatches.slice(0, count)) {
      const id = String(question?._id);
      if (!selectedIds.has(id)) {
        selected.push(question);
        selectedIds.add(id);
      }
    }
  });

  if (selected.length < totalQuestions) {
    for (const question of shuffled) {
      const id = String(question?._id);
      if (selectedIds.has(id)) continue;
      selected.push(question);
      selectedIds.add(id);
      if (selected.length >= totalQuestions) break;
    }
  }

  return selected.slice(0, totalQuestions);
}

function performanceMessageFromAccuracy(accuracy: number) {
  if (accuracy >= 85) return { rank: "Top Performer", message: "Excellent consistency today. Keep this momentum." };
  if (accuracy >= 65) return { rank: "Strong Progress", message: "Good performance. Focus on weak topics for better rank uplift." };
  if (accuracy >= 40) return { rank: "Improving", message: "You are on track. Review mistakes and attempt with better pace tomorrow." };
  return { rank: "Needs Improvement", message: "Revise fundamentals and retry weak chapters for stronger performance." };
}

let dailyTestIndexReady: Promise<void> | null = null;

function ensureDailyTestModeIndex() {
  if (!dailyTestIndexReady) {
    dailyTestIndexReady = (async () => {
      try {
        await DailyTest.collection.dropIndex("userId_1_testDate_1");
      } catch (error: any) {
        if (error?.codeName !== "IndexNotFound" && error?.code !== 27) {
          console.warn("Unable to drop legacy daily test index", error?.message || error);
        }
      }
      await DailyTest.collection.createIndex({ userId: 1, testDate: 1, examMode: 1 }, { unique: true });
    })();
  }
  return dailyTestIndexReady;
}

async function getDailyTestConfig() {
  const settings = await DailyTestSettings.findOne({});
  if (!settings) return DEFAULT_DAILY_TEST_CONFIG;

  return {
    totalQuestions: Number(settings.totalQuestions ?? DEFAULT_DAILY_TEST_CONFIG.totalQuestions),
    newQuestions: Number(settings.newQuestions ?? DEFAULT_DAILY_TEST_CONFIG.newQuestions),
    weakQuestions: Number(settings.weakQuestions ?? DEFAULT_DAILY_TEST_CONFIG.weakQuestions),
    revisionQuestions: Number(settings.revisionQuestions ?? DEFAULT_DAILY_TEST_CONFIG.revisionQuestions),
    easyPercentage: Number(settings.easyPercentage ?? DEFAULT_DAILY_TEST_CONFIG.easyPercentage),
    moderatePercentage: Number(settings.moderatePercentage ?? DEFAULT_DAILY_TEST_CONFIG.moderatePercentage),
    hardPercentage: Number(settings.hardPercentage ?? DEFAULT_DAILY_TEST_CONFIG.hardPercentage),
    enabled: Boolean(settings.enabled),
    examType: normalizeRequestedExamMode(settings.examType, "BOTH"),
    allowBothExamsSameDay: Boolean((settings as any).allowBothExamsSameDay ?? false),
    subjectDistribution: (settings as any).subjectDistribution ?? DEFAULT_DAILY_TEST_CONFIG.subjectDistribution,
    adaptiveModeEnabled: settings.adaptiveModeEnabled !== false,
    repeatLookbackSessions: Math.max(1, Number(settings.repeatLookbackSessions ?? DEFAULT_DAILY_TEST_CONFIG.repeatLookbackSessions)),
    maxRepeatedQuestions: Math.max(0, Number(settings.maxRepeatedQuestions ?? DEFAULT_DAILY_TEST_CONFIG.maxRepeatedQuestions)),
    lowPerformanceRatio: settings.lowPerformanceRatio ?? DEFAULT_DAILY_TEST_CONFIG.lowPerformanceRatio,
    mediumPerformanceRatio: settings.mediumPerformanceRatio ?? DEFAULT_DAILY_TEST_CONFIG.mediumPerformanceRatio,
    highPerformanceRatio: settings.highPerformanceRatio ?? DEFAULT_DAILY_TEST_CONFIG.highPerformanceRatio,
    mixedModeRatio: settings.mixedModeRatio ?? DEFAULT_DAILY_TEST_CONFIG.mixedModeRatio,
  };
}

function isDailyTestModeAllowed(config: typeof DEFAULT_DAILY_TEST_CONFIG, mode: SupportedExamMode) {
  const configuredMode = normalizeRequestedExamMode((config as any).examType, "BOTH");
  return configuredMode === "BOTH" || configuredMode === mode;
}

function getEffectiveDailyTestConfig(config: typeof DEFAULT_DAILY_TEST_CONFIG, isPremium?: boolean) {
  if (getSubjectDistributionTotal(config) > 0) return config;
  if (isPremium) return config;
  const totalQuestions = Math.min(20, Math.max(1, Number(config.totalQuestions || 20)));
  const sourceTotal = Math.max(
    1,
    Number(config.newQuestions || 0) + Number(config.weakQuestions || 0) + Number(config.revisionQuestions || 0),
  );
  const weakQuestions = Math.max(0, Math.floor((Number(config.weakQuestions || 0) / sourceTotal) * totalQuestions));
  const revisionQuestions = Math.max(0, Math.floor((Number(config.revisionQuestions || 0) / sourceTotal) * totalQuestions));
  const newQuestions = Math.max(0, totalQuestions - weakQuestions - revisionQuestions);
  return { ...config, totalQuestions, newQuestions, weakQuestions, revisionQuestions };
}

async function ensureTodayDailyTest(user: any, config: typeof DEFAULT_DAILY_TEST_CONFIG, forceRegenerate = false, requestedExamMode?: SupportedExamMode) {
  await ensureDailyTestModeIndex();
  const userId = String(user.id || user._id);
  const { start, end } = getTodayRange();
  const examMode = normalizeRequestedExamMode(requestedExamMode ?? user.examMode, "NEET");
  const planConfig = await DailyPlanConfig.findOne({ modeKey: examMode, isActive: true }).lean();
  const configuredSubjectDistribution = getConfiguredSubjectDistribution(config, examMode);
  const configuredSubjectTotal = configuredSubjectDistribution
    ? [...configuredSubjectDistribution.values()].reduce((sum, count) => sum + Number(count || 0), 0)
    : 0;
  const manualQuestionIds =
    String(planConfig?.selectionMode || "").toLowerCase() === "manual" && Array.isArray(planConfig?.manualQuestionIds)
      ? [...new Set(planConfig.manualQuestionIds.map(String).filter(Boolean))]
      : [];
  const effectiveConfig = {
    ...config,
    totalQuestions: configuredSubjectTotal
      ? configuredSubjectTotal
      : planConfig?.questionCount
      ? Math.min(200, Math.max(1, Number(planConfig.questionCount)))
      : config.totalQuestions,
  };
  const autoFillRemaining = planConfig?.autoFillRemaining !== false;
  const existing = await DailyTest.findOne({ userId, examMode, testDate: { $gte: start, $lte: end } });
  if (existing?.completed) return existing;
  if (!forceRegenerate
    && existing
    && Number(existing.totalQuestions ?? 0) === Number(effectiveConfig.totalQuestions ?? 0)
    && Number(existing.questionIds?.length ?? 0) === Number(existing.totalQuestions ?? 0)
  ) {
    return existing;
  }

  const examFilter = buildQuestionModeFilter(examMode);
  const mixedSubjectIds = await getMixedSubjectIdsForExamMode(examMode);
  const subjectFilter = buildFlexibleFieldMatch("subjectId", mixedSubjectIds);
  const poolFilter = subjectFilter ? { $and: [examFilter, subjectFilter] } : examFilter;
  const subjectDocs = mixedSubjectIds.length ? await Subject.find({ _id: { $in: mixedSubjectIds } }).select("_id name") : [];
  const subjectNameById = new Map(subjectDocs.map((subject: any) => [String(subject._id), String(subject.name || "")]));

  const [attemptedByQuestionAttempt, attemptedByPerformance] = await Promise.all([
    QuestionAttempt.find({ userId }).distinct("questionId"),
    Performance.find({ userId }).distinct("questionId"),
  ]);
  const attemptedIds = new Set(
    [...attemptedByQuestionAttempt, ...attemptedByPerformance]
      .map((value) => String(value))
      .filter(Boolean),
  );

  const chosen = new Map<string, any>();
  const adaptiveConfig = await getAdaptiveTestConfig();
  const userPerformance = await evaluateUserPerformanceTier(userId);
  const selectedRatio = getAdaptiveRatio(adaptiveConfig, userPerformance.tier);
  const { recentSet, sequences } = await getRecentSessionQuestionIds({
    userId,
    origin: "daily_set",
    lookback: Math.max(1, Number(config.repeatLookbackSessions ?? adaptiveConfig.repeatLookbackSessions)),
  });

  if (manualQuestionIds.length) {
    const manualQuestions = await Question.find({
      $and: [{ _id: { $in: manualQuestionIds } }, poolFilter],
    }).populate("questionTypeId");
    const manualMap = new Map(manualQuestions.map((question: any) => [String(question._id), question]));
    manualQuestionIds.forEach((questionId) => {
      const question = manualMap.get(questionId);
      if (question) chosen.set(questionId, question);
    });
  }

  const shouldAutoFill = manualQuestionIds.length === 0 || autoFillRemaining;

  const mistakeBookEntries = shouldAutoFill ? await MistakeBook.find({ userId })
    .sort({ attempts: -1, lastAttempt: 1 })
    .limit(Math.max(4, effectiveConfig.revisionQuestions * 4)) : [];
  const fallbackMistakes =
    shouldAutoFill && mistakeBookEntries.length === 0
      ? await Mistake.find({ userId }).sort({ attempts: -1, lastAttemptDate: 1 }).limit(Math.max(4, effectiveConfig.revisionQuestions * 4))
      : [];
  const revisionIds = (mistakeBookEntries.length ? mistakeBookEntries : fallbackMistakes)
    .map((item: any) => String(item.questionId))
    .filter(Boolean);
  const revisionPoolRaw = revisionIds.length
    ? await Question.find({ $and: [{ _id: { $in: revisionIds } }, poolFilter] }).populate("questionTypeId")
    : [];
  const revisionMap = new Map(revisionPoolRaw.map((item: any) => [String(item._id), item]));
  const revisionPool = revisionIds.map((id) => revisionMap.get(id)).filter(Boolean);
  pickRandom(revisionPool, Math.max(effectiveConfig.revisionQuestions * 3, effectiveConfig.revisionQuestions)).forEach((question: any) => {
    chosen.set(String(question._id), question);
  });

  const weakChapters = shouldAutoFill ? await ChapterPerformance.find({ userId, isWeak: true })
    .sort({ accuracy: 1, updatedAt: -1 })
    .limit(20)
    .distinct("chapterId") : [];
  const weakPoolRaw = weakChapters.length
    ? await Question.find({
        chapterId: { $in: weakChapters.map(String) },
        _id: { $nin: [...chosen.keys()] },
        ...poolFilter,
      })
        .populate("questionTypeId")
        .limit(250)
    : [];
  pickRandom(weakPoolRaw as any[], Math.max(effectiveConfig.weakQuestions * 3, effectiveConfig.weakQuestions)).forEach((question: any) => {
    chosen.set(String(question._id), question);
  });

  const newPoolRaw = shouldAutoFill ? await Question.find({
    _id: { $nin: [...chosen.keys(), ...attemptedIds] },
    ...poolFilter,
  })
    .populate("questionTypeId")
    .limit(600) : [];
  pickRandom(newPoolRaw as any[], Math.max(effectiveConfig.newQuestions * 3, effectiveConfig.newQuestions)).forEach((question: any) => {
    chosen.set(String(question._id), question);
  });

  if (shouldAutoFill && chosen.size < effectiveConfig.totalQuestions) {
    const fallbackRaw = await Question.find({
      _id: { $nin: [...chosen.keys()] },
      ...poolFilter,
    })
      .populate("questionTypeId")
      .limit(600);
    pickRandom(fallbackRaw as any[], Math.max(effectiveConfig.totalQuestions * 2, effectiveConfig.totalQuestions - chosen.size)).forEach((question: any) => {
      chosen.set(String(question._id), question);
    });
  }

  const baseQuestions = [...chosen.values()];
  const configuredRatio = config.adaptiveModeEnabled === false
    ? {
        easy: Number(config.easyPercentage || 30),
        moderate: Number(config.moderatePercentage || 40),
        hard: Number(config.hardPercentage || 30),
      }
    : selectedRatio;
  const adaptiveSelected = configuredSubjectDistribution
    ? await selectQuestionsForSubjectDistribution({
        poolFilter,
        subjectDocs,
        distribution: configuredSubjectDistribution,
        subjectNameById,
        existingQuestions: selectBySubjectDistribution({
          questions: baseQuestions,
          subjectNameById,
          distribution: configuredSubjectDistribution,
          totalQuestions: Math.min(effectiveConfig.totalQuestions, baseQuestions.length),
        }),
      })
    : selectAdaptiveQuestionSet({
    questions: baseQuestions,
    total: Math.min(effectiveConfig.totalQuestions, baseQuestions.length),
    ratio: configuredRatio,
    recentQuestionIds: recentSet,
    maxRepeatedQuestions: effectiveConfig.maxRepeatedQuestions ?? adaptiveConfig.maxRepeatedQuestions,
  });
  const selectedQuestions = adaptiveSelected.length
    ? adaptiveSelected
    : pickRandom(baseQuestions, effectiveConfig.totalQuestions);
  const finalQuestions = configuredSubjectDistribution
    ? selectedQuestions.slice(0, effectiveConfig.totalQuestions)
    : enforceRequiredDailySubjects({
        selectedQuestions,
        candidateQuestions: baseQuestions,
        subjectNameById,
        examMode,
        totalQuestions: effectiveConfig.totalQuestions,
      });

  let nextQuestionIds = finalQuestions.map((question: any) => String(question._id));
  nextQuestionIds = avoidRecentSequences(nextQuestionIds, sequences);
  nextQuestionIds = shuffleList(nextQuestionIds);

  if (existing?.questionIds?.length) {
    nextQuestionIds = avoidRecentSequences(nextQuestionIds, [existing.questionIds.map(String)]);
  }
  const shouldRefreshExisting =
    Boolean(existing)
    && (
      Number(existing?.totalQuestions ?? 0) !== Number(effectiveConfig.totalQuestions)
      || Number(existing?.questionIds?.length ?? 0) < Math.max(1, Number(effectiveConfig.totalQuestions ?? 0))
    );

  if (existing && !shouldRefreshExisting && !forceRegenerate) {
    return existing;
  }

  if (existing && (shouldRefreshExisting || forceRegenerate)) {
    existing.examMode = examMode;
    existing.questionIds = nextQuestionIds;
    existing.totalQuestions = nextQuestionIds.length;
    existing.completed = false;
    existing.score = 0;
    existing.accuracy = 0;
    await existing.save();
    return existing;
  }

  const created = await DailyTest.create({
    userId,
    examMode,
    testDate: start,
    questionIds: nextQuestionIds,
    totalQuestions: nextQuestionIds.length,
    completed: false,
    score: 0,
    accuracy: 0,
  });
  return created;
}

router.get("/daily-test", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const examMode = getRequestExamMode(req);
  const { start, end } = getTodayRange();
  const config = getEffectiveDailyTestConfig(await getDailyTestConfig(), user.isPremium);

  if (!config.enabled || !isDailyTestModeAllowed(config, examMode)) {
    res.json({
      enabled: false,
      completed: false,
      totalQuestions: config.totalQuestions,
      examMode,
      examType: config.examType,
      composition: {
        newQuestions: config.newQuestions,
        weakQuestions: config.weakQuestions,
        revisionQuestions: config.revisionQuestions,
      },
      statusMessage: !config.enabled
        ? "Daily Test is disabled by admin"
        : `${examMode} Daily Test is not enabled by admin`,
      questions: [],
      difficultyMix: { easy: 0, medium: 0, hard: 0, mixed: 0 },
    });
    return;
  }

  const dailyExamLock = config.allowBothExamsSameDay
    ? null
    : await getCompletedOtherDailyExam(String(user.id || user._id), examMode, start, end);
  if (dailyExamLock) {
    res.json({
      enabled: true,
      locked: true,
      autoCompleted: true,
      completed: false,
      totalQuestions: 0,
      examMode,
      examType: examMode,
      lockedByExamMode: dailyExamLock.completedMode,
      composition: {
        newQuestions: config.newQuestions,
        weakQuestions: config.weakQuestions,
        revisionQuestions: config.revisionQuestions,
      },
      statusMessage: dailyExamLock.message,
      questions: [],
      difficultyMix: { easy: 0, medium: 0, hard: 0, mixed: 0 },
    });
    return;
  }

  const dailyTest = await ensureTodayDailyTest(user, config, true, examMode);
  const questionsRaw = await Question.find({ _id: { $in: dailyTest.questionIds } }).populate("questionTypeId");
  const questionMap = new Map(questionsRaw.map((item: any) => [String(item._id), item]));
  let questions = dailyTest.questionIds.map((id) => questionMap.get(String(id))).filter(Boolean);

  const missingQuestionCount = Math.max(0, Number(dailyTest.questionIds?.length ?? 0) - questions.length);
  if (!dailyTest.completed && missingQuestionCount > 0) {
    const refreshedDailyTest = await ensureTodayDailyTest(user, config, false, examMode);
    if (String(refreshedDailyTest.id) !== String(dailyTest.id) || refreshedDailyTest.questionIds?.length !== dailyTest.questionIds?.length) {
      const refreshedQuestionsRaw = await Question.find({ _id: { $in: refreshedDailyTest.questionIds } }).populate("questionTypeId");
      const refreshedMap = new Map(refreshedQuestionsRaw.map((item: any) => [String(item._id), item]));
      questions = refreshedDailyTest.questionIds.map((id) => refreshedMap.get(String(id))).filter(Boolean);
      dailyTest.questionIds = refreshedDailyTest.questionIds;
      dailyTest.totalQuestions = refreshedDailyTest.totalQuestions;
      dailyTest.completed = refreshedDailyTest.completed;
      dailyTest.score = refreshedDailyTest.score;
      dailyTest.accuracy = refreshedDailyTest.accuracy;
      dailyTest.examMode = refreshedDailyTest.examMode;
    }
  }

  const yearIds = [...new Set(questions.map((question: any) => String(question.yearId ?? "")).filter(Boolean))];
  const subjectIds = [...new Set(questions.map((question: any) => String(question.subjectId ?? "")).filter(Boolean))];
  const chapterIds = [...new Set(questions.map((question: any) => String(question.chapterId ?? "")).filter(Boolean))];
  const [years, subjects, chapters] = await Promise.all([
    yearIds.length > 0 ? Year.find({ _id: { $in: yearIds } }) : [],
    subjectIds.length > 0 ? Subject.find({ _id: { $in: subjectIds } }).select("_id name") : [],
    chapterIds.length > 0 ? Chapter.find({ _id: { $in: chapterIds } }).select("_id name") : [],
  ]);
  const yearMap = new Map(years.map((year) => [year.id, year]));
  const subjectMap = new Map(subjects.map((subject) => [String(subject._id), subject.name]));
  const chapterMap = new Map(chapters.map((chapter) => [String(chapter._id), chapter.name]));
  const normalized = shuffleQuestionOptionsForDelivery(
    questions.map((question: any) => {
      const normalizedQuestion = normalizeQuestionDocument(question);
      const year = normalizedQuestion.yearId ? yearMap.get(String(normalizedQuestion.yearId)) : undefined;
      const subjectName = subjectMap.get(String(normalizedQuestion.subjectId));
      const chapterName = chapterMap.get(String(normalizedQuestion.chapterId));
      return {
        ...normalizedQuestion,
        subject: subjectName ?? normalizedQuestion.subject,
        subjectName: subjectName ?? normalizedQuestion.subjectName,
        chapterName: chapterName ?? normalizedQuestion.chapterName,
        ...resolveQuestionYearFields(normalizedQuestion, year as any),
      };
    }),
  );
  const difficultyMix = buildDifficultyMix(normalized);

  if (dailyTest.completed) {
    res.json({
      id: dailyTest.id,
      dailyTestId: dailyTest.id,
      testDate: dailyTest.testDate,
      examMode: dailyTest.examMode ?? examMode,
      totalQuestions: dailyTest.totalQuestions,
      completed: true,
      score: dailyTest.score,
      accuracy: dailyTest.accuracy,
      statusMessage: "Today's Test Completed",
      enabled: true,
      composition: {
        newQuestions: config.newQuestions,
        weakQuestions: config.weakQuestions,
        revisionQuestions: config.revisionQuestions,
      },
      difficultyMix,
    });
    return;
  }

  res.json({
    id: dailyTest.id,
    dailyTestId: dailyTest.id,
    testDate: dailyTest.testDate,
    examMode: dailyTest.examMode ?? examMode,
    totalQuestions: dailyTest.totalQuestions,
    estimatedTime: Math.max(1, dailyTest.totalQuestions) * 90,
    difficultyMix,
    completed: false,
    enabled: true,
    composition: {
      newQuestions: config.newQuestions,
      weakQuestions: config.weakQuestions,
      revisionQuestions: config.revisionQuestions,
    },
    statusMessage: `${dailyTest.totalQuestions} Questions for Today`,
    questions: normalized,
  });
});

router.post("/daily-test/submit", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const body = SubmitDailyTestBody.parse(req.body);
    const userId = req.userId!;
    const { start, end } = getTodayRange();
    const requestedId = body.dailyTestId || body.sessionId;
    const dailyTest = requestedId
      ? await DailyTest.findById(requestedId)
      : await DailyTest.findOne({ userId, testDate: { $gte: start, $lte: end } });

    if (!dailyTest || dailyTest.userId !== userId) {
      res.status(404).json({ error: "not_found", message: "Today's daily test not found" });
      return;
    }

    const config = getEffectiveDailyTestConfig(await getDailyTestConfig(), req.user?.isPremium);
    const dailyExamLock = config.allowBothExamsSameDay
      ? null
      : await getCompletedOtherDailyExam(userId, normalizeRequestedExamMode(dailyTest.examMode, "NEET"), start, end);
    if (dailyExamLock) {
      res.status(409).json({
        error: "daily_exam_already_completed",
        message: dailyExamLock.message,
        locked: true,
        autoCompleted: true,
        requestedExamMode: dailyExamLock.requestedMode,
        completedExamMode: dailyExamLock.completedMode,
      });
      return;
    }

    if (dailyTest.completed) {
      res.json({
        sessionId: dailyTest.id,
        score: dailyTest.score,
        accuracy: dailyTest.accuracy,
        timeTaken: body.timeTaken,
        totalQuestions: dailyTest.totalQuestions,
        completionStatus: "Completed",
        performanceMessage: "Today's Test Completed",
      });
      return;
    }

    const submittedQuestionIds = [...new Set(body.answers.map((item) => String(item.questionId)).filter(Boolean))];
    const questions = await Question.find({ _id: { $in: submittedQuestionIds } }).populate("questionTypeId");
    const questionMap = new Map<string, any>(questions.map((question: any) => [String(question._id), question]));

    let correct = 0;
    let incorrect = 0;
    let skipped = 0;
    let score = 0;
    const topicMap: Record<
      string,
      {
        subjectId: string;
        chapterId: string;
        total: number;
        correct: number;
        wrong: number;
        totalTime: number;
        topicId: string;
        skipped: number;
        correctQuestionIds: Set<string>;
        incorrectQuestionIds: Set<string>;
      }
    > = {};
    const performanceDocs: Array<Record<string, unknown>> = [];
    const attemptDocs: Array<Record<string, unknown>> = [];

    const existingSession = await LearningSession.findOne({
      userId,
      origin: "daily_set",
      type: "practice",
      "filterSnapshot.dailyTestId": dailyTest.id,
      createdAt: { $gte: start, $lte: end },
    });
    const learningSession =
      existingSession ||
      (await createLearningSession({
        userId,
        type: "practice",
        origin: "daily_set",
        modeKey: normalizeRequestedExamMode(dailyTest.examMode ?? req.user?.examMode, "NEET"),
        questionIds: submittedQuestionIds,
        filterSnapshot: { dailyTestId: dailyTest.id },
        title: "Daily Test",
      }));
    const sourceInfo = getLearningSourceInfo(learningSession);

    for (const answer of body.answers) {
      const questionId = String(answer.questionId);
      const question = questionMap.get(questionId);
      if (!question) continue;

      const selectedOption = answer.selectedOption ? String(answer.selectedOption) : undefined;
      const selectedOptions = Array.isArray(answer.selectedOptions) ? answer.selectedOptions.map(String) : [];
      const numericAnswer = answer.numericAnswer ? String(answer.numericAnswer) : undefined;
      const isSkipped = Boolean(answer.skipped || (!selectedOption && selectedOptions.length === 0 && !numericAnswer));
      const isCorrect = isSkipped
        ? false
        : question.responseType === "numeric"
          ? Number(numericAnswer) === Number(question.numericAnswer ?? "")
          : question.responseType === "multiple"
            ? [...selectedOptions].sort().join(",") === [...(question.correctOptions ?? [])].sort().join(",")
            : selectedOption === question.correctOption;

      if (isSkipped) skipped += 1;
      else if (isCorrect) correct += 1;
      else incorrect += 1;

      score += isSkipped ? 0 : isCorrect ? 4 : -1;

      const topicId = String(question.topicId ?? "");
      const topicKey = `${question.subjectId}|${question.chapterId}|${topicId || "chapter"}`;
      if (!topicMap[topicKey]) {
        topicMap[topicKey] = {
          subjectId: String(question.subjectId),
          chapterId: String(question.chapterId),
          topicId,
          total: 0,
          correct: 0,
          wrong: 0,
          totalTime: 0,
          skipped: 0,
          correctQuestionIds: new Set<string>(),
          incorrectQuestionIds: new Set<string>(),
        };
      }
      topicMap[topicKey].total += 1;
      topicMap[topicKey].totalTime += Number(answer.timeSpent ?? 0);
      if (isCorrect) {
        topicMap[topicKey].correct += 1;
        topicMap[topicKey].correctQuestionIds.add(questionId);
      }
      if (isSkipped) {
        topicMap[topicKey].skipped += 1;
        topicMap[topicKey].incorrectQuestionIds.add(questionId);
      }
      if (!isCorrect && !isSkipped) {
        topicMap[topicKey].wrong += 1;
        topicMap[topicKey].incorrectQuestionIds.add(questionId);
      }

      performanceDocs.push({
        userId,
        questionId,
        isCorrect,
        timeTaken: Number(answer.timeSpent ?? 0),
      });

      const existingMistake = await Mistake.findOne({ userId, questionId });
      const existingMistakeBook = await MistakeBook.findOne({ userId, questionId });
      if (!isCorrect && !isSkipped) {
        const nextAttempts = Number(existingMistake?.attempts ?? 0) + 1;
        const nextBookAttempts = Number(existingMistakeBook?.attempts ?? 0) + 1;
        await Mistake.findOneAndUpdate(
          { userId, questionId },
          {
            userId,
            questionId,
            attempts: nextAttempts,
            correctCount: Number(existingMistake?.correctCount ?? 0),
            wrongCount: Number(existingMistake?.wrongCount ?? 0) + 1,
            skippedCount: Number(existingMistake?.skippedCount ?? 0),
            accuracy: 0,
            previousAccuracy: Number(existingMistake?.accuracy ?? 0),
            improvementPercentage: 0,
            completionStatus: "in_progress",
            subjectId: String(question.subjectId || ""),
            chapterId: String(question.chapterId || ""),
            topicId: String(question.topicId || ""),
            examType: String(question.examMode || question.examType || dailyTest.examMode || ""),
            sourceType: sourceInfo.sourceType,
            sourceName: sourceInfo.sourceLabel,
            sourceSessionId: sourceInfo.sourceSessionId,
            sessionId: learningSession.id,
            category: String(question.topicId || question.chapterId || question.subjectId || ""),
            difficulty: String(question.difficulty || question.difficultyId || ""),
            lastAttemptDate: new Date(),
            status: nextAttempts >= 3 ? "weak" : "new",
          },
          { upsert: true, new: true },
        );
        await MistakeBook.findOneAndUpdate(
          { userId, questionId },
          { userId, questionId, chapter: String(question.chapterId || ""), attempts: nextBookAttempts, lastAttempt: new Date(), status: nextBookAttempts >= 3 ? "weak" : "new" },
          { upsert: true, new: true },
        );
      } else if (isSkipped) {
        const nextAttempts = Number(existingMistake?.attempts ?? 0) + 1;
        await Mistake.findOneAndUpdate(
          { userId, questionId },
          {
            userId,
            questionId,
            attempts: nextAttempts,
            correctCount: Number(existingMistake?.correctCount ?? 0),
            wrongCount: Number(existingMistake?.wrongCount ?? 0),
            skippedCount: Number(existingMistake?.skippedCount ?? 0) + 1,
            accuracy: Number(existingMistake?.accuracy ?? 0),
            previousAccuracy: Number(existingMistake?.accuracy ?? 0),
            improvementPercentage: 0,
            completionStatus: "in_progress",
            subjectId: String(question.subjectId || ""),
            chapterId: String(question.chapterId || ""),
            topicId: String(question.topicId || ""),
            examType: String(question.examMode || question.examType || dailyTest.examMode || ""),
            sourceType: sourceInfo.sourceType,
            sourceName: sourceInfo.sourceLabel,
            sourceSessionId: sourceInfo.sourceSessionId,
            sessionId: learningSession.id,
            category: String(question.topicId || question.chapterId || question.subjectId || ""),
            difficulty: String(question.difficulty || question.difficultyId || ""),
            lastAttemptDate: new Date(),
            status: nextAttempts >= 3 ? "weak" : "new",
          },
          { upsert: true, new: true },
        );
      } else if (isCorrect) {
        if (existingMistake) {
          await Mistake.findOneAndUpdate(
            { userId, questionId },
            {
              status: "improving",
              attempts: Number(existingMistake.attempts ?? 0) + 1,
              correctCount: Number(existingMistake.correctCount ?? 0) + 1,
              accuracy:
                Math.round(
                  ((Number(existingMistake.correctCount ?? 0) + 1) / (Number(existingMistake.attempts ?? 0) + 1)) * 10000,
                ) / 100,
              sourceType: sourceInfo.sourceType,
              sourceName: sourceInfo.sourceLabel,
              sourceSessionId: sourceInfo.sourceSessionId,
              sessionId: learningSession.id,
              lastAttemptDate: new Date(),
            },
            { new: true },
          );
        }
        if (existingMistakeBook) {
          await MistakeBook.findOneAndUpdate(
            { userId, questionId },
            { status: "improving", lastAttempt: new Date() },
            { new: true },
          );
        }
      }

      attemptDocs.push({
        userId,
        sessionId: learningSession.id,
        questionId,
        subjectId: String(question.subjectId),
        chapterId: String(question.chapterId),
        topicId,
        yearId: question.yearId ? String(question.yearId) : undefined,
        questionTypeId:
          typeof question.questionTypeId === "string"
            ? question.questionTypeId
            : question.questionTypeId?._id?.toString(),
        isCorrect,
        selectedOption,
        selectedOptions,
        numericAnswer,
        skipped: isSkipped,
        timeSpent: Number(answer.timeSpent ?? 0),
      });
    }

    const totalQuestions = body.answers.length;
    const accuracy = totalQuestions > 0 ? (correct / totalQuestions) * 100 : 0;

    const sessionAttempt = await new SessionAttempt({
      userId,
      sessionId: learningSession.id,
      sourceSessionId: learningSession.id,
      attemptNumber: await getSessionAttemptNumber(learningSession.id),
      score,
      accuracy,
      timeTaken: body.timeTaken,
      correctCount: correct,
      incorrectCount: incorrect,
      skippedCount: skipped,
      totalQuestions,
      answersJson: body.answers,
      completedAt: new Date(),
    }).save();

    if (attemptDocs.length) {
      await QuestionAttempt.insertMany(
        attemptDocs.map((item) => ({
          ...item,
          sessionAttemptId: sessionAttempt.id,
        })),
      );
    }
    if (performanceDocs.length) await Performance.insertMany(performanceDocs);

    for (const [, stats] of Object.entries(topicMap)) {
      const existing = await ChapterPerformance.findOne({ userId, chapterId: stats.chapterId, topicId: stats.topicId });
      const totalAttempts = Number(existing?.totalAttempts ?? 0) + stats.total;
      const attemptCount = Number(existing?.attemptCount ?? 0) + 1;
      const correctCount = Number(existing?.correctCount ?? 0) + stats.correct;
      const wrongCount = Number(existing?.wrongCount ?? 0) + stats.wrong;
      const skippedCount = Number(existing?.skippedCount ?? 0) + stats.skipped;
      const correctedQuestionIds = new Set(Array.from(stats.correctQuestionIds).map(String));
      const incorrectQuestionIds = [
        ...new Set([
          ...(existing?.incorrectQuestionIds ?? []).map(String).filter((id) => !correctedQuestionIds.has(id)),
          ...Array.from(stats.incorrectQuestionIds),
        ]),
      ];
      const topicIds = [...new Set([...(existing?.topicIds ?? []).map(String), stats.topicId].filter(Boolean))];
      const previousTotalTime = Number(existing?.averageTimeSpent ?? 0) * Number(existing?.totalAttempts ?? 0);
      const averageTimeSpent = totalAttempts > 0 ? (previousTotalTime + stats.totalTime) / totalAttempts : 0;
      const chapterAccuracy = totalAttempts > 0 ? correctCount / totalAttempts : 0;
      const latestAttemptComplete = stats.total > 0 && stats.correct === stats.total && stats.wrong === 0 && stats.skipped === 0;
      const isMastered = attemptCount > 1 && latestAttemptComplete;
      const progressPercentage = isMastered ? 100 : chapterAccuracy * 100;
      const isWeak = !latestAttemptComplete && (stats.wrong > 0 || stats.skipped > 0 || chapterAccuracy < 0.5 || wrongCount >= 3 || skippedCount > 0 || (averageTimeSpent > 75 && stats.wrong > 0));
      const strength: "strong" | "medium" | "weak" | "untested" =
        totalAttempts === 0 ? "untested" : isMastered ? "strong" : isWeak ? "weak" : chapterAccuracy >= 0.75 ? "strong" : "medium";

      await ChapterPerformance.findOneAndUpdate(
        { userId, chapterId: stats.chapterId, topicId: stats.topicId },
        {
          userId,
          chapterId: stats.chapterId,
          subjectId: stats.subjectId,
          topicId: stats.topicId,
          totalAttempts,
          attemptCount,
          correctCount,
          wrongCount,
          skippedCount,
          incorrectQuestionIds,
          topicIds,
          accuracy: chapterAccuracy,
          previousAccuracy: Number(existing?.accuracy ?? 0),
          improvementPercentage: Math.max(0, progressPercentage - Number(existing?.accuracy ?? 0) * 100),
          completionPercentage: Math.min(100, Math.round(progressPercentage * 100) / 100),
          masteryPercentage: Math.min(100, Math.round(progressPercentage * 100) / 100),
          isMastered,
          examMode: normalizeRequestedExamMode(dailyTest.examMode ?? req.user?.examMode, "NEET"),
          sourceType: sourceInfo.sourceType,
          sourceName: sourceInfo.sourceLabel,
          sourceSessionId: sourceInfo.sourceSessionId,
          completedAt: isMastered ? new Date() : existing?.completedAt,
          isWeak: !isMastered && isWeak,
          averageTimeSpent,
          strength,
          lastPracticed: new Date(),
        },
        { upsert: true, new: true },
      );
    }

    dailyTest.completed = true;
    dailyTest.score = score;
    dailyTest.accuracy = accuracy;
    await dailyTest.save();

    const perf = performanceMessageFromAccuracy(accuracy);
    res.json({
      sessionId: dailyTest.id,
      dailyTestId: dailyTest.id,
      score,
      accuracy,
      timeTaken: body.timeTaken,
      correctCount: correct,
      incorrectCount: incorrect,
      skippedCount: skipped,
      totalQuestions,
      maxScore: totalQuestions * 4,
      completionStatus: "Completed",
      rank: perf.rank,
      performanceMessage: perf.message,
    });
  } catch (error) {
    req.log.error({ error }, "Submit daily test failed");
    res.status(500).json({ error: "submit_failed", message: "Failed to submit daily test" });
  }
});

export default router;
