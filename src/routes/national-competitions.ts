import { Router, type IRouter } from "express";
import {
  NationalCompetition,
  NationalCompetitionAttempt,
  NationalCompetitionAuditLog,
  NationalCompetitionNotification,
  NationalCompetitionRegistration,
  NationalCompetitionReward,
  NationalLeaderboardEntry,
  Question,
  User,
} from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { refreshCompetitionLeaderboards, scoreCompetitionAttempt } from "../services/nationalLeaderboardEngine";
import { normalizeQuestionDocument } from "../lib/question-framework";
import { shuffleQuestionOptionsForDelivery } from "../lib/question-randomization";

const router: IRouter = Router();

function clientIp(req: AuthenticatedRequest) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function requestDeviceId(req: AuthenticatedRequest) {
  return String(req.body?.deviceId || req.headers["x-device-id"] || "").trim();
}

function isLegacyWebDeviceId(value: unknown) {
  return /^web-[a-z0-9-]+$/i.test(String(value || "").trim());
}

function formatCompetitionDate(value: Date | string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function serializeCompetition(item: any, extras: Record<string, unknown> = {}) {
  const raw = typeof item?.toJSON === "function" ? item.toJSON() : item;
  const now = Date.now();
  const startsAt = new Date(raw.startsAt).getTime();
  const registrationOpensAt = new Date(raw.registrationOpensAt).getTime();
  const registrationClosesAt = new Date(raw.registrationClosesAt).getTime();
  return {
    id: String(raw.id || raw._id),
    title: raw.title,
    slug: raw.slug,
    description: raw.description || "",
    examType: raw.examType,
    status: raw.status,
    registrationOpensAt: raw.registrationOpensAt,
    registrationClosesAt: raw.registrationClosesAt,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    durationMinutes: Number(raw.durationMinutes || 0),
    totalQuestions: Number(raw.totalQuestions || raw.questionIds?.length || 0),
    marksPerQuestion: Number(raw.marksPerQuestion || 0),
    negativeMarks: Number(raw.negativeMarks || 0),
    rules: raw.rules || [],
    rewardsSummary: raw.rewardsSummary || "",
    terms: raw.terms || "",
    eligibility: raw.eligibility || {},
    leaderboard: raw.leaderboard || {},
    security: raw.security || {},
    registrationOpen: now >= registrationOpensAt && now <= registrationClosesAt,
    startsInSeconds: Math.max(0, Math.floor((startsAt - now) / 1000)),
    ...extras,
  };
}

async function getRegistration(competitionId: string, userId: string) {
  return NationalCompetitionRegistration.findOne({ competitionId, userId });
}

function eligibilityCheck(competition: any, user: any, body: any, existingCount: number) {
  const eligibility = competition.eligibility || {};
  const state = String(body?.state || user?.state || "").trim();
  const district = String(body?.district || user?.district || "").trim();
  const allowedStates = Array.isArray(eligibility.allowedStates) ? eligibility.allowedStates : [];
  const allowedDistricts = Array.isArray(eligibility.allowedDistricts) ? eligibility.allowedDistricts : [];
  const stateAllowed = !allowedStates.length || allowedStates.some((item: unknown) => sameRegionName(item, state));
  const districtAllowed = !allowedDistricts.length || allowedDistricts.some((item: unknown) => sameRegionName(item, district));
  if (eligibility.premiumRequired && !user?.isPremium) return { ok: false, reason: "premium_required", message: "Premium membership is required." };
  if (eligibility.participantLimit > 0 && existingCount >= eligibility.participantLimit) {
    return { ok: false, reason: "participant_limit_reached", message: "Participant limit has been reached." };
  }
  if (!stateAllowed) return { ok: false, reason: "state_not_allowed", message: `${state || "Your state"} is not eligible for this competition.` };
  if (!districtAllowed) return { ok: false, reason: "district_not_allowed", message: `${district || "Your district"} is not eligible for this competition.` };
  return { ok: true, state, district };
}

function normalizeRegionName(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(dist|district)\b/gi, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function sameRegionName(a: unknown, b: unknown) {
  const left = normalizeRegionName(a);
  const right = normalizeRegionName(b);
  return Boolean(left && right && left === right);
}

function publicServerState(competition: any) {
  const now = Date.now();
  const startsAt = new Date(competition.startsAt).getTime();
  const endsAt = new Date(competition.endsAt).getTime();
  const registrationOpensAt = new Date(competition.registrationOpensAt).getTime();
  const registrationClosesAt = new Date(competition.registrationClosesAt).getTime();
  return {
    serverTime: new Date(now).toISOString(),
    serverTimeMs: now,
    registrationOpen: now >= registrationOpensAt && now <= registrationClosesAt,
    notStarted: now < startsAt,
    live: now >= startsAt && now <= endsAt,
    ended: now > endsAt,
    startsInSeconds: Math.max(0, Math.floor((startsAt - now) / 1000)),
    endsInSeconds: Math.max(0, Math.floor((endsAt - now) / 1000)),
  };
}

router.get("/server-time", requireAuth, async (_req: AuthenticatedRequest, res) => {
  const now = Date.now();
  res.json({ success: true, data: { serverTime: new Date(now).toISOString(), serverTimeMs: now } });
});

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const examType = String(req.query["examType"] || req.user?.examMode || "BOTH").toUpperCase();
  const filters: Record<string, unknown> = { isActive: true, isPublished: true, isEnabled: true, status: { $nin: ["draft", "cancelled"] } };
  if (examType !== "BOTH") filters.examType = { $in: [examType, "BOTH"] };
  const competitions = await NationalCompetition.find(filters).sort({ startsAt: 1 }).limit(50);
  const registrations = await NationalCompetitionRegistration.find({
    userId: req.userId!,
    competitionId: { $in: competitions.map((item) => String(item._id)) },
  });
  const registrationMap = new Map(registrations.map((item: any) => [String(item.competitionId), item]));
  res.json({
    success: true,
    data: competitions.map((item) => {
      const registration = registrationMap.get(String(item._id));
      return serializeCompetition(item, {
        registered: Boolean(registration),
        registrationStatus: registration?.status || "not_registered",
      });
    }),
  });
});

