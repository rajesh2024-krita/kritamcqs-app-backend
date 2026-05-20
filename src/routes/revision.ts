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
import { createLearningSession, getSessionAttemptNumber } from "../lib/learning";
import { normalizeQuestionDocument, resolveQuestionYearFields } from "../lib/question-framework";
import { getQuestionExamModes } from "../lib/subjects";

const router: IRouter = Router();

const DEFAULT_REVISION_CONFIG = {
  wrongQuestionLimit: 10,
  oldQuestionLimit: 5,
  revisionEnabled: true,
};

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
    revisionEnabled: settings.revisionEnabled !== false,
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

  const examModes = getQuestionExamModes(examPattern);
  const allowedModes = new Set(examModes);

  const mistakeEntries = await Mistake.find({ userId })
    .sort({ attempts: -1, lastAttemptDate: 1 })
    .limit(config.wrongQuestionLimit);

  const wrongQuestionIds = mistakeEntries.map((item) => String(item.questionId)).filter(Boolean);
  const wrongQuestionsRaw = wrongQuestionIds.length
    ? await Question.find({ _id: { $in: wrongQuestionIds } }).populate("questionTypeId")
    : [];
  const wrongQuestionMap = new Map(wrongQuestionsRaw.map((item: any) => [String(item._id), item]));
  const wrongQuestions = wrongQuestionIds
    .map((id) => wrongQuestionMap.get(id))
    .filter(Boolean)
    .filter((item: any) => allowedModes.has(String(item.examMode ?? "").toUpperCase()));

  const oldestCorrectAttempts = await QuestionAttempt.find({ userId, isCorrect: true })
    .sort({ createdAt: 1 })
    .select("questionId createdAt")
    .limit(500);

  const oldCorrectQuestionIds: string[] = [];
  const seenOld = new Set<string>();
  for (const attempt of oldestCorrectAttempts) {
    const questionId = String(attempt.questionId || "");
    if (!questionId || seenOld.has(questionId)) continue;
    seenOld.add(questionId);
    oldCorrectQuestionIds.push(questionId);
    if (oldCorrectQuestionIds.length >= config.oldQuestionLimit) break;
  }

  const oldCorrectRaw = oldCorrectQuestionIds.length
    ? await Question.find({ _id: { $in: oldCorrectQuestionIds } }).populate("questionTypeId")
    : [];
  const oldQuestionMap = new Map(oldCorrectRaw.map((item: any) => [String(item._id), item]));
  const oldCorrectQuestions = oldCorrectQuestionIds
    .map((id) => oldQuestionMap.get(id))
    .filter(Boolean)
    .filter((item: any) => allowedModes.has(String(item.examMode ?? "").toUpperCase()));

  const deduped = new Map<string, any>();
  [...wrongQuestions, ...oldCorrectQuestions].forEach((question: any) => {
    deduped.set(String(question._id ?? question.id), question);
  });

  const totalRevisionLimit = config.wrongQuestionLimit + config.oldQuestionLimit;
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

async function handleWeakAreas(req: AuthenticatedRequest, res: any) {
  const userId = req.userId!;
  const weakPerf = await ChapterPerformance.find({ userId, isWeak: true });

  const result = await Promise.all(
    weakPerf.map(async (p) => {
      const [subject, chapter] = await Promise.all([Subject.findById(p.subjectId), Chapter.findById(p.chapterId)]);
      return {
        id: p._id.toString(),
        subjectId: p.subjectId,
        subjectName: subject?.name ?? "Unknown",
        chapterId: p.chapterId,
        chapterName: chapter?.name ?? "Unknown",
        accuracy: p.accuracy * 100,
        attempts: p.totalAttempts,
        strength: p.strength,
        lastPracticed: p.lastPracticed,
      };
    }),
  );

  res.json(result);
}

