import { Router, type IRouter } from "express";
import { mongoose } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  completePaymentCancelledAutoNotifications,
  trackPaymentCancelledAutoNotification,
} from "../services/paymentCancelledAutoNotificationRuntime";

const router: IRouter = Router();

async function writeRouteLog(req: any) {
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    const eventType = String(req.body?.eventType || req.body?.status || "payment_cancelled");
    const paymentReference = String(req.body?.paymentReference || req.body?.orderId || req.body?.razorpayOrderId || req.body?.subscriptionId || req.body?.paymentId || Date.now());
    await db.collection("payment_cancelled_auto_notification_logs").insertOne({
      jobId: "",
      userId: "",
      configId: "",
      stageId: "app-route",
      stageName: "App Route",
      eventType,
      paymentReference,
      status: "app_route_received",
      reason: "App called payment cancelled notification tracking endpoint",
      hasAuthorization: Boolean(req.headers?.authorization),
      createdAt: new Date(),
    });
  } catch {
    // Do not block payment flow because diagnostic logging failed.
  }
}

router.post("/track", async (req, _res, next) => {
  await writeRouteLog(req);
  next();
}, requireAuth, async (req: AuthenticatedRequest, res, next) => {
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
