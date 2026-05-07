import { Router, type IRouter } from "express";
import { Mode } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (_req, res) => {
  const items = await Mode.find({}).sort({ label: 1 });
  res.json(items);
});

export default router;
