import { Router, type IRouter } from "express";
import { listEnabledScripts } from "../services/subscriptionReminderRuntime";

const router: IRouter = Router();

router.get("/", async (req, res, next) => {
  try {
    const data = await listEnabledScripts(req.query.platform || "web");
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

export default router;
