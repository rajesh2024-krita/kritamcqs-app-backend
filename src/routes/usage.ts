import { Router, type IRouter } from "express";
import { z } from "zod";
import { AppNavigationEvent, AppUsageEvent, AppUsageSession, AppUsageSettings } from "@api/db";
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

const retentionDays = [7, 15, 30, 60, 90, 180, 365] as const;

const usageSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  automaticCleanupEnabled: z.boolean().optional(),
  retentionDays: z.coerce.number().pipe(z.union(retentionDays.map((value) => z.literal(value)) as unknown as [z.ZodLiteral<7>, z.ZodLiteral<15>, z.ZodLiteral<30>, z.ZodLiteral<60>, z.ZodLiteral<90>, z.ZodLiteral<180>, z.ZodLiteral<365>] )).optional(),
  sessionTimeoutMinutes: z.coerce.number().int().min(5).max(240).optional(),
});

const analyticsEventSchema = z.object({
  eventId: z.string().trim().min(8).max(120),
  sessionId: z.string().trim().min(8).max(120),
  eventType: z.string().trim().min(2).max(80),
  screen: z.string().trim().max(160).optional().default(""),
  previousScreen: z.string().trim().max(160).optional().default(""),
  nextScreen: z.string().trim().max(160).optional().default(""),
  componentName: z.string().trim().max(160).optional().default(""),
  componentType: z.string().trim().max(80).optional().default(""),
  action: z.string().trim().max(160).optional().default(""),
  timestamp: z.string().datetime().optional(),
  enterTime: z.string().datetime().optional(),
  exitTime: z.string().datetime().optional(),
  durationSeconds: z.coerce.number().min(0).max(24 * 60 * 60).optional().default(0),
  coordinates: z.object({
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional().default({}),
  device: z.object({
    deviceId: z.string().trim().max(160).optional().default(""),
    platform: z.string().trim().max(40).optional().default("unknown"),
    appVersion: z.string().trim().max(80).optional().default(""),
    deviceModel: z.string().trim().max(160).optional().default(""),
    osVersion: z.string().trim().max(80).optional().default(""),
  }).optional().default({}),
});

const bulkEventsSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(250),
});

async function getUsageSettings() {
  return AppUsageSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default", enabled: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function mapSettings(settings: { enabled?: boolean; automaticCleanupEnabled?: boolean; retentionDays?: number; sessionTimeoutMinutes?: number }) {
  return {
    enabled: Boolean(settings.enabled),
    automaticCleanupEnabled: Boolean(settings.automaticCleanupEnabled),
    retentionDays: Number(settings.retentionDays || 90),
    sessionTimeoutMinutes: Number(settings.sessionTimeoutMinutes || 30),
  };
}

function publicUserSnapshot(req: AuthenticatedRequest) {
  const user = req.user;
  return {
    userId: String(req.userId || ""),
    userName: user?.name || "",
    email: user?.email || "",
    userType: user?.isPremium ? "Premium" as const : "Free" as const,
    loginMethod: user?.loginProvider || "",
  };
}

async function persistEvents(req: AuthenticatedRequest, rawEvents: unknown[]) {
  const user = publicUserSnapshot(req);
  const parsedEvents = rawEvents.map((item) => analyticsEventSchema.parse(item));
  const now = new Date();
  const events = parsedEvents.map((event) => ({
    ...user,
    eventId: event.eventId,
    sessionId: event.sessionId,
    eventType: event.eventType,
    screen: event.screen,
    previousScreen: event.previousScreen,
    nextScreen: event.nextScreen,
    componentName: event.componentName,
    componentType: event.componentType,
    action: event.action,
    timestamp: event.timestamp ? new Date(event.timestamp) : now,
    enterTime: event.enterTime ? new Date(event.enterTime) : undefined,
    exitTime: event.exitTime ? new Date(event.exitTime) : undefined,
    durationSeconds: Math.round(Number(event.durationSeconds || 0)),
    coordinates: event.coordinates,
    metadata: event.metadata,
    deviceId: event.device?.deviceId || "",
    platform: String(event.device?.platform || "unknown").toLowerCase(),
    appVersion: event.device?.appVersion || "",
    deviceModel: event.device?.deviceModel || "",
    osVersion: event.device?.osVersion || "",
  }));

  await AppUsageEvent.bulkWrite(
    events.map((event) => ({
      updateOne: {
        filter: { eventId: event.eventId },
        update: { $setOnInsert: event },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const bySession = new Map<string, typeof events>();
  events.forEach((event) => {
    bySession.set(event.sessionId, [...(bySession.get(event.sessionId) || []), event]);
  });

  await Promise.all([...bySession.entries()].map(async ([sessionId, sessionEvents]) => {
    const ordered = [...sessionEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const screenEvents = ordered.filter((event) => event.eventType === "ScreenView");
    const clickEvents = ordered.filter((event) => event.eventType.toLowerCase().includes("click"));
    const durationSeconds = ordered.reduce((sum, event) => sum + Number(event.durationSeconds || 0), 0);
    await AppUsageSession.findOneAndUpdate(
      { sessionId },
      {
        $setOnInsert: {
          sessionId,
          ...user,
          deviceId: first.deviceId,
          platform: first.platform,
          appVersion: first.appVersion,
          deviceModel: first.deviceModel,
          osVersion: first.osVersion,
          startedAt: first.timestamp,
          entryScreen: first.screen,
        },
        $set: {
          endedAt: last.timestamp,
          exitScreen: last.screen,
          lastActiveAt: last.timestamp,
        },
        $inc: {
          durationSeconds,
          foregroundSeconds: durationSeconds,
          screenViews: screenEvents.length,
          clicks: clickEvents.length,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }));

  return { accepted: events.length };
}

router.get("/settings", requireAuth, async (_req, res) => {
  const settings = await getUsageSettings();
  res.json(mapSettings(settings));
});

router.post("/events", requireAuth, async (req: AuthenticatedRequest, res) => {
  const settings = await getUsageSettings();
  if (!settings.enabled) {
    res.json({ skipped: true, enabled: false, accepted: 0 });
    return;
  }
  const result = await persistEvents(req, [req.body || {}]);
  res.status(201).json({ ...result, enabled: true });
});

router.post("/bulk", requireAuth, async (req: AuthenticatedRequest, res) => {
  const settings = await getUsageSettings();
  if (!settings.enabled) {
    res.json({ skipped: true, enabled: false, accepted: 0 });
    return;
  }
  const payload = bulkEventsSchema.parse(req.body || {});
  const result = await persistEvents(req, payload.events);
  res.status(201).json({ ...result, enabled: true });
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