router.get("/me/history/results", requireAuth, async (req: AuthenticatedRequest, res) => {
  const attempts = await NationalCompetitionAttempt.find({ userId: req.userId!, status: { $in: ["submitted", "auto_submitted"] } }).sort({ submittedAt: -1 }).limit(100);
  res.json({ success: true, data: attempts });
});

router.get("/me/rewards", requireAuth, async (req: AuthenticatedRequest, res) => {
  const ranks = await NationalLeaderboardEntry.find({ userId: req.userId!, rank: { $gt: 0 } }).sort({ updatedAt: -1 }).limit(200).lean();
  const competitionIds = [...new Set(ranks.map((rank: any) => String(rank.competitionId)))];
  const rewards = await NationalCompetitionReward.find({
    competitionId: { $in: competitionIds },
    approvalStatus: { $in: ["approved", "distributed"] },
  }).sort({ rankFrom: 1 }).lean();
  const earned = ranks.flatMap((rank: any) =>
    rewards
      .filter((reward: any) => String(reward.competitionId) === String(rank.competitionId) && Number(rank.rank) >= Number(reward.rankFrom) && Number(rank.rank) <= Number(reward.rankTo))
      .map((reward: any) => ({ ...reward, rank: rank.rank, scope: rank.scope, competitionId: rank.competitionId })),
  );
  res.json({ success: true, data: earned });
});

router.get("/me/notifications", requireAuth, async (req: AuthenticatedRequest, res) => {
  const registrations = await NationalCompetitionRegistration.find({ userId: req.userId!, status: { $in: ["approved", "locked", "pending"] } }).select("competitionId");
  const competitionIds = registrations.map((item: any) => String(item.competitionId));
  const notifications = await NationalCompetitionNotification.find({
    $or: [{ competitionId: { $in: competitionIds } }, { audience: "all" }],
    status: { $in: ["scheduled", "sent"] },
  }).sort({ scheduledAt: -1, createdAt: -1 }).limit(50);
  res.json({ success: true, data: notifications });
});

router.get("/profile/:userId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.params["userId"] === "me" ? req.userId! : req.params["userId"];
  const [attempts, bestNational, bestState, rewards] = await Promise.all([
    NationalCompetitionAttempt.find({ userId, status: { $in: ["submitted", "auto_submitted"] } }).sort({ submittedAt: -1 }).limit(20),
    NationalLeaderboardEntry.findOne({ userId, scope: "national" }).sort({ rank: 1 }),
    NationalLeaderboardEntry.findOne({ userId, scope: "state" }).sort({ rank: 1 }),
    NationalLeaderboardEntry.countDocuments({ userId, rank: { $lte: 10 } }),
  ]);
  const averageScore = attempts.length ? Math.round((attempts.reduce((sum: number, item: any) => sum + Number(item.score || 0), 0) / attempts.length) * 100) / 100 : 0;
  res.json({
    success: true,
    data: {
      userId,
      submittedAttempts: attempts.length,
      averageScore,
      bestNationalRank: bestNational?.rank || null,
      bestStateRank: bestState?.rank || null,
      topTenFinishes: rewards,
      recentAttempts: attempts,
    },
  });
});

