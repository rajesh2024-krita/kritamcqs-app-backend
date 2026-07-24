import { Router, type IRouter } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  completeSubscriptionReminders,
  trackSubscriptionReminder,
} from "../services/subscriptionReminderRuntime";

const router: IRouter = Router();

router.post("/track", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = await trackSubscriptionReminder(String(req.userId), req.body);
    res.status(201).json({
      success: true,
      message: data.skipped ? "Reminder not scheduled" : "Reminder scheduled",
      data,
    });
  } catch (error) {
    const statusCode = Number((error as any)?.statusCode || 500);
    if (statusCode !== 500) {
      res.status(statusCode).json({ success: false, message: (error as Error).message });
      return;
    }
    next(error);
  }
});

router.post("/complete", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    await completeSubscriptionReminders(String(req.userId));
    res.json({ success: true, message: "Subscription reminders completed" });
  } catch (error) {
    next(error);
  }
});

export default router;
