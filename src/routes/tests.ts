import { Router, type IRouter } from "express";
import {
  Chapter,
  ChapterPerformance,
  ExamMarkingSettings,
  LearningSession,
  Mistake,
  Question,
  QuestionAttempt,
  SessionAttempt,
  Subject,
  Year,
  mongoose,
} from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { z } from "zod";
import {
  createLearningSession,
  getLearningSourceInfo,
  getOrCreateDailyAssignment,
  getQuestionsAttemptedToday,
  getSessionAttemptNumber,
  updateDailyAssignmentProgress,
} from "../lib/learning";
import { buildDifficultyQuery } from "../lib/difficulties";
import { normalizeQuestionDocument, resolveQuestionYearFields } from "../lib/question-framework";
import { buildStrictQuestionExamModeQuery, getMixedSubjectIdsForExamMode, resolveSubjectIds } from "../lib/subjects";
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

const OFFICIAL_EXAM_PATTERNS: Record<string, { totalQuestions: number; durationMinutes: number; maxScore: number }> = {
  NEET: { totalQuestions: 180, durationMinutes: 180, maxScore: 720 },
  JEE: { totalQuestions: 75, durationMinutes: 180, maxScore: 300 },
};

function buildIdVariants(ids: Array<string | number>) {
  const stringIds = ids.map((value) => String(value)).filter(Boolean);
  const objectIds = stringIds
    .filter((value) => mongoose.isValidObjectId(value))
    .map((value) => new mongoose.Types.ObjectId(value));
  return [...stringIds, ...objectIds];
}

function buildFlexibleIdMatch(field: "chapterId" | "subjectId", ids?: Array<string | number>) {
  const normalizedIds = ids?.map((value) => String(value)).filter(Boolean) ?? [];
  if (normalizedIds.length === 0) return undefined;
  return { $expr: { $in: [{ $toString: `$${field}` }, normalizedIds] } };
}

function buildFlexibleFieldMatch(field: "chapterId" | "subjectId" | "topicId", ids?: Array<string | number>) {
  const normalizedIds = ids?.map((value) => String(value)).filter(Boolean) ?? [];
  if (normalizedIds.length === 0) return undefined;
  return { $expr: { $in: [{ $toString: `$${field}` }, normalizedIds] } };
}