router.get("/:id/eligibility", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const competition = await NationalCompetition.findById(req.params["id"]);
  if (!competition || !competition.isActive || !competition.isPublished || !competition.isEnabled) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const [existingCount, registration] = await Promise.all([
    NationalCompetitionRegistration.countDocuments({ competitionId: String(competition._id), status: { $in: ["approved", "pending", "locked"] } }),
    getRegistration(String(competition._id), req.userId!),
  ]);
  const result = eligibilityCheck(competition, req.user, req.query, existingCount);
  res.json({
    success: true,
    data: {
      eligible: result.ok,
      reason: result.ok ? "eligible" : result.reason,
      message: result.ok ? "You are eligible for this competition." : result.message,
      registration,
      state: result.state || "",
      district: result.district || "",
      serverState: publicServerState(competition),
    },
  });
});

router.get("/:id", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const competition = await NationalCompetition.findById(req.params["id"]);
  if (!competition || !competition.isActive || !competition.isPublished || !competition.isEnabled) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const [registration, rewards] = await Promise.all([
    getRegistration(String(competition._id), req.userId!),
    NationalCompetitionReward.find({ competitionId: String(competition._id) }).sort({ rankFrom: 1 }),
  ]);
  res.json({
    success: true,
    data: serializeCompetition(competition, {
      registered: Boolean(registration),
      registrationStatus: registration?.status || "not_registered",
      registration,
      rewards,
      serverState: publicServerState(competition),
    }),
  });
});

router.post("/:id/register", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const competition = await NationalCompetition.findById(req.params["id"]);
  if (!competition || !competition.isActive || !competition.isPublished || !competition.isEnabled) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const now = Date.now();
  const registrationOpensAt = new Date(competition.registrationOpensAt).getTime();
  const registrationClosesAt = new Date(competition.registrationClosesAt).getTime();
  if (now < registrationOpensAt) {
    return res.status(403).json({
      error: "registration_not_started",
      message: `Registration opens on ${formatCompetitionDate(competition.registrationOpensAt)}.`,
      data: { registrationOpensAt: competition.registrationOpensAt, registrationClosesAt: competition.registrationClosesAt },
    });
  }
  if (now > registrationClosesAt) {
    return res.status(403).json({
      error: "registration_closed",
      message: `Registration closed on ${formatCompetitionDate(competition.registrationClosesAt)}.`,
      data: { registrationOpensAt: competition.registrationOpensAt, registrationClosesAt: competition.registrationClosesAt },
    });
  }
  if (String(competition.terms || "").trim() && req.body?.acceptedTerms !== true) {
    return res.status(400).json({ error: "terms_required", message: "Please accept the competition terms and conditions." });
  }
  const existingCount = await NationalCompetitionRegistration.countDocuments({ competitionId: String(competition._id), status: { $in: ["approved", "pending", "locked"] } });
  const eligibility = eligibilityCheck(competition, req.user, req.body, existingCount);
  if (!eligibility.ok) return res.status(403).json({ error: eligibility.reason, message: eligibility.message });
  if (eligibility.state || eligibility.district) {
    await User.updateOne(
      { _id: req.userId! },
      { $set: { state: eligibility.state || "", district: eligibility.district || "" } },
    );
  }
  const status = competition.eligibility?.approvalRequired ? "pending" : "approved";
  const registration = await NationalCompetitionRegistration.findOneAndUpdate(
    { competitionId: String(competition._id), userId: req.userId! },
    {
      $setOnInsert: {
        competitionId: String(competition._id),
        userId: req.userId!,
        state: eligibility.state,
        district: eligibility.district,
        school: String(req.body?.school || req.user?.school || "").trim(),
        deviceId: requestDeviceId(req),
        eligibilitySnapshot: { premiumRequired: competition.eligibility?.premiumRequired, acceptedTerms: req.body?.acceptedTerms === true, checkedAt: new Date().toISOString() },
      },
      $set: { status, approvedAt: status === "approved" ? new Date() : undefined },
    },
    { upsert: true, new: true },
  );
  await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "register", ipAddress: clientIp(req) });
  res.status(201).json({ success: true, data: registration });
});

