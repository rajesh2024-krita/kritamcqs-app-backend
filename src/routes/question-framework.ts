import { Router, type IRouter } from "express";
import { ExamFramework } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  const mode = (req.query["mode"] as string | undefined) ?? undefined;

  const frameworks = await ExamFramework.find(mode ? { mode } : {}).sort({ mode: 1 });
  res.json(frameworks.map((item) => item.toJSON()));
});

export default router;
