import { Router, type IRouter } from "express";
import {
  User,
  AppNotificationSettings,
  ChapterPerformance,
  DailyAssignment,
  DailyTest,
  ExamMarkingSettings,
  LearningSession,
  QuestionAttempt,
  SessionAttempt,
  Subject,
  Chapter,
  Mode,
  LearningLevel,
  Mistake,
  RevisionSettings,
  UserNotification,
  PushDeviceToken,
} from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { z } from "zod";
import mongoose from "mongoose";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { getLatestActivitySummary, getOrCreateDailyAssignment, getQuestionsAttemptedToday } from "../lib/learning";
import { registerToken, upsertUserNotificationOnInsert } from "../services/notificationService";

const router: IRouter = Router();
const UpdatePreferencesBody = z.object({
  examMode: z.string().trim().min(1).optional(),
  level: z.string().trim().min(1).optional(),
  name: z.string().optional(),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  address: z.string().optional(),
  mobile: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  userType: z.string().optional(),
  profileImage: z.string().optional(),
});
const CompleteOnboardingBody = z.object({
  examMode: z.string().trim().min(1),
  level: z.string().trim().min(1),
  name: z.string().optional(),
});
const RegisterPushTokenBody = z.object({
  token: z.string().trim().min(10).max(4096),
  platform: z.enum(["android", "ios", "web", "unknown"]).optional().default("unknown"),
  deviceId: z.string().trim().max(200).optional().default(""),
  appVersion: z.string().trim().max(80).optional().default(""),
});
const DEFAULT_REVISION_CONFIG = {
  wrongQuestionLimit: 10,
  oldQuestionLimit: 5,
  revisionEnabled: true,
};
const NEW_REGISTERED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_USER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function resolveConfiguredMode(examMode?: string) {
  if (!examMode) return undefined;
  const filters: any[] = [{ key: examMode }];
  if (mongoose.isValidObjectId(examMode)) filters.push({ _id: examMode });
  const mode = await Mode.findOne({ $or: filters }).select("key").lean();
  if (!mode?.key) {
    throw new Error("Invalid exam mode");
  }
  return mode.key;
}

