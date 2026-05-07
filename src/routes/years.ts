import { Router, type IRouter } from "express";
import { Year } from "@api/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (_req, res) => {
  const items = await Year.find({}).sort({ value: -1 });
  res.json(items);
});

export default router;
