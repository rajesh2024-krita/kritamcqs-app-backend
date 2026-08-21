import { Router, type IRouter } from "express";
import { Chapter, MockTest, Question, QuestionAttempt, SessionAttempt, Subject, Topic, Year, mongoose } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { createLearningSession } from "../lib/learning";
import { normalizeQuestionDocument, resolveQuestionYearFields } from "../lib/question-framework";
import {
  shuffleList,
} from "../lib/adaptive-testing";
import { shuffleQuestionOptionsForDelivery } from "../lib/question-randomization";

const router: IRouter = Router();
const WEEKDAY_KEYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const SUBJECT_MOCK_SETTINGS_DEFAULTS = {
  key: "default", enabled: true, premiumAccess: true, freeAccess: false,
  defaultQuestionCount: 10, maximumQuestionCount: 50,
  prioritizeUnseenQuestions: true, allowQuestionReuse: true,
};

async function getSubjectMockSettings() {
  const raw = await mongoose.connection.collection("subjectmocktestsettings").findOne({ key: "default" });
  return { ...SUBJECT_MOCK_SETTINGS_DEFAULTS, ...(raw || {}) };
}

function canAccessSubjectMocks(user: any, settings: any) {
  if (!settings.enabled) return false;
  if (typeof user?.subjectMockTestAccess === "boolean") return user.subjectMockTestAccess;
  return user?.isPremium ? settings.premiumAccess !== false : settings.freeAccess === true;
}

function getTodayWeekdayKey(date = new Date()) {
  return WEEKDAY_KEYS[date.getDay()] ?? "SUN";
}

function evaluateAvailability(mockTest: any, date = new Date()) {
  if (mockTest.startDate && date < new Date(mockTest.startDate)) {
    return { availableToday: false, availabilityText: "This mock test has not started yet" };
  }
  if (mockTest.endDate && date > new Date(mockTest.endDate)) {
    return { availableToday: false, availabilityText: "This mock test is no longer available" };
  }
  const mode = String(mockTest.availabilityMode || "all").toLowerCase();
  if (mode === "day_wise") {
    const today = date.getDate();
    const days = Array.isArray(mockTest.availableDaysOfMonth) ? mockTest.availableDaysOfMonth.map(Number) : [];
    return {
      availableToday: days.includes(today),
      availabilityText: days.length ? `Available on day ${days.sort((a, b) => a - b).join(", ")} each month` : "Not scheduled",
    };
  }
  if (mode === "week_wise") {
    const today = getTodayWeekdayKey(date);
    const weekdays = Array.isArray(mockTest.availableWeekdays) ? mockTest.availableWeekdays.map((item: unknown) => String(item).toUpperCase()) : [];
    return {
      availableToday: weekdays.includes(today),
      availabilityText: weekdays.length ? `Available every ${weekdays.join(", ")}` : "Not scheduled",
    };
  }
  return {
    availableToday: true,
    availabilityText: "Available all days",
  };
}

function buildMockPrediction(raw: any, score?: number) {
  const maxScore = Number(raw.maxScore ?? 0);
  const safeScore = typeof score === "number" ? score : undefined;
  const ratio = maxScore > 0 && typeof safeScore === "number" ? Math.max(0, Math.min(1, safeScore / maxScore)) : undefined;
  const band =
    ratio === undefined
      ? ""
      : ratio >= 0.85
        ? "Excellent exam-day readiness."
        : ratio >= 0.7
          ? "Strong scoring zone with room to improve."
          : ratio >= 0.5
            ? "Mid-range performance. More revision can lift the score."
            : "Needs targeted improvement before exam day.";

  return {
    title: raw.predictionTitle || "Predicted Score",
    description: raw.predictionDescription || "This score is projected from the configured mock test pattern.",
    predictedScore: typeof safeScore === "number" ? Math.round(safeScore) : null,
    maxScore,
    summary:
      typeof safeScore === "number"
        ? `Based on this ${raw.examType} mock pattern, your predicted score is ${Math.round(safeScore)}/${maxScore}. ${band}`.trim()
        : raw.predictionDescription || "Complete the mock test to generate your score prediction.",
  };
}

