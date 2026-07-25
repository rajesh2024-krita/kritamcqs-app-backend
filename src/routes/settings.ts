import { Router, type IRouter } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const logLevels = ["None", "Error", "Warning", "Info", "Verbose"] as const;

const microsoftClaritySettingsSchema = z.object({
  enabled: z.boolean().optional().default(false),
  projectId: z.string().trim().optional().default(""),
  logLevel: z.enum(logLevels).optional().default("None"),
});

type MicrosoftClaritySettings = z.infer<typeof microsoftClaritySettingsSchema>;

const disabledSettings: MicrosoftClaritySettings = {
  enabled: false,
  projectId: "",
  logLevel: "None",
};

function normalizeBaseUrl(value = "") {
  return value.trim().replace(/\/+$/, "");
}

function adminSettingsUrl() {
  const baseUrl = normalizeBaseUrl(
    process.env["ADMIN_API_BASE_URL"] ||
      process.env["ADMIN_BACKEND_API_BASE_URL"] ||
      "",
  );
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/api$/, "")}/api/settings/microsoft-clarity`;
}

async function fetchMicrosoftClaritySettings(): Promise<MicrosoftClaritySettings> {
  const url = adminSettingsUrl();
  if (!url) {
    logger.warn("ADMIN_API_BASE_URL is not configured; Microsoft Clarity is disabled for this response");
    return disabledSettings;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Admin backend rejected Microsoft Clarity settings request");
      return disabledSettings;
    }

    return microsoftClaritySettingsSchema.parse(await response.json());
  } catch (error) {
    logger.error({ error }, "Unable to fetch Microsoft Clarity settings from admin backend");
    return disabledSettings;
  } finally {
    clearTimeout(timeout);
  }
}

router.get("/microsoft-clarity", async (_req, res) => {
  res.json(await fetchMicrosoftClaritySettings());
});

export default router;
