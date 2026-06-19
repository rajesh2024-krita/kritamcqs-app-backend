import { Router, type IRouter } from "express";
import { Chapter, FreeQuestionConfig, Mode, Question, Subject, Year, mongoose } from "@api/db";
import { requireAuth, requireAdmin, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { buildDifficultyQuery, resolveDifficultySelection } from "../lib/difficulties";
import { getExamTypeLabel, normalizeQuestionDocument, readYearValue, resolveQuestionYearFields } from "../lib/question-framework";
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
    yearClauses.push({ examYear: numericYear });
    yearClauses.push({ previousYear: numericYear });
  }

  if (rawYear) {
    yearClauses.push({ year: rawYear });
    yearClauses.push({ examYear: rawYear });
    yearClauses.push({ previousYear: rawYear });
    yearClauses.push({ $expr: { $eq: [{ $toString: "$year" }, rawYear] } });
    yearClauses.push({ $expr: { $eq: [{ $toString: "$examYear" }, rawYear] } });
    yearClauses.push({ $expr: { $eq: [{ $toString: "$previousYear" }, rawYear] } });
  }

  if (yearIds.length > 0) {
    yearClauses.push({ $expr: { $in: [{ $toString: "$yearId" }, yearIds] } });
  }

  return yearClauses.length === 1 ? yearClauses[0] : { $or: yearClauses };
}

function buildPaperModeMatch(mode?: string, exactMode?: string) {
  const normalizedMode = String(mode ?? "").trim().toUpperCase();
  if (!normalizedMode) return undefined;

  const valuesForMode = (value: string) => {
    if (value === "JEE") return ["JEE", "Jee", "jee", "JEE_MAIN", "JEE_ADVANCED"];
    if (value === "NEET") return ["NEET", "Neet", "neet", "NEET_UG"];
    if (value === "BOTH") return ["BOTH", "Both", "both", "MIXED", "ALL"];
    return [value, String(mode)];
  };
  const modeKey = normalizedMode.startsWith("JEE")
    ? "JEE"
    : normalizedMode.startsWith("NEET")
      ? "NEET"
      : normalizedMode;
  const requestedModeValues = valuesForMode(modeKey);
  const bothModeValues = valuesForMode("BOTH");

  if (exactMode === "true") {
    return {
      $or: [
        { examMode: { $in: requestedModeValues } },
        { examType: { $in: requestedModeValues } },
        { exam: { $in: requestedModeValues } },
      ],
    };
  }

  const examModes = getQuestionExamModes(modeKey);
  const examModeValues = [...new Set([...examModes.flatMap(valuesForMode), ...bothModeValues])];

  return {
    $or: [
      { examMode: { $in: examModeValues } },
      { examType: { $in: examModeValues } },
      { exam: { $in: requestedModeValues } },
    ],
  };
}