function normalizeMockTest(mockTest: any, extras: Record<string, unknown> = {}) {
  const raw = typeof mockTest?.toJSON === "function" ? mockTest.toJSON() : mockTest;
  const availability = evaluateAvailability(raw);
  return {
    id: String(raw.id ?? raw._id),
    title: raw.title,
    slug: raw.slug,
    description: raw.description ?? "",
    examType: raw.examType,
    testType: raw.testType ?? "full",
    subjectId: raw.subjectId ?? null,
    subject: raw.subject ?? null,
    difficulty: raw.difficulty ?? "mixed",
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    generationMode: raw.generationMode ?? "fixed",
    generationFrequency: raw.generationFrequency ?? "daily",
    isOneTimeFree: Boolean(raw.isOneTimeFree),
    patternPreset: raw.patternPreset ?? "CUSTOM",
    durationMinutes: Number(raw.durationMinutes ?? 0),
    totalQuestions: Number(raw.totalQuestions ?? raw.questionIds?.length ?? 0),
    maxScore: Number(raw.maxScore ?? 0),
    questionIds: Array.isArray(raw.questionIds) ? raw.questionIds.map(String) : [],
    subjectIds: Array.isArray(raw.subjectIds) ? raw.subjectIds.map(String) : [],
    chapterIds: Array.isArray(raw.chapterIds) ? raw.chapterIds.map(String) : [],
    topicIds: Array.isArray(raw.topicIds) ? raw.topicIds.map(String) : [],
    instructions: Array.isArray(raw.instructions) ? raw.instructions : [],
    marksPerQuestion: Number(raw.marksPerQuestion ?? 4),
    negativeMarks: Number(raw.negativeMarks ?? 1),
    markingSchemeVersion: String(raw.markingSchemeVersion ?? "v1"),
    markingScheme: raw.markingScheme ?? null,
    questionMarkingRules: Array.isArray(raw.questionMarkingRules) ? raw.questionMarkingRules : [],
    markingOverrideEnabled: Boolean(raw.markingOverrideEnabled),
    prediction: buildMockPrediction(raw),
    availabilityMode: raw.availabilityMode ?? "all",
    availableDaysOfMonth: Array.isArray(raw.availableDaysOfMonth) ? raw.availableDaysOfMonth : [],
    availableWeekdays: Array.isArray(raw.availableWeekdays) ? raw.availableWeekdays : [],
    totalAttemptQuestions: Number(raw.totalAttemptQuestions ?? raw.totalQuestions ?? raw.questionIds?.length ?? 0),
    sectionGroups: Array.isArray(raw.sectionGroups) ? raw.sectionGroups : [],
    generationSource: raw.generationSource ?? "manual",
    generationScheduleType: raw.generationScheduleType ?? "",
    generationConfig: raw.generationConfig ?? null,
    generationHistory: Array.isArray(raw.generationHistory) ? raw.generationHistory : [],
    randomizeQuestionOrder: raw.randomizeQuestionOrder !== false,
    freeAccessDurationValue: Number(raw.freeAccessDurationValue ?? 1),
    freeAccessDurationUnit: raw.freeAccessDurationUnit ?? "days",
    premiumDurationType: raw.premiumDurationType ?? "daily",
    premiumValidityDays: Number(raw.premiumValidityDays ?? 1),
    autoDailyQuestionRearrangement: Boolean(raw.autoDailyQuestionRearrangement),
    autoDailyQuestionGeneration: Boolean(raw.autoDailyQuestionGeneration),
    ...availability,
    isPremiumOnly: Boolean(raw.isPremiumOnly),
    isPremiumForUser: Boolean(extras.isPremiumForUser ?? raw.isPremiumOnly),
    completedByUser: Boolean(extras.completedByUser),
    accessType: extras.accessType ?? (raw.isPremiumOnly ? "premium" : "free"),
    isActive: Boolean(raw.isActive),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...extras,
  };
}

function toIdString(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Buffer.isBuffer(value)) {
    return Array.from(value, (byte) => Number(byte).toString(16).padStart(2, "0")).join("");
  }
  if (value && typeof value === "object") {
    const objectValue: any = value;
    if (typeof objectValue.toHexString === "function") return String(objectValue.toHexString()).trim();
    if (typeof objectValue.$oid === "string") return String(objectValue.$oid).trim();
    if (objectValue.type === "Buffer" && Array.isArray(objectValue.data)) {
      return objectValue.data.map((byte: number) => Number(byte).toString(16).padStart(2, "0")).join("");
    }
    const nested = objectValue.id ?? objectValue._id;
    if (nested !== undefined) return toIdString(nested);
  }
  return String(value).trim();
}

function buildIdVariants(id: string) {
  const stringId = String(id || "").trim();
  if (!stringId) return [];
  const variants: Array<string | mongoose.Types.ObjectId> = [stringId];
  if (mongoose.isValidObjectId(stringId)) {
    variants.push(new mongoose.Types.ObjectId(stringId));
  }
  return variants;
}