router.get("/revision", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const userId = req.userId!;
  const examMode = (user.examMode ?? "NEET") as "NEET" | "JEE" | "BOTH";

  const revisionSet = await buildRevisionSet(userId, examMode);
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

  if (revisionSet.questions.length === 0) {
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

  const session = await createLearningSession({
    userId,
    type: "revision",
    origin: "revision",
    modeKey: examMode,
    questionIds: revisionSet.questions.map((question: any) => String(question._id ?? question.id)),
    filterSnapshot: { source: "revision_module" },
    title: `${examMode} Revision Session`,
  });

  const [wrongQuestions, oldQuestions, questions] = await Promise.all([
    Promise.all(revisionSet.wrongQuestions.map((question: any) => normalizeQuestionWithNames(question))),
    Promise.all(revisionSet.oldCorrectQuestions.map((question: any) => normalizeQuestionWithNames(question))),
    Promise.all(revisionSet.questions.map((question: any) => normalizeQuestionWithNames(question))),
  ]);

  res.json({
    sessionId: session.id,
    origin: "revision",
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
      { subjectId: string; chapterId: string; total: number; correct: number; wrong: number; totalTime: number }
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
            lastAttemptDate: new Date(),
            status: nextAttempts >= 3 ? "weak" : "new",
          },
          { upsert: true, new: true },
        );
        await MistakeBook.findOneAndUpdate(
          { userId, questionId },
          {
            userId,
            questionId,
            chapter: String(question.chapterId ?? ""),
            attempts: nextBookAttempts,
            lastAttempt: new Date(),
            status: nextBookAttempts >= 3 ? "weak" : "new",
          },
          { upsert: true, new: true },
        );
      } else if (isCorrect && existingMistake) {
        await Mistake.findOneAndUpdate(
          { userId, questionId },
          {
            status: "improving",
            lastAttemptDate: new Date(),
          },
          { new: true },
        );
        await MistakeBook.findOneAndUpdate(
          { userId, questionId },
          {
            userId,
            questionId,
            chapter: String(question.chapterId ?? ""),
            status: "improving",
            lastAttempt: new Date(),
          },
          { upsert: true, new: true },
        );
      }

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
      attemptNumber: await getSessionAttemptNumber(session.id),
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

router.get("/revision/today", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const userId = req.userId!;
  const examMode = (user.examMode ?? "NEET") as "NEET" | "JEE" | "BOTH";
  const revisionSet = await buildRevisionSet(userId, examMode);
  const [wrongQuestions, oldCorrectQuestions] = await Promise.all([
    Promise.all(revisionSet.wrongQuestions.map((question: any) => normalizeQuestionWithNames(question))),
    Promise.all(revisionSet.oldCorrectQuestions.map((question: any) => normalizeQuestionWithNames(question))),
  ]);

  res.json({
    wrongQuestions,
    oldCorrectQuestions,
    totalCount: revisionSet.totalCount,
    configuredTotalCount: revisionSet.config.wrongQuestionLimit + revisionSet.config.oldQuestionLimit,
    enabled: revisionSet.enabled,
  });
});

router.get("/weak-areas", requireAuth, requireOnboardingComplete, handleWeakAreas);

router.get("/mistakes", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const { status, subjectId } = req.query as Record<string, string>;

  const filter: Record<string, unknown> = { userId };
  if (status) filter.status = status;

  const allMistakes = await Mistake.find(filter);
  const result = await Promise.all(
    allMistakes.map(async (mistake) => {
      const question = await Question.findById(mistake.questionId);
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
        question: {
          ...normalizedQuestion,
          subjectName: subject?.name ?? "Unknown",
          chapterName: chapter?.name ?? "Unknown",
          topicName: topic?.name ?? "General",
          ...resolveQuestionYearFields(normalizedQuestion, year as any),
        },
        status: mistake.status,
        attempts: mistake.attempts,
        lastAttemptDate: mistake.lastAttemptDate,
        subjectId: String(question.subjectId),
        subjectName: subject?.name ?? "Unknown",
        chapterId: String(question.chapterId),
        chapterName: chapter?.name ?? "Unknown",
        topicId: String(question.topicId ?? ""),
        topicName: topic?.name ?? "General",
        selectedOption: latestAttempt?.selectedOption,
        selectedOptions: latestAttempt?.selectedOptions ?? [],
        numericAnswer: latestAttempt?.numericAnswer,
      };
    }),
  );

  res.json(result.filter(Boolean));
});

export default router;
