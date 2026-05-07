import { Router, type IRouter } from "express";
import { QuestionType } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res) => {
  const mode = req.query["mode"] as string | undefined;

  const filter: Record<string, unknown> =
    !mode || mode === "BOTH"
      ? {}
      : {
          $or: [
            { mode },
            { mode: "BOTH" },
            { examType: mode },
            { examCategory: mode },
            ...(mode === "JEE" ? [{ examCategory: "JEE_MAIN" }, { examCategory: "JEE_ADVANCED" }] : []),
          ],
        };

  const items = await QuestionType.find(filter).sort({ name: 1, label: 1 });
  res.json(items.map((item) => item.toJSON()));
});

export default router;
