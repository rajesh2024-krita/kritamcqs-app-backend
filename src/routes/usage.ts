import { Router, type IRouter } from "express";
import { z } from "zod";
import { AppNavigationEvent, AppUsageSettings } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";

const router: IRouter = Router();

const eventSchema = z.object({
  path: z.string().trim().min(1).max(300),
  title: z.string().trim().max(160).optional().default(""),
  durationSeconds: z.coerce.number().min(0).max(24 * 60 * 60),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  platform: z.string().trim().max(80).optional().default(""),
});

async function getUsageSettings() {
  return AppUsageSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default", enabled: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

router.get("/settings", requireAuth, async (_req, res) => {
  const settings = await getUsageSettings();
  res.json({ enabled: Boolean(settings.enabled) });
});

router.post("/navigation-events", requireAuth, async (req: AuthenticatedRequest, res) => {
  const settings = await getUsageSettings();
  if (!settings.enabled) {
    res.json({ skipped: true, enabled: false });
    return;
  }
  const payload = eventSchema.parse(req.body || {});
  const event = await AppNavigationEvent.create({
    userId: String(req.userId || ""),
    path: payload.path,
    title: payload.title,
    durationSeconds: Math.round(Number(payload.durationSeconds || 0)),
    startedAt: payload.startedAt ? new Date(payload.startedAt) : undefined,
    endedAt: payload.endedAt ? new Date(payload.endedAt) : undefined,
    platform: payload.platform,
  });
  res.status(201).json({ id: String(event._id), enabled: true });
});

export default router;