function buildPracticeMatch({
  chapterIds,
  allowedChapterIds,
  subjectIds,
  topicIds,
  examMatch,
  difficultyFilter,
}: {
  chapterIds?: string[];
  allowedChapterIds?: string[];
  subjectIds?: string[];
  topicIds?: string[];
  examMatch?: Record<string, unknown>;
  difficultyFilter?: Record<string, unknown>;
}) {
  const clauses: Record<string, unknown>[] = [];
  const chapterMatch = buildFlexibleIdMatch("chapterId", chapterIds);
  const allowedChapterMatch = buildFlexibleIdMatch("chapterId", allowedChapterIds);
  const subjectMatch = buildFlexibleIdMatch("subjectId", subjectIds);
  const topicMatch = buildFlexibleFieldMatch("topicId", topicIds);

  if (chapterMatch) clauses.push(chapterMatch);
  if (allowedChapterMatch) clauses.push(allowedChapterMatch);
  if (subjectMatch) clauses.push(subjectMatch);
  if (topicMatch) clauses.push(topicMatch);
  if (difficultyFilter) clauses.push(difficultyFilter);
  if (examMatch && Object.keys(examMatch).length > 0) clauses.push(examMatch);

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

async function findQuestionsByMatch(match: Record<string, unknown>, limit: number) {
  const hits = await Question.aggregate([
    { $match: match },
    { $limit: limit },
    { $project: { _id: 1 } },
  ]);
  if (hits.length === 0) return [];

  const ids = hits.map((item: any) => item._id);
  const questions = await Question.find({ _id: { $in: ids } }).populate("questionTypeId");
  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
  return ids.map((id: any) => questionMap.get(String(id))).filter(Boolean);
}

function scoreAnswer({
  patternPreset,
  marksPerQuestion,
  negativeMarks,
  markingScheme,
  questionRule,
  question,
  isCorrect,
  isSkipped,
}: {
  patternPreset?: string;
  marksPerQuestion: number;
  negativeMarks: number;
  markingScheme?: any;
  questionRule?: any;
  question: any;
  isCorrect: boolean;
  isSkipped: boolean;
}) {
  const questionType = String(question?.responseType || "").toLowerCase() === "numeric" ? "numerical" : "mcq";
  const appliedRule = questionType === "numerical"
    ? markingScheme?.numerical
    : markingScheme?.mcq;

  if (isSkipped) {
    if (questionRule && Number.isFinite(Number(questionRule.unansweredMarks))) return Number(questionRule.unansweredMarks);
    if (appliedRule && Number.isFinite(Number(appliedRule.unanswered))) return Number(appliedRule.unanswered);
    return 0;
  }
  if (isCorrect) {
    if (questionRule && Number.isFinite(Number(questionRule.positiveMarks))) return Number(questionRule.positiveMarks);
    if (appliedRule && Number.isFinite(Number(appliedRule.correct))) return Number(appliedRule.correct);
    return marksPerQuestion;
  }
  if (questionRule && Number.isFinite(Number(questionRule.negativeMarks))) return Number(questionRule.negativeMarks);
  if (appliedRule && Number.isFinite(Number(appliedRule.wrong))) return Number(appliedRule.wrong);
  if (patternPreset === "JEE_REAL" && String(question?.responseType || "").toLowerCase() === "numeric") return 0;
  return -negativeMarks;
}

function buildPrediction({
  patternPreset,
  predictionTitle,
  predictionDescription,
  score,
  maxScore,
}: {
  patternPreset?: string;
  predictionTitle?: string;
  predictionDescription?: string;
  score: number;
  maxScore: number;
}) {
  const ratio = maxScore > 0 ? Math.max(0, Math.min(1, score / maxScore)) : 0;
  const level =
    ratio >= 0.85
      ? "Excellent exam-day readiness."
      : ratio >= 0.7
        ? "Strong scoring zone with room to improve."
        : ratio >= 0.5
          ? "Mid-range performance with clear upside."
          : "This needs revision before the real exam.";

  const examLabel = patternPreset === "NEET_REAL" ? "NEET" : patternPreset === "JEE_REAL" ? "JEE" : "mock";

  return {
    title: predictionTitle || `Predicted ${examLabel} Score`,
    description: predictionDescription || "Your mock test performance is used to predict your real exam scoring level.",
    predictedScore: Math.round(score),
    maxScore,
    summary: `Based on this ${examLabel} pattern, your predicted score is ${Math.round(score)}/${maxScore}. ${level}`,
  };
}

function getGeneratedSessionTiming(pattern: string, questionCount: number) {
  const normalizedPattern = String(pattern || "").toUpperCase();
  const official = OFFICIAL_EXAM_PATTERNS[normalizedPattern];
  if (official && questionCount >= official.totalQuestions) {
    return { durationMinutes: official.durationMinutes, timeLimitSeconds: official.durationMinutes * 60 };
  }
  const timeLimitSeconds = Math.max(60, questionCount * 90);
  return { durationMinutes: Math.ceil(timeLimitSeconds / 60), timeLimitSeconds };
}

function normalizeQuestionMode(question: any): "NEET" | "JEE" {
  const raw = String(question?.examMode ?? question?.examType ?? question?.exam ?? "").toUpperCase();
  return raw.includes("JEE") ? "JEE" : "NEET";
}

async function updateMistakeProgress({
  userId,
  question,
  answer,
  isCorrect,
  isSkipped,
  sourceInfo,
  sessionId,
  sessionAttemptId,
}: {
  userId: string;
  question: any;
  answer: any;
  isCorrect: boolean;
  isSkipped: boolean;
  sourceInfo?: ReturnType<typeof getLearningSourceInfo>;
  sessionId?: string;
  sessionAttemptId?: string;
}) {
  const questionId = String(question._id ?? question.id);
  const existing = await Mistake.findOne({ userId, questionId });
  if (!existing && isCorrect) return;

  const attempts = Number(existing?.attempts ?? 0) + 1;
  const correctCount = Number(existing?.correctCount ?? 0) + (isCorrect ? 1 : 0);
  const wrongCount = Number(existing?.wrongCount ?? 0) + (isCorrect ? 0 : 1);
  const skippedCount = Number(existing?.skippedCount ?? 0) + (isSkipped ? 1 : 0);
  const previousAccuracy = Number(existing?.accuracy ?? 0);
  const accuracy = attempts > 0 ? Math.round((correctCount / attempts) * 10000) / 100 : 0;
  const improvementPercentage = Math.max(0, Math.round((accuracy - previousAccuracy) * 100) / 100);
  const completionStatus = existing && isCorrect ? "completed" : "in_progress";
  const status = completionStatus === "completed" ? "improving" : attempts === 1 ? "new" : isCorrect || improvementPercentage > 0 ? "improving" : "weak";
  const firstIncorrectAt = existing?.firstIncorrectAt ?? (!isCorrect ? new Date() : undefined);
  const correctedAt = completionStatus === "completed" ? new Date() : undefined;
  const incorrectAttemptsBeforeCorrection = completionStatus === "completed"
    ? Number(existing?.wrongCount ?? 0) + Number(existing?.skippedCount ?? 0)
    : Number(existing?.incorrectAttemptsBeforeCorrection ?? 0);

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
      firstIncorrectAt,
      correctedAt,
      incorrectAttemptsBeforeCorrection,
      status,
      mode: normalizeQuestionMode(question),
      examType: normalizeQuestionMode(question),
      subjectId: String(question.subjectId ?? ""),
      chapterId: String(question.chapterId ?? ""),
      topicId: String(question.topicId ?? ""),
      sourceType: sourceInfo?.sourceType,
      sourceName: sourceInfo?.sourceLabel ?? sourceInfo?.sourceName,
      sourceSessionId: sourceInfo?.sourceSessionId,
      sessionId,
      sessionAttemptId,
      category: String(question.topicId ?? question.chapterId ?? question.subjectId ?? ""),
      difficulty: String(question.difficulty ?? question.difficultyId ?? ""),
      selectedOption: answer.selectedOption || "",
      selectedOptions: Array.isArray(answer.selectedOptions) ? answer.selectedOptions.map(String) : [],
      numericAnswer: answer.numericAnswer ? String(answer.numericAnswer) : "",
      lastAttemptDate: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function findQuestionsForPractice({
  chapterIds,
  allowedChapterIds,
  subjectIds,
  topicIds,
  examMatch,
  difficulty,
  limit,
}: {
  chapterIds?: string[];
  allowedChapterIds?: string[];
  subjectIds?: string[];
  topicIds?: string[];
  examMatch?: Record<string, unknown>;
  difficulty?: string;
  limit: number;
}) {
  const queries: Array<Record<string, unknown>> = [];
  const difficultyFilter = await buildDifficultyQuery(difficulty);
  if (difficultyFilter) {
    return findQuestionsByMatch(
      buildPracticeMatch({ chapterIds, allowedChapterIds, subjectIds, topicIds, difficultyFilter, examMatch }),
      limit,
    );
  }

  if (examMatch) {
    queries.push(buildPracticeMatch({ chapterIds, allowedChapterIds, subjectIds, topicIds, examMatch }));
  }

  queries.push(buildPracticeMatch({ chapterIds, allowedChapterIds, subjectIds, topicIds }));

  for (const query of queries) {
    const found = await findQuestionsByMatch(query, limit);
    if (found.length > 0) {
      return found;
    }
  }

  if (chapterIds?.length) {
    const chapterDocs = await Chapter.find({ _id: { $in: chapterIds.map(String) } });
    const chapterSubjectIds = [...new Set(chapterDocs.map((chapter) => String(chapter.subjectId)).filter(Boolean))];
    if (chapterSubjectIds.length > 0) {
      const subjectQueries: Array<Record<string, unknown>> = [];
      if (difficultyFilter) {
        subjectQueries.push(buildPracticeMatch({ subjectIds: chapterSubjectIds, allowedChapterIds, difficultyFilter, examMatch }));
      }
      if (!difficultyFilter && examMatch) {
        subjectQueries.push(buildPracticeMatch({ subjectIds: chapterSubjectIds, allowedChapterIds, examMatch }));
      }
      if (!difficultyFilter) {
        subjectQueries.push(buildPracticeMatch({ subjectIds: chapterSubjectIds, allowedChapterIds }));
      }

      for (const query of subjectQueries) {
        const subjectFallback = await findQuestionsByMatch(query, limit);
        if (subjectFallback.length > 0) {
          return subjectFallback;
        }
      }
    }
  }

  if (!difficultyFilter && chapterIds?.length) {
    const anyChapterQuestions = await findQuestionsByMatch(buildPracticeMatch({ chapterIds, allowedChapterIds }), limit);
    if (anyChapterQuestions.length > 0) {
      return anyChapterQuestions;
    }
  }

  if (!difficultyFilter && subjectIds?.length) {
    const anySubjectQuestions = await findQuestionsByMatch(buildPracticeMatch({ subjectIds, allowedChapterIds }), limit);
    if (anySubjectQuestions.length > 0) {
      return anySubjectQuestions;
    }
  }

  if (!difficultyFilter && examMatch) {
    const anyExamQuestions = await findQuestionsByMatch(buildPracticeMatch({ examMatch, allowedChapterIds }), limit);
    if (anyExamQuestions.length > 0) {
      return anyExamQuestions;
    }
  }

  return [];
}

async function getWeakAreaPriorityQuestionIds(userId: string, chapterIds?: Array<string | number>, topicIds?: Array<string | number>) {
  if (!chapterIds?.length) return [];
  const clauses: Record<string, unknown>[] = [
    { userId },
    buildFlexibleIdMatch("chapterId", chapterIds.map(String)),
  ].filter(Boolean) as Record<string, unknown>[];
  const topicMatch = buildFlexibleFieldMatch("topicId", topicIds?.map(String));
  if (topicMatch) clauses.push(topicMatch);

  const areas = await ChapterPerformance.find(clauses.length > 1 ? { $and: clauses } : clauses[0])
    .sort({ updatedAt: -1 })
    .select("incorrectQuestionIds");
  return [
    ...new Set(
      areas
        .flatMap((area: any) => (area.incorrectQuestionIds ?? []).map(String))
        .filter(Boolean),
    ),
  ];
}

function getWeakAreaSourceId({
  userId,
  examMode,
  chapterIds,
  topicIds,
}: {
  userId: string;
  examMode: string;
  chapterIds?: Array<string | number>;
  topicIds?: Array<string | number>;
}) {
  const chapterKey = (chapterIds ?? []).map(String).filter(Boolean).sort().join("_") || "all-chapters";
  const topicKey = (topicIds ?? []).map(String).filter(Boolean).sort().join("_") || "chapter";
  return `weak_area:${userId}:${String(examMode || "NEET").toUpperCase()}:${chapterKey}:${topicKey}`;
}

async function getStoredWeakAreaQuestionIds(userId: string, sourceSessionId: string, chapterIds?: Array<string | number>, topicIds?: Array<string | number>) {
  const latestSession = await LearningSession.findOne({
    userId,
    origin: "weak_area",
    sourceSessionId,
    questionIds: { $exists: true, $ne: [] },
  }).sort({ createdAt: 1 });
  if (latestSession?.questionIds?.length) return latestSession.questionIds.map(String);

  if (!chapterIds?.length) return [];
  const clauses: Record<string, unknown>[] = [
    { userId },
    buildFlexibleIdMatch("chapterId", chapterIds.map(String)),
  ].filter(Boolean) as Record<string, unknown>[];
  const topicMatch = buildFlexibleFieldMatch("topicId", topicIds?.map(String));
  if (topicMatch) clauses.push(topicMatch);
  const area = await ChapterPerformance.findOne(clauses.length > 1 ? { $and: clauses } : clauses[0])
    .sort({ updatedAt: -1 })
    .select("weakQuestionIds");
  return (area?.weakQuestionIds ?? []).map(String).filter(Boolean);
}

async function getQuestionsByStoredOrder(questionIds: string[], examMatch: Record<string, unknown>) {
  if (!questionIds.length) return [];
  const questions = await Question.find({ _id: { $in: buildIdVariants(questionIds) }, ...examMatch }).populate("questionTypeId");
  const questionMap = new Map(questions.map((question: any) => [String(question._id ?? question.id), question]));
  return questionIds.map((id) => questionMap.get(String(id))).filter(Boolean);
}

function orderQuestionsByPriority(questions: any[], priorityQuestionIds: string[]) {
  if (!priorityQuestionIds.length) return questions;
  const priorityIndex = new Map(priorityQuestionIds.map((id, index) => [String(id), index]));
  return questions
    .map((question, index) => ({ question, index, priority: priorityIndex.get(String(question._id ?? question.id)) }))
    .sort((a, b) => {
      const aPriority = a.priority ?? Number.MAX_SAFE_INTEGER;
      const bPriority = b.priority ?? Number.MAX_SAFE_INTEGER;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.index - b.index;
    })
    .map((item) => item.question);
}

async function prependPriorityQuestions(questions: any[], priorityQuestionIds: string[], examMatch: Record<string, unknown>) {
  if (!priorityQuestionIds.length) return questions;
  const priorityQuestions = await Question.find({ _id: { $in: priorityQuestionIds }, ...examMatch }).populate("questionTypeId");
  const priorityMap = new Map(priorityQuestions.map((question: any) => [String(question._id ?? question.id), question]));
  const seen = new Set<string>();
  const orderedPriorityQuestions = priorityQuestionIds
    .map((id) => priorityMap.get(String(id)))
    .filter((question) => {
      const id = String(question?._id ?? question?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const remainingQuestions = questions.filter((question) => {
    const id = String(question._id ?? question.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...orderedPriorityQuestions, ...remainingQuestions];
}

const GenerateSessionBody = z.object({
  mode: z.enum(["smart", "practice", "revision"]),
  subjectIds: z.array(z.union([z.string(), z.number()])).optional(),
  chapterIds: z.array(z.union([z.string(), z.number()])).optional(),
  difficulty: z.enum(["easy", "medium", "moderate", "hard", "mixed"]).optional(),
  questionCount: z.number().optional(),
  examPattern: z.enum(["NEET", "JEE", "BOTH", "MIXED"]).optional(),
  weakAreaPractice: z.boolean().optional(),
  mistakeQuestionIds: z.array(z.union([z.string(), z.number()])).optional(),
  freeQuestionIds: z.array(z.union([z.string(), z.number()])).optional(),
  topicIds: z.array(z.union([z.string(), z.number()])).optional(),
  allAvailableQuestions: z.boolean().optional(),
});

const SubmitSessionBody = z.object({
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

router.post("/generate", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const body = GenerateSessionBody.parse(req.body);
    const userId = req.userId!;
    const user = req.user!;
    if (!user.isPremium && (body.mode === "revision" || body.weakAreaPractice || body.mistakeQuestionIds?.length)) {
      res.status(403).json({
        error: "premium_required",
        message: "Weak-area and mistake practice is available for premium learners. Free users can view the analysis.",
      });
      return;
    }
    const hasExplicitSelection = Boolean(body.chapterIds?.length || body.subjectIds?.length || body.mistakeQuestionIds?.length || body.freeQuestionIds?.length);
    const shouldUseDailySet = !user.isPremium && !hasExplicitSelection && body.mode !== "revision";
    const remainingForFree = shouldUseDailySet ? Math.max(0, 20 - (await getQuestionsAttemptedToday(userId))) : null;

    if (shouldUseDailySet && Number(remainingForFree) <= 0) {
      res.status(403).json({
        error: "daily_limit_reached",
        message: "You've reached today's daily-test limit. Free practice chapters are still available from Practice.",
      });
      return;
    }

    const useAllAvailableQuestions = Boolean(
      user.isPremium
        && body.allAvailableQuestions
        && body.mode === "practice"
        && !body.weakAreaPractice
        && !body.mistakeQuestionIds?.length
        && Boolean(body.chapterIds?.length || body.subjectIds?.length),
    );
    const requestedCount = useAllAvailableQuestions
      ? Math.max(1, Math.min(5000, Number(body.questionCount ?? 5000)))
      : Math.max(1, Math.min(200, Number(body.questionCount ?? 20)));
    const limit = shouldUseDailySet ? Math.max(1, Math.min(Number(remainingForFree), requestedCount)) : requestedCount;
    const requestedExamMode =
      body.examPattern === "MIXED" || body.examPattern === "BOTH"
        ? String(user.examMode ?? "NEET").toUpperCase()
        : body.examPattern ?? user.examMode ?? "NEET";
    const examMatch = buildStrictQuestionExamModeQuery(requestedExamMode);
    const weakAreaSourceId = body.weakAreaPractice
      ? getWeakAreaSourceId({
          userId,
          examMode: requestedExamMode,
          chapterIds: body.chapterIds,
          topicIds: body.topicIds,
        })
      : undefined;
    const storedWeakAreaQuestionIds = weakAreaSourceId
      ? await getStoredWeakAreaQuestionIds(userId, weakAreaSourceId, body.chapterIds, body.topicIds)
      : [];
    const mixedSubjectIds = await getMixedSubjectIdsForExamMode(requestedExamMode);
    const adaptiveConfig = await getAdaptiveTestConfig();
    const performanceProfile = await evaluateUserPerformanceTier(userId);
    const adaptiveRatio = getAdaptiveRatio(adaptiveConfig, performanceProfile.tier);
    const poolLimit = Math.max(limit * 6, 120);

    let questions: any[] = [];
    let origin: "daily_set" | "practice_filter" | "revision" | "smart_test" | "retest" | "weak_area" =
      body.mode === "smart" ? "smart_test" : body.weakAreaPractice ? "weak_area" : "practice_filter";
    let title = body.mode === "smart" ? `${requestedExamMode} Smart Test` : "Practice Session";
    let allowedChapterIds: string[] | undefined = undefined;

    if (shouldUseDailySet) {
      const assignment = await getOrCreateDailyAssignment(user);
      const assignmentQuestions = await Question.find({ _id: { $in: assignment.questionIds } }).populate("questionTypeId");
      questions = assignmentQuestions.slice(0, limit);
      origin = "daily_set";
      title = `${assignment.modeKey} Daily Set`;
    } else if (body.freeQuestionIds?.length) {
      const freeIds = [...new Set(body.freeQuestionIds.map(String).filter(Boolean))];
      const freeQuestions = await Question.find({ _id: { $in: freeIds }, ...examMatch }).populate("questionTypeId");
      const freeQuestionMap = new Map(freeQuestions.map((question: any) => [String(question._id), question]));
      questions = freeIds.map((id) => freeQuestionMap.get(id)).filter(Boolean);
      origin = "practice_filter";
      title = `${requestedExamMode} Free Practice Questions`;
    } else if (body.mistakeQuestionIds?.length) {
      const mistakeIds = [...new Set(body.mistakeQuestionIds.map(String).filter(Boolean))];
      const mistakes = await Mistake.find({
        userId,
        questionId: { $in: mistakeIds },
        completionStatus: { $ne: "completed" },
      }).select("questionId");
      const allowedMistakeIds = new Set(mistakes.map((item) => String(item.questionId)));
      const clauses: Record<string, unknown>[] = [
        { _id: { $in: mistakeIds.filter((id) => allowedMistakeIds.has(id)) } },
        examMatch,
      ];
      const subjectMatch = buildFlexibleIdMatch("subjectId", body.subjectIds);
      const chapterMatch = buildFlexibleIdMatch("chapterId", body.chapterIds);
      if (subjectMatch) clauses.push(subjectMatch);
      if (chapterMatch) clauses.push(chapterMatch);
      const topicMatch = buildFlexibleFieldMatch("topicId", body.topicIds);
      if (topicMatch) clauses.push(topicMatch);
      const mistakeQuestions = await Question.find({ $and: clauses }).populate("questionTypeId");
      const mistakeQuestionMap = new Map(mistakeQuestions.map((question: any) => [String(question._id), question]));
      questions = mistakeIds.map((id) => mistakeQuestionMap.get(id)).filter(Boolean);
      origin = "retest";
      title = `${requestedExamMode} Mistake Book Practice`;
    } else if (body.mode === "revision") {
      const mistakeEntries = await Mistake.find({ userId }).sort({ lastAttemptDate: -1 }).limit(10);
      const wrongQuestionIds = mistakeEntries.map((item) => item.questionId);
      const wrongQuestions = await Question.find({ _id: { $in: wrongQuestionIds }, ...examMatch }).populate("questionTypeId");

      let oldCorrect: any[] = [];
      const correctAttemptQuestionIds = await QuestionAttempt.find({ userId, isCorrect: true })
        .sort({ createdAt: 1 })
        .limit(5)
        .distinct("questionId");
      oldCorrect = await Question.find({ _id: { $in: correctAttemptQuestionIds }, ...examMatch }).populate("questionTypeId");

      const deduped = new Map<string, any>();
      [...wrongQuestions, ...oldCorrect].forEach((question: any) => {
        deduped.set(String(question._id ?? question.id), question);
      });
      questions = [...deduped.values()];
      origin = "revision";
      title = `${requestedExamMode} Revision Session`;
    } else if (body.chapterIds?.length) {
      const chapterIds = body.chapterIds.map(String);
      if (!user.isPremium) {
        const validChapterObjectIds = chapterIds
          .filter((chapterId) => mongoose.isValidObjectId(chapterId))
          .map((chapterId) => new mongoose.Types.ObjectId(chapterId));
        const lockedChapters = await Chapter.find({
          _id: { $in: validChapterObjectIds },
          isLockedForFreeUsers: true,
        }).select("_id name");
        if (lockedChapters.length > 0) {
          res.status(403).json({
            error: "chapter_locked_for_free_user",
            message: "This chapter is locked. Upgrade to access.",
          });
          return;
        }
        allowedChapterIds = chapterIds;
      }

      questions = await findQuestionsForPractice({
        chapterIds,
        allowedChapterIds,
        examMatch,
        difficulty: useAllAvailableQuestions ? undefined : body.difficulty,
        topicIds: body.topicIds?.map(String),
        limit: poolLimit,
      });
    } else if (body.subjectIds?.length) {
      const resolvedSubjectIds = (
        await Promise.all(
          body.subjectIds.map((subjectId) =>
            resolveSubjectIds(String(subjectId), requestedExamMode === "BOTH" ? null : requestedExamMode),
          ),
        )
      ).flat();

      if (!user.isPremium) {
        const freeAccessibleChapters = await Chapter.find({
          subjectId: { $in: buildIdVariants(resolvedSubjectIds) },
          isLockedForFreeUsers: { $ne: true },
        }).select("_id");
        allowedChapterIds = freeAccessibleChapters.map((chapter) => String(chapter._id));
        if (allowedChapterIds.length === 0) {
          res.status(403).json({
            error: "subject_chapters_locked_for_free_user",
            message: "This chapter is locked. Upgrade to access.",
          });
          return;
        }
      }

      questions = await findQuestionsForPractice({
        subjectIds: resolvedSubjectIds,
        allowedChapterIds,
        examMatch,
        difficulty: useAllAvailableQuestions ? undefined : body.difficulty,
        topicIds: body.topicIds?.map(String),
        limit: poolLimit,
      });
    } else {
      const subjectMatch = buildFlexibleFieldMatch("subjectId", mixedSubjectIds);
      const sampled = await Question.aggregate([
        { $match: subjectMatch ? { $and: [examMatch, subjectMatch] } : examMatch },
        { $sample: { size: poolLimit } },
      ]);
      const ids = sampled.map((item: any) => item._id);
      questions = await Question.find({ _id: { $in: ids } }).populate("questionTypeId");

      if (questions.length === 0) {
        questions = await Question.find(subjectMatch ? { $and: [examMatch, subjectMatch] } : examMatch).populate("questionTypeId").limit(poolLimit);
      }
    }

    if (body.weakAreaPractice && storedWeakAreaQuestionIds.length) {
      questions = await getQuestionsByStoredOrder(storedWeakAreaQuestionIds, examMatch);
    }

    if (questions.length === 0) {
      res.status(404).json({ error: "no_questions", message: "No questions available for this selection" });
      return;
    }

    const { recentSet, sequences } = await getRecentSessionQuestionIds({
      userId,
      origin,
      lookback: adaptiveConfig.repeatLookbackSessions,
    });
    const weakAreaPriorityQuestionIds = body.weakAreaPractice
      ? await getWeakAreaPriorityQuestionIds(userId, body.chapterIds, body.topicIds)
      : [];
    if (body.weakAreaPractice && !storedWeakAreaQuestionIds.length) {
      questions = await prependPriorityQuestions(questions, weakAreaPriorityQuestionIds, examMatch);
      questions = orderQuestionsByPriority(questions, weakAreaPriorityQuestionIds);
    }

    let selectedQuestions = useAllAvailableQuestions
      ? questions
      : body.weakAreaPractice
        ? questions.slice(0, Math.max(1, limit))
        : (() => {
          const adaptiveQuestions = selectAdaptiveQuestionSet({
            questions,
            total: limit,
            ratio: adaptiveRatio,
            recentQuestionIds: recentSet,
            maxRepeatedQuestions: adaptiveConfig.maxRepeatedQuestions,
          });
          return adaptiveQuestions.length ? adaptiveQuestions : shuffleList(questions).slice(0, Math.max(1, limit));
        })();
    let selectedQuestionIds = selectedQuestions.map((question: any) => String(question._id ?? question.id));
    if (body.weakAreaPractice && storedWeakAreaQuestionIds.length) {
      selectedQuestionIds = storedWeakAreaQuestionIds.slice(0, Math.max(1, storedWeakAreaQuestionIds.length));
    } else {
      selectedQuestionIds = useAllAvailableQuestions || body.weakAreaPractice ? selectedQuestionIds : avoidRecentSequences(selectedQuestionIds, sequences);
    }
    const selectedMap = new Map(selectedQuestions.map((question: any) => [String(question._id ?? question.id), question]));
    selectedQuestions = selectedQuestionIds.map((id) => selectedMap.get(id)).filter(Boolean);

    const firstQuestion = selectedQuestions[0];
    const subject = firstQuestion?.subjectId ? await Subject.findById(firstQuestion.subjectId) : null;
    const timing = getGeneratedSessionTiming(requestedExamMode, selectedQuestions.length);
    const session = await createLearningSession({
      userId,
      type: body.mode === "revision" ? "revision" : body.mode === "practice" ? "practice" : "test",
      origin,
      modeKey: requestedExamMode as "NEET" | "JEE" | "BOTH",
      subjectId: body.subjectIds?.length === 1 ? String(body.subjectIds[0]) : subject?.id,
      chapterId: body.chapterIds?.length === 1 ? String(body.chapterIds[0]) : undefined,
      questionIds: selectedQuestions.map((question: any) => String(question._id ?? question.id)),
      sourceSessionId: weakAreaSourceId,
      isRetestGroup: Boolean(body.weakAreaPractice),
      filterSnapshot: {
        examPattern: body.examPattern,
        mode: body.mode,
        weakAreaPractice: Boolean(body.weakAreaPractice),
        weakAreaSourceId,
        subjectIds: body.subjectIds ?? [],
        chapterIds: body.chapterIds ?? [],
        topicIds: body.topicIds ?? [],
        mistakeQuestionIds: body.mistakeQuestionIds ?? [],
        freeQuestionIds: body.freeQuestionIds ?? [],
        userPerformanceTier: performanceProfile.tier,
        adaptiveRatio,
        durationMinutes: timing.durationMinutes,
        maxScore: OFFICIAL_EXAM_PATTERNS[String(requestedExamMode).toUpperCase()]?.totalQuestions === selectedQuestions.length
          ? OFFICIAL_EXAM_PATTERNS[String(requestedExamMode).toUpperCase()]?.maxScore
          : selectedQuestions.length * 4,
      },
      title: body.weakAreaPractice ? `${requestedExamMode} Weak Area Practice` : title,
    });

    const yearIds = [...new Set(selectedQuestions.map((question: any) => String(question.yearId ?? "")).filter(Boolean))];
    const subjectIds = [...new Set(selectedQuestions.map((question: any) => String(question.subjectId ?? "")).filter(Boolean))];
    const chapterIds = [...new Set(selectedQuestions.map((question: any) => String(question.chapterId ?? "")).filter(Boolean))];
    const [years, subjects, chapters] = await Promise.all([
      yearIds.length > 0 ? Year.find({ _id: { $in: yearIds } }) : [],
      subjectIds.length > 0 ? Subject.find({ _id: { $in: subjectIds } }).select("_id name") : [],
      chapterIds.length > 0 ? Chapter.find({ _id: { $in: chapterIds } }).select("_id name") : [],
    ]);
    const yearMap = new Map(years.map((year) => [year.id, year]));
    const subjectMap = new Map(subjects.map((subject) => [String(subject._id), subject.name]));
    const chapterMap = new Map(chapters.map((chapter) => [String(chapter._id), chapter.name]));
    const questionsJson = shuffleQuestionOptionsForDelivery(
      selectedQuestions.map((question: any) => {
        const normalized = normalizeQuestionDocument(question);
        const yearDoc = normalized.yearId ? yearMap.get(String(normalized.yearId)) : undefined;
        const subjectName = subjectMap.get(String(normalized.subjectId));
        const chapterName = chapterMap.get(String(normalized.chapterId));
        return {
          ...normalized,
          subject: subjectName ?? normalized.subject,
          subjectName: subjectName ?? normalized.subjectName,
          chapterName: chapterName ?? normalized.chapterName,
          ...resolveQuestionYearFields(normalized, yearDoc as any),
        };
      }),
    );
    res.json({
      id: session.id,
      sessionId: session.id,
      origin,
      questions: questionsJson,
      totalQuestions: selectedQuestions.length,
      timeLimit: timing.timeLimitSeconds,
      mode: body.mode,
    });
  } catch (error) {
    req.log.error({ error }, "Generate test failed");
    res.status(500).json({ error: "generate_failed", message: "Failed to generate test" });
  }
});

router.post("/:testId/submit", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const sessionId = req.params["testId"];
    const userId = req.userId!;
    const body = SubmitSessionBody.parse(req.body);

    const session = await LearningSession.findById(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "not_found", message: "Session not found" });
      return;
    }

    const existingAttempt = await SessionAttempt.findOne({ userId, sessionId: session.id, completedAt: { $ne: null } }).sort({ createdAt: -1 });
    if (existingAttempt) {
      res.json({
        sessionId: session.id,
        attemptId: existingAttempt.id,
        score: existingAttempt.score ?? 0,
        accuracy: existingAttempt.accuracy ?? 0,
        timeTaken: existingAttempt.timeTaken ?? 0,
        correctCount: existingAttempt.correctCount ?? 0,
        incorrectCount: existingAttempt.incorrectCount ?? 0,
        skippedCount: existingAttempt.skippedCount ?? 0,
        totalQuestions: existingAttempt.totalQuestions ?? 0,
        maxScore: Number((session.filterSnapshot as any)?.maxScore ?? (existingAttempt.totalQuestions ?? 0) * 4),
        topicBreakdown: existingAttempt.topicBreakdownJson ?? [],
        comparison: existingAttempt.comparisonJson ?? null,
        duplicate: true,
      });
      return;
    }

    const configuredDurationMinutes = Number((session.filterSnapshot as any)?.durationMinutes || 0);
    const skipTimerValidation = ["retest", "weak_area"].includes(String(session.origin || ""));
    if (!skipTimerValidation && configuredDurationMinutes > 0 && Number(body.timeTaken || 0) > configuredDurationMinutes * 60 + 60) {
      res.status(400).json({ error: "timer_invalid", message: "Submitted time exceeds the configured test duration." });
      return;
    }

    const questions = await Question.find({ _id: { $in: session.questionIds } }).populate("questionTypeId");
    const qMap = new Map<string, any>(questions.map((question: any) => [question._id.toString(), question]));

    const marksPerQuestion = Number((session.filterSnapshot as any)?.marksPerQuestion ?? 4);
    const negativeMarks = Number((session.filterSnapshot as any)?.negativeMarks ?? 1);
    const markingScheme = (session.filterSnapshot as any)?.markingScheme;
    const questionMarkingRules = Array.isArray((session.filterSnapshot as any)?.questionMarkingRules)
      ? (session.filterSnapshot as any).questionMarkingRules
      : [];
    const questionMarkingRuleMap = new Map(
      questionMarkingRules
        .map((item: any) => [String(item?.questionId || ""), item])
        .filter(([id]) => Boolean(id)),
    );
    const patternPreset = String((session.filterSnapshot as any)?.patternPreset ?? "");
    const maxScore = Number((session.filterSnapshot as any)?.maxScore ?? questions.length * marksPerQuestion);
    let correct = 0;
    let incorrect = 0;
    let skipped = 0;
    let score = 0;
    const topicMap: Record<
      string,
      {
        correct: number;
        wrong: number;
        total: number;
        totalTime: number;
        subjectId: string;
        chapterId: string;
        topicId: string;
        skipped: number;
        incorrectQuestionIds: Set<string>;
        correctQuestionIds: Set<string>;
      }
    > = {};
    const questionAttemptDocs: Array<Record<string, unknown>> = [];

    const answerMap = new Map(body.answers.map((answer) => [String(answer.questionId), answer]));

    for (const sessionQuestionId of session.questionIds.map(String)) {
      const answer = answerMap.get(sessionQuestionId) || { questionId: sessionQuestionId, skipped: true };
      const questionId = String(answer.questionId);
      const question = qMap.get(questionId);
      if (!question) continue;

      const topicId = String(question.topicId ?? "");
      const key = `${question.subjectId}|${question.chapterId}|${topicId || "chapter"}`;
      if (!topicMap[key]) {
        topicMap[key] = {
          correct: 0,
          wrong: 0,
          total: 0,
          totalTime: 0,
          subjectId: String(question.subjectId),
          chapterId: String(question.chapterId),
          topicId,
          skipped: 0,
          incorrectQuestionIds: new Set<string>(),
          correctQuestionIds: new Set<string>(),
        };
      }

      topicMap[key].total += 1;
      topicMap[key].totalTime += answer.timeSpent ?? 0;

      const selectedOption = answer.selectedOption ? String(answer.selectedOption) : undefined;
      const selectedOptions = Array.isArray((answer as any).selectedOptions) ? (answer as any).selectedOptions.map(String) : [];
      const numericAnswer = (answer as any).numericAnswer ? String((answer as any).numericAnswer).trim() : undefined;
      const isSkipped = Boolean(answer.skipped || (!selectedOption && selectedOptions.length === 0 && !numericAnswer));
      const responseType = String(question.responseType || "").toLowerCase();
      const numericSubmitted = numericAnswer !== undefined && /^-?\d+(\.\d+)?$/.test(numericAnswer);
      const numericCorrectAnswer = String(question.numericAnswer ?? "").trim();
      const numericIsCorrect = numericSubmitted
        && /^-?\d+(\.\d+)?$/.test(numericCorrectAnswer)
        && Math.abs(Number(numericAnswer) - Number(numericCorrectAnswer)) < 1e-6;
      const isCorrect = isSkipped
        ? false
        : responseType === "numeric"
          ? numericIsCorrect
          : responseType === "multiple"
            ? [...selectedOptions].sort().join(",") === [...(question.correctOptions ?? [])].sort().join(",")
            : selectedOption === question.correctOption;

      if (isSkipped) {
        skipped += 1;
        topicMap[key].skipped += 1;
        topicMap[key].incorrectQuestionIds.add(questionId);
      } else if (isCorrect) {
        correct += 1;
        topicMap[key].correct += 1;
        topicMap[key].correctQuestionIds.add(questionId);
      } else {
        incorrect += 1;
        topicMap[key].wrong += 1;
        topicMap[key].incorrectQuestionIds.add(questionId);
      }

      score += scoreAnswer({
        patternPreset,
        marksPerQuestion,
        negativeMarks,
        markingScheme,
        questionRule: questionMarkingRuleMap.get(questionId),
        question,
        isCorrect,
        isSkipped,
      });

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
        timeSpent: answer.timeSpent ?? 0,
      });
    }

    const total = session.questionIds.length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    const topicBreakdown = Object.entries(topicMap).map(([, stats]) => ({
      subjectId: stats.subjectId,
      chapterId: stats.chapterId,
      topicId: stats.topicId,
      correct: stats.correct,
      total: stats.total,
      accuracy: stats.total > 0 ? (stats.correct / stats.total) * 100 : 0,
    }));
    const [subjects, chapters] = await Promise.all([
      Subject.find({
        _id: { $in: [...new Set(topicBreakdown.map((topic) => topic.subjectId))] },
      }),
      Chapter.find({
        _id: { $in: [...new Set(topicBreakdown.map((topic) => topic.chapterId))] },
      }),
    ]);
    const subjectNameMap = new Map(subjects.map((subject) => [subject.id, subject.name]));
    const chapterNameMap = new Map(chapters.map((chapter) => [chapter.id, chapter.name]));
    const topicBreakdownWithNames = topicBreakdown.map((topic) => ({
      ...topic,
      subjectName: subjectNameMap.get(String(topic.subjectId)) ?? String(topic.subjectId),
      chapterName: chapterNameMap.get(String(topic.chapterId)) ?? String(topic.chapterId),
    }));

    const rawPrediction = buildPrediction({
      patternPreset,
      predictionTitle: (session.filterSnapshot as any)?.predictionTitle,
      predictionDescription: (session.filterSnapshot as any)?.predictionDescription,
      score,
      maxScore,
    });

    const comparisonSourceId = session.origin === "mock_test" && (session.filterSnapshot as any)?.testType === "subject"
      ? String((session.filterSnapshot as any)?.generatedTestKey || session.sourceSessionId || session.id)
      : session.sourceSessionId ?? session.id;
    const previousAttempts = await SessionAttempt.find({ userId, sourceSessionId: comparisonSourceId }).sort({ createdAt: 1 });
    const firstAttempt = previousAttempts[0];

    const sessionAttempt = await new SessionAttempt({
      userId,
      sessionId: session.id,
      sourceSessionId: comparisonSourceId,
      attemptNumber: session.origin === "weak_area" || (session.origin === "mock_test" && (session.filterSnapshot as any)?.testType === "subject")
        ? (await SessionAttempt.countDocuments({ userId, sourceSessionId: comparisonSourceId })) + 1
        : await getSessionAttemptNumber(session.id),
      score,
      accuracy,
      timeTaken: body.timeTaken,
      correctCount: correct,
      incorrectCount: incorrect,
      skippedCount: skipped,
      totalQuestions: total,
      answersJson: body.answers,
      topicBreakdownJson: topicBreakdownWithNames,
      comparisonJson: firstAttempt
        ? {
            scoreDelta: score - (firstAttempt.score ?? 0),
            accuracyDelta: accuracy - (firstAttempt.accuracy ?? 0),
            timeDelta: (body.timeTaken ?? 0) - (firstAttempt.timeTaken ?? 0),
          }
        : null,
      completedAt: new Date(),
    }).save();

    if (questionAttemptDocs.length > 0) {
      await QuestionAttempt.insertMany(
        questionAttemptDocs.map((item) => ({
          ...item,
          sessionAttemptId: sessionAttempt.id,
        })),
      );
    }

    const sourceInfo = getLearningSourceInfo(session);
    for (const item of questionAttemptDocs) {
      const question = qMap.get(String(item.questionId));
      const answer = answerMap.get(String(item.questionId)) || { questionId: String(item.questionId), skipped: true };
      if (!question) continue;
      await updateMistakeProgress({
        userId,
        question,
        answer,
        isCorrect: Boolean(item.isCorrect),
        isSkipped: Boolean(item.skipped),
        sourceInfo,
        sessionId: session.id,
        sessionAttemptId: sessionAttempt.id,
      });
    }

    for (const [, stats] of Object.entries(topicMap)) {
      const existing = await ChapterPerformance.findOne({ userId, chapterId: stats.chapterId, topicId: stats.topicId });
      const totalAttempts = (existing?.totalAttempts ?? 0) + stats.total;
      const attemptCount = Number(existing?.attemptCount ?? 0) + 1;
      const correctCount = (existing?.correctCount ?? 0) + stats.correct;
      const wrongCount = (existing?.wrongCount ?? 0) + stats.wrong;
      const skippedCount = Number(existing?.skippedCount ?? 0) + stats.skipped;
      const correctedQuestionIds = new Set(Array.from(stats.correctQuestionIds).map(String));
      const incorrectQuestionIds = [
        ...new Set([
          ...(existing?.incorrectQuestionIds ?? []).map(String).filter((id) => !correctedQuestionIds.has(id)),
          ...Array.from(stats.incorrectQuestionIds),
        ]),
      ];
      const topicIds = [...new Set([...(existing?.topicIds ?? []).map(String), stats.topicId].filter(Boolean))];
      const weakQuestionIds = session.origin === "weak_area"
        ? [...new Set([...(existing?.weakQuestionIds ?? []).map(String), ...session.questionIds.map(String)])]
        : (existing?.weakQuestionIds ?? []).map(String);
      const totalTimeSpent = (existing?.averageTimeSpent ?? 0) * (existing?.totalAttempts ?? 0) + stats.totalTime;
      const averageTimeSpent = totalAttempts > 0 ? totalTimeSpent / totalAttempts : 0;
      const chapterAccuracy = totalAttempts > 0 ? correctCount / totalAttempts : 0;
      const chapterAccuracyPercent = chapterAccuracy * 100;
      const previousAccuracyPercent = Number(existing?.accuracy ?? 0) * 100;
      const latestAttemptComplete = stats.total > 0 && stats.correct === stats.total && stats.wrong === 0 && stats.skipped === 0;
      const isMastered = session.origin === "weak_area" ? latestAttemptComplete : attemptCount > 1 && latestAttemptComplete;
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
          weakQuestionIds,
          topicIds,
          accuracy: chapterAccuracy,
          previousAccuracy: Number(existing?.accuracy ?? 0),
          improvementPercentage,
          completionPercentage: masteryPercentage,
          masteryPercentage,
          isWeak: !isMastered && isWeak,
          isMastered,
          examMode: normalizeQuestionMode({ examMode: session.modeKey }),
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

    if (session.origin === "daily_set") {
      await updateDailyAssignmentProgress(userId, questionAttemptDocs.map((item) => String(item.questionId)));
    }

    let prediction: any = rawPrediction;
    if (session.origin === "mock_test") {
      const markingSettings = await ExamMarkingSettings.findOne({});
      const minUniqueMockTests = Math.max(5, Number(markingSettings?.predictionMinimumMockTests ?? 5));
      const completedAttempts = await SessionAttempt.find({ userId, completedAt: { $ne: null } }).select("sessionId sourceSessionId");
      const completedSessions = await LearningSession.find({
        _id: { $in: completedAttempts.map((attempt) => attempt.sessionId).filter(Boolean) },
        origin: "mock_test",
      }).select("_id sourceSessionId");
      const mockSessionMap = new Map(completedSessions.map((completedSession) => [String(completedSession._id), completedSession]));
      const completedMockTestIds = completedAttempts
        .map((attempt) => {
          const completedSession = mockSessionMap.get(String(attempt.sessionId));
          return completedSession ? String(completedSession.sourceSessionId ?? attempt.sourceSessionId ?? completedSession._id) : "";
        })
        .filter(Boolean);
      const uniqueMockCount = new Set(completedMockTestIds).size;
      if (uniqueMockCount < minUniqueMockTests) {
        prediction = {
          ready: false,
          uniqueMockTestsCompleted: uniqueMockCount,
          requiredUniqueMockTests: minUniqueMockTests,
          summary: `Complete ${minUniqueMockTests} different mock tests to unlock predicted score analysis. Reattempts are not counted.`,
        };
      } else {
        prediction = { ...rawPrediction, ready: true, uniqueMockTestsCompleted: uniqueMockCount, requiredUniqueMockTests: minUniqueMockTests };
      }
    }

    res.json({
      sessionId: session.id,
      attemptId: sessionAttempt.id,
      score,
      accuracy,
      timeTaken: body.timeTaken,
      correctCount: correct,
      incorrectCount: incorrect,
      skippedCount: skipped,
      totalQuestions: total,
      maxScore,
      prediction,
      topicBreakdown: topicBreakdownWithNames,
      weakAreasAdded: topicBreakdownWithNames.filter((topic) => topic.accuracy < 50).map((topic) => topic.chapterId),
      comparison: sessionAttempt.comparisonJson ?? null,
    });
  } catch (error) {
    req.log.error({ error }, "Submit test failed");
    res.status(500).json({ error: "submit_failed", message: "Failed to submit test" });
  }
});

router.get("/history", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const limit = parseInt((req.query["limit"] as string) ?? "10");
  const attempts = await SessionAttempt.find({ userId, completedAt: { $ne: null } }).sort({ createdAt: -1 }).limit(limit);
  const sessions = await LearningSession.find({ _id: { $in: attempts.map((attempt) => attempt.sessionId) } });
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));

  res.json(
    attempts.map((attempt) => {
      const session = sessionMap.get(attempt.sessionId);
      return {
        id: attempt.id,
        sessionId: attempt.sessionId,
        date: attempt.completedAt ?? attempt.createdAt,
        score: attempt.score ?? 0,
        accuracy: attempt.accuracy ?? 0,
        totalQuestions: attempt.totalQuestions,
        mode: session?.type ?? "test",
        timeTaken: attempt.timeTaken ?? 0,
        title: session?.title ?? "Practice Session",
        origin: session?.origin ?? "practice_filter",
      };
    }),
  );
});

export default router;
