import { Router, type IRouter } from "express";
import { Question, Year } from "@api/db";
import { requireAuth } from "../middlewares/auth";
import { getQuestionExamModes } from "../lib/subjects";

const router: IRouter = Router();

router.get("/", requireAuth, async (req, res) => {
  const mode = String(req.query["mode"] || "");
  const examModes = getQuestionExamModes(mode);
  const questionFilter = examModes.length
    ? { examMode: examModes.length === 1 ? examModes[0] : { $in: examModes } }
    : {};
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
