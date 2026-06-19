import { Router, type IRouter } from "express";
import {
  Chapter,
  ChapterPerformance,
  LearningSession,
  Mistake,
  MistakeBook,
  Performance,
  Question,
  QuestionAttempt,
  RevisionHistory,
  RevisionSettings,
  SessionAttempt,
  Subject,
  Topic,
  Year,
} from "@api/db";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { createLearningSession, getLearningSourceInfo, getTodayDateKey } from "../lib/learning";
import { normalizeQuestionDocument, resolveQuestionYearFields } from "../lib/question-framework";
import { buildStrictQuestionExamModeQuery, getMixedSubjectIdsForExamMode } from "../lib/subjects";

const router: IRouter = Router();

const DEFAULT_REVISION_CONFIG = {
  wrongQuestionLimit: 10,
  oldQuestionLimit: 5,
  dailyRevisionLimit: 20,
  revisionEnabled: true,
  includeWrongQuestions: true,
  includeSkippedQuestions: true,
  includeLowAccuracyQuestions: true,
  includeWeakAreaQuestions: true,
  accuracyThreshold: 80,
  minimumCorrectAnswers: 1,
  completionAttemptCount: 1,
  difficultyMode: "mixed",
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
  if (userMode !== "BOTH" && requestedMode !== userMode) return userMode;
  return requestedMode;
}

function buildQuestionModeFilter(mode: SupportedExamMode) {
  return buildStrictQuestionExamModeQuery(mode);
}

function buildIdVariants(ids: Array<string | number>) {
  const stringIds = ids.map((value) => String(value)).filter(Boolean);
  return [
    ...stringIds,
    ...stringIds
      .filter((value) => /^[a-f\d]{24}$/i.test(value))
      .map((value) => {
        try {
          return new (Question as any).db.base.Types.ObjectId(value);
        } catch {
          return value;
        }
      }),
  ];
}

function buildFlexibleFieldMatch(field: "subjectId" | "chapterId" | "topicId", ids?: Array<string | number>) {
  const normalizedIds = ids?.map((value) => String(value)).filter(Boolean) ?? [];
  if (normalizedIds.length === 0) return undefined;
  return { $expr: { $in: [{ $toString: `$${field}` }, normalizedIds] } };
}

function questionMatchesExamMode(question: any, allowedModes: Set<string>) {
  const values = [
    question?.examMode,
    question?.examType,
    String(question?.exam || "").startsWith("JEE") ? "JEE" : question?.exam,
  ].map((value) => String(value || "").trim().toUpperCase());
  return values.some((value) => allowedModes.has(value));
}

function normalizeWeakAreaExamMode(value: unknown): "NEET" | "JEE" | "BOTH" {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "JEE" || normalized === "JEE_MAIN" || normalized === "JEE_ADVANCED" || normalized.startsWith("JEE")) return "JEE";
  if (normalized === "NEET" || normalized === "NEET_UG" || normalized.startsWith("NEET")) return "NEET";
  if (normalized === "BOTH" || normalized === "ALL" || normalized === "MIXED") return "BOTH";
  return "NEET";
}

function getWeakAreaExamModes(mode: SupportedExamMode) {
  return mode === "BOTH" ? new Set(["NEET", "JEE"]) : new Set([mode]);
}

function getQuestionWeakAreaExamMode(question: any): "NEET" | "JEE" | "BOTH" {
  return normalizeWeakAreaExamMode(question?.examMode ?? question?.examType ?? question?.exam);
}

