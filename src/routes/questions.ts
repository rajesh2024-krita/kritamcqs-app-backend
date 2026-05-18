import { Router, type IRouter } from "express";
import { Chapter, Mode, Question, Subject, Year, mongoose } from "@api/db";
import { requireAuth, requireAdmin, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { buildDifficultyQuery, resolveDifficultySelection } from "../lib/difficulties";
import { getExamTypeLabel, normalizeQuestionDocument } from "../lib/question-framework";
import {
  getQuestionExamModes,
  isValidExamSubjectCombination,
  normalizeQuestionSubject,
  resolveSubjectIds,
} from "../lib/subjects";

const router: IRouter = Router();

function buildIdVariants(ids: Array<string | number>) {
  const stringIds = ids.map((value) => String(value)).filter(Boolean);
  const objectIds = stringIds
    .filter((value) => mongoose.isValidObjectId(value))
    .map((value) => new mongoose.Types.ObjectId(value));
  return [...stringIds, ...objectIds];
}

function buildFlexibleIdMatch(field: "chapterId" | "subjectId", ids?: Array<string | number>) {
  const normalizedIds = ids?.map((value) => String(value)).filter(Boolean) ?? [];
  if (normalizedIds.length === 0) return undefined;
  return { $expr: { $in: [{ $toString: `$${field}` }, normalizedIds] } };
}

function buildFlexibleSingleIdMatch(field: "yearId" | "questionTypeId", id?: string) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) return undefined;
  return { $expr: { $eq: [{ $toString: `$${field}` }, normalizedId] } };
}

function buildYearMatch(year: unknown, yearIds: string[]) {
  const rawYear = String(year ?? "").trim();
  const numericYear = Number(rawYear);
  const yearClauses: Record<string, unknown>[] = [];

  if (Number.isFinite(numericYear)) {
    yearClauses.push({ year: numericYear });
  }

  if (rawYear) {
    yearClauses.push({ year: rawYear });
    yearClauses.push({ $expr: { $eq: [{ $toString: "$year" }, rawYear] } });
  }

  if (yearIds.length > 0) {
    yearClauses.push({ $expr: { $in: [{ $toString: "$yearId" }, yearIds] } });
  }

  return yearClauses.length === 1 ? yearClauses[0] : { $or: yearClauses };
}

