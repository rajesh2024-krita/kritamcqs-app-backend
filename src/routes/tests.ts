import { Router, type IRouter } from "express";
import {
  Chapter,
  ChapterPerformance,
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
  getOrCreateDailyAssignment,
  getQuestionsAttemptedToday,
  getSessionAttemptNumber,
  updateDailyAssignmentProgress,
} from "../lib/learning";
import { buildDifficultyQuery } from "../lib/difficulties";
import { normalizeQuestionDocument } from "../lib/question-framework";
import { getQuestionExamModes, resolveSubjectIds } from "../lib/subjects";
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

function buildPracticeMatch({
  chapterIds,
  allowedChapterIds,
  subjectIds,
  examMatch,
  difficultyFilter,
}: {
  chapterIds?: string[];
  allowedChapterIds?: string[];
  subjectIds?: string[];
  examMatch?: Record<string, unknown>;
  difficultyFilter?: Record<string, unknown>;
}) {
  const clauses: Record<string, unknown>[] = [];
  const chapterMatch = buildFlexibleIdMatch("chapterId", chapterIds);
  const allowedChapterMatch = buildFlexibleIdMatch("chapterId", allowedChapterIds);
  const subjectMatch = buildFlexibleIdMatch("subjectId", subjectIds);

  if (chapterMatch) clauses.push(chapterMatch);
  if (allowedChapterMatch) clauses.push(allowedChapterMatch);
  if (subjectMatch) clauses.push(subjectMatch);
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

async function findQuestionsForPractice({
  chapterIds,
  allowedChapterIds,
  subjectIds,
  examMatch,
  difficulty,
  limit,
}: {
  chapterIds?: string[];
  allowedChapterIds?: string[];
  subjectIds?: string[];
  examMatch?: Record<string, unknown>;
  difficulty?: string;
  limit: number;
}) {
  const queries: Array<Record<string, unknown>> = [];
  const difficultyFilter = await buildDifficultyQuery(difficulty);
  if (difficultyFilter) {
    queries.push(buildPracticeMatch({ chapterIds, allowedChapterIds, subjectIds, difficultyFilter, examMatch }));
  }

  if (!difficultyFilter && examMatch) {
    queries.push(buildPracticeMatch({ chapterIds, allowedChapterIds, subjectIds, examMatch }));
  }

  if (!difficultyFilter) {
    queries.push(buildPracticeMatch({ chapterIds, allowedChapterIds, subjectIds }));
  }

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

const GenerateSessionBody = z.object({
  mode: z.enum(["smart", "practice", "revision"]),
  subjectIds: z.array(z.union([z.string(), z.number()])).optional(),
  chapterIds: z.array(z.union([z.string(), z.number()])).optional(),
  difficulty: z.enum(["easy", "medium", "moderate", "hard", "mixed"]).optional(),
  questionCount: z.number().optional(),
  examPattern: z.enum(["NEET", "JEE", "BOTH", "MIXED"]).optional(),
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
    const hasExplicitSelection = Boolean(body.chapterIds?.length || body.subjectIds?.length);
    const shouldUseDailySet = !user.isPremium && !hasExplicitSelection && body.mode !== "revision";
    const remainingForFree = shouldUseDailySet ? Math.max(0, 20 - (await getQuestionsAttemptedToday(userId))) : null;

    if (shouldUseDailySet && Number(remainingForFree) <= 0) {
      res.status(403).json({
        error: "daily_limit_reached",
        message: "You've reached today's daily-test limit. Free practice chapters are still available from Practice.",
      });
      return;
    }

    const requestedCount = Math.max(1, Math.min(200, Number(body.questionCount ?? 20)));
    const limit = shouldUseDailySet ? Math.max(1, Math.min(Number(remainingForFree), requestedCount)) : requestedCount;
    const requestedExamMode =
      body.examPattern === "MIXED" || body.examPattern === "BOTH"
        ? "BOTH"
        : body.examPattern ?? user.examMode ?? "NEET";
    const examModes = getQuestionExamModes(requestedExamMode);
    const examMatch = { examMode: examModes.length === 1 ? examModes[0] : { $in: examModes } };
    const adaptiveConfig = await getAdaptiveTestConfig();
    const performanceProfile = await evaluateUserPerformanceTier(userId);
    const adaptiveRatio = getAdaptiveRatio(adaptiveConfig, performanceProfile.tier);
    const poolLimit = Math.max(limit * 6, 120);

    let questions: any[] = [];
    let origin: "daily_set" | "practice_filter" | "revision" | "smart_test" = body.mode === "smart" ? "smart_test" : "practice_filter";
    let title = body.mode === "smart" ? `${requestedExamMode} Smart Test` : "Practice Session";
    let allowedChapterIds: string[] | undefined = undefined;

    if (shouldUseDailySet) {
      const assignment = await getOrCreateDailyAssignment(user);
      const assignmentQuestions = await Question.find({ _id: { $in: assignment.questionIds } }).populate("questionTypeId");
      questions = assignmentQuestions.slice(0, limit);
      origin = "daily_set";
      title = `${assignment.modeKey} Daily Set`;
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
        difficulty: body.difficulty,
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
        difficulty: body.difficulty,
        limit: poolLimit,
      });
    } else {
      const sampled = await Question.aggregate([{ $match: examMatch }, { $sample: { size: poolLimit } }]);
      const ids = sampled.map((item: any) => item._id);
      questions = await Question.find({ _id: { $in: ids } }).populate("questionTypeId");

      if (questions.length === 0) {
        questions = await Question.find({}).populate("questionTypeId").limit(poolLimit);
      }
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
    const adaptiveQuestions = selectAdaptiveQuestionSet({
      questions,
      total: limit,
      ratio: adaptiveRatio,
      recentQuestionIds: recentSet,
      maxRepeatedQuestions: adaptiveConfig.maxRepeatedQuestions,
    });
    let selectedQuestions = adaptiveQuestions.length ? adaptiveQuestions : shuffleList(questions).slice(0, Math.max(1, limit));
    let selectedQuestionIds = selectedQuestions.map((question: any) => String(question._id ?? question.id));
    selectedQuestionIds = avoidRecentSequences(selectedQuestionIds, sequences);
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
      filterSnapshot: {
        examPattern: body.examPattern,
        mode: body.mode,
        subjectIds: body.subjectIds ?? [],
        chapterIds: body.chapterIds ?? [],
        userPerformanceTier: performanceProfile.tier,
        adaptiveRatio,
        durationMinutes: timing.durationMinutes,
        maxScore: OFFICIAL_EXAM_PATTERNS[String(requestedExamMode).toUpperCase()]?.totalQuestions === selectedQuestions.length
          ? OFFICIAL_EXAM_PATTERNS[String(requestedExamMode).toUpperCase()]?.maxScore
          : selectedQuestions.length * 4,
      },
      title,
    });

    const yearIds = [...new Set(selectedQuestions.map((question: any) => String(question.yearId ?? "")).filter(Boolean))];
    const years = yearIds.length > 0 ? await Year.find({ _id: { $in: yearIds } }) : [];
    const yearMap = new Map(years.map((year) => [year.id, year]));
    const questionsJson = shuffleQuestionOptionsForDelivery(
      selectedQuestions.map((question: any) => {
        const normalized = normalizeQuestionDocument(question);
        const yearDoc = normalized.yearId ? yearMap.get(String(normalized.yearId)) : undefined;
        return {
          ...normalized,
          year: normalized.year ?? (yearDoc as any)?.value ?? ((yearDoc as any)?.name ? Number((yearDoc as any).name) : undefined),
          yearLabel: (yearDoc as any)?.label ?? (yearDoc as any)?.name ?? (normalized.year ? String(normalized.year) : undefined),
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
    if (configuredDurationMinutes > 0 && Number(body.timeTaken || 0) > configuredDurationMinutes * 60 + 60) {
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
      { correct: number; wrong: number; total: number; totalTime: number; subjectId: string; chapterId: string }
    > = {};
    const questionAttemptDocs: Array<Record<string, unknown>> = [];

    const answerMap = new Map(body.answers.map((answer) => [String(answer.questionId), answer]));

    for (const sessionQuestionId of session.questionIds.map(String)) {
      const answer = answerMap.get(sessionQuestionId) || { questionId: sessionQuestionId, skipped: true };
      const questionId = String(answer.questionId);
      const question = qMap.get(questionId);
      if (!question) continue;

      const key = `${question.subjectId}|${question.chapterId}`;
      if (!topicMap[key]) {
        topicMap[key] = {
          correct: 0,
          wrong: 0,
          total: 0,
          totalTime: 0,
          subjectId: String(question.subjectId),
          chapterId: String(question.chapterId),
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
      } else if (isCorrect) {
        correct += 1;
        topicMap[key].correct += 1;
      } else {
        incorrect += 1;
        topicMap[key].wrong += 1;
        await Mistake.findOneAndUpdate(
          { userId, questionId },
          { $inc: { attempts: 1 }, lastAttemptDate: new Date(), status: "new" },
          { upsert: true, new: true },
        );
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

    const prediction = buildPrediction({
      patternPreset,
      predictionTitle: (session.filterSnapshot as any)?.predictionTitle,
      predictionDescription: (session.filterSnapshot as any)?.predictionDescription,
      score,
      maxScore,
    });

    const comparisonSourceId = session.sourceSessionId ?? session.id;
    const previousAttempts = await SessionAttempt.find({ userId, sourceSessionId: comparisonSourceId }).sort({ createdAt: 1 });
    const firstAttempt = previousAttempts[0];

    const sessionAttempt = await new SessionAttempt({
      userId,
      sessionId: session.id,
      sourceSessionId: comparisonSourceId,
      attemptNumber: await getSessionAttemptNumber(session.id),
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

    for (const [, stats] of Object.entries(topicMap)) {
      const existing = await ChapterPerformance.findOne({ userId, chapterId: stats.chapterId });
      const totalAttempts = (existing?.totalAttempts ?? 0) + stats.total;
      const correctCount = (existing?.correctCount ?? 0) + stats.correct;
      const wrongCount = (existing?.wrongCount ?? 0) + stats.wrong;
      const totalTimeSpent = (existing?.averageTimeSpent ?? 0) * (existing?.totalAttempts ?? 0) + stats.totalTime;
      const averageTimeSpent = totalAttempts > 0 ? totalTimeSpent / totalAttempts : 0;
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

    if (session.origin === "daily_set") {
      await updateDailyAssignmentProgress(userId, questionAttemptDocs.map((item) => String(item.questionId)));
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