async function updateMistakeProgress({
  userId,
  question,
  questionId,
  answer,
  isCorrect,
  isSkipped,
  sourceInfo,
  sessionId,
  sessionAttemptId,
}: {
  userId: string;
  question: any;
  questionId: string;
  answer: any;
  isCorrect: boolean;
  isSkipped: boolean;
  sourceInfo?: ReturnType<typeof getLearningSourceInfo>;
  sessionId?: string;
  sessionAttemptId?: string;
}) {
  const existing = await Mistake.findOne({ userId, questionId });
  if (!existing && isCorrect) return;

  const attempts = Number(existing?.attempts ?? 0) + 1;
  const correctCount = Number(existing?.correctCount ?? 0) + (isCorrect ? 1 : 0);
  const wrongCount = Number(existing?.wrongCount ?? 0) + (isCorrect ? 0 : 1);
  const skippedCount = Number(existing?.skippedCount ?? 0) + (isSkipped ? 1 : 0);
  const previousAccuracy = Number(existing?.accuracy ?? 0);
  const accuracy = attempts > 0 ? Math.round((correctCount / attempts) * 10000) / 100 : 0;
  const improvementPercentage = Math.max(0, Math.round((accuracy - previousAccuracy) * 100) / 100);
  const completionStatus = existing && isCorrect && accuracy >= 80 ? "completed" : "in_progress";
  const status = attempts === 1 ? "new" : isCorrect || improvementPercentage > 0 ? "improving" : "weak";
  const mode = getQuestionWeakAreaExamMode(question);

  await Mistake.findOneAndUpdate(
    { userId, questionId },
    {
      userId,
      questionId,
      attempts,
      correctCount,
      wrongCount,
      skippedCount,
      accuracy,
      previousAccuracy,
      improvementPercentage,
      completionStatus,
      status,
      mode,
      examType: mode,
      subjectId: String(question.subjectId ?? ""),
      chapterId: String(question.chapterId ?? ""),
      topicId: String(question.topicId ?? ""),
      sourceType: sourceInfo?.sourceType,
      sourceName: sourceInfo?.sourceLabel ?? sourceInfo?.sourceName,
      sourceSessionId: sourceInfo?.sourceSessionId,
      sessionId,
      sessionAttemptId,
      selectedOption: answer.selectedOption || "",
      selectedOptions: Array.isArray(answer.selectedOptions) ? answer.selectedOptions.map(String) : [],
      numericAnswer: answer.numericAnswer ? String(answer.numericAnswer) : "",
      lastAttemptDate: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await MistakeBook.findOneAndUpdate(
    { userId, questionId },
    {
      userId,
      questionId,
      chapter: String(question.chapterId ?? ""),
      attempts,
      status,
      lastAttempt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function questionMatchesWeakAreaMode(question: any, allowedModes: Set<string>) {
  return allowedModes.has(getQuestionWeakAreaExamMode(question));
}

function getQuestionTopicId(question: any) {
  const rawTopicId = question?.topicId ?? question?.topic?._id ?? question?.topic;
  return rawTopicId ? String(rawTopicId) : "";
}

function isWeakPerformance(stats: { total: number; correct: number; wrong: number; totalTime: number }) {
  if (stats.total <= 0) return false;
  const accuracyRatio = stats.correct / stats.total;
  const averageTimeSpent = stats.totalTime / stats.total;
  return accuracyRatio < 0.6 || stats.wrong >= 2 || (averageTimeSpent > 75 && stats.wrong > 0);
}

const SubmitRevisionBody = z.object({
  sessionId: z.string().min(1),
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

async function getRevisionConfig() {
  const settings = await RevisionSettings.findOne({});
  if (!settings) return DEFAULT_REVISION_CONFIG;

  return {
    wrongQuestionLimit: Math.max(1, Number(settings.wrongQuestionLimit ?? DEFAULT_REVISION_CONFIG.wrongQuestionLimit)),
    oldQuestionLimit: Math.max(1, Number(settings.oldQuestionLimit ?? DEFAULT_REVISION_CONFIG.oldQuestionLimit)),
    dailyRevisionLimit: Math.max(1, Number((settings as any).dailyRevisionLimit ?? DEFAULT_REVISION_CONFIG.dailyRevisionLimit)),
    revisionEnabled: settings.revisionEnabled !== false,
    includeWrongQuestions: (settings as any).includeWrongQuestions !== false,
    includeSkippedQuestions: (settings as any).includeSkippedQuestions !== false,
    includeLowAccuracyQuestions: (settings as any).includeLowAccuracyQuestions !== false,
    includeWeakAreaQuestions: (settings as any).includeWeakAreaQuestions !== false,
    accuracyThreshold: Math.max(0, Math.min(100, Number((settings as any).accuracyThreshold ?? DEFAULT_REVISION_CONFIG.accuracyThreshold))),
    minimumCorrectAnswers: Math.max(0, Number((settings as any).minimumCorrectAnswers ?? DEFAULT_REVISION_CONFIG.minimumCorrectAnswers)),
    completionAttemptCount: Math.max(1, Number((settings as any).completionAttemptCount ?? DEFAULT_REVISION_CONFIG.completionAttemptCount)),
    difficultyMode: String((settings as any).difficultyMode ?? DEFAULT_REVISION_CONFIG.difficultyMode),
  };
}

async function normalizeQuestionWithNames(question: any) {
  const [subject, chapter, topic, year] = await Promise.all([
    question.subjectId ? Subject.findById(question.subjectId) : Promise.resolve(null),
    question.chapterId ? Chapter.findById(question.chapterId) : Promise.resolve(null),
    question.topicId ? Topic.findById(question.topicId) : Promise.resolve(null),
    question.yearId ? Year.findById(question.yearId) : Promise.resolve(null),
  ]);
  const normalized = normalizeQuestionDocument(question);

  return {
    ...normalized,
    subjectName: subject?.name ?? "Unknown",
    chapterName: chapter?.name ?? "Unknown",
    topicName: topic?.name ?? "General",
    ...resolveQuestionYearFields(normalized, year as any),
  };
}

async function buildRevisionSet(userId: string, examPattern: "NEET" | "JEE" | "BOTH" = "NEET") {
  const config = await getRevisionConfig();
  if (!config.revisionEnabled) {
    return {
      wrongQuestions: [],
      oldCorrectQuestions: [],
      questions: [],
      totalCount: 0,
      enabled: false,
      config,
    };
  }

  const allowedModes = new Set([examPattern]);
  const mixedSubjectIds = await getMixedSubjectIdsForExamMode(examPattern);
  const subjectMatch = mixedSubjectIds.length ? buildFlexibleFieldMatch("subjectId", mixedSubjectIds) : undefined;
  const latestAttempt = await SessionAttempt.findOne({ userId, completedAt: { $ne: null } }).sort({ completedAt: -1, createdAt: -1 });
  const latestAttemptClauses: Record<string, unknown>[] = [];
  if (config.includeWrongQuestions) latestAttemptClauses.push({ isCorrect: false, skipped: { $ne: true } });
  if (config.includeSkippedQuestions) latestAttemptClauses.push({ skipped: true });
  const latestWrongAttempts = latestAttempt && latestAttemptClauses.length
    ? await QuestionAttempt.find({
        userId,
        sessionAttemptId: String(latestAttempt.id),
        $or: latestAttemptClauses,
      }).sort({ createdAt: 1 }).limit(config.dailyRevisionLimit)
    : [];

  const revisionIds = new Set<string>(latestWrongAttempts.map((item) => String(item.questionId)).filter(Boolean));

  if (config.includeWrongQuestions || config.includeSkippedQuestions) {
    const mistakeClauses: Record<string, unknown>[] = [];
    if (config.includeWrongQuestions) mistakeClauses.push({ wrongCount: { $gt: 0 } });
    if (config.includeSkippedQuestions) mistakeClauses.push({ skippedCount: { $gt: 0 } });
    const mistakeEntries = await Mistake.find({
      userId,
      completionStatus: { $ne: "completed" },
      ...(mistakeClauses.length ? { $or: mistakeClauses } : {}),
    }).sort({ lastAttemptDate: -1 }).limit(config.dailyRevisionLimit * 2);
    mistakeEntries.forEach((item) => {
      if (revisionIds.size < config.dailyRevisionLimit) revisionIds.add(String(item.questionId));
    });
  }

  if (revisionIds.size < config.dailyRevisionLimit && (config.includeLowAccuracyQuestions || config.includeWeakAreaQuestions)) {
    const weakFilter: Record<string, unknown> = {
      userId,
      isMastered: { $ne: true },
      examMode: examPattern,
      $or: [],
    };
    if (config.includeWeakAreaQuestions) (weakFilter.$or as any[]).push({ isWeak: true });
    if (config.includeLowAccuracyQuestions) (weakFilter.$or as any[]).push({ accuracy: { $lt: config.accuracyThreshold / 100 } });
    if (!(weakFilter.$or as any[]).length) delete weakFilter.$or;
    const weakAreas = await ChapterPerformance.find(weakFilter).sort({ accuracy: 1, updatedAt: -1 }).limit(20);
    for (const area of weakAreas) {
      for (const id of ((area.incorrectQuestionIds ?? []) as string[]).map(String)) {
        if (revisionIds.size < config.dailyRevisionLimit) revisionIds.add(id);
      }
      if (revisionIds.size >= config.dailyRevisionLimit) break;
      const areaQuestions = await Question.find({
        $and: [
          buildFlexibleFieldMatch("chapterId", [String(area.chapterId)]),
          ...(area.topicId ? [buildFlexibleFieldMatch("topicId", [String(area.topicId)])] : []),
          ...(subjectMatch ? [subjectMatch] : []),
          buildStrictQuestionExamModeQuery(examPattern),
        ].filter(Boolean),
      }).select("_id").limit(config.dailyRevisionLimit - revisionIds.size);
      areaQuestions.forEach((question: any) => revisionIds.add(String(question._id)));
      if (revisionIds.size >= config.dailyRevisionLimit) break;
    }
  }

  const wrongQuestionIds = [...revisionIds].slice(0, config.dailyRevisionLimit);
  const wrongQuestionsRaw = wrongQuestionIds.length
    ? await Question.find({
        $and: [
          { _id: { $in: buildIdVariants(wrongQuestionIds) } },
          ...(subjectMatch ? [subjectMatch] : []),
          buildStrictQuestionExamModeQuery(examPattern),
          ...(config.difficultyMode && config.difficultyMode !== "mixed" ? [{ difficulty: config.difficultyMode }] : []),
        ],
      }).populate("questionTypeId")
    : [];
  const wrongQuestionMap = new Map(wrongQuestionsRaw.map((item: any) => [String(item._id), item]));
  const wrongQuestions = wrongQuestionIds
    .map((id) => wrongQuestionMap.get(id))
    .filter(Boolean)
    .filter((item: any) => questionMatchesExamMode(item, allowedModes));

  const oldCorrectQuestions: any[] = [];

  const deduped = new Map<string, any>();
  wrongQuestions.forEach((question: any) => {
    deduped.set(String(question._id ?? question.id), question);
  });

  const totalRevisionLimit = config.dailyRevisionLimit;
  const questions = [...deduped.values()].slice(0, totalRevisionLimit);

  return {
    wrongQuestions,
    oldCorrectQuestions,
    questions,
    totalCount: questions.length,
    enabled: true,
    config,
  };
}

function getDailyRevisionSourceId(userId: string, examMode: SupportedExamMode, dateKey = getTodayDateKey()) {
  return `revision:${userId}:${examMode}:${dateKey}`;
}

function getWeakAreaPracticeSourceId(userId: string, examMode: string, chapterId: string, topicId?: string) {
  return `weak_area:${userId}:${String(examMode || "NEET").toUpperCase()}:${String(chapterId || "all-chapters")}:${String(topicId || "chapter")}`;
}

async function getQuestionsByStoredOrder(questionIds: string[]) {
  if (!questionIds.length) return [];
  const questions = await Question.find({ _id: { $in: buildIdVariants(questionIds) } }).populate("questionTypeId");
  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
  return questionIds.map((id) => questionMap.get(String(id))).filter(Boolean);
}

async function getRevisionAttemptSummary(userId: string, sourceSessionId: string) {
  const attempts = await SessionAttempt.find({ userId, sourceSessionId, completedAt: { $ne: null } }).sort({ completedAt: -1, createdAt: -1 });
  const latestAttempt = attempts[0];
  return {
    attemptCount: attempts.length,
    completed: Boolean(latestAttempt),
    latestAttempt: latestAttempt
      ? {
          id: latestAttempt.id,
          attemptNumber: latestAttempt.attemptNumber ?? attempts.length,
          score: latestAttempt.score ?? 0,
          accuracy: latestAttempt.accuracy ?? 0,
          percentage: latestAttempt.accuracy ?? 0,
          timeTaken: latestAttempt.timeTaken ?? 0,
          correctAnswers: latestAttempt.correctCount ?? 0,
          correctCount: latestAttempt.correctCount ?? 0,
          wrongAnswers: latestAttempt.incorrectCount ?? 0,
          incorrectCount: latestAttempt.incorrectCount ?? 0,
          skippedCount: latestAttempt.skippedCount ?? 0,
          totalQuestions: latestAttempt.totalQuestions ?? 0,
          attemptedQuestions: Number(latestAttempt.correctCount ?? 0) + Number(latestAttempt.incorrectCount ?? 0),
          completedAt: latestAttempt.completedAt ?? latestAttempt.createdAt,
          completionStatus: "Completed",
        }
      : null,
  };
}

async function getOrCreateDailyRevisionSession(userId: string, examMode: SupportedExamMode) {
  const dateKey = getTodayDateKey();
  const sourceSessionId = getDailyRevisionSourceId(userId, examMode, dateKey);
  const existing = await LearningSession.findOne({
    userId,
    type: "revision",
    origin: "revision",
    sourceSessionId,
  }).sort({ createdAt: 1 });

  if (existing) {
    const snapshot = (existing.filterSnapshot ?? {}) as Record<string, any>;
    const questions = await getQuestionsByStoredOrder((existing.questionIds ?? []).map(String));
    const wrongIdSet = new Set((snapshot.wrongQuestionIds ?? []).map(String));
    const oldIdSet = new Set((snapshot.oldCorrectQuestionIds ?? []).map(String));
    return {
      session: existing,
      revisionSet: {
        wrongQuestions: questions.filter((question: any) => wrongIdSet.has(String(question._id ?? question.id))),
        oldCorrectQuestions: questions.filter((question: any) => oldIdSet.has(String(question._id ?? question.id))),
        questions,
        totalCount: questions.length,
        enabled: snapshot.enabled !== false,
        config: await getRevisionConfig(),
      },
      sourceSessionId,
      dateKey,
      isExisting: true,
    };
  }

  const revisionSet = await buildRevisionSet(userId, examMode);
  const questionIds = revisionSet.questions.map((question: any) => String(question._id ?? question.id));
  const session = revisionSet.enabled && questionIds.length
    ? await createLearningSession({
        userId,
        type: "revision",
        origin: "revision",
        modeKey: examMode,
        questionIds,
        sourceSessionId,
        isRetestGroup: true,
        filterSnapshot: {
          source: "revision_module",
          dateKey,
          examMode,
          enabled: revisionSet.enabled,
          wrongQuestionIds: revisionSet.wrongQuestions.map((question: any) => String(question._id ?? question.id)),
          oldCorrectQuestionIds: revisionSet.oldCorrectQuestions.map((question: any) => String(question._id ?? question.id)),
        },
        title: `${examMode} Revision - ${dateKey}`,
      })
    : null;

  return { session, revisionSet, sourceSessionId, dateKey, isExisting: false };
}

async function handleWeakAreas(req: AuthenticatedRequest, res: any) {
  const userId = req.userId!;
  const examMode = getRequestExamMode(req);
  const allowedModes = getWeakAreaExamModes(examMode);

  const attempts = await QuestionAttempt.find({ userId }).sort({ createdAt: -1 }).limit(2000);
  const questionIds = [...new Set(attempts.map((attempt) => String(attempt.questionId)).filter(Boolean))];
  const questions = questionIds.length ? await Question.find({ _id: { $in: questionIds } }).select("_id subjectId chapterId topicId examMode examType exam") : [];
  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));

  const groupMap = new Map<
    string,
    {
      subjectId: string;
      chapterId: string;
      topicId: string;
      total: number;
      correct: number;
      wrong: number;
      skipped: number;
      totalTime: number;
      lastPracticed?: Date;
      examType?: string;
      incorrectQuestionIds: Set<string>;
    }
  >();

  for (const attempt of attempts) {
    const question = questionMap.get(String(attempt.questionId));
    if (!question || !questionMatchesWeakAreaMode(question, allowedModes)) continue;

    const subjectId = String(attempt.subjectId || question.subjectId || "");
    const chapterId = String(attempt.chapterId || question.chapterId || "");
    const topicId = getQuestionTopicId(question);
    const areaExamType = getQuestionWeakAreaExamMode(question);
    if (!subjectId || !chapterId) continue;

    const groupKey = `${areaExamType}|${subjectId}|${chapterId}|${topicId || "chapter"}`;
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        subjectId,
        chapterId,
        topicId,
        total: 0,
        correct: 0,
        wrong: 0,
        skipped: 0,
        totalTime: 0,
        lastPracticed: attempt.createdAt,
        examType: areaExamType,
        incorrectQuestionIds: new Set<string>(),
      });
    }

    const stats = groupMap.get(groupKey)!;
    stats.total += 1;
    stats.correct += attempt.isCorrect ? 1 : 0;
    stats.wrong += !attempt.isCorrect && !attempt.skipped ? 1 : 0;
    stats.skipped += attempt.skipped ? 1 : 0;
    if (!attempt.isCorrect || attempt.skipped) stats.incorrectQuestionIds.add(String(attempt.questionId));
    stats.totalTime += Number(attempt.timeSpent ?? 0);
    if (!stats.lastPracticed || attempt.createdAt > stats.lastPracticed) stats.lastPracticed = attempt.createdAt;
  }

  const weakFromAttempts = [...groupMap.entries()]
    .filter(([, stats]) => isWeakPerformance(stats))
    .map(([id, stats]) => {
      const accuracy = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
      return {
        id,
        subjectId: stats.subjectId,
        chapterId: stats.chapterId,
        topicId: stats.topicId,
        examMode: stats.examType ?? examMode,
        examType: stats.examType ?? examMode,
        accuracy,
        attempts: stats.total,
        totalQuestions: stats.incorrectQuestionIds.size || stats.wrong + stats.skipped,
        questionCount: stats.incorrectQuestionIds.size || stats.wrong + stats.skipped,
        incorrectQuestionIds: [...stats.incorrectQuestionIds],
        wrongCount: stats.wrong,
        skippedCount: stats.skipped,
        averageTimeSpent: stats.total > 0 ? stats.totalTime / stats.total : 0,
        strength: accuracy < 50 ? "weak" : "medium",
        lastPracticed: stats.lastPracticed,
      };
    });

  const weakPerf = await ChapterPerformance.find({ userId, totalAttempts: { $gt: 0 } });
  const performanceSubjectIds = [...new Set(weakPerf.map((p) => String(p.subjectId)).filter(Boolean))];
  const performanceSubjects = performanceSubjectIds.length
    ? await Subject.find({ _id: { $in: performanceSubjectIds } }).select("_id examType examMode")
    : [];
  const performanceSubjectModeMap = new Map(
    performanceSubjects.map((subject) => [String(subject._id), normalizeWeakAreaExamMode(subject.examType ?? subject.examMode)]),
  );
  const weakFromPerformance = weakPerf
    .filter((p) => p.isMastered || p.isWeak || p.accuracy < 0.6 || Number(p.wrongCount ?? 0) > 0 || Number((p as any).skippedCount ?? 0) > 0)
    .map((p) => {
      const areaExamType = normalizeWeakAreaExamMode(p.examMode ?? performanceSubjectModeMap.get(String(p.subjectId)) ?? examMode);
      const accuracyPercent = Number(p.accuracy ?? 0) * 100;
      return {
        id: p._id.toString(),
        subjectId: String(p.subjectId),
        chapterId: String(p.chapterId),
        topicId: String((p as any).topicId ?? ""),
        examMode: areaExamType,
        examType: areaExamType,
        accuracy: accuracyPercent,
        attempts: Number((p as any).attemptCount ?? 0),
        attemptCount: Number((p as any).attemptCount ?? 0),
        totalQuestionAttempts: Number(p.totalAttempts ?? 0),
        totalQuestions:
          Number((p as any).weakQuestionIds?.length ?? 0)
          || Number((p as any).incorrectQuestionIds?.length ?? 0)
          || Number(p.totalAttempts ?? 0),
        questionCount:
          Number((p as any).weakQuestionIds?.length ?? 0)
          || Number((p as any).incorrectQuestionIds?.length ?? 0)
          || Number(p.totalAttempts ?? 0),
        weakQuestionIds: ((p as any).weakQuestionIds ?? []).map(String),
        incorrectQuestionIds: ((p as any).incorrectQuestionIds ?? []).map(String),
        wrongCount: Number(p.wrongCount ?? 0),
        correctCount: Number(p.correctCount ?? 0),
        skippedCount: Number((p as any).skippedCount ?? 0),
        averageTimeSpent: Number(p.averageTimeSpent ?? 0),
        improvementPercentage: Number(p.improvementPercentage ?? 0),
        completionPercentage: Number(p.completionPercentage ?? accuracyPercent),
        masteryPercentage: Number(p.masteryPercentage ?? accuracyPercent),
        isMastered: Boolean(p.isMastered),
        strength: p.strength,
        lastTestStatus: p.lastTestStatus || (p.isMastered ? "Mastered" : p.isWeak ? "Needs Re-Test" : "Improving"),
        lastPracticed: p.lastPracticed,
        sourceType: (p as any).sourceType,
        sourceName: (p as any).sourceName,
        sourceSessionId: (p as any).sourceSessionId,
        completedDate: (p as any).completedAt,
      };
    })
    .filter((area) => allowedModes.has(normalizeWeakAreaExamMode(area.examType)));

  const merged = new Map<string, any>();
  [...weakFromAttempts, ...weakFromPerformance].forEach((area) => {
    const areaExamType = normalizeWeakAreaExamMode(area.examType ?? area.examMode);
    const key = `${areaExamType}|${area.subjectId}|${area.chapterId}|${area.topicId || "chapter"}`;
    const existing = merged.get(key);
    if (existing?.isMastered && !area.isMastered) return;
    const areaQuestionPoolSize = Number(area.totalQuestions ?? area.questionCount ?? area.weakQuestionIds?.length ?? area.incorrectQuestionIds?.length ?? 0);
    const existingQuestionPoolSize = Number(existing?.totalQuestions ?? existing?.questionCount ?? existing?.weakQuestionIds?.length ?? existing?.incorrectQuestionIds?.length ?? 0);
    if (
      area.isMastered
      || !existing
      || areaQuestionPoolSize > existingQuestionPoolSize
      || (!existingQuestionPoolSize && Number(area.attempts ?? 0) >= Number(existing.attempts ?? 0))
    ) {
      merged.set(key, { ...area, examMode: areaExamType, examType: areaExamType });
    }
  });

  const areas = [...merged.values()].sort((a, b) => Number(a.accuracy ?? 100) - Number(b.accuracy ?? 100));
  const subjectIds = [...new Set(areas.map((area) => String(area.subjectId)).filter(Boolean))];
  const chapterIds = [...new Set(areas.map((area) => String(area.chapterId)).filter(Boolean))];
  const topicIds = [...new Set(areas.map((area) => String(area.topicId)).filter(Boolean))];
  const [subjects, chapters, topics] = await Promise.all([
    subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }) : [],
    chapterIds.length ? Chapter.find({ _id: { $in: chapterIds } }) : [],
    topicIds.length ? Topic.find({ _id: { $in: topicIds } }) : [],
  ]);
  const subjectNameMap = new Map(subjects.map((subject) => [String(subject._id), subject.name]));
  const subjectExamMap = new Map(subjects.map((subject) => [String(subject._id), normalizeWeakAreaExamMode(subject.examType || subject.examMode)]));
  const chapterNameMap = new Map(chapters.map((chapter) => [String(chapter._id), chapter.name]));
  const topicNameMap = new Map(topics.map((topic) => [String(topic._id), topic.name]));
  const sourceIds = [
    ...new Set(
      areas
        .map((area) => getWeakAreaPracticeSourceId(userId, area.examType ?? area.examMode, area.chapterId, area.topicId))
        .filter(Boolean),
    ),
  ];
  const [sourceSessions, latestSourceAttempts] = await Promise.all([
    sourceIds.length
      ? LearningSession.find({ userId, sourceSessionId: { $in: sourceIds } }).sort({ createdAt: 1 })
      : [],
    sourceIds.length
      ? SessionAttempt.find({ userId, sourceSessionId: { $in: sourceIds }, completedAt: { $ne: null } }).sort({ completedAt: -1, createdAt: -1 })
      : [],
  ]);
  const sourceSessionMap = new Map<string, any>();
  sourceSessions.forEach((session: any) => {
    const sourceId = String(session.sourceSessionId || "");
    if (sourceId && !sourceSessionMap.has(sourceId)) sourceSessionMap.set(sourceId, session);
  });
  const latestAttemptMap = new Map<string, any>();
  const attemptCountMap = new Map<string, number>();
  latestSourceAttempts.forEach((attempt: any) => {
    const sourceId = String(attempt.sourceSessionId || "");
    if (sourceId) attemptCountMap.set(sourceId, Number(attemptCountMap.get(sourceId) ?? 0) + 1);
    if (sourceId && !latestAttemptMap.has(sourceId)) latestAttemptMap.set(sourceId, attempt);
  });
  const latestAttemptIds = [...latestAttemptMap.values()].map((attempt: any) => String(attempt.id));
  const latestQuestionAttempts = latestAttemptIds.length
    ? await QuestionAttempt.find({ userId, sessionAttemptId: { $in: latestAttemptIds } })
    : [];
  const latestAttemptStats = new Map<string, { correct: number; wrong: number; skipped: number; total: number }>();
  latestQuestionAttempts.forEach((attempt: any) => {
    const key = String(attempt.sessionAttemptId || "");
    if (!latestAttemptStats.has(key)) latestAttemptStats.set(key, { correct: 0, wrong: 0, skipped: 0, total: 0 });
    const stats = latestAttemptStats.get(key)!;
    stats.total += 1;
    if (attempt.skipped) stats.skipped += 1;
    else if (attempt.isCorrect) stats.correct += 1;
    else stats.wrong += 1;
  });

  res.json(
    areas.map((area) => {
      const sourceId = getWeakAreaPracticeSourceId(userId, area.examType ?? area.examMode, area.chapterId, area.topicId);
      const sourceSession = sourceId ? sourceSessionMap.get(sourceId) : null;
      const latestAttempt = sourceId ? latestAttemptMap.get(sourceId) : null;
      const latestStats = latestAttempt ? latestAttemptStats.get(String(latestAttempt.id)) : null;
      const stableQuestionIds = [
        ...new Set([
          ...((area.weakQuestionIds ?? []) as string[]).map(String),
          ...((area.incorrectQuestionIds ?? []) as string[]).map(String),
          ...((sourceSession?.questionIds ?? []) as string[]).map(String),
        ].filter(Boolean)),
      ];
      const totalQuestions = stableQuestionIds.length || Number(area.questionCount ?? area.totalQuestions ?? 0);
      const weakAreaAttemptCount = Number(attemptCountMap.get(sourceId) ?? 0);
      const latestCorrectCount = weakAreaAttemptCount > 0 ? (latestStats?.correct ?? Number(latestAttempt?.correctCount ?? 0)) : 0;
      const latestWrongCount = weakAreaAttemptCount > 0 ? (latestStats?.wrong ?? Number(latestAttempt?.incorrectCount ?? 0)) : totalQuestions;
      const latestSkippedCount = weakAreaAttemptCount > 0 ? (latestStats?.skipped ?? Number(latestAttempt?.skippedCount ?? 0)) : 0;
      const latestTotalQuestions = weakAreaAttemptCount > 0 ? (latestStats?.total ?? Number(latestAttempt?.totalQuestions ?? totalQuestions)) : totalQuestions;
      const latestAccuracy = latestTotalQuestions > 0 ? (latestCorrectCount / latestTotalQuestions) * 100 : Number(area.accuracy ?? 0);
      const currentStatus = area.isMastered || (totalQuestions > 0 && latestCorrectCount === totalQuestions && latestWrongCount === 0 && latestSkippedCount === 0)
        ? "Strong"
        : latestCorrectCount > 0 || weakAreaAttemptCount > 0
          ? "Improving"
          : "Weak";
      const effectiveMastered = currentStatus === "Strong";
      return {
        ...area,
        sourceSessionId: sourceId,
        isMastered: effectiveMastered,
        strength: effectiveMastered ? "strong" : area.strength,
        masteryPercentage: effectiveMastered ? 100 : area.masteryPercentage,
        completionPercentage: effectiveMastered ? 100 : area.completionPercentage,
        totalQuestions,
        questionCount: totalQuestions,
        attemptCount: weakAreaAttemptCount,
        attempts: weakAreaAttemptCount,
        latestCorrectCount,
        latestWrongCount,
        latestSkippedCount,
        latestTotalQuestions,
        latestAccuracy,
        accuracy: latestAccuracy,
        currentStatus,
        subjectName: subjectNameMap.get(String(area.subjectId)) ?? "Unknown",
        examMode: normalizeWeakAreaExamMode(area.examMode ?? area.examType ?? subjectExamMap.get(String(area.subjectId))),
        examType: normalizeWeakAreaExamMode(area.examType ?? area.examMode ?? subjectExamMap.get(String(area.subjectId))),
        chapterName: chapterNameMap.get(String(area.chapterId)) ?? "Unknown",
        topicName: area.topicId ? topicNameMap.get(String(area.topicId)) ?? "General" : undefined,
      };
    }),
  );
}