function buildPaperModeMatch(mode?: string, exactMode?: string) {
  if (!mode) return undefined;
  if (mode === "NEET") return { $or: [{ examMode: "NEET" }, { exam: "NEET" }] };
  if (mode === "JEE") return { $or: [{ examMode: "JEE" }, { exam: { $in: ["JEE", "JEE_MAIN", "JEE_ADVANCED"] } }] };
  if (exactMode === "true") return { examMode: mode };
  const examModes = getQuestionExamModes(mode);
  if (examModes.length === 0) return undefined;
  return { examMode: examModes.length === 1 ? examModes[0] : { $in: examModes } };
}

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const { subjectId, chapterId, difficulty, limit, mode, exam, questionType, subject, isNumerical, hasDiagram, exactMode } =
    req.query as Record<string, string>;
  const examType = String(req.query["examType"] ?? req.query["exam_type"] ?? "").trim();
  const filter: Record<string, unknown> = {};
  const aggregateClauses: Record<string, unknown>[] = [];
  const normalizedSubject = normalizeQuestionSubject(subject);

  if (subjectId) {
    const resolvedSubjectIds = await resolveSubjectIds(subjectId);
    if (resolvedSubjectIds.length === 0) {
      filter["subjectId"] = "__missing_subject__";
    } else {
      aggregateClauses.push(buildFlexibleIdMatch("subjectId", resolvedSubjectIds)!);
    }
  }
  if (chapterId) {
    aggregateClauses.push(buildFlexibleIdMatch("chapterId", [chapterId])!);
  }
  const difficultyFilter = await buildDifficultyQuery(difficulty);
  if (difficultyFilter) aggregateClauses.push(difficultyFilter);
  const modeMatch = buildPaperModeMatch(mode, exactMode);
  if (modeMatch) aggregateClauses.push(modeMatch);
  const examTypeMatch = buildPaperModeMatch(examType, exactMode);
  if (examTypeMatch) aggregateClauses.push(examTypeMatch);
  if (exam) aggregateClauses.push({ exam });
  if (questionType) aggregateClauses.push({ questionType });
  if (normalizedSubject) {
    aggregateClauses.push({
      subject:
        normalizedSubject === "Mathematics"
          ? { $in: ["Mathematics", "Maths"] }
          : normalizedSubject,
    });
  }
  if (req.query["year"]) {
    const requestedYear = Number(req.query["year"]);
    const yearText = String(req.query["year"]).trim();
    const yearDocs = Number.isFinite(requestedYear)
      ? await Year.find({
          $or: [
            { value: requestedYear },
            { name: yearText },
            { label: yearText },
          ],
        }).select("_id")
      : [];
    const yearIds = yearDocs.map((item) => String(item._id));
    aggregateClauses.push(buildYearMatch(req.query["year"], yearIds));
  }
  if (req.query["yearId"]) aggregateClauses.push(buildFlexibleSingleIdMatch("yearId", String(req.query["yearId"]))!);
  if (req.query["questionTypeId"]) aggregateClauses.push(buildFlexibleSingleIdMatch("questionTypeId", String(req.query["questionTypeId"]))!);
  if (isNumerical !== undefined) aggregateClauses.push({ isNumerical: isNumerical === "true" });
  if (hasDiagram !== undefined) aggregateClauses.push({ hasDiagram: hasDiagram === "true" });

  const aggregateMatch =
    aggregateClauses.length === 0 ? filter : aggregateClauses.length === 1 ? { ...filter, ...aggregateClauses[0] } : { ...filter, $and: aggregateClauses };

  const questionIds = await Question.aggregate([
    { $match: aggregateMatch },
    { $limit: limit ? parseInt(limit) : 500 },
    { $project: { _id: 1 } },
  ]);
  const orderedIds = questionIds.map((item: any) => item._id);

  const [questions, subjects, chapters, years, modes] = await Promise.all([
    orderedIds.length > 0 ? Question.find({ _id: { $in: orderedIds } }).populate("questionTypeId") : Promise.resolve([]),
    Subject.find({}),
    Chapter.find({}),
    Year.find({}),
    Mode.find({}),
  ]);

  const subjectMap = new Map(subjects.map((item) => [item.id, item]));
  const chapterMap = new Map(chapters.map((item) => [item.id, item]));
  const yearMap = new Map(years.map((item) => [item.id, item]));
  const modeMap = new Map(modes.map((item) => [item.id, item]));

  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));

  res.json(
    orderedIds.map((id: any) => questionMap.get(String(id))).filter(Boolean).map((question) => {
      const normalized = normalizeQuestionDocument(question);
      const subjectDoc = subjectMap.get(String(normalized.subjectId));
      const chapterDoc = chapterMap.get(String(normalized.chapterId));
      const yearDoc = normalized.yearId ? yearMap.get(String(normalized.yearId)) : undefined;
      const modeDoc = normalized.modeId ? modeMap.get(String(normalized.modeId)) : undefined;

      return {
        ...normalized,
        subjectName: normalized.subject ?? subjectDoc?.name,
        chapterName: chapterDoc?.name,
        year: normalized.year ?? (yearDoc as any)?.value ?? ((yearDoc as any)?.name ? Number((yearDoc as any).name) : undefined),
        yearLabel: (yearDoc as any)?.label ?? (yearDoc as any)?.name ?? (normalized.year ? String(normalized.year) : undefined),
        modeLabel: modeDoc?.label ?? normalized.examMode,
        examTypeLabel: getExamTypeLabel(normalized.exam, normalized.examMode),
      };
    }),
  );
});