async function resolveConfiguredLevel(level?: string) {
  if (!level) return undefined;
  const filters: any[] = [{ key: level, active: true }];
  if (mongoose.isValidObjectId(level)) filters.push({ _id: level, active: true });
  const learningLevel = await LearningLevel.findOne({ $or: filters }).select("key").lean();
  if (!learningLevel?.key) {
    throw new Error("Invalid learning level");
  }
  return learningLevel.key;
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
    emailVerified: u.emailVerified,
    authTypes: u.authTypes ?? [],
    requiresProfileCompletion: u.requiresProfileCompletion,
    isPremium: u.isPremium,
    premiumExpiresAt: u.premiumExpiresAt,
    createdAt: u.createdAt,
    isAdmin: u.isAdmin,
    migratedFromOldApp: u.migratedFromOldApp,
    country: u.country,
    state: u.state,
    city: u.city,
    userType: u.userType,
    profileImage: u.profileImage,
    isActive: u.isActive,
    isBlocked: u.isBlocked,
    lastLoginAt: u.lastLoginAt,
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

function getLearningTestType(origin?: string) {
  const normalized = String(origin || "").toLowerCase();
  if (normalized === "revision") return "Revision Test";
  if (normalized === "mock_test") return "Mock Test";
  if (normalized === "daily_set" || normalized === "daily_test") return "Daily Test";
  if (normalized === "weak_area" || normalized === "retest") return "Weak Area Practice";
  if (normalized === "smart_test") return "Subject-Based Practice Test";
  if (normalized === "practice_filter") return "Practice Test";
  return "Practice Test";
}

async function buildNotifications(
  user: any,
  userId: string,
  revisionPendingCount: number,
  weakTopicsCount: number,
  remainingToday: number | null,
  dailyTestPending: boolean,
  options: { page?: number; limit?: number; type?: string; status?: string; date?: string } = {},
) {
  const page = Math.max(1, Number(options.page || 1));
  const limit = Math.min(50, Math.max(1, Number(options.limit || 20)));
  const generatedNotifications: Array<{
    id: string;
    title: string;
    body: string;
    type: string;
    createdAt: string;
    isRead: boolean;
    linkUrl: string;
    imageUrl?: string;
  }> = [];
  const typeFilter = String(options.type || "").trim();
  const statusFilter = String(options.status || "").trim();
  const dateFilter = String(options.date || "").trim();
  await ensureAppReminderNotificationsForUser(user, userId, weakTopicsCount, dailyTestPending);

  if (!user.isPremium) {
    generatedNotifications.push({
      id: "free-daily-limit",
      title: "Daily Practice Reminder",
      body: `${remainingToday ?? 0} questions remaining in today's free plan quota.`,
      type: "practice",
      createdAt: new Date().toISOString(),
      isRead: true,
      linkUrl: "/daily-test",
    });
  }

  if (weakTopicsCount > 0) {
    generatedNotifications.push({
      id: "weak-topics",
      title: "Weak Areas Need Attention",
      body: `${weakTopicsCount} weak chapters are ready for focused practice.`,
      type: "weak_area",
      createdAt: new Date().toISOString(),
      isRead: true,
      linkUrl: "/weak-areas",
    });
  }

  if (revisionPendingCount > 0) {
    generatedNotifications.push({
      id: "revision-ready",
      title: "Revision Queue Ready",
      body: `${revisionPendingCount} revision questions are available for today.`,
      type: "revision",
      createdAt: new Date().toISOString(),
      isRead: true,
      linkUrl: "/revision",
    });
  }

  if (user.isPremium && user.premiumExpiresAt) {
    const msLeft = new Date(user.premiumExpiresAt).getTime() - Date.now();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    if (daysLeft <= 5 && daysLeft >= 0) {
      generatedNotifications.push({
        id: "subscription-ending",
        title: "Plan Ending Soon",
        body: `Your premium plan expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renew to keep unlimited access.`,
        type: "subscription",
        createdAt: new Date().toISOString(),
        isRead: true,
        linkUrl: "/subscription",
      });
    }
  }

  const latestAttempt = await SessionAttempt.findOne({ userId, completedAt: { $ne: null } }).sort({ completedAt: -1 });
  if (latestAttempt) {
    generatedNotifications.push({
      id: "latest-result",
      title: "Latest Test Result Saved",
      body: `Your latest score is ${latestAttempt.score ?? 0} with ${Math.round(latestAttempt.accuracy ?? 0)}% accuracy.`,
      type: "result",
      createdAt: (latestAttempt.completedAt ?? latestAttempt.createdAt).toISOString(),
      isRead: true,
      linkUrl: "/test-results",
    });
  }

  const storedFilter = { userId, visibleInApp: { $ne: false } };
  if (typeFilter && typeFilter !== "all") {
    (storedFilter as any).type = typeFilter;
  }
  if (statusFilter === "read") {
    (storedFilter as any).readAt = { $exists: true };
  }
  if (statusFilter === "unread") {
    (storedFilter as any).readAt = { $exists: false };
  }
  if (dateFilter) {
    const start = new Date(dateFilter);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      (storedFilter as any).createdAt = { $gte: start, $lt: end };
    }
  }
  const matchesGeneratedFilters = (item: { type: string; isRead: boolean; createdAt: string }) => {
    if (typeFilter && typeFilter !== "all" && item.type !== typeFilter) return false;
    if (statusFilter === "read" && !item.isRead) return false;
    if (statusFilter === "unread" && item.isRead) return false;
    if (dateFilter) {
      const selected = new Date(dateFilter);
      const createdAt = new Date(item.createdAt);
      if (Number.isNaN(selected.getTime()) || Number.isNaN(createdAt.getTime())) return false;
      if (
        selected.getFullYear() !== createdAt.getFullYear()
        || selected.getMonth() !== createdAt.getMonth()
        || selected.getDate() !== createdAt.getDate()
      ) {
        return false;
      }
    }
    return true;
  };
  const filteredGeneratedNotifications = generatedNotifications.filter(matchesGeneratedFilters);

  const [storedNotifications, storedTotal, storedUnread] = await Promise.all([
    UserNotification.find(storedFilter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    UserNotification.countDocuments(storedFilter),
    UserNotification.countDocuments({ ...storedFilter, readAt: { $exists: false } }),
  ]);

  return {
    items: [
      ...storedNotifications.map((item: any) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      type: item.type,
      isRead: Boolean(item.readAt),
      linkUrl: item.linkUrl || notificationLinkForType(item.type),
      imageUrl: item.imageUrl || "",
      attachmentUrl: item.attachmentUrl || "",
      attachmentName: item.attachmentName || "",
      senderName: item.senderName || "Admin",
      emailStatus: item.emailStatus || "",
      notificationStatus: item.notificationStatus || "",
      createdAt: item.createdAt.toISOString(),
      })),
      ...(page === 1 ? filteredGeneratedNotifications : []),
    ],
    count: storedUnread,
    unreadCount: storedUnread,
    total: storedTotal + filteredGeneratedNotifications.length,
    meta: { page, limit, total: storedTotal + filteredGeneratedNotifications.length, pages: Math.max(1, Math.ceil((storedTotal + filteredGeneratedNotifications.length) / limit)) },
  };
}

