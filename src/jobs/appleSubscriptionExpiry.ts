import cron, { type ScheduledTask } from "node-cron";
import { Invoice, Subscription, UserSubscription } from "@api/db";
import { generateInvoiceForSubscription } from "../lib/invoices";
import { logger } from "../lib/logger";
import { getLatestAppleSubscriptionStatus } from "../services/appleNotificationService";
import {
  fulfillVerifiedApplePurchase,
  saveVerifiedAppleSubscription,
  syncUserPremiumEntitlement,
} from "../services/appleSubscriptionService";

const RENEWAL_CRON = "0 6 * * *";
const RETRY_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
let renewalTask: ScheduledTask | null = null;

async function retryMissingAppleInvoices() {
  const purchases = await Subscription.find({
    paymentProvider: "apple",
    paymentStatus: "PAID",
    status: "active",
  })
    .sort({ transactionDate: -1 })
    .limit(100)
    .select("_id");
  if (!purchases.length) return 0;

  const purchaseIds = purchases.map((purchase) => String(purchase._id));
  const invoicedIds = new Set(
    (
      await Invoice.find({ subscriptionId: { $in: purchaseIds } })
        .select("subscriptionId")
        .lean()
    ).map((invoice) => invoice.subscriptionId),
  );
  let generated = 0;
  for (const subscriptionId of purchaseIds) {
    if (invoicedIds.has(subscriptionId)) continue;
    try {
      await generateInvoiceForSubscription(subscriptionId);
      generated += 1;
    } catch (error) {
      logger.warn(
        { err: error, subscriptionId },
        "Missing Apple invoice could not be generated",
      );
    }
  }
  return generated;
}

export async function verifyExpiredAppleSubscriptions() {
  const now = new Date();
  // The job runs at 06:00, so include the full third calendar day even when
  // the original expiry timestamp was shortly after midnight.
  const cutoff = new Date(
    now.getTime() - RETRY_WINDOW_DAYS * DAY_MS - 6 * 60 * 60 * 1000,
  );
  const candidates = await UserSubscription.find({
    platform: "ios",
    expiryDate: { $gte: cutoff, $lte: now },
    $or: [
      {
        retryPending: { $ne: true },
        subscriptionStatus: { $in: ["active", "cancelled", "failed"] },
      },
      {
        retryPending: true,
        subscriptionStatus: { $in: ["active", "cancelled", "failed", "expired"] },
        $or: [
          { nextRetryAt: { $exists: false } },
          { nextRetryAt: null },
          { nextRetryAt: { $lte: now } },
        ],
      },
    ],
  })
    .sort({ expiryDate: 1 })
    .limit(500);

  let renewed = 0;
  let expired = 0;
  let pending = 0;
  let errors = 0;

  for (const candidate of candidates) {
    const claimed = await UserSubscription.findOneAndUpdate(
      {
        _id: candidate._id,
        $or: [
          { lastRetryAt: { $exists: false } },
          { lastRetryAt: { $lt: new Date(now.getTime() - 20 * 60 * 60 * 1000) } },
        ],
      },
      { $set: { lastRetryAt: now, lastVerificationAt: now } },
      { new: true },
    );
    if (!claimed) continue;

    try {
      const latest = await getLatestAppleSubscriptionStatus(
        claimed.originalTransactionId,
        claimed.productId,
        claimed.environment || "Production",
      );

      if (
        latest.active &&
        latest.expiryDate.getTime() > claimed.expiryDate.getTime()
      ) {
        await fulfillVerifiedApplePurchase(claimed.userId, undefined, latest);
        renewed += 1;
        continue;
      }

      await saveVerifiedAppleSubscription(claimed.userId, undefined, latest);
      const retryCount = claimed.retryPending ? claimed.retryCount + 1 : 0;
      const retriesExhausted = retryCount >= RETRY_WINDOW_DAYS;
      await UserSubscription.findByIdAndUpdate(claimed._id, {
        $set: {
          subscriptionStatus: retriesExhausted ? "expired" : latest.billingRetry ? "failed" : "expired",
          retryPending: !retriesExhausted,
          retryCount,
          nextRetryAt: retriesExhausted
            ? null
            : new Date(now.getTime() + 20 * 60 * 60 * 1000),
          lastVerificationAt: now,
        },
      });
      await syncUserPremiumEntitlement(claimed.userId);
      if (retriesExhausted) expired += 1;
      else pending += 1;
    } catch (error) {
      errors += 1;
      const retryCount = claimed.retryPending ? claimed.retryCount + 1 : 0;
      const retriesExhausted = retryCount >= RETRY_WINDOW_DAYS;
      await UserSubscription.findByIdAndUpdate(claimed._id, {
        $set: {
          subscriptionStatus: retriesExhausted ? "expired" : claimed.subscriptionStatus,
          retryPending: !retriesExhausted,
          retryCount,
          nextRetryAt: retriesExhausted
            ? null
            : new Date(now.getTime() + 20 * 60 * 60 * 1000),
        },
      });
      if (retriesExhausted) {
        expired += 1;
        await syncUserPremiumEntitlement(claimed.userId);
      } else {
        pending += 1;
      }
      logger.warn(
        {
          err: error,
          userId: claimed.userId,
          originalTransactionId: claimed.originalTransactionId,
          retryCount,
          retriesExhausted,
        },
        retriesExhausted
          ? "Apple renewal verification retries exhausted"
          : "Apple renewal verification failed; retry remains pending",
      );
    }
  }

  const invoicesGenerated = await retryMissingAppleInvoices();
  const result = {
    checked: candidates.length,
    renewed,
    retryPending: pending,
    expired,
    errors,
    invoicesGenerated,
  };
  logger.info(result, "Apple subscription renewal cron completed");
  return result;
}

// Backward-compatible export for any operational scripts that used the old name.
export const expireAppleSubscriptions = verifyExpiredAppleSubscriptions;

export function startAppleSubscriptionExpiryWorker() {
  if (renewalTask) return;
  const timezone = process.env["APPLE_RENEWAL_CRON_TIME_ZONE"] || "Asia/Kolkata";
  renewalTask = cron.schedule(
    RENEWAL_CRON,
    () => {
      void verifyExpiredAppleSubscriptions().catch((err) =>
        logger.error({ err }, "Apple subscription renewal cron failed"),
      );
    },
    { timezone, noOverlap: true },
  );
  logger.info(
    { schedule: RENEWAL_CRON, timezone },
    "Apple subscription renewal cron scheduled",
  );
}