function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function refreshPremiumMockQuestionsIfNeeded(mockTest: any) {
  if (!mockTest?.isPremiumOnly) return mockTest;
  // Weekly/monthly scheduler output is a published paper, not a daily template.
  // This also protects older weekly records that were saved with the daily flag.
  if (["weekly", "monthly"].includes(String(mockTest.generationScheduleType || "").toLowerCase())) return mockTest;
  if (!mockTest.autoDailyQuestionGeneration && !mockTest.autoDailyQuestionRearrangement) return mockTest;

  const todayKey = getDateKey();
  if (mockTest.lastAutoGeneratedDateKey === todayKey) return mockTest;

  if (mockTest.autoDailyQuestionGeneration) {
    const match: Record<string, unknown> = {};
    if (mockTest.examType && mockTest.examType !== "BOTH") match.examMode = mockTest.examType;
    if (Array.isArray(mockTest.subjectIds) && mockTest.subjectIds.length) match.subjectId = { $in: mockTest.subjectIds.map(String) };
    if (Array.isArray(mockTest.chapterIds) && mockTest.chapterIds.length) match.chapterId = { $in: mockTest.chapterIds.map(String) };

    const targetCount = Math.max(1, Number(mockTest.totalQuestions || mockTest.questionIds?.length || 1));
    const generated = await selectPrioritizedMockQuestions({
      match,
      targetCount,
      existingMockTestId: mockTest.id,
      includedQuestionIds: mockTest.includedQuestionIds,
    });

    if (generated.length > 0) {
      mockTest.questionIds = generated.map((question: any) => String(question._id));
      mockTest.subjectIds = [...new Set(generated.map((question: any) => toIdString(question.subjectId)).filter(Boolean))];
      mockTest.chapterIds = [...new Set(generated.map((question: any) => toIdString(question.chapterId)).filter(Boolean))];
      mockTest.totalQuestions = mockTest.questionIds.length;
    }
  } else if (mockTest.autoDailyQuestionRearrangement) {
    mockTest.questionIds = shuffleList((mockTest.questionIds || []).map(String));
  }

  mockTest.lastAutoGeneratedDateKey = todayKey;
  await mockTest.save();
  return mockTest;
}

async function getCompletedMockTestIdsForUser(userId: string, mockTestIds: string[]) {
  const ids = [...new Set(mockTestIds.map(String).filter(Boolean))];
  if (!ids.length) return new Set<string>();

  const completed = await SessionAttempt.find({
    userId,
    sourceSessionId: { $in: ids },
    completedAt: { $ne: null },
  }).distinct("sourceSessionId");

  return new Set(completed.map(String));
}