function appNotificationLink(action?: string, customLink?: string) {
  if (action === "dailyTest") return "/daily-test";
  if (action === "weakAreas") return "/weak-areas";
  if (action === "subscription") return "/subscription";
  if (action === "custom" && customLink) return customLink;
  return "/notifications";
}

function reminderAudienceMatches(user: any, audience?: string) {
  const createdAt = user?.createdAt ? new Date(user.createdAt).getTime() : Number.NaN;
  const lastLoginAt = user?.lastLoginAt ? new Date(user.lastLoginAt).getTime() : Number.NaN;
  const isPremium = Boolean(user?.isPremium);
  const isNewRegistered = Number.isFinite(createdAt) && Date.now() - createdAt <= NEW_REGISTERED_WINDOW_MS;
  const isActive = Number.isFinite(lastLoginAt) && Date.now() - lastLoginAt <= ACTIVE_USER_WINDOW_MS;

  if (audience === "premium") return isPremium;
  if (audience === "nonPremium") return !isPremium;
  if (audience === "newRegistered") return isNewRegistered;
  if (audience === "active") return isActive;
  return true;
}

function scheduleDueToday(time?: string) {
  const [hour, minute] = String(time || "09:00").split(":").map((item) => Number(item));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const now = new Date();
  const scheduledAt = new Date(now);
  scheduledAt.setHours(hour, minute, 0, 0);
  return now.getTime() >= scheduledAt.getTime();
}

function scheduleCreatedAt(time?: string) {
  const [hour, minute] = String(time || "09:00").split(":").map((item) => Number(item));
  const date = new Date();
  date.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0);
  return date.toISOString();
}

async function buildAppReminderNotifications(user: any, weakTopicsCount: number, dailyTestPending: boolean) {
  const settings = await AppNotificationSettings.findOne({ key: "app-reminders" }).lean();
  if (!settings) return [];

  const build = (
    key: "dailyTest" | "weakAreas",
    pending: boolean,
    fallback: { title: string; message: string; type: string; link: string },
  ) => {
    const reminder = (settings as any)[key];
    if (!pending || !reminder?.enabled || !reminderAudienceMatches(user, reminder.audience)) return [];
    return (reminder.schedules || [])
      .filter((schedule: any) => schedule?.enabled !== false && scheduleDueToday(schedule?.time))
      .map((schedule: any, index: number) => ({
        id: `configured-${key}-${String(schedule?.time || index).replace(/[^a-z0-9]/gi, "")}`,
        title: reminder.title || fallback.title,
        body: reminder.message || fallback.message,
        type: fallback.type,
        createdAt: scheduleCreatedAt(schedule?.time),
        isRead: true,
        linkUrl: appNotificationLink(reminder.ctaAction, reminder.ctaLink) || fallback.link,
        imageUrl: reminder.image || "",
      }));
  };

  return [
    ...build("dailyTest", dailyTestPending, {
      title: "Your Daily Test is waiting",
      message: "Complete today's Daily Test and keep your streak moving.",
      type: "daily_test",
      link: "/daily-test",
    }),
    ...build("weakAreas", weakTopicsCount > 0, {
      title: "Practice your Weak Areas",
      message: `${weakTopicsCount} weak chapters are ready for focused practice.`,
      type: "weak_area",
      link: "/weak-areas",
    }),
  ];
}