router.get("/revision", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const examMode = getRequestExamMode(req);

  const { session, revisionSet, sourceSessionId, dateKey } = await getOrCreateDailyRevisionSession(userId, examMode);
  const attemptSummary = await getRevisionAttemptSummary(userId, sourceSessionId);
  if (!revisionSet.enabled) {
    res.json({
      sessionId: null,
      wrongQuestions: [],
      oldQuestions: [],
      questions: [],
      wrongCount: 0,
      oldCount: 0,
      totalCount: 0,
      configuredTotalCount: 0,
      timeLimit: 0,
      status: "disabled",
      message: "Revision module is disabled by admin",
    });
    return;
  }

  if (!session || revisionSet.questions.length === 0) {
    res.json({
      sessionId: null,
      wrongQuestions: [],
      oldQuestions: [],
      questions: [],
      wrongCount: 0,
      oldCount: 0,
      totalCount: 0,
      configuredTotalCount: revisionSet.config.wrongQuestionLimit + revisionSet.config.oldQuestionLimit,
      timeLimit: 0,
      status: "empty",
      message: "No Revision Pending",
    });
    return;
  }

  const [wrongQuestions, oldQuestions, questions] = await Promise.all([
    Promise.all(revisionSet.wrongQuestions.map((question: any) => normalizeQuestionWithNames(question))),
    Promise.all(revisionSet.oldCorrectQuestions.map((question: any) => normalizeQuestionWithNames(question))),
    Promise.all(revisionSet.questions.map((question: any) => normalizeQuestionWithNames(question))),
  ]);

  res.json({
    sessionId: session.id,
    origin: "revision",
    dateKey,
    sourceSessionId,
    attemptCount: attemptSummary.attemptCount,
    nextAttemptNumber: attemptSummary.attemptCount + 1,
    completedToday: attemptSummary.completed,
    latestAttempt: attemptSummary.latestAttempt,
    wrongQuestions,
    oldQuestions,
    questions,
    wrongCount: revisionSet.wrongQuestions.length,
    oldCount: revisionSet.oldCorrectQuestions.length,
    totalCount: revisionSet.totalCount,
    configuredTotalCount: revisionSet.config.wrongQuestionLimit + revisionSet.config.oldQuestionLimit,
    timeLimit: revisionSet.totalCount * 90,
    status: "ready",
  });
});