router.post("/:id/start", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const competition = await NationalCompetition.findById(req.params["id"]);
  if (!competition || !competition.isActive || !competition.isPublished || !competition.isEnabled) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const registration = await getRegistration(String(competition._id), req.userId!);
  if (!registration || !["approved", "locked"].includes(registration.status)) return res.status(403).json({ error: "not_registered", message: "Registration approval is required." });
  const now = Date.now();
  if (now < new Date(competition.startsAt).getTime()) return res.status(403).json({ error: "competition_not_started", message: "Competition has not started yet." });
  if (now > new Date(competition.endsAt).getTime()) return res.status(403).json({ error: "competition_closed", message: "Competition window is closed." });
  const existingSubmitted = await NationalCompetitionAttempt.exists({ competitionId: String(competition._id), userId: req.userId!, status: { $in: ["submitted", "auto_submitted"] } });
  if (existingSubmitted && competition.security?.oneAttemptOnly !== false) return res.status(409).json({ error: "attempt_already_submitted", message: "Only one attempt is allowed." });
  const deviceId = requestDeviceId(req);
  const existingInProgressAttempt = await NationalCompetitionAttempt.findOne({ competitionId: String(competition._id), userId: req.userId!, status: "in_progress" });
  if (competition.security?.deviceValidation !== false && existingInProgressAttempt?.deviceId && deviceId && existingInProgressAttempt.deviceId !== deviceId) {
    if (isLegacyWebDeviceId(existingInProgressAttempt.deviceId)) {
      await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "attempt_device_lock_migrated", ipAddress: clientIp(req), metadata: { attemptDevice: existingInProgressAttempt.deviceId, currentDevice: deviceId } });
      existingInProgressAttempt.deviceId = deviceId;
      await existingInProgressAttempt.save();
    } else {
      await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "device_mismatch_start_attempt", ipAddress: clientIp(req), metadata: { attemptDevice: existingInProgressAttempt.deviceId, currentDevice: deviceId } });
      return res.status(403).json({ error: "device_mismatch", message: "This competition attempt is locked to the device where it was started." });
    }
  }
  if (competition.security?.deviceValidation !== false && registration.deviceId && deviceId && registration.deviceId !== deviceId) {
    if (isLegacyWebDeviceId(registration.deviceId)) {
      await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "device_lock_migrated", ipAddress: clientIp(req), metadata: { registeredDevice: registration.deviceId, attemptedDevice: deviceId } });
      registration.deviceId = deviceId;
      await registration.save();
    } else {
      await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "device_mismatch_start", ipAddress: clientIp(req), metadata: { registeredDevice: registration.deviceId, attemptedDevice: deviceId } });
      return res.status(403).json({ error: "device_mismatch", message: "This competition is locked to the registered device." });
    }
  }
  if (competition.security?.deviceValidation !== false && !registration.deviceId && deviceId) {
    registration.deviceId = deviceId;
    await registration.save();
  }
  const attempt = await NationalCompetitionAttempt.findOneAndUpdate(
    { competitionId: String(competition._id), userId: req.userId! },
    {
      $setOnInsert: { registrationId: String(registration._id), competitionId: String(competition._id), userId: req.userId!, startedAt: new Date(), ipAddress: clientIp(req) },
      $set: { status: "in_progress", deviceId },
    },
    { upsert: true, new: true },
  );
  const questions = await Question.find({ _id: { $in: competition.questionIds } }).populate("questionTypeId");
  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
  const ordered = competition.questionIds.map((id: string) => questionMap.get(String(id))).filter(Boolean);
  res.json({
    success: true,
    attemptId: String(attempt._id),
    timeLimit: Number(competition.durationMinutes || 0) * 60,
    serverState: publicServerState(competition),
    autosaveIntervalSeconds: Number(competition.security?.autosaveIntervalSeconds || 20),
    competition: serializeCompetition(competition),
    questions: shuffleQuestionOptionsForDelivery(ordered.map((question: any) => normalizeQuestionDocument(question))),
    savedAnswers: attempt.answers || [],
  });
});