async function ensureAppReminderNotificationsForUser(user: any, userId: string, weakTopicsCount: number, dailyTestPending: boolean) {
  const settings = await AppNotificationSettings.findOne({ key: "app-reminders" }).lean();
  if (!settings) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateKey = today.toISOString().slice(0, 10);

  const createFor = async (
    key: "dailyTest" | "weakAreas",
    pending: boolean,
    fallback: { title: string; message: string; type: string; link: string },
  ) => {
    const reminder = (settings as any)[key];
    if (!pending || !reminder?.enabled || !reminderAudienceMatches(user, reminder.audience)) return;
    const deliveryMode = reminder.deliveryMode || "app";
    if (deliveryMode === "email") return;

    const dueSchedules = (reminder.schedules || []).filter((schedule: any) => schedule?.enabled !== false && scheduleDueToday(schedule?.time));
    for (const [index, schedule] of dueSchedules.entries()) {
      const scheduleKey = String(schedule?.time || index).replace(/[^0-9a-z]/gi, "") || String(index);
      const dedupeKey = `app-reminder:${key}:${dateKey}:${scheduleKey}:${userId}`;
      await upsertUserNotificationOnInsert(
        { dedupeKey },
        {
          userId,
          type: fallback.type,
          title: reminder.title || fallback.title,
          body: reminder.message || fallback.message,
          dedupeKey,
          visibleInApp: true,
          linkUrl: appNotificationLink(reminder.ctaAction, reminder.ctaLink) || fallback.link,
          imageUrl: reminder.image || "",
          targetGroup: reminder.audience || "all",
          deliveryMode: deliveryMode === "both" ? "notification_email" : "notification",
          notificationStatus: "created",
          pushStatus: "pending",
          senderName: "System",
          sentAt: new Date(),
        },
      );
    }
  };

  await Promise.all([
    createFor("dailyTest", dailyTestPending, {
      title: "Your Daily Test is waiting",
      message: "Complete today's Daily Test and keep your streak moving.",
      type: "daily_test",
      link: "/daily-test",
    }),
    createFor("weakAreas", weakTopicsCount > 0, {
      title: "Practice your Weak Areas",
      message: `${weakTopicsCount} weak chapters are ready for focused practice.`,
      type: "weak_area",
      link: "/weak-areas",
    }),
  ]);
}

async function hasPendingDailyTest(userId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const completed = await DailyTest.exists({ userId, testDate: { $gte: start, $lt: end }, completed: true });
  return !completed;
}

function notificationLinkForType(type: string) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("offer") || normalized.includes("subscription")) return "/subscription";
  if (normalized.includes("weak")) return "/weak-areas";
  if (normalized.includes("revision")) return "/revision";
  if (normalized.includes("result") || normalized.includes("mock")) return "/test-results";
  if (normalized.includes("support")) return "/help-support";
  if (normalized.includes("practice")) return "/practice";
  return "/notifications";
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

