import { Router, type IRouter } from "express";
import { Difficulty } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (_req, res) => {
  const items = await Difficulty.find({}).sort({ sortOrder: 1, name: 1 });
  res.json(items);
});

export default router;