router.post("/", requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const body = await parseQuestionPayload(req.body);
    const q = await new Question(body).save();
    res.status(201).json(normalizeQuestionDocument(q));
  } catch (error) {
    req.log.error({ error }, "Create question failed");
    res.status(400).json({ error: "create_failed", message: "Failed to create question" });
  }
});

router.put("/:questionId", requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const body = await parseQuestionPayload(req.body);
    const q = await Question.findByIdAndUpdate(req.params["questionId"], body, { new: true }).populate("questionTypeId");
    if (!q) {
      res.status(404).json({ error: "not_found", message: "Question not found" });
      return;
    }
    res.json(normalizeQuestionDocument(q));
  } catch (error) {
    req.log.error({ error }, "Update question failed");
    res.status(400).json({ error: "update_failed", message: "Failed to update question" });
  }
});

router.delete("/:questionId", requireAdmin, async (req: AuthenticatedRequest, res) => {
  await Question.findByIdAndDelete(req.params["questionId"]);
  res.json({ success: true, message: "Question deleted" });
});

export default router;

async function parseQuestionPayload(body: Record<string, any>) {
  const examMode = body.examMode ? String(body.examMode) : undefined;
  const normalizedSubject = normalizeQuestionSubject(body.subject);
  const resolvedDifficulty = await resolveDifficultySelection({
    difficulty: body.difficulty,
    difficultyId: body.difficultyId,
  });
  const yearDoc = body.yearId && !body.year
    ? await Year.findById(String(body.yearId)).catch(() => null)
    : null;
  const rawYearValue = body.year
    ? body.year
    : (yearDoc as any)?.value ?? (yearDoc as any)?.name;
  const yearValue = rawYearValue !== undefined && rawYearValue !== null ? Number(rawYearValue) : undefined;

  if (examMode && normalizedSubject && !isValidExamSubjectCombination(examMode, normalizedSubject)) {
    throw new Error(`Invalid subject "${normalizedSubject}" for exam mode "${examMode}"`);
  }

  return {
    subjectId: String(body.subjectId),
    chapterId: String(body.chapterId),
    modeId: body.modeId ? String(body.modeId) : undefined,
    question: String(body.question ?? ""),
    optionA: body.optionA ? String(body.optionA) : undefined,
    optionB: body.optionB ? String(body.optionB) : undefined,
    optionC: body.optionC ? String(body.optionC) : undefined,
    optionD: body.optionD ? String(body.optionD) : undefined,
    correctOption: body.correctOption ? String(body.correctOption) : undefined,
    explanation: body.explanation ? String(body.explanation) : undefined,
    difficultyId: resolvedDifficulty.difficultyId,
    difficulty: resolvedDifficulty.difficultyKey,
    examMode,
    questionTypeId: body.questionTypeId ? String(body.questionTypeId) : undefined,
    yearId: body.yearId ? String(body.yearId) : undefined,
    exam: body.exam,
    subject: normalizedSubject === "Mathematics" ? "Maths" : normalizedSubject,
    questionType: body.questionType,
    conceptTags: Array.isArray(body.conceptTags) ? body.conceptTags.map(String) : [],
    isNumerical: Boolean(body.isNumerical),
    hasDiagram: Boolean(body.hasDiagram),
    source: body.source ? String(body.source) : undefined,
    responseType: body.responseType,
    numericAnswer: body.numericAnswer ? String(body.numericAnswer) : undefined,
    correctOptions: Array.isArray(body.correctOptions) ? body.correctOptions.map(String) : [],
    passage: body.passage ? String(body.passage) : undefined,
    year: Number.isFinite(yearValue) ? yearValue : undefined,
    batch: body.batch ? String(body.batch) : undefined,
    batchLabel: body.batchLabel ? String(body.batchLabel) : undefined,
    batchYear: body.batchYear ? String(body.batchYear) : undefined,
  };
}
