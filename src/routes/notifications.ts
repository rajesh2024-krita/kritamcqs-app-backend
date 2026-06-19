import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  broadcast,
  registerToken,
  removeToken,
  sendToUser,
} from "../services/notificationService";

const router: IRouter = Router();

const notificationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const RegisterTokenBody = z.object({
  token: z.string().trim().min(10).max(4096),
  platform: z.enum(["android", "ios", "web", "unknown"]).optional().default("unknown"),
  deviceId: z.string().trim().max(200).optional().default(""),
  appVersion: z.string().trim().max(80).optional().default(""),
});

const RemoveTokenBody = z.object({
  token: z.string().trim().min(10).max(4096),
});

const PayloadBody = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  data: z.record(z.unknown()).optional().default({}),
});

const SendBody = PayloadBody.extend({
  userId: z.string().trim().min(1),
});

router.use(notificationRateLimit);

router.post("/register-token", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = RegisterTokenBody.parse(req.body || {});
    const token = await registerToken({
      userId: req.userId!,
      token: body.token,
      platform: body.platform,
      deviceId: body.deviceId,
      appVersion: body.appVersion,
    });
    res.json({ success: true, id: token.id, lastUpdated: token.lastUpdated });
  } catch (error) {
    req.log.error({ error }, "Failed to register FCM token");
    res.status(400).json({ error: "register_token_failed", message: "Failed to register notification token" });
  }
});

router.delete("/remove-token", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = RemoveTokenBody.parse(req.body || {});
    await removeToken(req.userId!, body.token);
    res.json({ success: true });
  } catch (error) {
    req.log.error({ error }, "Failed to remove FCM token");
    res.status(400).json({ error: "remove_token_failed", message: "Failed to remove notification token" });
  }
});

router.post("/send", requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const body = SendBody.parse(req.body || {});
    const result = await sendToUser(body.userId, {
      title: body.title,
      body: body.body,
      data: body.data,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    req.log.error({ error }, "Failed to send FCM notification");
    res.status(400).json({ error: "send_notification_failed", message: "Failed to send notification" });
  }
});

router.post("/broadcast", requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const body = PayloadBody.parse(req.body || {});
    const result = await broadcast({
      title: body.title,
      body: body.body,
      data: body.data,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    req.log.error({ error }, "Failed to broadcast FCM notification");
    res.status(400).json({ error: "broadcast_notification_failed", message: "Failed to broadcast notification" });
  }
});

export default router;
