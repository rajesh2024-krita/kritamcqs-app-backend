import { UserSubscription } from "@api/db";
import { logger } from "../lib/logger";
import { syncUserPremiumEntitlement } from "../services/appleSubscriptionService";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
let expiryTimer: NodeJS.Timeout | null = null;

export async function expireAppleSubscriptions() {
  const now = new Date();
  const expired = await UserSubscription.find({
    expiryDate: { $lte: now },
    subscriptionStatus: { $in: ["active", "failed", "cancelled"] },
  }).select("userId originalTransactionId");

  if (!expired.length) return { expired: 0, usersUpdated: 0 };

  await UserSubscription.updateMany(
    { _id: { $in: expired.map((item) => item._id) } },
    { $set: { subscriptionStatus: "expired" } },
  );

  const userIds = [...new Set(expired.map((item) => item.userId))];
  await Promise.all(userIds.map((userId) => syncUserPremiumEntitlement(userId)));
  logger.info(
    { subscriptionsExpired: expired.length, usersUpdated: userIds.length },
    "Expired Apple subscriptions reconciled",
  );
  return { expired: expired.length, usersUpdated: userIds.length };
}

export function startAppleSubscriptionExpiryWorker() {
  if (expiryTimer) return;
  const run = () =>
    expireAppleSubscriptions().catch((err) =>
      logger.warn({ err }, "Apple subscription expiry worker failed"),
    );
  expiryTimer = setInterval(run, ONE_DAY_MS);
  expiryTimer.unref();
  run();
}
