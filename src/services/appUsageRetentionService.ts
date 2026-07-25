import { AppUsageEvent, AppUsageSession, AppUsageSettings } from "@api/db";
import { logger } from "../lib/logger";

let workerStarted = false;

async function cleanupAppUsageLogs() {
  const settings = await AppUsageSettings.findOne({ key: "default" }).lean();
  if (!settings?.automaticCleanupEnabled) return;

  const retentionDays = Math.max(7, Math.min(365, Number(settings.retentionDays || 90)));
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const [events, sessions] = await Promise.all([
    AppUsageEvent.deleteMany({ timestamp: { $lt: cutoff } }),
    AppUsageSession.deleteMany({ startedAt: { $lt: cutoff } }),
  ]);
  logger.info(
    { retentionDays, cutoff, eventsDeleted: events.deletedCount, sessionsDeleted: sessions.deletedCount },
    "App usage retention cleanup completed",
  );
}

export function startAppUsageRetentionWorker() {
  if (workerStarted) return;
  workerStarted = true;
  void cleanupAppUsageLogs().catch((error) => logger.error({ error }, "App usage retention cleanup failed"));
  setInterval(() => {
    void cleanupAppUsageLogs().catch((error) => logger.error({ error }, "App usage retention cleanup failed"));
  }, 6 * 60 * 60 * 1000);
}
