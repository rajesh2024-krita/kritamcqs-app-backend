import { Router, type IRouter } from "express";
import {
  User,
  ChapterPerformance,
  DailyAssignment,
  LearningSession,
  SessionAttempt,
  Subject,
  Chapter,
  Mode,
  LearningLevel,
  RevisionSettings,
  UserNotification,
} from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { z } from "zod";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { getLatestActivitySummary, getOrCreateDailyAssignment, getQuestionsAttemptedToday } from "../lib/learning";

const router: IRouter = Router();
const UpdatePreferencesBody = z.object({
  examMode: z.string().trim().min(1).optional(),
  level: z.string().trim().min(1).optional(),
  name: z.string().optional(),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  address: z.string().optional(),
});
const CompleteOnboardingBody = z.object({
  examMode: z.string().trim().min(1),
  level: z.string().trim().min(1),
  name: z.string().optional(),
});
const DEFAULT_REVISION_CONFIG = {
  wrongQuestionLimit: 10,
  oldQuestionLimit: 5,
  revisionEnabled: true,
};

async function ensureConfiguredMode(examMode?: string) {
  if (!examMode) return;
  const exists = await Mode.exists({ key: examMode });
  if (!exists) {
    throw new Error("Invalid exam mode");
  }
}

async function ensureConfiguredLevel(level?: string) {
  if (!level) return;
  const exists = await LearningLevel.exists({ key: level, active: true });
  if (!exists) {
    throw new Error("Invalid learning level");
  }
}

function userResponse(user: any) {
  const u = user.toJSON ? user.toJSON() : user;
  return {
    id: u.id,
    mobile: u.mobile,
    email: u.email,
    name: u.name,
    address: u.address,
    examMode: u.examMode,
    level: u.level,
    onboardingComplete: u.onboardingComplete,
    mobileVerified: u.mobileVerified,
    isPremium: u.isPremium,
    premiumExpiresAt: u.premiumExpiresAt,
    createdAt: u.createdAt,
    isAdmin: u.isAdmin,
    migratedFromOldApp: u.migratedFromOldApp,
  };
}

function getCurrentStreakFromDates(dates: Date[]) {
  if (dates.length === 0) return 0;

  const normalizedDates = [...new Set(dates.map((value) => new Date(value).toISOString().slice(0, 10)))].sort((a, b) =>
    a < b ? 1 : -1,
  );

  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  for (const value of normalizedDates) {
    const currentKey = cursor.toISOString().slice(0, 10);
    if (value === currentKey) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    if (streak === 0) {
      const yesterday = new Date(cursor);
      yesterday.setDate(yesterday.getDate() - 1);
      if (value === yesterday.toISOString().slice(0, 10)) {
        streak += 1;
        cursor = yesterday;
        cursor.setDate(cursor.getDate() - 1);
      }
    }
    break;
  }

  return streak;
}

function getPredictionBandFromRatio(ratio: number) {
  if (ratio >= 0.85) return "Excellent";
  if (ratio >= 0.7) return "Strong";
  if (ratio >= 0.5) return "Progressing";
  return "Needs Improvement";
}

async function buildNotifications(user: any, userId: string, revisionPendingCount: number, weakTopicsCount: number, remainingToday: number | null) {
  const notifications: Array<{ id: string; title: string; body: string; type: string; createdAt: string }> = [];

  if (!user.isPremium) {
    notifications.push({
      id: "free-daily-limit",
      title: "Daily Practice Reminder",
      body: `${remainingToday ?? 0} questions remaining in today's free plan quota.`,
      type: "practice",
      createdAt: new Date().toISOString(),
    });
  }

  if (weakTopicsCount > 0) {
    notifications.push({
      id: "weak-topics",
      title: "Weak Areas Need Attention",
      body: `${weakTopicsCount} weak chapters are ready for focused practice.`,
      type: "weak_area",
      createdAt: new Date().toISOString(),
    });
  }

  if (revisionPendingCount > 0) {
    notifications.push({
      id: "revision-ready",
      title: "Revision Queue Ready",
      body: `${revisionPendingCount} revision questions are available for today.`,
      type: "revision",
      createdAt: new Date().toISOString(),
    });
  }

  if (user.isPremium && user.premiumExpiresAt) {
    const msLeft = new Date(user.premiumExpiresAt).getTime() - Date.now();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    if (daysLeft <= 5 && daysLeft >= 0) {
      notifications.push({
        id: "subscription-ending",
        title: "Plan Ending Soon",
        body: `Your premium plan expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renew to keep unlimited access.`,
        type: "subscription",
        createdAt: new Date().toISOString(),
      });
    }
  }

  const latestAttempt = await SessionAttempt.findOne({ userId, completedAt: { $ne: null } }).sort({ completedAt: -1 });
  if (latestAttempt) {
    notifications.push({
      id: "latest-result",
      title: "Latest Test Result Saved",
      body: `Your latest score is ${latestAttempt.score ?? 0} with ${Math.round(latestAttempt.accuracy ?? 0)}% accuracy.`,
      type: "result",
      createdAt: (latestAttempt.completedAt ?? latestAttempt.createdAt).toISOString(),
    });
  }

  const storedNotifications = await UserNotification.find({ userId, visibleInApp: { $ne: false } }).sort({ createdAt: -1 }).limit(20);
  return [
    ...storedNotifications.map((item: any) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      type: item.type,
      createdAt: item.createdAt.toISOString(),
    })),
    ...notifications,
  ];
}

