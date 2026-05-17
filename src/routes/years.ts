import { Router, type IRouter } from "express";
import { Question, Year } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function buildPaperModeFilter(mode: string) {
  if (!mode) return {};
  if (mode === "NEET") return { $or: [{ examMode: "NEET" }, { exam: "NEET" }] };
  if (mode === "JEE") return { $or: [{ examMode: "JEE" }, { exam: { $in: ["JEE", "JEE_MAIN", "JEE_ADVANCED"] } }] };
  if (mode === "BOTH") return { examMode: "BOTH" };
  return { examMode: mode };
}

router.get("/", requireAuth, async (req, res) => {
  const mode = String(req.query["mode"] || "");
  const questionFilter = buildPaperModeFilter(mode);
  const [items, yearValues] = await Promise.all([
    Year.find({}).sort({ value: -1 }),
    Question.distinct("year", { ...questionFilter, year: { $ne: null } }),
  ]);
  if (!mode) {
    res.json(items);
    return;
  }
  const available = new Set(yearValues.map((value) => String(value)));
  const filtered = items.filter((item: any) => available.has(String(item.value ?? item.name ?? item.label)));
  if (filtered.length) {
    res.json(filtered);
    return;
  }
  res.json(
    [...available]
      .sort((a, b) => Number(b) - Number(a))
      .map((year) => ({ id: year, name: year, label: year, value: Number(year) })),
  );
});

export default router;
