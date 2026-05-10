import { Router, type IRouter } from "express";
import {
  ChapterPerformance,
  DailyTest,
  DailyTestSettings,
  LearningSession,
  Mistake,
  MistakeBook,
  Performance,
  Question,
  QuestionAttempt,
  SessionAttempt,
  User,
} from "@api/db";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { createLearningSession, getSessionAttemptNumber } from "../lib/learning";
import { normalizeQuestionDocument } from "../lib/question-framework";
import { getQuestionExamModes } from "../lib/subjects";
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
  adaptiveModeEnabled: true,
  repeatLookbackSessions: 5,
  maxRepeatedQuestions: 2,
  lowPerformanceRatio: { easy: 70, moderate: 20, hard: 10 },
  mediumPerformanceRatio: { easy: 40, moderate: 40, hard: 20 },
  highPerformanceRatio: { easy: 15, moderate: 45, hard: 40 },
  mixedModeRatio: { easy: 34, moderate: 33, hard: 33 },
};

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

function performanceMessageFromAccuracy(accuracy: number) {
  if (accuracy >= 85) return { rank: "Top Performer", message: "Excellent consistency today. Keep this momentum." };
  if (accuracy >= 65) return { rank: "Strong Progress", message: "Good performance. Focus on weak topics for better rank uplift." };
  if (accuracy >= 40) return { rank: "Improving", message: "You are on track. Review mistakes and attempt with better pace tomorrow." };
  return { rank: "Needs Improvement", message: "Revise fundamentals and retry weak chapters for stronger performance." };
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
    adaptiveModeEnabled: settings.adaptiveModeEnabled !== false,
    repeatLookbackSessions: Math.max(1, Number(settings.repeatLookbackSessions ?? DEFAULT_DAILY_TEST_CONFIG.repeatLookbackSessions)),
    maxRepeatedQuestions: Math.max(0, Number(settings.maxRepeatedQuestions ?? DEFAULT_DAILY_TEST_CONFIG.maxRepeatedQuestions)),
    lowPerformanceRatio: settings.lowPerformanceRatio ?? DEFAULT_DAILY_TEST_CONFIG.lowPerformanceRatio,
    mediumPerformanceRatio: settings.mediumPerformanceRatio ?? DEFAULT_DAILY_TEST_CONFIG.mediumPerformanceRatio,
    highPerformanceRatio: settings.highPerformanceRatio ?? DEFAULT_DAILY_TEST_CONFIG.highPerformanceRatio,
    mixedModeRatio: settings.mixedModeRatio ?? DEFAULT_DAILY_TEST_CONFIG.mixedModeRatio,
  };
}

