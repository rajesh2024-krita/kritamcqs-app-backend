import {
  Chapter,
  ChapterPerformance,
  DailyAssignment,
  DailyPlanConfig,
  LearningSession,
  Mode,
  Question,
  QuestionAttempt,
  SessionAttempt,
  Subject,
  User,
  Year,
  type IMode,
} from "@api/db";
import { getExamTypeLabel, normalizeQuestionDocument, resolveQuestionYearFields } from "./question-framework";

type ModeKey = "NEET" | "JEE" | "BOTH";
type SessionType = "test" | "practice" | "revision";
type SessionOrigin = "daily_set" | "practice_filter" | "weak_area" | "revision" | "smart_test" | "retest" | "mock_test";

export function getTodayDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function ensureModeRecords() {
  const inputs: Array<Pick<IMode, "key" | "label" | "description">> = [
    { key: "NEET", label: "NEET", description: "Biology-heavy learning mode" },
    { key: "JEE", label: "JEE", description: "Problem-solving focused learning mode" },
    { key: "BOTH", label: "BOTH", description: "Combined NEET and JEE mode" },
  ];

  const records = await Promise.all(
    inputs.map((input) =>
      Mode.findOneAndUpdate({ key: input.key }, input, { upsert: true, new: true }),
    ),
  );

  return new Map(records.map((record) => [record.key, record]));
}

export async function getModeRecord(modeKey: ModeKey) {
  const modeRecords = await ensureModeRecords();
  return modeRecords.get(modeKey) ?? modeRecords.get("NEET")!;
}

export async function ensureYearRecord(yearValue: number) {
  const yearName = String(yearValue);
  return Year.findOneAndUpdate(
    { $or: [{ value: yearValue }, { name: yearName }, { label: yearName }] },
    { name: yearName, value: yearValue, label: yearName },
    { upsert: true, new: true },
  );
}

export async function getQuestionsAttemptedToday(userId: string, dateKey = getTodayDateKey()) {
  const startOfDay = new Date(`${dateKey}T00:00:00.000Z`);
  const endOfDay = new Date(`${dateKey}T23:59:59.999Z`);
  return QuestionAttempt.countDocuments({
    userId,
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });
}

export async function getOrCreateDailyAssignment(user: InstanceType<typeof User>, dateKey = getTodayDateKey()) {
  const modeKey = (user.examMode ?? "NEET") as ModeKey;
  const mode = await getModeRecord(modeKey);

  let assignment = await DailyAssignment.findOne({ userId: user._id.toString(), dateKey });
  if (assignment) return assignment;

  const dailyPlanConfig = await DailyPlanConfig.findOne({ modeKey, isActive: true }).lean();

  const weakChapterIds = await ChapterPerformance.find({ userId: user._id.toString(), isWeak: true })
    .sort({ accuracy: 1, updatedAt: -1 })
    .limit(5)
    .distinct("chapterId");

  const examMatch =
    modeKey === "BOTH"
      ? {}
      : { $or: [{ examMode: modeKey }, { examMode: "BOTH" }] };

  const configuredCount = Number(dailyPlanConfig?.questionCount ?? 20);
  const targetCount = Number.isFinite(configuredCount) ? Math.min(200, Math.max(1, configuredCount)) : 20;
  const selectionMode = String(dailyPlanConfig?.selectionMode ?? "random").toLowerCase();
  const autoFillRemaining = dailyPlanConfig?.autoFillRemaining !== false;
  const manualQuestionIds =
    selectionMode === "manual" && Array.isArray(dailyPlanConfig?.manualQuestionIds)
      ? [...new Set(dailyPlanConfig.manualQuestionIds.map(String).filter(Boolean))]
      : [];

  let questions: any[] = [];
  const seen = new Set<string>();

  if (manualQuestionIds.length) {
    const manualQuestions = await Question.find({
      _id: { $in: manualQuestionIds },
      ...examMatch,
    }).select("_id");
    for (const item of manualQuestions) {
      const id = String(item._id);
      if (!seen.has(id)) {
        seen.add(id);
        questions.push(item);
      }
    }
  }

  if (selectionMode !== "manual" || autoFillRemaining) {
    const targetWeakSample = Math.max(0, Math.min(targetCount - questions.length, Math.ceil(targetCount * 0.6)));
    if (weakChapterIds.length && targetWeakSample > 0) {
      const weakQuestions = await Question.aggregate([
        { $match: { chapterId: { $in: weakChapterIds }, ...examMatch } },
        { $sample: { size: targetWeakSample } },
      ]);
      for (const item of weakQuestions) {
        const id = String(item._id);
        if (!seen.has(id)) {
          seen.add(id);
          questions.push(item);
        }
      }
    }

    if (questions.length < targetCount) {
      const remaining = targetCount - questions.length;
      const randomPoolFilter = seen.size
        ? { ...examMatch, _id: { $nin: Array.from(seen) } }
        : examMatch;
      const extra = await Question.aggregate([
        { $match: randomPoolFilter },
        { $sample: { size: remaining } },
      ]);
      for (const item of extra) {
        const id = String(item._id);
        if (!seen.has(id)) {
          seen.add(id);
          questions.push(item);
        }
      }
    }
  }

  const questionIds = questions.slice(0, targetCount).map((item: any) => String(item._id));

  assignment = await new DailyAssignment({
    userId: user._id.toString(),
    dateKey,
    modeId: mode._id.toString(),
    modeKey,
    questionIds,
    assignedCount: questionIds.length,
    completedQuestionIds: [],
    completedCount: 0,
    source: "daily_set",
  }).save();

  return assignment;
}