router.post("/revision/submit", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const body = SubmitRevisionBody.parse(req.body);
    const userId = req.userId!;
    const session = await LearningSession.findById(body.sessionId);

    if (!session || session.userId !== userId || session.type !== "revision") {
      res.status(404).json({ error: "not_found", message: "Revision session not found" });
      return;
    }

    const questions = await Question.find({ _id: { $in: session.questionIds } }).populate("questionTypeId");
    const questionMap = new Map<string, any>(questions.map((question: any) => [String(question._id), question]));
    const sourceSessionId = session.sourceSessionId ?? session.id;

    let correct = 0;
    let incorrect = 0;
    let skipped = 0;
    let score = 0;

    const topicMap: Record<
      string,
      {
        subjectId: string;
        chapterId: string;
        topicId: string;
        total: number;
        correct: number;
        wrong: number;
        skipped: number;
        totalTime: number;
        correctQuestionIds: Set<string>;
        incorrectQuestionIds: Set<string>;
      }
    > = {};
    const questionAttemptDocs: Array<Record<string, unknown>> = [];
    const performanceDocs: Array<Record<string, unknown>> = [];

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

      if (isSkipped) {
        skipped += 1;
      } else if (isCorrect) {
        correct += 1;
      } else {
        incorrect += 1;
      }

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
          skipped: 0,
          totalTime: 0,
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

      questionAttemptDocs.push({
        userId,
        sessionId: session.id,
        questionId,
        modeId: question.modeId,
        subjectId: String(question.subjectId),
        chapterId: String(question.chapterId),
        topicId,
        yearId: question.yearId,
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
      performanceDocs.push({
        userId,
        questionId,
        isCorrect,
        timeTaken: Number(answer.timeSpent ?? 0),
      });
    }

    const totalQuestions = body.answers.length;
    const accuracy = totalQuestions > 0 ? (correct / totalQuestions) * 100 : 0;
    const maxScore = totalQuestions * 4;

    const sessionAttempt = await new SessionAttempt({
      userId,
      sessionId: session.id,
      sourceSessionId,
      attemptNumber: (await SessionAttempt.countDocuments({ userId, sourceSessionId })) + 1,
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

    const sourceInfo = getLearningSourceInfo(session);
    for (const item of questionAttemptDocs) {
      const question = questionMap.get(String(item.questionId));
      const answer = body.answers.find((entry) => String(entry.questionId) === String(item.questionId)) ?? {
        questionId: String(item.questionId),
        skipped: true,
      };
      if (!question) continue;
      await updateMistakeProgress({
        userId,
        question,
        questionId: String(item.questionId),
        answer,
        isCorrect: Boolean(item.isCorrect),
        isSkipped: Boolean(item.skipped),
        sourceInfo,
        sessionId: session.id,
        sessionAttemptId: sessionAttempt.id,
      });
    }

    if (questionAttemptDocs.length) {
      await QuestionAttempt.insertMany(
        questionAttemptDocs.map((item) => ({
          ...item,
          sessionAttemptId: sessionAttempt.id,
        })),
      );
    }
    if (performanceDocs.length) {
      await Performance.insertMany(performanceDocs);
    }

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
      const chapterAccuracyPercent = chapterAccuracy * 100;
      const previousAccuracyPercent = Number(existing?.accuracy ?? 0) * 100;
      const latestAttemptComplete = stats.total > 0 && stats.correct === stats.total && stats.wrong === 0 && stats.skipped === 0;
      const isMastered = attemptCount > 1 && latestAttemptComplete;
      const progressPercentage = isMastered ? 100 : chapterAccuracyPercent;
      const improvementPercentage = Math.max(0, progressPercentage - previousAccuracyPercent);
      const masteryPercentage = Math.min(100, Math.round(progressPercentage * 100) / 100);
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
          improvementPercentage,
          completionPercentage: masteryPercentage,
          masteryPercentage,
          isWeak: !isMastered && isWeak,
          isMastered,
          examMode: getQuestionWeakAreaExamMode({ examMode: session.modeKey }),
          sourceType: sourceInfo.sourceType,
          sourceName: sourceInfo.sourceLabel,
          sourceSessionId: sourceInfo.sourceSessionId,
          completedAt: isMastered ? new Date() : existing?.completedAt,
          lastTestStatus: isMastered ? "Mastered" : isWeak ? "Needs Re-Test" : "Improving",
          averageTimeSpent,
          strength,
          lastPracticed: new Date(),
        },
        { upsert: true, new: true },
      );
    }

    await new RevisionHistory({
      userId,
      questionIds: questionAttemptDocs.map((item) => String(item.questionId)),
      totalQuestions,
      correctAnswers: correct,
      accuracy,
      completedAt: new Date(),
    }).save();

    res.json({
      sessionId: session.id,
      attemptId: sessionAttempt.id,
      score,
      accuracy,
      timeTaken: body.timeTaken,
      correctCount: correct,
      incorrectCount: incorrect,
      skippedCount: skipped,
      totalQuestions,
      maxScore,
      completionStatus: "Completed",
    });
  } catch (error) {
    req.log.error({ error }, "Submit revision failed");
    res.status(500).json({ error: "submit_failed", message: "Failed to submit revision" });
  }
});

