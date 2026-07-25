import { Router, type IRouter } from "express";
import { z } from "zod";
import { MicrosoftClarityLog, MicrosoftClaritySettings } from "@api/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const logLevels = ["None", "Error", "Warning", "Info", "Verbose"] as const;
const statuses = [
  "Initializing",
  "Connected",
  "Waiting for Data",
  "Uploading",
  "Recording",
  "Disabled",
  "Configuration API Failed",
  "Cordova Not Ready",
  "Device Not Ready",
  "Initialization Failed",
  "Plugin Not Loaded",
  "Plugin Missing",
  "Project ID Invalid",
  "Internet Unavailable",
  "Native Error",
  "SDK Initialization Failed",
  "Session Not Created",
  "Upload Blocked",
  "Upload Failed",
] as const;

const configSchema = z.object({
  enabled: z.boolean().optional().default(false),
  projectId: z.string().trim().optional().default(""),
  logLevel: z.enum(logLevels).optional().default("None"),
});

const logSchema = z.object({
  deviceId: z.string().trim().max(180).optional().default(""),
  platform: z.string().trim().max(80).optional().default(""),
  appVersion: z.string().trim().max(80).optional().default(""),
  projectId: z.string().trim().max(100).optional().default(""),
  status: z.enum(statuses).optional().default("Initializing"),
  level: z.enum(["success", "warning", "error", "info"]).optional().default("info"),
  message: z.string().trim().max(2000).optional().default(""),
  sessionId: z.string().trim().max(180).optional().default(""),
  sdkVersion: z.string().trim().max(80).optional().default(""),
  pluginVersion: z.string().trim().max(80).optional().default(""),
  capacitorVersion: z.string().trim().max(80).optional().default(""),
  sdkStatus: z.string().trim().max(120).optional().default(""),
  errorMessage: z.string().trim().max(4000).optional().default(""),
  stack: z.string().trim().max(8000).optional().default(""),
  metadata: z.record(z.unknown()).optional().default({}),
  timestamp: z.string().optional(),
  lastHeartbeatAt: z.string().optional(),
  lastUploadAt: z.string().optional(),
});

const disabledConfig = { enabled: false, projectId: "", logLevel: "None" as const };

function mapConfig(settings: { enabled?: boolean; projectId?: string; logLevel?: string } | null | undefined) {
  return configSchema.parse({
    enabled: Boolean(settings?.enabled),
    projectId: settings?.projectId || "",
    logLevel: settings?.logLevel || "None",
  });
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

router.get("/config", async (_req, res) => {
  try {
    const localSettings = await MicrosoftClaritySettings.findOne({ key: "default" }).lean();
    if (localSettings) {
      res.json(mapConfig(localSettings));
      return;
    }

    const response = await fetchFromAdmin("/microsoft-clarity/config", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response?.ok) {
      logger.warn({ status: response?.status }, "Microsoft Clarity config unavailable from admin backend");
      res.json(disabledConfig);
      return;
    }
    const config = configSchema.parse(await response.json());
    await MicrosoftClaritySettings.findOneAndUpdate(
      { key: "default" },
      { key: "default", ...config },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json(config);
  } catch (error) {
    logger.error({ error }, "Microsoft Clarity config fetch failed");
    res.json(disabledConfig);
  }
});

router.post("/log", async (req, res) => {
  const payload = logSchema.parse(req.body || {});
  const saved = await MicrosoftClarityLog.create({
    ...payload,
    timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    lastHeartbeatAt: payload.lastHeartbeatAt ? new Date(payload.lastHeartbeatAt) : undefined,
    lastUploadAt: payload.lastUploadAt ? new Date(payload.lastUploadAt) : undefined,
  });

  try {
    const response = await fetchFromAdmin("/microsoft-clarity/log", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response?.ok) {
      logger.warn({ status: response?.status, payload }, "Microsoft Clarity log forwarding failed");
      res.status(201).json({ accepted: true, stored: true, forwarded: false, id: String(saved._id) });
      return;
    }
    res.status(201).json({ accepted: true, stored: true, forwarded: true, id: String(saved._id) });
  } catch (error) {
    logger.error({ error }, "Microsoft Clarity log forwarding failed");
    res.status(201).json({ accepted: true, stored: true, forwarded: false, id: String(saved._id) });
  }
});

export default router;