async function getMockAttemptCountsForUser(userId: string, mockTestIds: string[]) {
  const ids = [...new Set(mockTestIds.map(String).filter(Boolean))];
  if (!ids.length) return new Map<string, number>();

  const rows = await SessionAttempt.aggregate([
    {
      $match: {
        userId,
        sourceSessionId: { $in: ids },
        completedAt: { $ne: null },
      },
    },
    { $group: { _id: "$sourceSessionId", attemptCount: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row: any) => [String(row._id), Number(row.attemptCount ?? 0)]));
}

async function hasCompletedMockTest(userId: string, mockTestId: string) {
  const existing = await SessionAttempt.exists({
    userId,
    sourceSessionId: String(mockTestId),
    completedAt: { $ne: null },
  });
  return Boolean(existing);
}

async function selectPrioritizedMockQuestions({
  match,
  targetCount,
  existingMockTestId,
  includedQuestionIds = [],
}: {
  match: Record<string, unknown>;
  targetCount: number;
  existingMockTestId?: string;
  includedQuestionIds?: unknown[];
}) {
  const explicitIds = [...new Set((Array.isArray(includedQuestionIds) ? includedQuestionIds : []).map(String).filter(Boolean))];
  const usedIds = new Set(
    (
      await MockTest.find(existingMockTestId ? { _id: { $ne: existingMockTestId } } : {})
        .select("questionIds")
        .lean()
    )
      .flatMap((item: any) => (item.questionIds ?? []).map(String))
      .filter(Boolean),
  );
  const incorrectIds = new Set(
    (
      await QuestionAttempt.find({ isCorrect: false, skipped: { $ne: true } })
        .sort({ createdAt: -1 })
        .limit(5000)
        .distinct("questionId")
    ).map(String),
  );

  const candidates = await Question.find(match)
    .select("_id subjectId chapterId difficulty responseType examMode")
    .limit(20000);
  const candidateMap = new Map(candidates.map((question: any) => [String(question._id), question]));
  const selected: any[] = [];
  const selectedIds = new Set<string>();
  const append = (questions: any[]) => {
    for (const question of questions) {
      const id = String(question?._id ?? "");
      if (!id || selectedIds.has(id)) continue;
      selectedIds.add(id);
      selected.push(question);
      if (selected.length >= targetCount) break;
    }
  };

  append(explicitIds.map((id) => candidateMap.get(id)).filter(Boolean));
  append(shuffleList(candidates.filter((question: any) => !usedIds.has(String(question._id)))));
  append(shuffleList(candidates.filter((question: any) => incorrectIds.has(String(question._id)))));
  append(shuffleList(candidates.filter((question: any) => usedIds.has(String(question._id)))));
  return selected.slice(0, targetCount);
}

function buildAccessExtras(mockTest: any, user: any, completedByUser: boolean, subjectAccess = Boolean(user?.isPremium)) {
  if (mockTest.testType === "subject") {
    return {
      completedByUser,
      oneTimeFreeUsed: false,
      isPremiumForUser: true,
      accessType: "premium",
      premiumLocked: !subjectAccess,
    };
  }
  const oneTimeFreeUsed = Boolean(mockTest.testType === "subject" && mockTest.isOneTimeFree && completedByUser);
  const legacyFullRetest = Boolean((mockTest.testType ?? "full") === "full" && completedByUser);
  const isPremiumForUser = Boolean(mockTest.isPremiumOnly || oneTimeFreeUsed || legacyFullRetest);
  return {
    completedByUser,
    oneTimeFreeUsed,
    isPremiumForUser,
    accessType: isPremiumForUser ? "premium" : "free",
    premiumLocked: Boolean(isPremiumForUser && !user?.isPremium),
  };
}

function requestedIds(value: unknown) {
  return [...new Set((Array.isArray(value) ? value : []).map(toIdString).filter(Boolean))];
}

async function buildSubjectQuestionSet(item: any, body: any, userId: string, settings: any) {
  const selectedChapterIds = requestedIds(body?.chapterIds);
  const selectedTopicIds = requestedIds(body?.topicIds);
  const allowedChapterIds = requestedIds(item.chapterIds);
  const allowedTopicIds = requestedIds(item.topicIds);

  if (!selectedChapterIds.length || !selectedTopicIds.length) {
    throw Object.assign(new Error("Select at least one chapter and one topic."), { statusCode: 400, code: "subject_selection_required" });
  }
  if (allowedChapterIds.length && selectedChapterIds.some((id) => !allowedChapterIds.includes(id))) {
    throw Object.assign(new Error("A selected chapter is not enabled for this mock test."), { statusCode: 400, code: "invalid_chapter_selection" });
  }
  if (allowedTopicIds.length && selectedTopicIds.some((id) => !allowedTopicIds.includes(id))) {
    throw Object.assign(new Error("A selected topic is not enabled for this mock test."), { statusCode: 400, code: "invalid_topic_selection" });
  }

  if (selectedTopicIds.length) {
    const selectedTopicDocs = await Topic.find({ _id: { $in: selectedTopicIds } }).select("_id subjectId chapterId").lean();
    if (selectedTopicDocs.length !== selectedTopicIds.length || selectedTopicDocs.some((topic: any) => String(topic.subjectId) !== String(item.subjectId))) {
      throw Object.assign(new Error("A selected topic does not belong to this subject."), { statusCode: 400, code: "invalid_topic_selection" });
    }
    if (selectedChapterIds.length && selectedTopicDocs.some((topic: any) => !selectedChapterIds.includes(String(topic.chapterId)))) {
      throw Object.assign(new Error("Selected topics must belong to the selected chapters."), { statusCode: 400, code: "topic_chapter_mismatch" });
    }
  }

  const match: Record<string, unknown> = {
    subjectId: item.subjectId,
    examMode: item.examType,
    isVisibleToUsers: { $ne: false },
    questionStatus: { $ne: "incomplete" },
  };
  if (selectedTopicIds.length) match.topicId = { $in: selectedTopicIds.flatMap(buildIdVariants) };
  if (selectedChapterIds.length) match.chapterId = { $in: selectedChapterIds.flatMap(buildIdVariants) };
  const targetCount = Math.max(1, Math.min(Number(settings.maximumQuestionCount || 50), Number(settings.defaultQuestionCount || item.totalQuestions || 10)));
  const questions = await Question.find(match).populate("questionTypeId").limit(Math.max(targetCount * 10, 500));
  const historyCollection = mongoose.connection.collection("subjectmockquestionhistories");
  const previouslyServed = settings.prioritizeUnseenQuestions === false ? [] : await historyCollection
    .find({ userId, questionId: { $in: questions.map((question: any) => String(question._id)) } })
    .project({ questionId: 1 }).toArray();
  const seenIds = new Set(previouslyServed.map((entry: any) => String(entry.questionId)));
  const unseen = shuffleList(questions.filter((question: any) => !seenIds.has(String(question._id))));
  const reused = settings.allowQuestionReuse === false ? [] : shuffleList(questions.filter((question: any) => seenIds.has(String(question._id))));
  const selected = [...unseen, ...reused].slice(0, targetCount);
  if (!selected.length) {
    throw Object.assign(new Error("No questions are available for the selected chapters and topics."), { statusCode: 400, code: "no_matching_questions" });
  }
  return { questions: selected, selectedChapterIds, selectedTopicIds, seenIds };
}

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const userId = req.userId!;
    const subjectSettings = await getSubjectMockSettings();
    const subjectAccess = canAccessSubjectMocks(user, subjectSettings);
    const requestedExamType = String(req.query["examType"] ?? user.examMode ?? "NEET").toUpperCase();
    const search = String(req.query["search"] ?? "").trim();
    const requestedTestType = String(req.query["testType"] ?? "").toLowerCase();
    const requestedSubjectId = String(req.query["subjectId"] ?? "").trim();
    const filters: Record<string, unknown> = { isActive: true, isGenerationTemplate: { $ne: true } };

    if (requestedExamType && requestedExamType !== "BOTH") {
      filters.examType = { $in: [requestedExamType, "BOTH"] };
    }
    if (requestedTestType) filters.testType = requestedTestType === "full" ? { $in: ["full", null] } : requestedTestType;
    if (requestedSubjectId) filters.subjectId = requestedSubjectId;

    if (search) {
      filters.$or = [
        { title: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { description: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      ];
    }

    const items = await MockTest.find(filters).sort({ createdAt: -1 });
    const accessVisibleItems = user.isPremium
      ? await Promise.all(items.map((item) => refreshPremiumMockQuestionsIfNeeded(item)))
      : items.filter((item) => !item.isPremiumOnly || item.testType === "subject");
    const visibleItems = accessVisibleItems.filter((item) => item.testType !== "subject" || evaluateAvailability(item).availableToday);

    const visibleMockTestIds = visibleItems.map((item) => item.id);
    const [completedMockTestIds, attemptCountMap] = await Promise.all([
      getCompletedMockTestIdsForUser(userId, visibleMockTestIds),
      getMockAttemptCountsForUser(userId, visibleMockTestIds),
    ]);
    const subjectIds = [...new Set(visibleItems.flatMap((item) => item.subjectIds ?? []).map(String))];
    const chapterIds = [...new Set(visibleItems.flatMap((item) => item.chapterIds ?? []).map(String))];
    const [subjects, chapters] = await Promise.all([
      subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }) : [],
      chapterIds.length ? Chapter.find({ _id: { $in: chapterIds } }) : [],
    ]);
    const subjectMap = new Map(subjects.map((item) => [String(item._id), item.name]));
    const chapterMap = new Map(chapters.map((item) => [String(item._id), item.name]));

    res.json({
      success: true,
      data: visibleItems.map((item) =>
        normalizeMockTest(item, {
          ...buildAccessExtras(item, user, completedMockTestIds.has(String(item.id)), subjectAccess),
          ...(item.testType === "subject" ? {
            totalQuestions: Math.max(1, Math.min(Number(subjectSettings.maximumQuestionCount || 50), Number(subjectSettings.defaultQuestionCount || 10))),
            maxScore: Math.max(1, Math.min(Number(subjectSettings.maximumQuestionCount || 50), Number(subjectSettings.defaultQuestionCount || 10))) * Number(item.marksPerQuestion || 4),
          } : {}),
          attemptCount: attemptCountMap.get(String(item.id)) ?? 0,
          nextAttemptNumber: (attemptCountMap.get(String(item.id)) ?? 0) + 1,
          subjectNames: (item.subjectIds ?? []).map((id) => subjectMap.get(String(id))).filter(Boolean),
          chapterNames: (item.chapterIds ?? []).map((id) => chapterMap.get(String(id))).filter(Boolean),
        }),
      ),
    });
  } catch (error) {
    req.log.error({ error }, "List mock tests failed");
    res.status(500).json({ error: "mock_tests_failed", message: "Failed to load mock tests" });
  }
});