export async function updateDailyAssignmentProgress(userId: string, questionIds: string[], dateKey = getTodayDateKey()) {
  const assignment = await DailyAssignment.findOne({ userId, dateKey });
  if (!assignment) return null;

  const completedSet = new Set(assignment.completedQuestionIds ?? []);
  for (const questionId of questionIds) {
    if ((assignment.questionIds ?? []).includes(questionId)) {
      completedSet.add(questionId);
    }
  }

  assignment.completedQuestionIds = Array.from(completedSet);
  assignment.completedCount = assignment.completedQuestionIds.length;
  await assignment.save();
  return assignment;
}

export async function createLearningSession(input: {
  userId: string;
  type: SessionType;
  origin: SessionOrigin;
  modeKey: ModeKey;
  subjectId?: string;
  chapterId?: string;
  yearId?: string;
  questionTypeId?: string;
  questionIds: string[];
  filterSnapshot?: Record<string, unknown>;
  sourceSessionId?: string;
  isRetestGroup?: boolean;
  title?: string;
}) {
  const mode = await getModeRecord(input.modeKey);
  return new LearningSession({
    userId: input.userId,
    type: input.type,
    origin: input.origin,
    modeId: mode._id.toString(),
    modeKey: input.modeKey,
    subjectId: input.subjectId,
    chapterId: input.chapterId,
    yearId: input.yearId,
    questionTypeId: input.questionTypeId,
    questionIds: input.questionIds,
    filterSnapshot: input.filterSnapshot,
    sourceSessionId: input.sourceSessionId,
    isRetestGroup: Boolean(input.isRetestGroup),
    title: input.title,
  }).save();
}

export async function getSessionAttemptNumber(sessionId: string) {
  const count = await SessionAttempt.countDocuments({ sessionId });
  return count + 1;
}

export async function buildQuestionDisplayMap(questionIds: string[]) {
  const [subjects, chapters, years] = await Promise.all([
    Subject.find({}),
    Chapter.find({}),
    Year.find({}),
  ]);

  const subjectMap = new Map(subjects.map((subject) => [subject.id, subject]));
  const chapterMap = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const yearMap = new Map(years.map((year) => [year.id, year]));

  const questions = await Question.find({ _id: { $in: questionIds } }).populate("questionTypeId");
  return questions.map((question: any) => {
    const normalized = normalizeQuestionDocument(question);
    const subject = subjectMap.get(String(normalized.subjectId));
    const chapter = chapterMap.get(String(normalized.chapterId));
    const year = normalized.yearId ? yearMap.get(String(normalized.yearId)) : null;

    return {
      ...normalized,
      subjectName: subject?.name ?? normalized.subject,
      chapterName: chapter?.name,
      ...resolveQuestionYearFields(normalized, year as any),
      modeId: normalized.modeId,
      modeLabel: normalized.examMode,
      examTypeLabel: getExamTypeLabel(normalized.exam, normalized.examMode),
    };
  });
}

export async function getLatestActivitySummary(userId: string) {
  const latestAttempt = await SessionAttempt.findOne({ userId, completedAt: { $ne: null } }).sort({ completedAt: -1 });
  if (!latestAttempt) return null;

  const session = await LearningSession.findById(latestAttempt.sessionId);
  return {
    sessionId: session?.id ?? latestAttempt.sessionId,
    type: session?.type ?? "test",
    score: latestAttempt.score ?? 0,
    accuracy: latestAttempt.accuracy ?? 0,
    timeTaken: latestAttempt.timeTaken ?? 0,
    completedAt: latestAttempt.completedAt,
  };
}
