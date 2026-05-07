import { Router, type IRouter } from "express";
import { Chapter, MockTest, Question, Subject, mongoose } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { createLearningSession } from "../lib/learning";
import { normalizeQuestionDocument } from "../lib/question-framework";
import {
  avoidRecentSequences,
  getRecentSessionQuestionIds,
  shuffleList,
} from "../lib/adaptive-testing";
import { shuffleQuestionOptionsForDelivery } from "../lib/question-randomization";

const router: IRouter = Router();
const WEEKDAY_KEYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function getTodayWeekdayKey(date = new Date()) {
  return WEEKDAY_KEYS[date.getDay()] ?? "SUN";
}

function evaluateAvailability(mockTest: any, date = new Date()) {
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
    patternPreset: raw.patternPreset ?? "CUSTOM",
    durationMinutes: Number(raw.durationMinutes ?? 0),
    totalQuestions: Number(raw.totalQuestions ?? raw.questionIds?.length ?? 0),
    maxScore: Number(raw.maxScore ?? 0),
    questionIds: Array.isArray(raw.questionIds) ? raw.questionIds.map(String) : [],
    subjectIds: Array.isArray(raw.subjectIds) ? raw.subjectIds.map(String) : [],
    chapterIds: Array.isArray(raw.chapterIds) ? raw.chapterIds.map(String) : [],
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
    generationConfig: raw.generationConfig ?? null,
    generationHistory: Array.isArray(raw.generationHistory) ? raw.generationHistory : [],
    randomizeQuestionOrder: raw.randomizeQuestionOrder !== false,
    ...availability,
    isPremiumOnly: Boolean(raw.isPremiumOnly),
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

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const requestedExamType = String(req.query["examType"] ?? user.examMode ?? "NEET").toUpperCase();
    const search = String(req.query["search"] ?? "").trim();
    const filters: Record<string, unknown> = { isActive: true };

    if (requestedExamType && requestedExamType !== "BOTH") {
      filters.examType = { $in: [requestedExamType, "BOTH"] };
    }

    if (search) {
      filters.$or = [
        { title: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        { description: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
      ];
    }

    const items = await MockTest.find(filters).sort({ createdAt: -1 });
    const visibleItems = user.isPremium ? items : items.filter((item) => !item.isPremiumOnly);

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

router.get("/:id", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const item = await MockTest.findById(req.params["id"]);
    if (!item || !item.isActive) {
      res.status(404).json({ error: "mock_test_not_found", message: "Mock test not found" });
      return;
    }

    if (item.isPremiumOnly && !req.user?.isPremium) {
      res.status(403).json({ error: "premium_required", message: "This mock test is available for premium learners." });
      return;
    }

    res.json({ success: true, data: normalizeMockTest(item) });
  } catch (error) {
    req.log.error({ error }, "Mock test detail failed");
    res.status(500).json({ error: "mock_test_failed", message: "Failed to load mock test" });
  }
});

router.post("/:id/start", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const item = await MockTest.findById(req.params["id"]);
    if (!item || !item.isActive) {
      res.status(404).json({ error: "mock_test_not_found", message: "Mock test not found" });
      return;
    }

    if (item.isPremiumOnly && !user.isPremium) {
      res.status(403).json({ error: "premium_required", message: "This mock test is available for premium learners." });
      return;
    }
    const availability = evaluateAvailability(item);
    if (!availability.availableToday) {
      res.status(403).json({ error: "mock_test_locked_today", message: availability.availabilityText });
      return;
    }

    const questions = await Question.find({ _id: { $in: item.questionIds } }).populate("questionTypeId");
    if (!questions.length) {
      res.status(400).json({ error: "mock_test_empty", message: "This mock test has no available questions." });
      return;
    }

    const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
    const orderedQuestions = item.questionIds.map((id) => questionMap.get(String(id))).filter(Boolean);
    const { sequences } = await getRecentSessionQuestionIds({
      userId: req.userId!,
      origin: "mock_test",
      sourceSessionId: item.id,
      lookback: 5,
    });
    const shouldRandomize = item.randomizeQuestionOrder !== false;
    let sessionQuestions = orderedQuestions;

    if (shouldRandomize) {
      const sectionGroups = Array.isArray(item.sectionGroups) ? item.sectionGroups : [];
      if (sectionGroups.length > 0) {
        const sectionQuestionIds = sectionGroups
          .flatMap((section: any) => Array.isArray(section?.questionIds) ? section.questionIds.map(String) : [])
          .filter(Boolean);
        const sectionIdSet = new Set(sectionQuestionIds);
        const randomizedSectionQuestions = sectionGroups.flatMap((section: any) => {
          const ids = Array.isArray(section?.questionIds) ? section.questionIds.map(String) : [];
          const sectionQuestions = ids.map((id) => questionMap.get(id)).filter(Boolean);
          return shuffleList(sectionQuestions);
        });
        const extras = orderedQuestions.filter((question: any) => !sectionIdSet.has(String(question?._id)));
        sessionQuestions = [...randomizedSectionQuestions, ...shuffleList(extras)];
      } else {
        sessionQuestions = shuffleList(orderedQuestions);
      }
      const randomizedIds = avoidRecentSequences(sessionQuestions.map((question: any) => String(question?._id)), sequences);
      const orderedMap = new Map(sessionQuestions.map((question: any) => [String(question?._id), question]));
      sessionQuestions = randomizedIds.map((id) => orderedMap.get(id)).filter(Boolean);
    }

    const sessionSubjectIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.subjectId)).filter(Boolean))];
    const sessionChapterIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.chapterId)).filter(Boolean))];
    const sessionTopicIds = [...new Set(sessionQuestions.map((question: any) => toIdString(question?.topicId)).filter(Boolean))];
    const [sessionSubjects, sessionChapters] = await Promise.all([
      sessionSubjectIds.length ? Subject.find({ _id: { $in: sessionSubjectIds } }).select("_id name") : [],
      sessionChapterIds.length ? Chapter.find({ _id: { $in: sessionChapterIds } }).select("_id name") : [],
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

    const session = await createLearningSession({
      userId: req.userId!,
      type: "test",
      origin: "mock_test",
      modeKey: item.examType === "BOTH" ? "BOTH" : item.examType,
      questionIds: sessionQuestions.map((question: any) => String(question._id)),
      filterSnapshot: {
        mockTestId: item.id,
        marksPerQuestion: item.marksPerQuestion,
        negativeMarks: item.negativeMarks,
        markingSchemeVersion: item.markingSchemeVersion,
        markingScheme: item.markingScheme ?? null,
        questionMarkingRules: Array.isArray(item.questionMarkingRules) ? item.questionMarkingRules : [],
        durationMinutes: item.durationMinutes,
        maxScore: item.maxScore,
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
      data: normalizeMockTest(item),
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
          return {
            ...normalized,
            subject: subjectName || normalized.subject,
            subjectName: subjectName || normalized.subjectName,
            chapterName: chapterName || normalized.chapterName,
            topicName: topicName || normalized.topicName,
            topicLabel: topicName || normalized.topicLabel,
          };
        }),
      ),
    });
  } catch (error) {
    req.log.error({ error }, "Mock test start failed");
    res.status(500).json({ error: "mock_test_start_failed", message: "Failed to start mock test" });
  }
});

export default router;