async function getConfiguredRevisionLimit() {
  const settings = await RevisionSettings.findOne({});
  if (!settings) return DEFAULT_REVISION_CONFIG.wrongQuestionLimit + DEFAULT_REVISION_CONFIG.oldQuestionLimit;
  if (settings.revisionEnabled === false) return 0;
  return Math.max(
    0,
    Number(settings.wrongQuestionLimit ?? DEFAULT_REVISION_CONFIG.wrongQuestionLimit)
      + Number(settings.oldQuestionLimit ?? DEFAULT_REVISION_CONFIG.oldQuestionLimit),
  );
}

function getRevisionPendingCount({
  configuredLimit,
  weakAreasCount,
  totalQuestions,
}: {
  configuredLimit: number;
  weakAreasCount: number;
  totalQuestions?: number;
}) {
  if (configuredLimit <= 0) return 0;
  const estimatedPending = Math.max(weakAreasCount * 3, Math.floor(Number(totalQuestions ?? 0) * 0.15));
  return Math.min(configuredLimit, estimatedPending);
}

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const mode = user.examMode ? await Mode.findOne({ key: user.examMode }).lean() : null;
  let daily = {
    questionsRemainingToday: user.isPremium ? null : 20,
    dailySetAssignedCount: 0,
    dailySetCompletedCount: 0,
  };

  if (user.onboardingComplete) {
    const [assignment, attemptedToday] = await Promise.all([
      getOrCreateDailyAssignment(user),
      getQuestionsAttemptedToday(req.userId!),
    ]);

    daily = {
      questionsRemainingToday: user.isPremium ? null : Math.max(0, 20 - attemptedToday),
      dailySetAssignedCount: assignment.assignedCount,
      dailySetCompletedCount: assignment.completedCount,
    };
  }

  const [weakTopicsCount, configuredRevisionLimit] = await Promise.all([
    user.onboardingComplete ? ChapterPerformance.countDocuments({ userId: req.userId!, isWeak: true }) : 0,
    getConfiguredRevisionLimit(),
  ]);
  const revisionPendingCount = user.onboardingComplete
    ? getRevisionPendingCount({ configuredLimit: configuredRevisionLimit, weakAreasCount: weakTopicsCount })
    : 0;
  const notifications = await buildNotifications(
    user,
    req.userId!,
    revisionPendingCount,
    weakTopicsCount,
    daily.questionsRemainingToday,
  );

  res.json({
    ...userResponse(user),
    ...daily,
    notificationCount: notifications.length,
    modeMetadata: user.examMode
      ? {
          key: user.examMode,
          label: mode?.label ?? user.examMode,
          description: mode?.description,
        }
      : null,
  });
});

router.post("/onboarding", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = CompleteOnboardingBody.parse(req.body);
    await ensureConfiguredMode(body.examMode);
    await ensureConfiguredLevel(body.level);
    const updated = await User.findByIdAndUpdate(
      req.userId,
      { examMode: body.examMode, level: body.level, name: body.name, onboardingComplete: true },
      { new: true }
    );
    if (!updated) {
      res.status(404).json({ error: "not_found", message: "User not found" });
      return;
    }
    res.json(userResponse(updated));
  } catch (error) {
    req.log.error({ error }, "Onboarding error");
    res.status(400).json({ error: "onboarding_failed", message: "Failed to save preferences" });
  }
});