function buildExactMatch(value?: string) {
  if (value === undefined) return undefined;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return { $or: [{ exact: true }, { exact: "true" }, { exact: 1 }] };
  if (normalized === "false") return { $or: [{ exact: false }, { exact: "false" }, { exact: 0 }, { exact: null }, { exact: { $exists: false } }] };
  return undefined;
}

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const { subjectId, chapterId, difficulty, limit, mode, exam, questionType, subject, isNumerical, hasDiagram, exactMode, exact } =
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
    const yearDocs = Number.isFinite(requestedYear)
      ? (await Year.find({}).select("_id name label value").lean())
          .filter((item: any) => readYearValue(item.value, item.name, item.label) === requestedYear)
      : [];
    const yearIds = yearDocs.map((item) => String(item._id));
    aggregateClauses.push(buildYearMatch(req.query["year"], yearIds));
  }
  if (req.query["yearId"]) aggregateClauses.push(buildFlexibleSingleIdMatch("yearId", String(req.query["yearId"]))!);
  if (req.query["questionTypeId"]) aggregateClauses.push(buildFlexibleSingleIdMatch("questionTypeId", String(req.query["questionTypeId"]))!);
  if (isNumerical !== undefined) aggregateClauses.push({ isNumerical: isNumerical === "true" });
  if (hasDiagram !== undefined) aggregateClauses.push({ hasDiagram: hasDiagram === "true" });
  const exactMatch = buildExactMatch(exact ?? (exactMode === "true" ? "true" : undefined));
  if (exactMatch) aggregateClauses.push(exactMatch);

  const aggregateMatch =
    aggregateClauses.length === 0 ? filter : aggregateClauses.length === 1 ? { ...filter, ...aggregateClauses[0] } : { ...filter, $and: aggregateClauses };

  const questionIds = await Question.aggregate([
    { $match: aggregateMatch },
    { $limit: limit ? parseInt(limit) : 500 },
    { $project: { _id: 1 } },
  ]);
  const orderedIds = questionIds.map((item: any) => item._id);

  const [questions, subjects, chapters, modes] = await Promise.all([
    orderedIds.length > 0 ? Question.find({ _id: { $in: orderedIds } }).populate("questionTypeId") : Promise.resolve([]),
    Subject.find({}),
    Chapter.find({}),
    Mode.find({}),
  ]);
  const questionYearIds = [...new Set(questions.map((question: any) => toIdString(question?.yearId)).filter(Boolean))];
  const years = questionYearIds.length
    ? await Year.find({
        $or: [
          { _id: { $in: questionYearIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) } },
          { id: { $in: questionYearIds } },
          { name: { $in: questionYearIds } },
          { label: { $in: questionYearIds } },
        ],
      })
    : [];

  const subjectMap = new Map(subjects.flatMap((item: any) => {
    const keys = [toIdString(item.id), toIdString(item._id)].filter(Boolean);
    return keys.map((key) => [key, item] as const);
  }));
  const chapterMap = new Map(chapters.flatMap((item: any) => {
    const keys = [toIdString(item.id), toIdString(item._id)].filter(Boolean);
    return keys.map((key) => [key, item] as const);
  }));
  const yearMap = new Map(years.flatMap((item: any) => {
    const keys = [
      toIdString(item.id),
      toIdString(item._id),
      String(item.name ?? "").trim(),
      String(item.label ?? "").trim(),
      String(item.value ?? "").trim(),
    ].filter(Boolean);
    return keys.map((key) => [key, item] as const);
  }));
  const modeMap = new Map(modes.map((item) => [item.id, item]));

  const questionMap = new Map(questions.map((question: any) => [String(question._id), question]));
  res.json(
    orderedIds.map((id: any) => questionMap.get(String(id))).filter(Boolean).map((question) => {
      const normalized = normalizeQuestionDocument(question);
      const subjectDoc = subjectMap.get(toIdString(normalized.subjectId));
      const chapterDoc = chapterMap.get(toIdString(normalized.chapterId));
      const yearDoc = normalized.yearId ? yearMap.get(toIdString(normalized.yearId)) : undefined;
      const modeDoc = normalized.modeId ? modeMap.get(String(normalized.modeId)) : undefined;
      const yearFields = resolveQuestionYearFields(normalized, yearDoc as any);

      return {
        ...normalized,
        subjectName: subjectDoc?.name ?? normalized.subject,
        chapterName: chapterDoc?.name,
        ...yearFields,
        modeLabel: modeDoc?.label ?? normalized.examMode,
        examTypeLabel: getExamTypeLabel(normalized.exam, normalized.examMode),
      };
    }),
  );
});

router.get("/free-practice", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const mode = String(req.query["mode"] ?? req.user?.examMode ?? "NEET");
  const configs = await FreeQuestionConfig.find({ isActive: true }).sort({ createdAt: -1 });
  const subjectIds = [...new Set(configs.map((item) => String(item.subjectId)).filter(Boolean))];
  const [subjects, chapters] = await Promise.all([
    subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }) : [],
    Chapter.find({ subjectId: { $in: subjectIds } }),
  ]);
  const subjectMap = new Map(subjects.map((item) => [String(item._id), item]));
  const chapterMap = new Map(chapters.map((item) => [String(item._id), item]));
  const modeMatch = buildPaperModeMatch(mode, "true") ?? {};

  const groups = await Promise.all(configs.map(async (config) => {
    const questionIds = config.selectionMode === "manual"
      ? config.manualQuestionIds.map(String).filter(Boolean)
      : [];
    const questions = config.selectionMode === "manual" && questionIds.length
      ? await Question.find({ _id: { $in: questionIds }, ...modeMatch }).limit(config.questionCount)
      : await Question.find({ subjectId: String(config.subjectId), ...modeMatch }).limit(config.questionCount);
    const ordered = config.selectionMode === "manual"
      ? questionIds.map((id) => questions.find((question: any) => String(question._id) === id)).filter(Boolean)
      : questions;
    const subjectDoc = subjectMap.get(String(config.subjectId));
    return {
      id: config.id,
      subjectId: config.subjectId,
      subjectName: subjectDoc?.name ?? "Subject",
      examMode: subjectDoc?.examType ?? subjectDoc?.examMode ?? mode,
      questionCount: ordered.length,
      questions: ordered.map((question: any) => {
        const normalized = normalizeQuestionDocument(question);
        return {
          ...normalized,
          subjectName: subjectDoc?.name ?? normalized.subject,
          chapterName: chapterMap.get(String(normalized.chapterId))?.name,
        };
      }),
    };
  }));

  res.json(groups.filter((group) => group.questionCount > 0));
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
    exact: body.exact === undefined || body.exact === null || body.exact === "" ? undefined : body.exact === true || ["true", "1", "yes", "y"].includes(String(body.exact).trim().toLowerCase()),
    batch: body.batch ? String(body.batch) : undefined,
    batchLabel: body.batchLabel ? String(body.batchLabel) : undefined,
    batchYear: body.batchYear ? String(body.batchYear) : undefined,
  };
}