router.get("/revision/history", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const examMode = getRequestExamMode(req);
  const modeFilter = req.query.mode ? examMode : undefined;
  const revisionSessions = await LearningSession.find({
    userId,
    type: "revision",
    origin: "revision",
    ...(modeFilter ? { modeKey: modeFilter } : {}),
  }).select("_id id title modeKey sourceSessionId filterSnapshot");
  const sessionIds = revisionSessions.map((session: any) => String(session.id));
  const sourceIds = revisionSessions.map((session: any) => String(session.sourceSessionId || session.id)).filter(Boolean);
  const sessionMap = new Map(revisionSessions.map((session: any) => [String(session.id), session]));

  const attempts = await SessionAttempt.find({
    userId,
    completedAt: { $ne: null },
    $or: [
      { sessionId: { $in: sessionIds } },
      { sourceSessionId: { $in: sourceIds } },
    ],
  }).sort({ completedAt: -1, createdAt: -1 }).limit(200);

  const rows = attempts.map((attempt: any) => {
    const session = sessionMap.get(String(attempt.sessionId));
    const snapshot = (session?.filterSnapshot ?? {}) as Record<string, any>;
    const totalQuestions = Number(attempt.totalQuestions ?? 0);
    const correctAnswers = Number(attempt.correctCount ?? 0);
    const wrongAnswers = Number(attempt.incorrectCount ?? 0);
    const skippedCount = Number(attempt.skippedCount ?? 0);
    const percentage = totalQuestions > 0 ? Math.round((correctAnswers / totalQuestions) * 10000) / 100 : 0;
    const completedAt = attempt.completedAt ?? attempt.createdAt;
    return {
      id: attempt.id,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      sourceSessionId: attempt.sourceSessionId,
      revisionDate: snapshot.dateKey ?? new Date(completedAt).toISOString().slice(0, 10),
      attemptNumber: attempt.attemptNumber ?? 1,
      testName: session?.title ?? "Revision Test",
      testType: "Revision Test",
      examMode: session?.modeKey ?? examMode,
      score: attempt.score ?? 0,
      totalQuestions,
      correctAnswers,
      wrongAnswers,
      incorrectCount: wrongAnswers,
      skippedCount,
      attemptedQuestions: correctAnswers + wrongAnswers,
      percentage,
      accuracy: percentage,
      completionStatus: "Completed",
      completedAt,
    };
  });

  res.json({ data: rows, summary: { totalAttempts: rows.length } });
});