async function ensureTodayDailyTest(user: any, config: typeof DEFAULT_DAILY_TEST_CONFIG, forceRegenerate = false) {
  const userId = String(user.id || user._id);
  const { start, end } = getTodayRange();
  const existing = await DailyTest.findOne({ userId, testDate: { $gte: start, $lte: end } });
  if (existing?.completed) return existing;
  if (!forceRegenerate
    && existing
    && Number(existing.totalQuestions ?? 0) === Number(config.totalQuestions ?? 0)
    && Number(existing.questionIds?.length ?? 0) === Number(existing.totalQuestions ?? 0)
  ) {
    return existing;
  }

  const examModes = getQuestionExamModes((user.examMode ?? "NEET") as "NEET" | "JEE" | "BOTH");
  const examFilter = { examMode: examModes.length === 1 ? examModes[0] : { $in: examModes } };

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

  const mistakeBookEntries = await MistakeBook.find({ userId })
    .sort({ attempts: -1, lastAttempt: 1 })
    .limit(Math.max(4, config.revisionQuestions * 4));
  const fallbackMistakes =
    mistakeBookEntries.length === 0
      ? await Mistake.find({ userId }).sort({ attempts: -1, lastAttemptDate: 1 }).limit(Math.max(4, config.revisionQuestions * 4))
      : [];
  const revisionIds = (mistakeBookEntries.length ? mistakeBookEntries : fallbackMistakes)
    .map((item: any) => String(item.questionId))
    .filter(Boolean);
  const revisionPoolRaw = revisionIds.length
    ? await Question.find({ _id: { $in: revisionIds }, ...examFilter }).populate("questionTypeId")
    : [];
  const revisionMap = new Map(revisionPoolRaw.map((item: any) => [String(item._id), item]));
  const revisionPool = revisionIds.map((id) => revisionMap.get(id)).filter(Boolean);
  pickRandom(revisionPool, Math.max(config.revisionQuestions * 3, config.revisionQuestions)).forEach((question: any) => {
    chosen.set(String(question._id), question);
  });

  const weakChapters = await ChapterPerformance.find({ userId, isWeak: true })
    .sort({ accuracy: 1, updatedAt: -1 })
    .limit(20)
    .distinct("chapterId");
  const weakPoolRaw = weakChapters.length
    ? await Question.find({
        chapterId: { $in: weakChapters.map(String) },
        _id: { $nin: [...chosen.keys()] },
        ...examFilter,
      })
        .populate("questionTypeId")
        .limit(250)
    : [];
  pickRandom(weakPoolRaw as any[], Math.max(config.weakQuestions * 3, config.weakQuestions)).forEach((question: any) => {
    chosen.set(String(question._id), question);
  });

  const newPoolRaw = await Question.find({
    _id: { $nin: [...chosen.keys(), ...attemptedIds] },
    ...examFilter,
  })
    .populate("questionTypeId")
    .limit(600);
  pickRandom(newPoolRaw as any[], Math.max(config.newQuestions * 3, config.newQuestions)).forEach((question: any) => {
    chosen.set(String(question._id), question);
  });

  if (chosen.size < config.totalQuestions) {
    const fallbackRaw = await Question.find({
      _id: { $nin: [...chosen.keys()] },
      ...examFilter,
    })
      .populate("questionTypeId")
      .limit(600);
    pickRandom(fallbackRaw as any[], Math.max(config.totalQuestions * 2, config.totalQuestions - chosen.size)).forEach((question: any) => {
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
  const adaptiveSelected = selectAdaptiveQuestionSet({
    questions: baseQuestions,
    total: config.totalQuestions,
    ratio: configuredRatio,
    recentQuestionIds: recentSet,
    maxRepeatedQuestions: config.maxRepeatedQuestions ?? adaptiveConfig.maxRepeatedQuestions,
  });
  const finalQuestions = adaptiveSelected.length
    ? adaptiveSelected
    : pickRandom(baseQuestions, config.totalQuestions);

  let nextQuestionIds = finalQuestions.map((question: any) => String(question._id));
  nextQuestionIds = avoidRecentSequences(nextQuestionIds, sequences);
  nextQuestionIds = shuffleList(nextQuestionIds);

  if (existing?.questionIds?.length) {
    nextQuestionIds = avoidRecentSequences(nextQuestionIds, [existing.questionIds.map(String)]);
  }
  const shouldRefreshExisting =
    Boolean(existing)
    && (
      Number(existing?.totalQuestions ?? 0) !== Number(config.totalQuestions)
      || Number(existing?.questionIds?.length ?? 0) < Math.max(1, Number(config.totalQuestions ?? 0))
    );

  if (existing && !shouldRefreshExisting && !forceRegenerate) {
    return existing;
  }

  if (existing && (shouldRefreshExisting || forceRegenerate)) {
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
  const config = await getDailyTestConfig();

  if (!config.enabled) {
    res.json({
      enabled: false,
      completed: false,
      totalQuestions: config.totalQuestions,
      composition: {
        newQuestions: config.newQuestions,
        weakQuestions: config.weakQuestions,
        revisionQuestions: config.revisionQuestions,
      },
      statusMessage: "Daily Test is disabled by admin",
      questions: [],
      difficultyMix: { easy: 0, medium: 0, hard: 0, mixed: 0 },
    });
    return;
  }

  const dailyTest = await ensureTodayDailyTest(user, config, true);
  const questionsRaw = await Question.find({ _id: { $in: dailyTest.questionIds } }).populate("questionTypeId");
  const questionMap = new Map(questionsRaw.map((item: any) => [String(item._id), item]));
  let questions = dailyTest.questionIds.map((id) => questionMap.get(String(id))).filter(Boolean);

  const missingQuestionCount = Math.max(0, Number(dailyTest.questionIds?.length ?? 0) - questions.length);
  if (!dailyTest.completed && missingQuestionCount > 0) {
    const refreshedDailyTest = await ensureTodayDailyTest(user, config);
    if (String(refreshedDailyTest.id) !== String(dailyTest.id) || refreshedDailyTest.questionIds?.length !== dailyTest.questionIds?.length) {
      const refreshedQuestionsRaw = await Question.find({ _id: { $in: refreshedDailyTest.questionIds } }).populate("questionTypeId");
      const refreshedMap = new Map(refreshedQuestionsRaw.map((item: any) => [String(item._id), item]));
      questions = refreshedDailyTest.questionIds.map((id) => refreshedMap.get(String(id))).filter(Boolean);
      dailyTest.questionIds = refreshedDailyTest.questionIds;
      dailyTest.totalQuestions = refreshedDailyTest.totalQuestions;
      dailyTest.completed = refreshedDailyTest.completed;
      dailyTest.score = refreshedDailyTest.score;
      dailyTest.accuracy = refreshedDailyTest.accuracy;
    }
  }

  const normalized = shuffleQuestionOptionsForDelivery(
    questions.map((question: any) => normalizeQuestionDocument(question)),
  );
  const difficultyMix = buildDifficultyMix(normalized);

  if (dailyTest.completed) {
    res.json({
      id: dailyTest.id,
      dailyTestId: dailyTest.id,
      testDate: dailyTest.testDate,
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
    const topicMap: Record<string, { subjectId: string; chapterId: string; total: number; correct: number; wrong: number; totalTime: number }> = {};
    const performanceDocs: Array<Record<string, unknown>> = [];
    const attemptDocs: Array<Record<string, unknown>> = [];

    const existingSession = await LearningSession.findOne({
      userId,
      origin: "daily_set",
      type: "practice",
      createdAt: { $gte: start, $lte: end },
    });
    const learningSession =
      existingSession ||
      (await createLearningSession({
        userId,
        type: "practice",
        origin: "daily_set",
        modeKey: (req.user?.examMode ?? "NEET") as "NEET" | "JEE" | "BOTH",
        questionIds: submittedQuestionIds,
        filterSnapshot: { dailyTestId: dailyTest.id },
        title: "Daily Test",
      }));

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

      const topicKey = `${question.subjectId}|${question.chapterId}`;
      if (!topicMap[topicKey]) {
        topicMap[topicKey] = {
          subjectId: String(question.subjectId),
          chapterId: String(question.chapterId),
          total: 0,
          correct: 0,
          wrong: 0,
          totalTime: 0,
        };
      }
      topicMap[topicKey].total += 1;
      topicMap[topicKey].totalTime += Number(answer.timeSpent ?? 0);
      if (isCorrect) topicMap[topicKey].correct += 1;
      if (!isCorrect && !isSkipped) topicMap[topicKey].wrong += 1;

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
          { userId, questionId, attempts: nextAttempts, lastAttemptDate: new Date(), status: nextAttempts >= 3 ? "weak" : "new" },
          { upsert: true, new: true },
        );
        await MistakeBook.findOneAndUpdate(
          { userId, questionId },
          { userId, questionId, chapter: String(question.chapterId || ""), attempts: nextBookAttempts, lastAttempt: new Date(), status: nextBookAttempts >= 3 ? "weak" : "new" },
          { upsert: true, new: true },
        );
      } else if (isCorrect) {
        if (existingMistake) {
          await Mistake.findOneAndUpdate(
            { userId, questionId },
            { status: "improving", lastAttemptDate: new Date() },
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
      const existing = await ChapterPerformance.findOne({ userId, chapterId: stats.chapterId });
      const totalAttempts = Number(existing?.totalAttempts ?? 0) + stats.total;
      const correctCount = Number(existing?.correctCount ?? 0) + stats.correct;
      const wrongCount = Number(existing?.wrongCount ?? 0) + stats.wrong;
      const previousTotalTime = Number(existing?.averageTimeSpent ?? 0) * Number(existing?.totalAttempts ?? 0);
      const averageTimeSpent = totalAttempts > 0 ? (previousTotalTime + stats.totalTime) / totalAttempts : 0;
      const chapterAccuracy = totalAttempts > 0 ? correctCount / totalAttempts : 0;
      const isWeak = chapterAccuracy < 0.5 || wrongCount >= 3 || (averageTimeSpent > 75 && stats.wrong > 0);
      const strength: "strong" | "medium" | "weak" | "untested" =
        totalAttempts === 0 ? "untested" : isWeak ? "weak" : chapterAccuracy >= 0.75 ? "strong" : "medium";

      await ChapterPerformance.findOneAndUpdate(
        { userId, chapterId: stats.chapterId },
        {
          userId,
          chapterId: stats.chapterId,
          subjectId: stats.subjectId,
          totalAttempts,
          correctCount,
          wrongCount,
          accuracy: chapterAccuracy,
          isWeak,
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