router.get("/:id/attempt/resume", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const [competition, attempt] = await Promise.all([
    NationalCompetition.findById(req.params["id"]),
    NationalCompetitionAttempt.findOne({ competitionId: req.params["id"], userId: req.userId!, status: "in_progress" }),
  ]);
  if (!competition || !attempt) return res.status(404).json({ error: "resume_not_found", message: "No active competition attempt found." });
  const deviceId = requestDeviceId(req);
  if (competition.security?.deviceValidation !== false && attempt.deviceId && deviceId && attempt.deviceId !== deviceId) {
    if (isLegacyWebDeviceId(attempt.deviceId)) {
      await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "attempt_device_lock_migrated", ipAddress: clientIp(req), metadata: { attemptDevice: attempt.deviceId, currentDevice: deviceId } });
      attempt.deviceId = deviceId;
      await attempt.save();
    } else {
      await NationalCompetitionAuditLog.create({ competitionId: String(competition._id), actorId: req.userId!, actorRole: "student", action: "device_mismatch_resume", ipAddress: clientIp(req), metadata: { attemptDevice: attempt.deviceId, currentDevice: deviceId } });
      return res.status(403).json({ error: "device_mismatch", message: "This competition attempt is locked to the device where it was started." });
    }
  }
  if (competition.security?.deviceValidation !== false && !attempt.deviceId && deviceId) {
    attempt.deviceId = deviceId;
    await attempt.save();
  }
  const maxSeconds = Number(competition.durationMinutes || 0) * 60;
  const elapsedByClock = attempt.startedAt ? Math.max(0, Math.floor((Date.now() - new Date(attempt.startedAt).getTime()) / 1000)) : Number(attempt.totalTimeSeconds || 0);
  const elapsed = Math.min(maxSeconds, Math.max(Number(attempt.totalTimeSeconds || 0), elapsedByClock));
  const questions = await Question.find({ _id: { $in: competition.questionIds } }).populate("questionTypeId");
  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
  const ordered = competition.questionIds.map((questionId: string) => questionMap.get(String(questionId))).filter(Boolean);
  res.json({
    success: true,
    attemptId: String(attempt._id),
    timeLimit: maxSeconds,
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, maxSeconds - elapsed),
    serverState: publicServerState(competition),
    autosaveIntervalSeconds: Number(competition.security?.autosaveIntervalSeconds || 20),
    competition: serializeCompetition(competition),
    questions: shuffleQuestionOptionsForDelivery(ordered.map((question: any) => normalizeQuestionDocument(question))),
    savedAnswers: attempt.answers || [],
  });
});

router.patch("/:id/attempt/:attemptId/autosave", requireAuth, async (req: AuthenticatedRequest, res) => {
  const [competition, attempt] = await Promise.all([
    NationalCompetition.findById(req.params["id"]),
    NationalCompetitionAttempt.findOne({ _id: req.params["attemptId"], competitionId: req.params["id"], userId: req.userId! }),
  ]);
  if (!attempt || attempt.status !== "in_progress") return res.status(404).json({ error: "attempt_not_found", message: "Active attempt not found" });
  const deviceId = requestDeviceId(req);
  if (competition?.security?.deviceValidation !== false && attempt.deviceId && deviceId && attempt.deviceId !== deviceId) {
    return res.status(403).json({ error: "device_mismatch", message: "Autosave rejected for a different device." });
  }
  attempt.answers = Array.isArray(req.body?.answers) ? req.body.answers : attempt.answers;
  const maxSeconds = Number(competition?.durationMinutes || 0) * 60;
  const submittedSeconds = Math.max(Number(req.body?.totalTimeSeconds || attempt.totalTimeSeconds || 0), 0);
  attempt.totalTimeSeconds = maxSeconds ? Math.min(submittedSeconds, maxSeconds) : submittedSeconds;
  attempt.lastAutosavedAt = new Date();
  await attempt.save();
  res.json({ success: true, savedAt: attempt.lastAutosavedAt });
});