router.post("/preferences", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = UpdatePreferencesBody.parse(req.body);
    const updates: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};

    if (body.examMode) {
      await ensureConfiguredMode(body.examMode);
      updates["examMode"] = body.examMode;
    }
    if (body.level) {
      await ensureConfiguredLevel(body.level);
      updates["level"] = body.level;
    }
    if (body.name !== undefined) updates["name"] = body.name;
    if (body.email !== undefined) {
      const email = String(body.email || "").trim().toLowerCase();
      if (email) updates["email"] = email;
      else unset["email"] = "";
    }
    if (body.address !== undefined) updates["address"] = body.address;

    const updated = await User.findByIdAndUpdate(
      req.userId,
      {
        ...(Object.keys(updates).length ? { $set: updates } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { new: true },
    );

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "User not found" });
      return;
    }

    res.json(userResponse(updated));
  } catch (error) {
    req.log.error({ error }, "Update preferences error");
    const message = (error as any)?.code === 11000 ? "This email is already used by another account" : "Failed to update preferences";
    res.status(400).json({ error: "preferences_failed", message });
  }
});

router.get("/stats", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const [attempts, weakAreas, user, assignment, attemptedToday, latestActivitySummary, eligibleSubjects, chapterAttemptSummary, configuredRevisionLimit] = await Promise.all([
    SessionAttempt.find({ userId, completedAt: { $ne: null } }),
    ChapterPerformance.find({ userId, isWeak: true }),
    User.findById(userId),
    DailyAssignment.findOne({ userId, dateKey: new Date().toISOString().slice(0, 10) }),
    getQuestionsAttemptedToday(userId),
    getLatestActivitySummary(userId),
    Subject.find(
      !req.user?.examMode || req.user.examMode === "BOTH"
        ? {}
        : { $or: [{ examMode: req.user.examMode }, { examMode: "BOTH" }] },
    ),
    ChapterPerformance.aggregate([
      { $match: { userId } },
      { $group: { _id: null, totalChapterAttempts: { $sum: "$totalAttempts" } } },
    ]),
    getConfiguredRevisionLimit(),
  ]);

  const totalTests = attempts.length;
  const totalAttempts = attempts.length;
  const avgAccuracy = attempts.length > 0
    ? attempts.reduce((sum, attempt) => sum + (attempt.accuracy ?? 0), 0) / attempts.length
    : 0;
  const totalQuestions = attempts.reduce((sum, attempt) => sum + attempt.totalQuestions, 0);
  const correctAnswers = attempts.reduce((sum, attempt) => sum + (attempt.correctCount ?? 0), 0);
  const totalTimeTaken = attempts.reduce((sum, attempt) => sum + (attempt.timeTaken ?? 0), 0);
  const subjectIds = eligibleSubjects.map((subject: any) => subject.id);
  const totalChapters = subjectIds.length > 0 ? await Chapter.countDocuments({ subjectId: { $in: subjectIds } }) : 0;
  const attemptedChapters = await ChapterPerformance.countDocuments({ userId, totalAttempts: { $gt: 0 } });
  const chapterCoverage = totalChapters > 0 ? attemptedChapters / totalChapters : 0;
  const attemptSessionIds = [...new Set(attempts.map((attempt) => String(attempt.sessionId)).filter(Boolean))];
  const attemptSessions = attemptSessionIds.length
    ? await LearningSession.find({ _id: { $in: attemptSessionIds } })
    : [];
  const sessionMap = new Map(attemptSessions.map((session) => [String(session.id), session]));
  const mockAttempts = attempts
    .map((attempt) => ({ attempt, session: sessionMap.get(String(attempt.sessionId)) }))
    .filter((item) => item.session && item.session.origin === "mock_test");

  const mockPredictionHistory = mockAttempts
    .map(({ attempt, session }) => {
      const marksPerQuestion = Number((session?.filterSnapshot as any)?.marksPerQuestion ?? 4);
      const fallbackMaxScore = Number(attempt.totalQuestions ?? 0) * marksPerQuestion;
      const maxScore = Number((session?.filterSnapshot as any)?.maxScore ?? fallbackMaxScore ?? 0);
      const safeMaxScore = maxScore > 0 ? maxScore : fallbackMaxScore;
      const score = Number(attempt.score ?? 0);
      const ratio = safeMaxScore > 0 ? Math.max(0, Math.min(1, score / safeMaxScore)) : 0;
      return {
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        mockTestId: session?.sourceSessionId ?? null,
        title: session?.title ?? "Mock Test",
        predictedScore: Math.round(score),
        maxScore: Math.round(safeMaxScore),
        accuracy: Number(attempt.accuracy ?? 0),
        range: getPredictionBandFromRatio(ratio),
        completedAt: attempt.completedAt ?? attempt.createdAt,
      };
    })
    .sort((a, b) => {
      const left = new Date(a.completedAt).getTime();
      const right = new Date(b.completedAt).getTime();
      return right - left;
    });

  const totalMockScore = mockPredictionHistory.reduce((sum, item) => sum + Number(item.predictedScore || 0), 0);
  const totalMockMax = mockPredictionHistory.reduce((sum, item) => sum + Number(item.maxScore || 0), 0);
  const mockPerformanceRatio = totalMockMax > 0 ? Math.max(0, Math.min(1, totalMockScore / totalMockMax)) : 0;
  const latestMockMaxScore = Number(mockPredictionHistory[0]?.maxScore ?? 0);
  const predictedMaxScore =
    user?.examMode === "JEE"
      ? 300
      : user?.examMode === "NEET"
        ? 720
        : latestMockMaxScore > 0
          ? latestMockMaxScore
          : 720;
  const predictedScore = Math.round(predictedMaxScore * mockPerformanceRatio);
  const predictionRange = mockPredictionHistory.length > 0 ? getPredictionBandFromRatio(mockPerformanceRatio) : "No Mock Data";
  const revisionPendingCount = getRevisionPendingCount({
    configuredLimit: configuredRevisionLimit,
    weakAreasCount: weakAreas.length,
    totalQuestions,
  });
  const avgTimePerQuestion = totalQuestions > 0 ? Math.round((totalTimeTaken / totalQuestions) * 100) / 100 : 0;
  const currentStreak = getCurrentStreakFromDates(
    attempts
      .map((attempt) => attempt.completedAt ?? attempt.createdAt)
      .filter((value): value is Date => Boolean(value)),
  );
  const totalChapterAttempts = Number(chapterAttemptSummary?.[0]?.totalChapterAttempts ?? 0);

  res.json({
    totalTests,
    totalAttempts,
    totalChapterAttempts,
    avgAccuracy: Math.round(avgAccuracy * 100) / 100,
    totalQuestions,
    correctAnswers,
    avgTimePerQuestion,
    predictedScore,
    predictedMaxScore,
    predictionRange,
    mockTestsCompleted: mockPredictionHistory.length,
    mockPredictionHistory: mockPredictionHistory.slice(0, 10),
    chapterCoveragePercent: Math.round(chapterCoverage * 100),
    currentStreak,
    weakTopicsCount: weakAreas.length,
    revisionPendingCount,
    questionsRemainingToday: user?.isPremium ? null : Math.max(0, 20 - attemptedToday),
    dailySetAssignedCount: assignment?.assignedCount ?? 0,
    dailySetCompletedCount: assignment?.completedCount ?? 0,
    latestActivitySummary,
  });
});

router.get("/notifications", requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const userId = req.userId!;
  const [weakTopicsCount, attemptedToday, configuredRevisionLimit] = await Promise.all([
    user.onboardingComplete ? ChapterPerformance.countDocuments({ userId, isWeak: true }) : 0,
    user.onboardingComplete ? getQuestionsAttemptedToday(userId) : 0,
    getConfiguredRevisionLimit(),
  ]);
  const remainingToday = user.isPremium ? null : Math.max(0, 20 - attemptedToday);
  const revisionPendingCount = user.onboardingComplete
    ? getRevisionPendingCount({ configuredLimit: configuredRevisionLimit, weakAreasCount: weakTopicsCount })
    : 0;
  const notifications = await buildNotifications(user, userId, revisionPendingCount, weakTopicsCount, remainingToday);
  res.json({
    count: notifications.length,
    items: notifications,
  });
});

export default router;
