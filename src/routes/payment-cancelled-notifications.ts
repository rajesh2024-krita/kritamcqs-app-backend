import { Router, type IRouter } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  completePaymentCancelledAutoNotifications,
  trackPaymentCancelledAutoNotification,
} from "../services/paymentCancelledAutoNotificationRuntime";

const router: IRouter = Router();

router.post("/track", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = await trackPaymentCancelledAutoNotification(String(req.userId), req.body);
    res.status(201).json({
      success: true,
      message: data.skipped ? "Payment cancelled notification not scheduled" : "Payment cancelled notification scheduled",
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/complete", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    await completePaymentCancelledAutoNotifications(String(req.userId));
    res.json({ success: true, message: "Payment cancelled notifications completed" });
  } catch (error) {
    next(error);
  }
});

export default router;
