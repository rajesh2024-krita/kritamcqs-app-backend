import { Router, type IRouter } from "express";
import { Question, Year, mongoose } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function buildPaperModeFilter(mode: string) {
  if (!mode) return {};
  if (mode === "NEET") return { $or: [{ examMode: "NEET" }, { exam: "NEET" }] };
  if (mode === "JEE") return { $or: [{ examMode: "JEE" }, { exam: { $in: ["JEE", "JEE_MAIN", "JEE_ADVANCED"] } }] };
  if (mode === "BOTH") return { examMode: "BOTH" };
  return { examMode: mode };
}

function readYearValue(item: any) {
  const raw = item?.value ?? item?.name ?? item?.label;
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

router.get("/", requireAuth, async (req, res) => {
  const mode = String(req.query["mode"] || "");
  const questionFilter = buildPaperModeFilter(mode);

  const [yearDocs, questionYearValues, questionYearIds] = await Promise.all([
    Year.find({}).sort({ name: -1, value: -1 }),
    Question.distinct("year", { ...questionFilter, year: { $nin: [null, ""] } }),
    Question.distinct("yearId", { ...questionFilter, yearId: { $nin: [null, ""] } }),
  ]);

  if (!mode) {
    res.json(yearDocs.map((item) => normalizeYearResponse(item)));
    return;
  }

  const yearValueSet = new Set(
    questionYearValues
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map(String),
  );
  const yearIdStrings = questionYearIds.map((value) => String(value)).filter(Boolean);
  const yearIdSet = new Set(yearIdStrings);

  const linkedYearDocs = yearDocs.filter((item: any) => {
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
  [...linkedYearDocs, ...missingYearDocs].forEach((item) => {
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
  res.json(response);
});

export default router;
