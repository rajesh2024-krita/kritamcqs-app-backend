import { Router, type IRouter } from "express";
import { Question, Year } from "@api/db";
import { requireAuth } from "../middlewares/auth";
import { readYearValue } from "../lib/question-framework";

const router: IRouter = Router();

function normalizeYearResponse(item: any, fallbackYear?: string | number) {
  const raw = typeof item?.toJSON === "function" ? item.toJSON() : item;
  const yearValue = readYearValue(raw?.value, raw?.name, raw?.label, raw?.year, raw?.examYear, raw?.previousYear, fallbackYear);
  const yearLabel = String(raw?.label ?? raw?.name ?? fallbackYear ?? yearValue ?? "").trim();

  return {
    ...raw,
    id: String(raw?.id ?? raw?._id ?? yearLabel),
    name: String(raw?.name ?? yearLabel),
    label: yearLabel,
    value: Number.isFinite(yearValue) ? yearValue : undefined,
  };
}

function matchesYearMode(item: any, mode: string) {
  const normalizedMode = String(mode || "").trim().toUpperCase();
  if (!normalizedMode || normalizedMode === "BOTH" || normalizedMode === "ALL") return true;
  const examType = normalizeExamMode(item?.examType ?? item?.examCategory ?? item?.examMode ?? item?.exam);
  if (!examType) return true;
  if (normalizedMode.startsWith("JEE")) return examType === "JEE";
  if (normalizedMode.startsWith("NEET")) return examType === "NEET";
  return examType === normalizedMode;
}

function normalizeExamMode(value: unknown) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "";
  if (normalized.startsWith("NEET")) return "NEET";
  if (normalized.startsWith("JEE")) return "JEE";
  if (["BOTH", "ALL", "MIXED"].includes(normalized)) return "BOTH";
  return normalized;
}

function questionModeMatch(mode: string) {
  const normalizedMode = normalizeExamMode(mode);
  if (!normalizedMode || normalizedMode === "BOTH") return {};

  const requestedValues = normalizedMode === "NEET"
    ? ["NEET", "Neet", "neet", "NEET_UG"]
    : normalizedMode === "JEE"
      ? ["JEE", "Jee", "jee", "JEE_MAIN", "JEE_ADVANCED"]
      : [normalizedMode, mode];
  const broadValues = [...new Set([...requestedValues, "BOTH", "Both", "both", "MIXED", "ALL"])];

  return {
    $or: [
      { examMode: { $in: broadValues } },
      { examType: { $in: broadValues } },
      { exam: { $in: requestedValues } },
    ],
  };
}

function entityKey(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") {
    const objectValue: any = value;
    if (typeof objectValue.toHexString === "function") return String(objectValue.toHexString()).trim();
    if (typeof objectValue.$oid === "string") return String(objectValue.$oid).trim();
    if (objectValue.type === "Buffer" && Array.isArray(objectValue.data)) {
      return objectValue.data.map((byte: number) => Number(byte).toString(16).padStart(2, "0")).join("");
    }
    return entityKey(objectValue.id ?? objectValue._id);
  }
  return String(value).trim();
}

function indexYearDocuments(yearDocs: any[]) {
  const map = new Map<string, any>();
  yearDocs.forEach((item) => {
    [
      entityKey(item?._id),
      entityKey(item?.id),
      String(item?.name ?? "").trim(),
      String(item?.label ?? "").trim(),
      String(item?.value ?? "").trim(),
    ].filter(Boolean).forEach((key) => map.set(key, item));
  });
  return map;
}

function mergeYear(items: Map<number, any>, item: any) {
  const normalized = normalizeYearResponse(item);
  if (!Number.isFinite(normalized.value)) return;
  const current = items.get(normalized.value);
  if (!current || (!current.id && normalized.id) || (!current.examType && normalized.examType)) {
    items.set(normalized.value, normalized);
  }
}

router.get("/", requireAuth, async (req, res) => {
  const mode = String(req.query["mode"] || "");
  const yearDocs = await Year.find({}).sort({ name: -1, value: -1 }).lean();
  const yearByKey = indexYearDocuments(yearDocs);
  const yearsByValue = new Map<number, any>();

  yearDocs
    .filter((item: any) => matchesYearMode(item, mode))
    .forEach((item) => mergeYear(yearsByValue, item));

  const questionRows = await Question.find(questionModeMatch(mode))
    .select("yearId year examYear previousYear examMode exam examType")
    .limit(5000)
    .lean();

  questionRows.forEach((question: any) => {
    const yearDoc = yearByKey.get(entityKey(question.yearId));
    const yearValue = readYearValue(yearDoc?.value, yearDoc?.name, yearDoc?.label, question.year, question.examYear, question.previousYear);
    if (!yearValue) return;
    mergeYear(yearsByValue, {
      ...(yearDoc || {}),
      id: entityKey(yearDoc?._id ?? yearDoc?.id ?? question.yearId),
      name: yearDoc?.name ?? String(yearValue),
      label: yearDoc?.label ?? yearDoc?.name ?? String(yearValue),
      value: yearValue,
      examType: yearDoc?.examType ?? normalizeExamMode(question.examType ?? question.examMode ?? question.exam),
    });
  });

  const response = [...yearsByValue.values()].sort((a, b) => Number(b.value ?? b.name) - Number(a.value ?? a.name));

  req.log.info({
    mode,
    totalYearDocs: yearDocs.length,
    referencedQuestionRows: questionRows.length,
    returnedYears: response.map((item) => ({ id: item.id, name: item.name, value: item.value, examType: item.examType })),
  }, "Years catalog response");
  res.json(response);
});

export default router;
