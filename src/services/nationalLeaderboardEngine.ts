import {
  NationalCompetition,
  NationalCompetitionAttempt,
  NationalCompetitionRegistration,
  NationalLeaderboardEntry,
  Question,
  User,
} from "@api/db";

export const DEFAULT_RANKING_PRIORITY = [
  "marks",
  "negativeMarks",
  "totalTime",
  "averageTimePerQuestion",
  "accuracy",
  "submissionTime",
  "attendance",
];

function normalizePriority(priority?: unknown[]) {
  const allowed = new Set(DEFAULT_RANKING_PRIORITY);
  const configured = Array.isArray(priority) ? priority.map(String).filter((item) => allowed.has(item)) : [];
  return [...configured, ...DEFAULT_RANKING_PRIORITY.filter((item) => !configured.includes(item))];
}

function rankingWeight(weights: any, key: string) {
  const value = typeof weights?.get === "function" ? weights.get(key) : weights?.[key];
  const numeric = Number(value ?? 1);
  return Number.isFinite(numeric) ? numeric : 1;
}

function weightedCompare(value: number, weights: any, key: string) {
  const weight = rankingWeight(weights, key);
  return weight === 0 ? 0 : value * Math.abs(weight);
}

function compareAttempts(a: any, b: any, priority: string[], weights: any = {}) {
  for (const key of priority) {
    if (key === "marks" && Number(b.score) !== Number(a.score)) return weightedCompare(Number(b.score) - Number(a.score), weights, key);
    if (key === "negativeMarks" && Number(a.negativeMarksApplied) !== Number(b.negativeMarksApplied)) {
      return weightedCompare(Number(a.negativeMarksApplied) - Number(b.negativeMarksApplied), weights, key);
    }
    if (key === "totalTime" && Number(a.totalTimeSeconds) !== Number(b.totalTimeSeconds)) return weightedCompare(Number(a.totalTimeSeconds) - Number(b.totalTimeSeconds), weights, key);
    if (key === "averageTimePerQuestion" && Number(a.averageTimePerQuestion) !== Number(b.averageTimePerQuestion)) {
      return weightedCompare(Number(a.averageTimePerQuestion) - Number(b.averageTimePerQuestion), weights, key);
    }
    if (key === "accuracy" && Number(b.accuracy) !== Number(a.accuracy)) return weightedCompare(Number(b.accuracy) - Number(a.accuracy), weights, key);
    if (key === "submissionTime") {
      const aTime = new Date(a.submittedAt || a.autoSubmittedAt || a.updatedAt || 0).getTime();
      const bTime = new Date(b.submittedAt || b.autoSubmittedAt || b.updatedAt || 0).getTime();
      if (aTime !== bTime) return weightedCompare(aTime - bTime, weights, key);
    }
    if (key === "attendance") {
      const aAttendance = a.startedAt ? 1 : 0;
      const bAttendance = b.startedAt ? 1 : 0;
      if (aAttendance !== bAttendance) return weightedCompare(bAttendance - aAttendance, weights, key);
    }
  }
  return String(a.userId).localeCompare(String(b.userId));
}

