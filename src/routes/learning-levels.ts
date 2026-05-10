import { Router, type IRouter } from "express";
import { LearningLevel } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (_req, res) => {
  const items = await LearningLevel.find({ active: true }).sort({ sortOrder: 1, label: 1 });
  res.json(items);
});

export default router;