router.get("/revision/today", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const examMode = getRequestExamMode(req);
  const { session, revisionSet, sourceSessionId, dateKey } = await getOrCreateDailyRevisionSession(userId, examMode);
  const attemptSummary = await getRevisionAttemptSummary(userId, sourceSessionId);
  const [wrongQuestions, oldCorrectQuestions] = await Promise.all([
    Promise.all(revisionSet.wrongQuestions.map((question: any) => normalizeQuestionWithNames(question))),
    Promise.all(revisionSet.oldCorrectQuestions.map((question: any) => normalizeQuestionWithNames(question))),
  ]);

  res.json({
    sessionId: session?.id ?? null,
    dateKey,
    sourceSessionId,
    wrongQuestions,
    oldCorrectQuestions,
    totalCount: revisionSet.totalCount,
    configuredTotalCount: revisionSet.config.wrongQuestionLimit + revisionSet.config.oldQuestionLimit,
    enabled: revisionSet.enabled,
    attemptCount: attemptSummary.attemptCount,
    totalAttempts: attemptSummary.attemptCount,
    completedToday: attemptSummary.completed,
    latestAttempt: attemptSummary.latestAttempt,
    todayStatus: attemptSummary.completed ? "Completed" : revisionSet.totalCount > 0 ? "Pending" : "No Revision Pending",
  });
});