async function getLatestRevisionPendingCount(userId: string, configuredLimit: number) {
  if (configuredLimit <= 0) return 0;
  const latestAttempt = await SessionAttempt.findOne({ userId, completedAt: { $ne: null } }).sort({ completedAt: -1, createdAt: -1 });
  const latestIds = latestAttempt
    ? await QuestionAttempt.distinct("questionId", {
        userId,
        sessionAttemptId: String(latestAttempt.id),
        $or: [{ isCorrect: false }, { skipped: true }],
      })
    : [];
  const mistakeIds = await Mistake.distinct("questionId", {
    userId,
    completionStatus: { $ne: "completed" },
    $or: [{ wrongCount: { $gt: 0 } }, { skippedCount: { $gt: 0 } }],
  });
  const weakAreas = await ChapterPerformance.find({ userId, isMastered: { $ne: true }, $or: [{ isWeak: true }, { accuracy: { $lt: 0.8 } }] })
    .select("incorrectQuestionIds")
    .limit(50);
  const weakIds = weakAreas.flatMap((area: any) => (area.incorrectQuestionIds ?? []).map(String));
  const ids = new Set([...latestIds, ...mistakeIds, ...weakIds].map(String).filter(Boolean));
  return Math.min(configuredLimit, ids.size);
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
  const dailyTestPending = user.onboardingComplete ? await hasPendingDailyTest(req.userId!) : false;
  const revisionPendingCount = user.onboardingComplete
    ? await getLatestRevisionPendingCount(req.userId!, configuredRevisionLimit)
    : 0;
  const notifications = await buildNotifications(
    user,
    req.userId!,
    revisionPendingCount,
    weakTopicsCount,
    daily.questionsRemainingToday,
    dailyTestPending,
  );

  res.json({
    ...userResponse(user),
    ...daily,
    notificationCount: notifications.unreadCount,
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
    const examMode = await resolveConfiguredMode(body.examMode);
    const level = await resolveConfiguredLevel(body.level);
    const updated = await User.findByIdAndUpdate(
      req.userId,
      { examMode, level, name: body.name, onboardingComplete: true, requiresProfileCompletion: false },
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
      updates["examMode"] = await resolveConfiguredMode(body.examMode);
    }
    if (body.level) {
      updates["level"] = await resolveConfiguredLevel(body.level);
    }
    if (body.name !== undefined) updates["name"] = body.name;
    if (body.email !== undefined) {
      const email = String(body.email || "").trim().toLowerCase();
      if (email) updates["email"] = email;
      else unset["email"] = "";
    }
    if (body.address !== undefined) updates["address"] = body.address;
    if (body.mobile !== undefined) {
      const mobile = String(body.mobile || "").replace(/\D/g, "").slice(0, 15);
      if (mobile) updates["mobile"] = mobile;
      else unset["mobile"] = "";
    }
    if (body.country !== undefined) updates["country"] = body.country;
    if (body.state !== undefined) updates["state"] = body.state;
    if (body.city !== undefined) updates["city"] = body.city;
    if (body.userType !== undefined) updates["userType"] = body.userType;
    if (body.profileImage !== undefined) updates["profileImage"] = body.profileImage;
    if (body.name !== undefined && String(body.name || "").trim().length >= 2 && (body.email === undefined || String(body.email || "").trim())) {
      updates["requiresProfileCompletion"] = false;
    }

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
  const [
    attempts,
    weakAreas,
    strongAreas,
    user,
    assignment,
    attemptedToday,
    latestActivitySummary,
    eligibleSubjects,
    chapterAttemptSummary,
    configuredRevisionLimit,
    markingSettings,
  ] = await Promise.all([
      SessionAttempt.find({ userId, completedAt: { $ne: null } }).sort({ completedAt: -1, createdAt: -1 }),
      ChapterPerformance.find({ userId, isWeak: true }),
      ChapterPerformance.find({ userId, isMastered: true }),
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
      ExamMarkingSettings.findOne({}),
    ]);

  const uniqueAttempts = [...new Map(attempts.map((attempt) => [String(attempt.id), attempt])).values()];
  const totalTests = uniqueAttempts.length;
  const totalAttempts = uniqueAttempts.length;
  const avgAccuracy = attempts.length > 0
    ? uniqueAttempts.reduce((sum, attempt) => sum + (attempt.accuracy ?? 0), 0) / uniqueAttempts.length
    : 0;
  const totalQuestions = uniqueAttempts.reduce((sum, attempt) => sum + attempt.totalQuestions, 0);
  const correctAnswers = uniqueAttempts.reduce((sum, attempt) => sum + (attempt.correctCount ?? 0), 0);
  const totalTimeTaken = uniqueAttempts.reduce((sum, attempt) => sum + (attempt.timeTaken ?? 0), 0);
  const subjectIds = eligibleSubjects.map((subject: any) => subject.id);
  const totalChapters = subjectIds.length > 0 ? await Chapter.countDocuments({ subjectId: { $in: subjectIds } }) : 0;
  const attemptedChapters = await ChapterPerformance.countDocuments({ userId, totalAttempts: { $gt: 0 } });
  const chapterCoverage = totalChapters > 0 ? attemptedChapters / totalChapters : 0;
  const attemptSessionIds = [...new Set(uniqueAttempts.map((attempt) => String(attempt.sessionId)).filter(Boolean))];
  const attemptSessions = attemptSessionIds.length
    ? await LearningSession.find({ _id: { $in: attemptSessionIds } })
    : [];
  const sessionMap = new Map(attemptSessions.map((session) => [String(session.id), session]));
  const latestCompletedAttempt = uniqueAttempts[0];
  const latestCompletedSession = latestCompletedAttempt ? sessionMap.get(String(latestCompletedAttempt.sessionId)) : null;
  const latestAttemptedQuestions = latestCompletedAttempt
    ? Number(latestCompletedAttempt.correctCount ?? 0) + Number(latestCompletedAttempt.incorrectCount ?? 0)
    : 0;
  const latestAccuracy = latestCompletedAttempt && latestAttemptedQuestions > 0
    ? (Number(latestCompletedAttempt.correctCount ?? 0) / latestAttemptedQuestions) * 100
    : 0;
  const latestAverageTime = latestCompletedAttempt && latestAttemptedQuestions > 0
    ? Number(latestCompletedAttempt.timeTaken ?? 0) / latestAttemptedQuestions
    : 0;
  const latestTest = latestCompletedAttempt
    ? {
        attemptId: latestCompletedAttempt.id,
        sessionId: latestCompletedAttempt.sessionId,
        testName: latestCompletedSession?.title ?? getLearningTestType(latestCompletedSession?.origin),
        testType: getLearningTestType(latestCompletedSession?.origin),
        completionDateTime: latestCompletedAttempt.completedAt ?? latestCompletedAttempt.createdAt,
        completedAt: latestCompletedAttempt.completedAt ?? latestCompletedAttempt.createdAt,
        score: latestCompletedAttempt.score ?? 0,
        accuracy: Math.round(latestAccuracy * 100) / 100,
        averageTimePerQuestion: Math.round(latestAverageTime * 100) / 100,
        avgTimePerQuestion: Math.round(latestAverageTime * 100) / 100,
        correctAnswers: latestCompletedAttempt.correctCount ?? 0,
        wrongAnswers: latestCompletedAttempt.incorrectCount ?? 0,
        skippedCount: latestCompletedAttempt.skippedCount ?? 0,
        totalQuestions: latestCompletedAttempt.totalQuestions ?? 0,
        attemptedQuestions: latestAttemptedQuestions,
      }
    : null;
  const mockAttempts = uniqueAttempts
    .map((attempt) => ({ attempt, session: sessionMap.get(String(attempt.sessionId)) }))
    .filter((item) => item.session && item.session.origin === "mock_test");

  const latestAttemptByMockTest = new Map<string, { attempt: any; session: any }>();
  mockAttempts.forEach((item) => {
    const mockTestId = String(item.session?.sourceSessionId ?? item.attempt.sourceSessionId ?? item.session?.id ?? item.attempt.sessionId);
    const existing = latestAttemptByMockTest.get(mockTestId);
    const currentTime = new Date(item.attempt.completedAt ?? item.attempt.createdAt).getTime();
    const existingTime = existing ? new Date(existing.attempt.completedAt ?? existing.attempt.createdAt).getTime() : -1;
    if (!existing || currentTime > existingTime) latestAttemptByMockTest.set(mockTestId, item);
  });

  const buildMockHistoryItem = ({ attempt, session }: { attempt: any; session: any }) => {
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
        score: Math.round(score),
        predictedScore: Math.round(score),
        maxScore: Math.round(safeMaxScore),
        percentage: Math.round(ratio * 10000) / 100,
        accuracy: Number(attempt.accuracy ?? 0),
        rank: (attempt as any).rank ?? (attempt.comparisonJson as any)?.rank ?? undefined,
        range: getPredictionBandFromRatio(ratio),
        completedAt: attempt.completedAt ?? attempt.createdAt,
      };
    };

  const sortByLatestCompletion = (a: any, b: any) => {
    const left = new Date(a.completedAt).getTime();
    const right = new Date(b.completedAt).getTime();
    return right - left;
  };

  const mockPredictionHistory = [...latestAttemptByMockTest.values()]
    .map(buildMockHistoryItem)
    .sort((a, b) => {
      return sortByLatestCompletion(a, b);
    });
  const mockTestHistory = mockAttempts.map(buildMockHistoryItem).sort(sortByLatestCompletion);

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
  const minMockTestsForPrediction = Math.max(1, Number(markingSettings?.predictionMinimumMockTests ?? 5));
  const predictionReady = mockPredictionHistory.length >= minMockTestsForPrediction;
  const predictedScore = predictionReady ? Math.round(predictedMaxScore * mockPerformanceRatio) : 0;
  const predictionRange = predictionReady
    ? getPredictionBandFromRatio(mockPerformanceRatio)
    : `Complete ${minMockTestsForPrediction} mock tests`;
  const revisionPendingCount = await getLatestRevisionPendingCount(userId, configuredRevisionLimit);
  const avgTimePerQuestion = totalQuestions > 0 ? Math.round((totalTimeTaken / totalQuestions) * 100) / 100 : 0;
  const currentStreak = getCurrentStreakFromDates(
    uniqueAttempts
      .map((attempt) => attempt.completedAt ?? attempt.createdAt)
      .filter((value): value is Date => Boolean(value)),
  );
  const totalChapterAttempts = Number(chapterAttemptSummary?.[0]?.totalChapterAttempts ?? 0);

  res.json({
    totalTests,
    totalAttempts,
    totalChapterAttempts,
    avgAccuracy: Math.round(avgAccuracy * 100) / 100,
    latestAccuracy: latestTest?.accuracy ?? 0,
    totalQuestions,
    correctAnswers,
    avgTimePerQuestion,
    latestAvgTimePerQuestion: latestTest?.averageTimePerQuestion ?? 0,
    latestTest,
    predictedScore,
    predictedMaxScore,
    predictionRange,
    predictionReady,
    minMockTestsForPrediction,
    mockTestsCompleted: mockPredictionHistory.length,
    mockPredictionHistory,
    mockTestHistory,
    chapterCoveragePercent: Math.round(chapterCoverage * 100),
    currentStreak,
    weakTopicsCount: weakAreas.length,
    strongTopicsCount: strongAreas.length,
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
  const [weakTopicsCount, attemptedToday, configuredRevisionLimit, dailyTestPending] = await Promise.all([
    user.onboardingComplete ? ChapterPerformance.countDocuments({ userId, isWeak: true }) : 0,
    user.onboardingComplete ? getQuestionsAttemptedToday(userId) : 0,
    getConfiguredRevisionLimit(),
    user.onboardingComplete ? hasPendingDailyTest(userId) : false,
  ]);
  const remainingToday = user.isPremium ? null : Math.max(0, 20 - attemptedToday);
  const revisionPendingCount = user.onboardingComplete
    ? await getLatestRevisionPendingCount(userId, configuredRevisionLimit)
    : 0;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const notifications = await buildNotifications(user, userId, revisionPendingCount, weakTopicsCount, remainingToday, dailyTestPending, {
    page,
    limit,
    type: String(req.query.type || ""),
    status: String(req.query.status || ""),
    date: String(req.query.date || ""),
  });
  res.json({
    count: notifications.unreadCount,
    total: notifications.total,
    items: notifications.items,
    meta: notifications.meta,
  });
});

router.post("/notifications/:id/read", requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params["id"] || "");
  if (!id.match(/^[a-f\d]{24}$/i)) {
    res.json({ success: true, synthetic: true });
    return;
  }
  const updated = await UserNotification.findOneAndUpdate(
    { _id: id, userId: req.userId! },
    { readAt: new Date() },
    { new: true },
  );
  if (!updated) {
    res.status(404).json({ error: "not_found", message: "Notification not found" });
    return;
  }
  res.json({ success: true, id: updated.id, readAt: updated.readAt });
});

router.post("/push-token", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = RegisterPushTokenBody.parse(req.body || {});
  const token = await registerToken({
    userId: req.userId!,
    token: body.token,
    platform: body.platform,
    deviceId: body.deviceId,
    appVersion: body.appVersion,
  });
  res.json({ success: true, id: token.id });
});

export default router;
