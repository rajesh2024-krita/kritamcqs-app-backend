import { Router, type IRouter } from "express";
import {
  NationalCompetition,
  NationalCompetitionAttempt,
  NationalCompetitionAuditLog,
  NationalCompetitionRegistration,
  NationalCompetitionReward,
  NationalLeaderboardEntry,
  Question,
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
  if (eligibility.premiumRequired && !user?.isPremium) return { ok: false, reason: "premium_required", message: "Premium membership is required." };
  if (eligibility.participantLimit > 0 && existingCount >= eligibility.participantLimit) {
    return { ok: false, reason: "participant_limit_reached", message: "Participant limit has been reached." };
  }
  if (eligibility.allowedStates?.length && !eligibility.allowedStates.includes(state)) return { ok: false, reason: "state_not_allowed", message: "Your state is not eligible." };
  if (eligibility.allowedDistricts?.length && !eligibility.allowedDistricts.includes(district)) return { ok: false, reason: "district_not_allowed", message: "Your district is not eligible." };
  return { ok: true, state, district };
}

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const examType = String(req.query["examType"] || req.user?.examMode || "BOTH").toUpperCase();
  const filters: Record<string, unknown> = { isActive: true, status: { $ne: "draft" } };
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

router.get("/:id", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const competition = await NationalCompetition.findById(req.params["id"]);
  if (!competition || !competition.isActive) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const [registration, rewards] = await Promise.all([
    getRegistration(String(competition._id), req.userId!),
    NationalCompetitionReward.find({ competitionId: String(competition._id) }).sort({ rankFrom: 1 }),
  ]);
  res.json({ success: true, data: serializeCompetition(competition, { registered: Boolean(registration), registration, rewards }) });
});

router.post("/:id/register", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const competition = await NationalCompetition.findById(req.params["id"]);
  if (!competition || !competition.isActive) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const now = Date.now();
  if (now < new Date(competition.registrationOpensAt).getTime() || now > new Date(competition.registrationClosesAt).getTime()) {
    return res.status(403).json({ error: "registration_closed", message: "Registration is not open." });
  }
  const existingCount = await NationalCompetitionRegistration.countDocuments({ competitionId: String(competition._id), status: { $in: ["approved", "pending", "locked"] } });
  const eligibility = eligibilityCheck(competition, req.user, req.body, existingCount);
  if (!eligibility.ok) return res.status(403).json({ error: eligibility.reason, message: eligibility.message });
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
        deviceId: String(req.body?.deviceId || req.headers["x-device-id"] || "").trim(),
        eligibilitySnapshot: { premiumRequired: competition.eligibility?.premiumRequired, checkedAt: new Date().toISOString() },
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
  if (!competition || !competition.isActive) return res.status(404).json({ error: "competition_not_found", message: "Competition not found" });
  const registration = await getRegistration(String(competition._id), req.userId!);
  if (!registration || !["approved", "locked"].includes(registration.status)) return res.status(403).json({ error: "not_registered", message: "Registration approval is required." });
  const now = Date.now();
  if (now < new Date(competition.startsAt).getTime()) return res.status(403).json({ error: "competition_not_started", message: "Competition has not started yet." });
  if (now > new Date(competition.endsAt).getTime()) return res.status(403).json({ error: "competition_closed", message: "Competition window is closed." });
  const existingSubmitted = await NationalCompetitionAttempt.exists({ competitionId: String(competition._id), userId: req.userId!, status: { $in: ["submitted", "auto_submitted"] } });
  if (existingSubmitted && competition.security?.oneAttemptOnly !== false) return res.status(409).json({ error: "attempt_already_submitted", message: "Only one attempt is allowed." });
  const deviceId = String(req.body?.deviceId || req.headers["x-device-id"] || "").trim();
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
    autosaveIntervalSeconds: Number(competition.security?.autosaveIntervalSeconds || 20),
    competition: serializeCompetition(competition),
    questions: shuffleQuestionOptionsForDelivery(ordered.map((question: any) => normalizeQuestionDocument(question))),
    savedAnswers: attempt.answers || [],
  });
});

router.patch("/:id/attempt/:attemptId/autosave", requireAuth, async (req: AuthenticatedRequest, res) => {
  const attempt = await NationalCompetitionAttempt.findOne({ _id: req.params["attemptId"], competitionId: req.params["id"], userId: req.userId! });
  if (!attempt || attempt.status !== "in_progress") return res.status(404).json({ error: "attempt_not_found", message: "Active attempt not found" });
  attempt.answers = Array.isArray(req.body?.answers) ? req.body.answers : attempt.answers;
  attempt.totalTimeSeconds = Math.max(Number(req.body?.totalTimeSeconds || attempt.totalTimeSeconds || 0), 0);
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
  res.json({ success: true, data: attempt, result });
});

router.get("/:id/result", requireAuth, async (req: AuthenticatedRequest, res) => {
  const [attempt, rewards] = await Promise.all([
    NationalCompetitionAttempt.findOne({ competitionId: req.params["id"], userId: req.userId!, status: { $in: ["submitted", "auto_submitted"] } }),
    NationalCompetitionReward.find({ competitionId: req.params["id"], approvalStatus: { $in: ["approved", "distributed"] } }).sort({ rankFrom: 1 }),
  ]);
  if (!attempt) return res.status(404).json({ error: "result_not_found", message: "Result is not available yet." });
  const ranks = await NationalLeaderboardEntry.find({ competitionId: req.params["id"], userId: req.userId! });
  res.json({ success: true, data: { attempt, ranks, rewards } });
});

router.get("/:id/leaderboard", requireAuth, async (req: AuthenticatedRequest, res) => {
  const scope = String(req.query["scope"] || "national");
  const page = Math.max(1, Number(req.query["page"] || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"] || 25)));
  const filter: Record<string, unknown> = { competitionId: req.params["id"], scope };
  if (scope === "state" && req.query["state"]) filter.state = String(req.query["state"]);
  if (scope === "district" && req.query["district"]) filter.district = String(req.query["district"]);
  const [items, total, mine] = await Promise.all([
    NationalLeaderboardEntry.find(filter).sort({ rank: 1 }).skip((page - 1) * limit).limit(limit),
    NationalLeaderboardEntry.countDocuments(filter),
    NationalLeaderboardEntry.findOne({ ...filter, userId: req.userId! }),
  ]);
  res.json({ success: true, data: items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), mine } });
});

export default router;
