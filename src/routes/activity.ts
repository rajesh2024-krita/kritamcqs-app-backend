import { Router, type IRouter } from "express";
import { Chapter, LearningSession, Question, QuestionAttempt, SessionAttempt, Subject } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { buildQuestionDisplayMap } from "../lib/learning";
import { getExamTypeLabel } from "../lib/question-framework";

const router: IRouter = Router();

router.get("/history", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const limit = parseInt((req.query["limit"] as string) ?? "20");
  const sessions = await LearningSession.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(limit);
  const sessionIds = sessions.map((session) => session.id);
  const attempts = await SessionAttempt.find({ sessionId: { $in: sessionIds } }).sort({ createdAt: -1 });

  const latestAttemptBySession = new Map<string, any>();
  const firstAttemptBySource = new Map<string, any>();
  const latestAttemptBySource = new Map<string, any>();

  for (const attempt of attempts) {
    if (!latestAttemptBySession.has(attempt.sessionId)) latestAttemptBySession.set(attempt.sessionId, attempt);
    const groupKey = attempt.sourceSessionId ?? attempt.sessionId;
    if (!firstAttemptBySource.has(groupKey)) firstAttemptBySource.set(groupKey, attempt);
    latestAttemptBySource.set(groupKey, attempt);
  }

  res.json(
    sessions.map((session) => {
      const latest = latestAttemptBySession.get(session.id);
      const groupKey = session.sourceSessionId ?? session.id;
      const first = firstAttemptBySource.get(groupKey);
      const finalAttempt = latestAttemptBySource.get(groupKey);

      return {
        id: session.id,
        type: session.type,
        origin: session.origin,
        title: session.title,
        createdAt: session.createdAt,
        completedAt: latest?.completedAt,
        totalQuestions: session.questionIds.length,
        latestAttempt: latest
          ? {
              id: latest.id,
              score: latest.score ?? 0,
              accuracy: latest.accuracy ?? 0,
              timeTaken: latest.timeTaken ?? 0,
              attemptNumber: latest.attemptNumber,
            }
          : null,
        comparison:
          first && finalAttempt
            ? {
                scoreDelta: (finalAttempt.score ?? 0) - (first.score ?? 0),
                accuracyDelta: (finalAttempt.accuracy ?? 0) - (first.accuracy ?? 0),
                timeDelta: (finalAttempt.timeTaken ?? 0) - (first.timeTaken ?? 0),
              }
            : null,
      };
    }),
  );
});

router.get("/:sessionId", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const session = await LearningSession.findById(req.params["sessionId"]);
  if (!session || session.userId !== req.userId) {
    res.status(404).json({ error: "not_found", message: "Session not found" });
    return;
  }

  const [attempts, questions, subjects, chapters, questionAttempts] = await Promise.all([
    SessionAttempt.find({ sessionId: session.id }).sort({ attemptNumber: 1 }),
    Question.find({ _id: { $in: session.questionIds } }).populate("questionTypeId"),
    Subject.find({}),
    Chapter.find({}),
    QuestionAttempt.find({ sessionId: session.id }).sort({ createdAt: 1 }),
  ]);

  const subjectMap = new Map(subjects.map((subject) => [subject.id, subject]));
  const chapterMap = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  res.json({
    session,
    attempts,
    questions: questions.map((question: any) => ({
      id: question.id,
      question: question.question,
      subjectName: subjectMap.get(String(question.subjectId))?.name,
      chapterName: chapterMap.get(String(question.chapterId))?.name,
      examTypeLabel: getExamTypeLabel(question.exam, question.examMode),
      year: question.year,
      questionTypeLabel:
        typeof question.questionTypeId === "object" ? question.questionTypeId?.label : question.questionType,
    })),
    questionAttempts,
  });
});

router.post("/:sessionId/retest", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const sourceSession = await LearningSession.findById(req.params["sessionId"]);
  if (!sourceSession || sourceSession.userId !== req.userId) {
    res.status(404).json({ error: "not_found", message: "Session not found" });
    return;
  }

  const retestSession = await new LearningSession({
    userId: req.userId,
    type: sourceSession.type,
    origin: "retest",
    modeId: sourceSession.modeId,
    modeKey: sourceSession.modeKey,
    subjectId: sourceSession.subjectId,
    chapterId: sourceSession.chapterId,
    yearId: sourceSession.yearId,
    questionTypeId: sourceSession.questionTypeId,
    questionIds: sourceSession.questionIds,
    filterSnapshot: sourceSession.filterSnapshot,
    sourceSessionId: sourceSession.sourceSessionId ?? sourceSession.id,
    isRetestGroup: true,
    title: `${sourceSession.title ?? "Session"} Retest`,
  }).save();

  const questions = await buildQuestionDisplayMap(sourceSession.questionIds);
  res.json({
    sessionId: retestSession.id,
    sourceSessionId: sourceSession.id,
    origin: "retest",
    questions,
    totalQuestions: questions.length,
  });
});

export default router;
