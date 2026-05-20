import { Router, type IRouter } from "express";
import { Year } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

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
  const yearDocs = await Year.find({}).sort({ name: -1, value: -1 }).lean();
  const response = yearDocs
    .filter((item: any) => matchesYearMode(item, mode))
    .map((item) => normalizeYearResponse(item))
    .sort((a, b) => Number(b.value ?? b.name) - Number(a.value ?? a.name));

  req.log.info({
    mode,
    totalYearDocs: yearDocs.length,
    returnedYears: response.map((item) => ({ id: item.id, name: item.name, value: item.value, examType: item.examType })),
  }, "Years catalog response");
  res.json(response);
});

export default router;
