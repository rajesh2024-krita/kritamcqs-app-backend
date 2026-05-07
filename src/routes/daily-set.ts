import { Router, type IRouter } from "express";
import { DailyAssignment, LearningSession } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import {
  buildQuestionDisplayMap,
  createLearningSession,
  getOrCreateDailyAssignment,
  getTodayDateKey,
} from "../lib/learning";

const router: IRouter = Router();

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const assignment = await getOrCreateDailyAssignment(req.user!);
  const questions = await buildQuestionDisplayMap(assignment.questionIds);

  res.json({
    id: assignment.id,
    dateKey: assignment.dateKey,
    modeKey: assignment.modeKey,
    assignedCount: assignment.assignedCount,
    totalQuestions: assignment.assignedCount,
    completedCount: assignment.completedCount,
    remainingCount: Math.max(0, assignment.assignedCount - assignment.completedCount),
    questions,
  });
});

router.post("/:assignmentId/start", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const assignment = await DailyAssignment.findById(req.params["assignmentId"]);
  if (!assignment || assignment.userId !== req.userId) {
    res.status(404).json({ error: "not_found", message: "Daily set not found" });
    return;
  }

  let session = await LearningSession.findOne({
    userId: req.userId,
    origin: "daily_set",
    type: "practice",
    createdAt: {
      $gte: new Date(`${getTodayDateKey()}T00:00:00.000Z`),
      $lte: new Date(`${getTodayDateKey()}T23:59:59.999Z`),
    },
  });

  if (!session) {
    session = await createLearningSession({
      userId: req.userId!,
      type: "practice",
      origin: "daily_set",
      modeKey: assignment.modeKey,
      questionIds: assignment.questionIds,
      filterSnapshot: { dailyAssignmentId: assignment.id },
      title: `${assignment.modeKey} Daily Set`,
    });
  }

  const questions = await buildQuestionDisplayMap(assignment.questionIds);
  res.json({
    sessionId: session.id,
    origin: "daily_set",
    questions,
    totalQuestions: questions.length,
  });
});

export default router;