router.get("/performance/subject", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const examType = String(req.query["examType"] ?? "").toUpperCase();
    const subjectId = String(req.query["subjectId"] ?? "").trim();
    if (!["NEET", "JEE"].includes(examType) || !subjectId) {
      res.status(400).json({ error: "invalid_subject_filter", message: "A valid exam mode and subject are required" });
      return;
    }
    const tests = await MockTest.find({ testType: "subject", examType, subjectId }).select("_id title maxScore subject").lean();
    const testMap = new Map(tests.map((test: any) => [String(test._id), test]));
    const attempts = await SessionAttempt.find({
      userId: req.userId!,
      sourceSessionId: { $in: [...testMap.keys()] },
      completedAt: { $ne: null },
    }).sort({ completedAt: -1 }).lean();
    const recentAttempts = attempts.map((attempt: any) => {
      const test: any = testMap.get(String(attempt.sourceSessionId));
      const maxScore = Number(test?.maxScore || 0);
      return {
        attemptId: String(attempt._id), mockTestId: String(attempt.sourceSessionId), mockTest: test?.title,
        examMode: examType, subjectId, subject: test?.subject, score: Number(attempt.score || 0),
        percentage: maxScore > 0 ? (Number(attempt.score || 0) / maxScore) * 100 : 0,
        accuracy: Number(attempt.accuracy || 0), correct: Number(attempt.correctCount || 0),
        incorrect: Number(attempt.incorrectCount || 0), unanswered: Number(attempt.skippedCount || 0),
        timeTaken: Number(attempt.timeTaken || 0), attemptDate: attempt.completedAt,
      };
    });
    const count = recentAttempts.length;
    res.json({ success: true, data: {
      examMode: examType, subjectId, testsAttempted: count,
      averageScore: count ? recentAttempts.reduce((sum, row) => sum + row.score, 0) / count : 0,
      averageAccuracy: count ? recentAttempts.reduce((sum, row) => sum + row.accuracy, 0) / count : 0,
      bestScore: count ? Math.max(...recentAttempts.map((row) => row.score)) : 0,
      recentAttempts,
    } });
  } catch (error) {
    req.log.error({ error }, "Subject performance failed");
    res.status(500).json({ error: "subject_performance_failed", message: "Failed to load subject performance" });
  }
});