router.get("/weak-areas", requireAuth, requireOnboardingComplete, handleWeakAreas);

router.get("/mistakes", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const examMode = getRequestExamMode(req);
  const questionModeFilter = buildQuestionModeFilter(examMode);
  const { status, subjectId } = req.query as Record<string, string>;

  const filter: Record<string, unknown> = { userId, completionStatus: { $ne: "completed" } };
  if (status) filter.status = status;
  if (!req.user?.isPremium) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    filter.lastAttemptDate = { $gte: start, $lt: end };
  }

  const allMistakes = await Mistake.find(filter);
  const result = await Promise.all(
    allMistakes.map(async (mistake) => {
      const question = await Question.findOne({ _id: mistake.questionId, ...questionModeFilter });
      if (!question) return null;

      if (subjectId && String(question.subjectId) !== String(subjectId)) return null;

      const [subject, chapter, topic, year, latestAttempt] = await Promise.all([
        Subject.findById(question.subjectId),
        Chapter.findById(question.chapterId),
        question.topicId ? Topic.findById(question.topicId) : Promise.resolve(null),
        question.yearId ? Year.findById(question.yearId) : Promise.resolve(null),
        QuestionAttempt.findOne({ userId, questionId: String(question._id) }).sort({ createdAt: -1 }),
      ]);
      const normalizedQuestion = normalizeQuestionDocument(question);

      return {
        id: mistake._id.toString(),
        questionId: mistake.questionId,
        question: {
          ...normalizedQuestion,
          subjectName: subject?.name ?? "Unknown",
          chapterName: chapter?.name ?? "Unknown",
          topicName: topic?.name ?? "General",
          ...resolveQuestionYearFields(normalizedQuestion, year as any),
        },
        status: mistake.status,
        attempts: mistake.attempts,
        totalAttempts: mistake.attempts,
        correctCount: mistake.correctCount ?? 0,
        wrongCount: mistake.wrongCount ?? 0,
        skippedCount: mistake.skippedCount ?? 0,
        accuracy: mistake.accuracy ?? 0,
        previousAccuracy: mistake.previousAccuracy ?? 0,
        improvementPercentage: mistake.improvementPercentage ?? 0,
        completionStatus: mistake.completionStatus ?? "in_progress",
        mode: mistake.mode ?? getQuestionWeakAreaExamMode(question),
        examMode: mistake.mode ?? getQuestionWeakAreaExamMode(question),
        examType: mistake.examType ?? mistake.mode ?? getQuestionWeakAreaExamMode(question),
        sourceType: mistake.sourceType ?? "Practice Test",
        sourceName: mistake.sourceName ?? "Practice Test",
        sourceSessionId: mistake.sourceSessionId,
        lastAttemptDate: mistake.lastAttemptDate,
        subjectId: String(question.subjectId),
        subjectName: subject?.name ?? "Unknown",
        chapterId: String(question.chapterId),
        chapterName: chapter?.name ?? "Unknown",
        topicId: String(question.topicId ?? ""),
        topicName: topic?.name ?? "General",
        wrongQuestionsCount: 1,
        selectedOption: latestAttempt?.selectedOption,
        selectedOptions: latestAttempt?.selectedOptions ?? [],
        numericAnswer: latestAttempt?.numericAnswer,
      };
    }),
  );

  res.json(result.filter(Boolean));
});

