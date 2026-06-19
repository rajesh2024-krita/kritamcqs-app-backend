import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  createAndSend,
  registerToken,
  removeToken,
} from "../services/notificationService";
import { User } from "@api/db";

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
    const result = await createAndSend({
      userIds: [body.userId],
      title: body.title,
      body: body.body,
      type: String(body.data?.["type"] || "custom"),
      linkUrl: String(body.data?.["deepLink"] || body.data?.["linkUrl"] || "/notifications"),
      metadata: body.data,
      senderId: String((req as any).admin?._id || ""),
      senderName: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
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
    const users = await User.find({ isActive: { $ne: false }, isBlocked: { $ne: true } }).select("_id").lean();
    const result = await createAndSend({
      userIds: users.map((user: any) => String(user._id)),
      title: body.title,
      body: body.body,
      type: String(body.data?.["type"] || "custom"),
      linkUrl: String(body.data?.["deepLink"] || body.data?.["linkUrl"] || "/notifications"),
      metadata: body.data,
      senderId: String((req as any).admin?._id || ""),
      senderName: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    req.log.error({ error }, "Failed to broadcast FCM notification");
    res.status(400).json({ error: "broadcast_notification_failed", message: "Failed to broadcast notification" });
  }
});

export default router;
