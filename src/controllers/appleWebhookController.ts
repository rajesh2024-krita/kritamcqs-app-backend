import type { Request, Response } from "express";
import { z } from "zod";
import { APPLE_PRODUCT_ID } from "../services/appleReceiptService";
import { verifyAppleNotification } from "../services/appleNotificationService";
import { updateSubscriptionFromWebhook } from "../services/appleSubscriptionService";
import { SubscriptionPlan, User, type AppleSubscriptionStatus } from "@api/db";

const webhookSchema = z.object({
  signedPayload: z.string().min(20).max(10_000_000),
});

const SUPPORTED_EVENTS = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "DID_FAIL_TO_RENEW",
  "EXPIRED",
  "DID_CHANGE_RENEWAL_STATUS",
  "REFUND",
]);

export async function handleAppleWebhook(req: Request, res: Response) {
  try {
    const { signedPayload } = webhookSchema.parse(req.body);
    const { notification, transaction, renewal, environment } =
      await verifyAppleNotification(signedPayload);
    const eventType = String(notification.notificationType || "");

    req.log.info(
      {
        notificationType: eventType,
        subtype: notification.subtype,
        notificationUUID: notification.notificationUUID,
        environment,
      },
      "Verified Apple webhook event received",
    );

    if (!SUPPORTED_EVENTS.has(eventType)) {
      res.status(200).json({ success: true, ignored: true });
      return;
    }

    const originalTransactionId =
      transaction?.originalTransactionId || renewal?.originalTransactionId;
    if (!originalTransactionId) {
      throw new Error("Verified Apple notification is missing originalTransactionId.");
    }
    if (transaction?.productId && transaction.productId !== APPLE_PRODUCT_ID) {
      const configuredPlan = await SubscriptionPlan.exists({
        platform: "ios",
        billingProductId: transaction.productId,
      });
      if (!configuredPlan) {
        res.status(200).json({ success: true, ignored: true });
        return;
      }
    }

    let status: AppleSubscriptionStatus | undefined;
    if (eventType === "SUBSCRIBED" || eventType === "DID_RENEW") status = "active";
    if (eventType === "DID_FAIL_TO_RENEW") status = "failed";
    if (eventType === "EXPIRED") status = "expired";
    if (eventType === "REFUND") status = "refunded";
    if (eventType === "DID_CHANGE_RENEWAL_STATUS") {
      status =
        renewal?.autoRenewStatus === undefined
          ? undefined
          : renewal.autoRenewStatus === 0
            ? "cancelled"
            : "active";
    }

    const transactionExpiry = transaction?.expiresDate;
    const graceExpiry = renewal?.gracePeriodExpiresDate;
    const effectiveExpiry =
      transactionExpiry || graceExpiry
        ? Math.max(transactionExpiry || 0, graceExpiry || 0)
        : undefined;
    const linkedUser = transaction?.appAccountToken
      ? await User.findOne({ appleAppAccountToken: transaction.appAccountToken }).select("_id")
      : null;

    const updated = await updateSubscriptionFromWebhook({
      userId: linkedUser?._id.toString(),
      originalTransactionId,
      transactionId: transaction?.transactionId,
      productId: transaction?.productId,
      purchaseDate: transaction?.purchaseDate ? new Date(transaction.purchaseDate) : undefined,
      expiryDate: effectiveExpiry ? new Date(effectiveExpiry) : undefined,
      status,
      autoRenewStatus:
        renewal?.autoRenewStatus === undefined ? undefined : renewal.autoRenewStatus === 1,
      environment,
      latestWebhookEvent: {
        type: eventType,
        subtype: notification.subtype,
        notificationUUID: notification.notificationUUID,
        signedDate: notification.signedDate ? new Date(notification.signedDate) : undefined,
      },
    });

    if (!updated) {
      req.log.warn(
        { originalTransactionId, eventType },
        "Apple webhook has no locally linked subscription; awaiting receipt verification",
      );
    }
    res.status(200).json({ success: true });
  } catch (error) {
    req.log.warn(
      { err: error },
      "Apple webhook rejected because signedPayload verification failed",
    );
    res.status(400).json({
      success: false,
      error: "invalid_apple_webhook",
      message: "Apple notification signature could not be verified.",
    });
  }
}