router.get("/mistakes/history", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const examMode = getRequestExamMode(req);
  const questionModeFilter = buildQuestionModeFilter(examMode);
  const { subjectId, chapterId, topicId, date } = req.query as Record<string, string>;

  if (!req.user?.isPremium) {
    res.json([]);
    return;
  }

  const completedMistakes = await Mistake.find({ userId, completionStatus: "completed" }).sort({ updatedAt: -1 }).limit(200);
  const activeMistakeCount = await Mistake.countDocuments({ userId, completionStatus: { $ne: "completed" } });
  const result = await Promise.all(
    completedMistakes.map(async (mistake) => {
      const question = await Question.findOne({ _id: mistake.questionId, ...questionModeFilter });
      if (!question) return null;
      if (subjectId && String(question.subjectId) !== String(subjectId)) return null;
      if (chapterId && String(question.chapterId) !== String(chapterId)) return null;
      if (topicId && String(question.topicId ?? "") !== String(topicId)) return null;
      if (date) {
        const target = new Date(`${String(date).slice(0, 10)}T00:00:00.000Z`);
        const correctedAt = new Date(mistake.correctedAt ?? mistake.updatedAt);
        if (!Number.isNaN(target.getTime())) {
          const end = new Date(target);
          end.setUTCDate(end.getUTCDate() + 1);
          if (correctedAt < target || correctedAt >= end) return null;
        }
      }
      const [subject, chapter, topic, year] = await Promise.all([
        Subject.findById(question.subjectId),
        Chapter.findById(question.chapterId),
        question.topicId ? Topic.findById(question.topicId) : Promise.resolve(null),
        question.yearId ? Year.findById(question.yearId) : Promise.resolve(null),
      ]);
      const normalizedQuestion = normalizeQuestionDocument(question);

      return {
        id: mistake._id.toString(),
        questionId: mistake.questionId,
        question: {
          ...normalizedQuestion,
          subjectName: subject?.name ?? "Unknown",
          chapterName: chapter?.name ?? "Unknown",
          topicName: topic?.name ?? "General",
          ...resolveQuestionYearFields(normalizedQuestion, year as any),
        },
        status: mistake.status,
        attempts: mistake.attempts,
        wrongCount: mistake.wrongCount ?? 0,
        skippedCount: mistake.skippedCount ?? 0,
        incorrectAttemptsBeforeCorrection: mistake.incorrectAttemptsBeforeCorrection ?? ((mistake.wrongCount ?? 0) + (mistake.skippedCount ?? 0)),
        accuracy: mistake.accuracy ?? 0,
        improvementPercentage: mistake.improvementPercentage ?? 0,
        completionStatus: mistake.completionStatus,
        mode: mistake.mode ?? getQuestionWeakAreaExamMode(question),
        examType: mistake.examType ?? mistake.mode ?? getQuestionWeakAreaExamMode(question),
        sourceType: mistake.sourceType ?? "Practice Test",
        sourceName: mistake.sourceName ?? "Practice Test",
        sourceSessionId: mistake.sourceSessionId,
        subjectName: subject?.name ?? "Unknown",
        subjectId: String(question.subjectId),
        chapterName: chapter?.name ?? "Unknown",
        chapterId: String(question.chapterId),
        topicName: topic?.name ?? "General",
        topicId: String(question.topicId ?? ""),
        firstIncorrectAt: mistake.firstIncorrectAt ?? mistake.createdAt,
        correctedAt: mistake.correctedAt ?? mistake.updatedAt,
        lastAttemptDate: mistake.lastAttemptDate,
      };
    }),
  );

  const rows = result.filter(Boolean);
  const totalIncorrectAttempts = rows.reduce((sum: number, item: any) => sum + Number(item.incorrectAttemptsBeforeCorrection || 0), 0);
  res.json({
    data: rows,
    summary: {
      totalCorrectedMistakes: rows.length,
      totalActiveMistakes: activeMistakeCount,
      averageAttemptsRequiredForCorrection: rows.length ? Math.round((totalIncorrectAttempts / rows.length) * 100) / 100 : 0,
    },
  });
});

export default router;
