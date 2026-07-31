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

function isDuplicateBulkWriteError(error: unknown) {
  const item = error as { code?: number; writeErrors?: Array<{ code?: number }> };
  return item?.code === 11000 || (Array.isArray(item?.writeErrors) && item.writeErrors.every((writeError) => writeError.code === 11000));
}

function normalizeBaseUrl(value = "") {
  return value.trim().replace(/\/+$/, "");
}

function adminApiUrl(path: string) {
  const baseUrl = normalizeBaseUrl(
    process.env["ADMIN_API_BASE_URL"] ||
      process.env["ADMIN_BACKEND_API_BASE_URL"] ||
      "",
  );
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/api$/, "")}/api${path}`;
}

async function fetchFromAdmin(path: string, init?: RequestInit) {
  const url = adminApiUrl(path);
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getUsageSettings() {
  const localSettings = await AppUsageSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default", enabled: true, automaticCleanupEnabled: false, retentionDays: 90, sessionTimeoutMinutes: 30 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const response = await fetchFromAdmin("/app-usage/settings", {
    method: "GET",
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!response?.ok) {
    if (!localSettings.enabled) {
      return AppUsageSettings.findOneAndUpdate(
        { key: "default" },
        { $set: { enabled: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
    return localSettings;
  }
  const adminPayload = await response.json();
  const adminSettings = usageSettingsSchema.parse(adminPayload?.data || adminPayload);
  return AppUsageSettings.findOneAndUpdate(
    { key: "default" },
    { key: "default", ...adminSettings },
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
  const loginMethod = user?.loginProvider || (user?.isAppleLogin || user?.appleId ? "APPLE" : user?.googleId ? "GOOGLE" : "EMAIL");
  const email = String(user?.email || user?.appleEmail || "").trim().toLowerCase();
  return {
    userId: String(req.userId || ""),
    userName: user?.name || "",
    email,
    userType: user?.isPremium ? "Premium" as const : "Free" as const,
    loginMethod,
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

  try {
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
  } catch (error) {
    if (!isDuplicateBulkWriteError(error)) throw error;
  }

  const bySession = new Map<string, typeof events>();
  events.forEach((event) => {
    bySession.set(event.sessionId, [...(bySession.get(event.sessionId) || []), event]);
  });

  await Promise.all([...bySession.entries()].map(async ([sessionId, sessionEvents]) => {
    const storedEvents = await AppUsageEvent.find({ sessionId }).sort({ timestamp: 1 }).lean();
    const ordered = (storedEvents.length ? storedEvents : sessionEvents).sort((a: any, b: any) => a.timestamp.getTime() - b.timestamp.getTime());
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const latestUserEvent = [...ordered].reverse().find((event: any) => event.email || event.userId || event.userName) || first;
    const screenEvents = ordered.filter((event: any) => event.eventType === "ScreenView");
    const clickEvents = ordered.filter((event: any) => String(event.eventType || "").toLowerCase().includes("click"));
    const durationSeconds = ordered.reduce((sum: number, event: any) => sum + Number(event.durationSeconds || 0), 0);
    await AppUsageSession.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          sessionId,
          userId: latestUserEvent.userId || user.userId,
          userName: latestUserEvent.userName || user.userName,
          email: String(latestUserEvent.email || user.email || "").trim().toLowerCase(),
          userType: latestUserEvent.userType || user.userType,
          loginMethod: latestUserEvent.loginMethod || user.loginMethod,
          deviceId: first.deviceId,
          platform: first.platform,
          appVersion: first.appVersion,
          deviceModel: first.deviceModel,
          osVersion: first.osVersion,
          startedAt: first.timestamp,
          entryScreen: first.screen,
          endedAt: last.timestamp,
          exitScreen: last.screen,
          lastActiveAt: last.timestamp,
          durationSeconds,
          foregroundSeconds: durationSeconds,
          screenViews: screenEvents.length,
          clicks: clickEvents.length,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }));

  return { accepted: events.length, events };
}

async function forwardEventsToAdmin(events: unknown[]) {
  const payloadEvents = events.map((event) => {
    const item = event as Record<string, unknown>;
    return {
      ...item,
      timestamp: item["timestamp"] instanceof Date ? item["timestamp"].toISOString() : item["timestamp"],
      enterTime: item["enterTime"] instanceof Date ? item["enterTime"].toISOString() : item["enterTime"],
      exitTime: item["exitTime"] instanceof Date ? item["exitTime"].toISOString() : item["exitTime"],
    };
  });
  const response = await fetchFromAdmin("/app-usage/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ events: payloadEvents }),
  }).catch(() => null);
  return Boolean(response?.ok);
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
  const forwarded = await forwardEventsToAdmin(result.events);
  res.status(201).json({ accepted: result.accepted, enabled: true, forwarded });
});

router.post("/bulk", requireAuth, async (req: AuthenticatedRequest, res) => {
  const settings = await getUsageSettings();
  if (!settings.enabled) {
    res.json({ skipped: true, enabled: false, accepted: 0 });
    return;
  }
  const payload = bulkEventsSchema.parse(req.body || {});
  const result = await persistEvents(req, payload.events);
  const forwarded = await forwardEventsToAdmin(result.events);
  res.status(201).json({ accepted: result.accepted, enabled: true, forwarded });
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