router.get("/:id/subject-options", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await getSubjectMockSettings();
    if (!canAccessSubjectMocks(req.user, settings)) return res.status(403).json({ error: "subject_mock_access_required", message: "Subject-based mock test access is not enabled for this account." });
    const item = await MockTest.findById(req.params["id"]);
    if (!item || !item.isActive || item.testType !== "subject") return res.status(404).json({ error: "subject_mock_not_found", message: "Subject mock test not found." });
    const chapterFilter: any = { subjectId: String(item.subjectId) };
    if (item.chapterIds?.length) chapterFilter._id = { $in: item.chapterIds };
    const chapters = await Chapter.find(chapterFilter).sort({ name: 1 }).lean();
    const chapterIds = chapters.map((chapter: any) => String(chapter._id));
    const topicFilter: any = { chapterId: { $in: chapterIds.flatMap(buildIdVariants) } };
    if (item.topicIds?.length) topicFilter._id = { $in: item.topicIds };
    const topics = await Topic.find(topicFilter).sort({ name: 1 }).lean();
    res.json({ success: true, data: { chapters, topics } });
  } catch (error) {
    req.log.error({ error }, "Subject mock options failed");
    res.status(500).json({ error: "subject_options_failed", message: "Failed to load chapters and topics." });
  }
});

router.get("/:id", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    let item = await MockTest.findById(req.params["id"]);
    if (!item || !item.isActive || item.isGenerationTemplate) {
      res.status(404).json({ error: "mock_test_not_found", message: "Mock test not found" });
      return;
    }

    const completedByUser = await hasCompletedMockTest(req.userId!, item.id);
    const access = buildAccessExtras(item, req.user, completedByUser);
    if (access.premiumLocked) {
      res.status(403).json({ error: "premium_required", message: "This mock test is available for premium learners." });
      return;
    }

    res.json({ success: true, data: normalizeMockTest(item, access) });
  } catch (error) {
    req.log.error({ error }, "Mock test detail failed");
    res.status(500).json({ error: "mock_test_failed", message: "Failed to load mock test" });
  }
});