router.post("/:id/attempt/:attemptId/submit", requireAuth, async (req: AuthenticatedRequest, res) => {
  const [competition, attempt] = await Promise.all([
    NationalCompetition.findById(req.params["id"]),
    NationalCompetitionAttempt.findOne({ _id: req.params["attemptId"], competitionId: req.params["id"], userId: req.userId! }),
  ]);
  if (!competition || !attempt || !["in_progress", "not_started"].includes(attempt.status)) return res.status(404).json({ error: "attempt_not_found", message: "Submittable attempt not found" });
  const deviceId = requestDeviceId(req);
  if (competition.security?.deviceValidation !== false && attempt.deviceId && deviceId && attempt.deviceId !== deviceId) {
    return res.status(403).json({ error: "device_mismatch", message: "Submission rejected for a different device." });
  }
  const now = Date.now();
  const closeAt = new Date(competition.endsAt).getTime();
  if (now > closeAt + 30000 && req.body?.auto !== true) {
    return res.status(403).json({ error: "competition_closed", message: "Competition window is closed. Please reconnect to auto-submit." });
  }
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : attempt.answers;
  const maxSeconds = Number(competition.durationMinutes || 0) * 60;
  const submittedTime = req.body?.totalTimeSeconds ?? req.body?.timeTaken ?? attempt.totalTimeSeconds ?? 0;
  const totalTimeSeconds = Math.min(Math.max(Number(submittedTime || 0), 0), maxSeconds || Number.MAX_SAFE_INTEGER);
  const result = await scoreCompetitionAttempt(competition, answers, totalTimeSeconds);
  Object.assign(attempt, result, {
    answers,
    status: req.body?.auto === true ? "auto_submitted" : "submitted",
    submittedAt: new Date(),
    autoSubmittedAt: req.body?.auto === true ? new Date() : undefined,
  });
  await attempt.save();
  await refreshCompetitionLeaderboards(String(competition._id));
  res.json({
    success: true,
    data: attempt,
    result,
    attemptId: String(attempt._id),
    sessionId: String(attempt._id),
    score: result.score,
    accuracy: result.accuracy,
    timeTaken: result.totalTimeSeconds,
    totalQuestions: Array.isArray(competition.questionIds) ? competition.questionIds.length : 0,
    correctCount: result.correctCount,
    incorrectCount: result.wrongCount,
    skippedCount: result.skippedCount,
    maxScore: Number(competition.totalQuestions || competition.questionIds?.length || 0) * Number(competition.marksPerQuestion || 0),
    completionStatus: req.body?.auto === true ? "Auto Submitted" : "Completed",
    performanceMessage: "Competition test submitted. Leaderboard ranks will update shortly.",
  });
});

router.get("/:id/result", requireAuth, async (req: AuthenticatedRequest, res) => {
  const [attempt, rewards, totalSubmitted] = await Promise.all([
    NationalCompetitionAttempt.findOne({ competitionId: req.params["id"], userId: req.userId!, status: { $in: ["submitted", "auto_submitted"] } }),
    NationalCompetitionReward.find({ competitionId: req.params["id"], approvalStatus: { $in: ["approved", "distributed"] } }).sort({ rankFrom: 1 }),
    NationalCompetitionAttempt.countDocuments({ competitionId: req.params["id"], status: { $in: ["submitted", "auto_submitted"] } }),
  ]);
  if (!attempt) return res.status(404).json({ error: "result_not_found", message: "Result is not available yet." });
  const ranks = await NationalLeaderboardEntry.find({ competitionId: req.params["id"], userId: req.userId! });
  const nationalRank = ranks.find((rank: any) => rank.scope === "national");
  const percentile = nationalRank && totalSubmitted > 1 ? Math.round(((totalSubmitted - Number(nationalRank.rank || totalSubmitted)) / (totalSubmitted - 1)) * 10000) / 100 : null;
  res.json({ success: true, data: { attempt, ranks, rewards, percentile, totalSubmitted } });
});

router.get("/:id/leaderboard", requireAuth, async (req: AuthenticatedRequest, res) => {
  const scope = String(req.query["scope"] || "national");
  const page = Math.max(1, Number(req.query["page"] || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] || 25)));
  const filter: Record<string, unknown> = { competitionId: req.params["id"], scope };
  if (scope === "state" && req.query["state"]) filter.state = String(req.query["state"]);
  if (scope === "district" && req.query["district"]) filter.district = String(req.query["district"]);
  if (req.query["search"]) filter.userName = new RegExp(String(req.query["search"]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const [items, total, mine] = await Promise.all([
    NationalLeaderboardEntry.find(filter).sort({ rank: 1 }).skip((page - 1) * limit).limit(limit),
    NationalLeaderboardEntry.countDocuments(filter),
    NationalLeaderboardEntry.findOne({ ...filter, userId: req.userId! }),
  ]);
  res.json({ success: true, data: items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), mine } });
});

export default router;
