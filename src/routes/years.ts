import { Router, type IRouter } from "express";
import { Question, Year, mongoose } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function buildPaperModeFilter(mode: string) {
  const normalizedMode = String(mode || "").trim().toUpperCase();
  if (!normalizedMode) return {};
  if (normalizedMode === "BOTH") return {};

  const modeValues = normalizedMode.startsWith("JEE")
    ? ["JEE", "Jee", "jee", "JEE_MAIN", "JEE_ADVANCED"]
    : normalizedMode.startsWith("NEET")
      ? ["NEET", "Neet", "neet", "NEET_UG"]
      : [normalizedMode, mode];
  const bothValues = ["BOTH", "Both", "both", "MIXED", "ALL"];

  return {
    $or: [
      { examMode: { $in: [...modeValues, ...bothValues] } },
      { examType: { $in: [...modeValues, ...bothValues] } },
      { exam: { $in: modeValues } },
    ],
  };
}

function readYearValue(item: any) {
  const raw = item?.value ?? item?.name ?? item?.label ?? item?.year ?? item?.examYear ?? item?.previousYear;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeYearResponse(item: any, fallbackYear?: string | number) {
  const raw = typeof item?.toJSON === "function" ? item.toJSON() : item;
  const yearValue = readYearValue(raw) ?? Number(fallbackYear);
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
  const examType = String(item?.examType ?? item?.examCategory ?? "").trim().toUpperCase();
  if (!examType) return true;
  if (normalizedMode.startsWith("JEE")) return examType === "JEE";
  if (normalizedMode.startsWith("NEET")) return examType === "NEET";
  return examType === normalizedMode;
}

router.get("/", requireAuth, async (req, res) => {
  const mode = String(req.query["mode"] || "");
  const questionFilter = buildPaperModeFilter(mode);

  const [yearDocs, questionYearValues, questionExamYearValues, questionPreviousYearValues, questionYearIds] = await Promise.all([
    Year.find({}).sort({ name: -1, value: -1 }),
    Question.distinct("year", { ...questionFilter, year: { $nin: [null, ""] } }),
    Question.distinct("examYear", { ...questionFilter, examYear: { $nin: [null, ""] } }),
    Question.distinct("previousYear", { ...questionFilter, previousYear: { $nin: [null, ""] } }),
    Question.distinct("yearId", { ...questionFilter, yearId: { $nin: [null, ""] } }),
  ]);
  console.log("[YEAR DEBUG][backend:/api/years:raw]", {
    mode,
    questionFilter,
    yearDocs: yearDocs.map((item: any) => ({
      id: String(item.id ?? item._id),
      name: item.name,
      label: item.label,
      value: item.value,
      examType: item.examType,
    })),
    questionYearValues,
    questionExamYearValues,
    questionPreviousYearValues,
    questionYearIds,
  });

  if (!mode) {
    const response = yearDocs.map((item) => normalizeYearResponse(item));
    console.log("[YEAR DEBUG][backend:/api/years:response]", { mode, response });
    res.json(response);
    return;
  }

  const yearValueSet = new Set(
    [...questionYearValues, ...questionExamYearValues, ...questionPreviousYearValues]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map(String),
  );
  const yearIdStrings = questionYearIds.map((value) => String(value)).filter(Boolean);
  const yearIdSet = new Set(yearIdStrings);

  const modeYearDocs = yearDocs.filter((item: any) => matchesYearMode(item, mode));
  const linkedYearDocs = modeYearDocs.filter((item: any) => {
    const id = String(item.id ?? item._id);
    const value = readYearValue(item);
    return yearIdSet.has(id) || (value !== null && yearValueSet.has(String(value))) || yearIdSet.has(String(item.name ?? item.label ?? ""));
  });

  const missingYearDocs = linkedYearDocs.length
    ? []
    : await Year.find({
        $or: [
          { _id: { $in: yearIdStrings.filter((value) => mongoose.isValidObjectId(value)) } },
          { name: { $in: [...yearValueSet, ...yearIdStrings] } },
          { label: { $in: [...yearValueSet, ...yearIdStrings] } },
          { value: { $in: [...yearValueSet].map(Number) } },
        ],
      });

  const byYear = new Map<string, any>();
  [...modeYearDocs, ...linkedYearDocs, ...missingYearDocs].forEach((item) => {
    const normalized = normalizeYearResponse(item);
    const key = String(normalized.value ?? normalized.name ?? normalized.id);
    if (key) byYear.set(key, normalized);
  });

  yearValueSet.forEach((year) => {
    if (!byYear.has(year)) {
      byYear.set(year, normalizeYearResponse(null, year));
    }
  });

  const response = [...byYear.values()].sort((a, b) => Number(b.value ?? b.name) - Number(a.value ?? a.name));
  console.log("[YEAR DEBUG][backend:/api/years:response]", {
    mode,
    yearValueSet: [...yearValueSet],
    yearIdStrings,
    linkedYearDocs: linkedYearDocs.map((item: any) => String(item.id ?? item._id)),
    response,
  });
  res.json(response);
});

export default router;