router.post("/:id/start", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const userId = req.userId!;
    let item = await MockTest.findById(req.params["id"]);
    if (!item || !item.isActive || item.isGenerationTemplate) {
      res.status(404).json({ error: "mock_test_not_found", message: "Mock test not found" });
      return;
    }

    const subjectSettings = await getSubjectMockSettings();
    const subjectAccess = canAccessSubjectMocks(user, subjectSettings);
    if (item.testType === "subject" && !subjectAccess) {
      res.status(403).json({ error: "subject_mock_access_required", message: "Subject-based mock test access is not enabled for this account." });
      return;
    }
    const completedByUser = await hasCompletedMockTest(userId, item.id);
    const access = buildAccessExtras(item, user, completedByUser, subjectAccess);
    if (access.premiumLocked) {
      res.status(403).json({ error: "premium_required", message: "This mock test is available for premium learners." });
      return;
    }
    if (user.isPremium) {
      item = await refreshPremiumMockQuestionsIfNeeded(item);
    }
    const availability = evaluateAvailability(item);
    if (!availability.availableToday) {
      res.status(403).json({ error: "mock_test_locked_today", message: availability.availabilityText });
      return;
    }

    if (item.testType === "subject") {
      if (!["NEET", "JEE"].includes(item.examType) || !item.subjectId) {
        res.status(400).json({ error: "invalid_subject_test", message: "This subject mock test is not configured correctly." });
        return;
      }
      const subject = await Subject.findById(item.subjectId).select("_id name examType");
      const validNames = item.examType === "NEET"
        ? new Set(["biology", "physics", "chemistry"])
        : new Set(["mathematics", "maths", "physics", "chemistry"]);
      if (!subject || subject.examType !== item.examType || !validNames.has(String((subject as any).name || item.subject || "").trim().toLowerCase())) {
        res.status(400).json({ error: "invalid_subject_test", message: "Invalid subject for this exam mode." });
        return;
      }
    }

    let selectedChapterIds: string[] = [];
    let selectedTopicIds: string[] = [];
    let selectedSeenIds = new Set<string>();
    let questions: any[];
    if (item.testType === "subject") {
      const selection = await buildSubjectQuestionSet(item, req.body, userId, subjectSettings);
      questions = selection.questions;
      selectedChapterIds = selection.selectedChapterIds;
      selectedTopicIds = selection.selectedTopicIds;
      selectedSeenIds = selection.seenIds;
    } else {
      questions = await Question.find({ _id: { $in: item.questionIds } }).populate("questionTypeId");
    }
    if (!questions.length) {
      res.status(400).json({ error: "mock_test_empty", message: "This mock test has no available questions." });
      return;
    }
    if (item.testType === "subject" && questions.some((question: any) =>
      String(question.subjectId) !== String(item.subjectId) || String(question.examMode).toUpperCase() !== item.examType
    )) {
      res.status(400).json({ error: "invalid_subject_questions", message: "One or more questions do not belong to this exam mode and subject." });
      return;
    }

    const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
    const orderedQuestions = item.testType === "subject" ? questions : item.questionIds.map((id) => questionMap.get(String(id))).filter(Boolean);
    const sessionQuestions = orderedQuestions;
    const sessionMaxScore = item.testType === "subject"
      ? sessionQuestions.length * Number(item.marksPerQuestion || 4)
      : Number(item.maxScore || 0);

    const sessionSubjectIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.subjectId)).filter(Boolean))];
    const sessionChapterIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.chapterId)).filter(Boolean))];
    const sessionTopicIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.topicId)).filter(Boolean))];
    const sessionYearIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.yearId)).filter(Boolean))];
    const [sessionSubjects, sessionChapters, sessionYears] = await Promise.all([
      sessionSubjectIds.length ? Subject.find({ _id: { $in: sessionSubjectIds } }).select("_id name") : [],
      sessionChapterIds.length ? Chapter.find({ _id: { $in: sessionChapterIds } }).select("_id name") : [],
      sessionYearIds.length ? Year.find({ _id: { $in: sessionYearIds } }) : [],
    ]);
    let topicNameMap = new Map<string, string>();
    if (sessionTopicIds.length) {
      const topicCollection = mongoose.connection.collection("topics");
      const topicIdObjectIds = sessionTopicIds
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      const chapterVariants = sessionChapterIds.flatMap((id) => buildIdVariants(id));
      const topicDocs = await topicCollection
        .find({
          $or: [
            { _id: { $in: topicIdObjectIds } },
            { id: { $in: sessionTopicIds } },
            { chapterId: { $in: chapterVariants } },
          ],
        })
        .toArray();
      topicNameMap = new Map(
        topicDocs
          .map((doc: any) => [toIdString(doc?._id ?? doc?.id), String(doc?.name ?? doc?.label ?? "").trim()] as const)
          .filter(([id, name]) => Boolean(id && name)),
      );
    }
    const subjectNameMap = new Map(sessionSubjects.map((item: any) => [toIdString(item?._id), String(item?.name || "").trim()]));
    const chapterNameMap = new Map(sessionChapters.map((item: any) => [toIdString(item?._id), String(item?.name || "").trim()]));
    const yearMap = new Map(sessionYears.map((item: any) => [toIdString(item?._id), item]));

    const session = await createLearningSession({
      userId: req.userId!,
      type: "test",
      origin: "mock_test",
      modeKey: item.examType === "BOTH" ? "BOTH" : item.examType,
      questionIds: sessionQuestions.map((question: any) => String(question._id)),
      filterSnapshot: {
        mockTestId: item.id,
        testType: item.testType ?? "full",
        examType: item.examType,
        subjectId: item.subjectId ?? null,
        subjectName: item.subject ?? "",
        chapterIds: selectedChapterIds,
        topicIds: selectedTopicIds,
        chapterNames: selectedChapterIds.map((id) => chapterNameMap.get(id)).filter(Boolean),
        topicNames: selectedTopicIds.map((id) => topicNameMap.get(id)).filter(Boolean),
        marksPerQuestion: item.marksPerQuestion,
        negativeMarks: item.negativeMarks,
        markingSchemeVersion: item.markingSchemeVersion,
        markingScheme: item.markingScheme ?? null,
        questionMarkingRules: item.testType === "subject" ? [] : Array.isArray(item.questionMarkingRules) ? item.questionMarkingRules : [],
        durationMinutes: item.durationMinutes,
        maxScore: sessionMaxScore,
        patternPreset: item.patternPreset,
        predictionTitle: item.predictionTitle,
        predictionDescription: item.predictionDescription,
        generatedAt: new Date().toISOString(),
      },
      sourceSessionId: item.id,
      title: item.title,
    });

    res.json({
      success: true,
      data: normalizeMockTest(item, access),
      sessionId: session.id,
      origin: "mock_test",
      totalQuestions: sessionQuestions.length,
      timeLimit: Number(item.durationMinutes) * 60,
      title: item.title,
      prediction: buildMockPrediction(item),
      questions: shuffleQuestionOptionsForDelivery(
        sessionQuestions.map((question: any) => {
          const normalized = normalizeQuestionDocument(question);
          const subjectName = subjectNameMap.get(toIdString(question?.subjectId)) || String(normalized?.subject || "").trim();
          const chapterName = chapterNameMap.get(toIdString(question?.chapterId)) || String(normalized?.chapterName || "").trim();
          const topicName = topicNameMap.get(toIdString(question?.topicId)) || String(normalized?.topicName || normalized?.topicLabel || normalized?.topic || "").trim();
          const year = yearMap.get(toIdString(question?.yearId));
          return {
            ...normalized,
            subject: subjectName || normalized.subject,
            subjectName: subjectName || normalized.subjectName,
            chapterName: chapterName || normalized.chapterName,
            topicName: topicName || normalized.topicName,
            topicLabel: topicName || normalized.topicLabel,
            ...resolveQuestionYearFields(normalized, year as any),
          };
        }),
      ),
    });
  } catch (error) {
    req.log.error({ error }, "Mock test start failed");
    const known = error as any;
    res.status(Number(known?.statusCode || 500)).json({
      error: known?.code || "mock_test_start_failed",
      message: known?.statusCode ? known.message : "Failed to start mock test",
    });

    if (item.testType === "subject") {
      const historyCollection = mongoose.connection.collection("subjectmockquestionhistories");
      const generatedAt = new Date();
      await historyCollection.insertMany(sessionQuestions.map((question: any) => ({
        userId,
        examType: item.examType,
        subjectId: String(item.subjectId),
        chapterId: toIdString(question.chapterId),
        topicId: toIdString(question.topicId),
        questionId: String(question._id),
        mockTestId: String(item.id),
        sessionId: String(session.id),
        generatedAt,
        previouslyShown: selectedSeenIds.has(String(question._id)),
      })));
    }
  }
});

export default router;