export function getPeriodKey(date = new Date(), scope = "weekly") {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (scope === "monthly") return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}`;
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function answerMatches(question: any, answer: any) {
  const responseType = String(question.responseType || "").toLowerCase();
  if (responseType === "multiple" || Array.isArray(question.correctOptions)) {
    const expected = (question.correctOptions || []).map(String).sort();
    const actual = (answer.selectedOptions || []).map(String).sort();
    return expected.length > 0 && expected.length === actual.length && expected.every((item: string, index: number) => item === actual[index]);
  }
  if (responseType === "numeric") {
    return String(question.numericAnswer ?? "").trim().toLowerCase() === String(answer.numericAnswer ?? "").trim().toLowerCase();
  }
  return String(question.correctOption ?? "").trim().toUpperCase() === String(answer.selectedOption ?? "").trim().toUpperCase();
}

export async function scoreCompetitionAttempt(competition: any, answers: any[], totalTimeSeconds: number) {
  const questionIds = [...new Set((competition.questionIds || []).map(String))];
  const questions = await Question.find({ _id: { $in: questionIds } }).select("_id correctOption correctOptions numericAnswer responseType");
  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
  const answerMap = new Map((answers || []).map((answer) => [String(answer.questionId), answer]));
  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;

  questionIds.forEach((questionId) => {
    const question = questionMap.get(questionId);
    const answer = answerMap.get(questionId);
    const hasAnswer = Boolean(answer?.selectedOption || answer?.numericAnswer || (Array.isArray(answer?.selectedOptions) && answer.selectedOptions.length));
    if (!question || !hasAnswer) {
      skippedCount += 1;
      return;
    }
    if (answerMatches(question, answer)) correctCount += 1;
    else wrongCount += 1;
  });

  const score = correctCount * Number(competition.marksPerQuestion || 0) - wrongCount * Number(competition.negativeMarks || 0);
  const totalQuestions = Math.max(1, questionIds.length);
  return {
    score,
    correctCount,
    wrongCount,
    skippedCount,
    negativeMarksApplied: wrongCount * Number(competition.negativeMarks || 0),
    totalTimeSeconds,
    averageTimePerQuestion: Math.round((totalTimeSeconds / totalQuestions) * 100) / 100,
    accuracy: Math.round((correctCount / totalQuestions) * 10000) / 100,
  };
}

async function upsertScopeEntries({ competition, attempts, scope, periodKey }: { competition: any; attempts: any[]; scope: string; periodKey: string }) {
  const priority = normalizePriority(competition.leaderboard?.rankingPriority);
  const weights = competition.leaderboard?.rankingWeights || {};
  const registrations = await NationalCompetitionRegistration.find({ competitionId: String(competition._id) }).lean();
  const registrationMap = new Map(registrations.map((item: any) => [String(item.userId), item]));
  const users = await User.find({ _id: { $in: attempts.map((attempt) => attempt.userId).filter(Boolean) } }).select("_id name email mobile").lean();
  const userMap = new Map(users.map((user: any) => [String(user._id), user]));

  const scopedAttempts = attempts.filter((attempt) => {
    const registration = registrationMap.get(String(attempt.userId));
    if (scope === "state") return Boolean(registration?.state);
    if (scope === "district") return Boolean(registration?.district);
    return true;
  });

  const groups = new Map<string, any[]>();
  scopedAttempts.forEach((attempt) => {
    const registration = registrationMap.get(String(attempt.userId));
    const groupKey = scope === "state" ? String(registration?.state || "") : scope === "district" ? `${registration?.state || ""}:${registration?.district || ""}` : "all";
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(attempt);
  });

  const writes: any[] = [];
  groups.forEach((groupAttempts) => {
    groupAttempts.sort((a, b) => compareAttempts(a, b, priority, weights));
    groupAttempts.forEach((attempt, index) => {
      const registration = registrationMap.get(String(attempt.userId));
      const user = userMap.get(String(attempt.userId));
      writes.push({
        updateOne: {
          filter: { competitionId: String(competition._id), scope, periodKey, userId: String(attempt.userId) },
          update: {
            $set: {
              competitionId: String(competition._id),
              attemptId: String(attempt._id),
              userId: String(attempt.userId),
              userName: user?.name || user?.email || user?.mobile || "Learner",
              state: registration?.state || "",
              district: registration?.district || "",
              school: registration?.school || "",
              scope,
              periodKey,
              rank: index + 1,
              score: attempt.score,
              negativeMarksApplied: attempt.negativeMarksApplied,
              totalTimeSeconds: attempt.totalTimeSeconds,
              averageTimePerQuestion: attempt.averageTimePerQuestion,
              accuracy: attempt.accuracy,
              submittedAt: attempt.submittedAt || attempt.autoSubmittedAt,
              attendanceScore: attempt.startedAt ? 1 : 0,
              tieBreakSnapshot: { priority, weights, refreshedAt: new Date().toISOString() },
            },
          },
          upsert: true,
        },
      });
    });
  });

  if (writes.length) await NationalLeaderboardEntry.bulkWrite(writes);
  return writes.length;
}

export async function refreshCompetitionLeaderboards(competitionId: string) {
  const competition = await NationalCompetition.findById(competitionId);
  if (!competition) throw new Error("Competition not found");
  const attempts = await NationalCompetitionAttempt.find({
    competitionId: String(competition._id),
    status: { $in: ["submitted", "auto_submitted"] },
  }).lean();
  const scopes = ["national", "state", "district"];
  if (competition.leaderboard?.publishWeekly !== false) scopes.push("weekly");
  if (competition.leaderboard?.publishMonthly !== false) scopes.push("monthly");
  if (competition.status === "archived") scopes.push("archived");
  let count = 0;
  for (const scope of scopes) {
    const periodKey = scope === "weekly" ? getPeriodKey(competition.startsAt, "weekly") : scope === "monthly" ? getPeriodKey(competition.startsAt, "monthly") : "";
    count += await upsertScopeEntries({ competition, attempts, scope, periodKey });
  }
  return { refreshedEntries: count, attemptCount: attempts.length };
}
