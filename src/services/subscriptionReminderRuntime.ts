import mongoose from "mongoose";
import { InvoiceSettings, User } from "@api/db";
import { sendEmail } from "../lib/simple-email";
import { logger } from "../lib/logger";
import { createUserNotification } from "./notificationService";

type ReminderConfiguration = {
  _id: mongoose.Types.ObjectId;
  reminderName?: string;
  status?: string;
  channels?: "Notification" | "Email" | "Both";
  immediateReminderEnabled?: boolean;
  initialDelay?: number;
  repeatInterval?: number;
  delayUnit?: "Minutes" | "Hours" | "Days";
  maximumReminderCount?: number;
  notificationTitle?: string;
  notificationMessage?: string;
  emailSubject?: string;
  emailTemplate?: string;
  platform?: "Android" | "iOS" | "Both";
  applicablePlan?: string;
  priority?: number;
};

type SubscriptionReminder = {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId | string;
  subscriptionId?: string;
  subscriptionPlan?: string;
  eventType?: string;
  platform?: "Android" | "iOS" | "Web";
  status?: string;
  reminderCount?: number;
  nextReminderDate?: Date;
  purchaseCompleted?: boolean;
};

const eventTypes = new Set([
  "razorpay_closed",
  "payment_cancelled",
  "payment_failed",
  "back_pressed",
  "subscription_page_exit",
  "app_closed_during_payment",
  "subscription_abandoned",
  "payment_timeout",
]);

function collection(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  return db.collection(name);
}

function platformFrom(value: unknown): "Android" | "iOS" | "Web" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "ios") return "iOS";
  if (normalized === "web") return "Web";
  return "Android";
}

function unitToMs(unit?: string) {
  if (unit === "Days") return 24 * 60 * 60 * 1000;
  if (unit === "Hours") return 60 * 60 * 1000;
  return 60 * 1000;
}

function nextDate(config: ReminderConfiguration, repeat = false) {
  const amount = repeat ? config.repeatInterval : config.initialDelay;
  return new Date(Date.now() + Math.max(0, Number(amount || 0)) * unitToMs(config.delayUnit));
}

function render(template: string | undefined, values: Record<string, string>) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

function placeholders(user: any, reminder: SubscriptionReminder, config: ReminderConfiguration) {
  const now = new Date();
  return {
    UserName: String(user?.name || user?.email || user?.mobile || "Learner"),
    PlanName: String(reminder.subscriptionPlan || config.applicablePlan || "Premium Plan"),
    PlanPrice: "",
    PurchaseLink: "/subscription",
    SupportEmail: "support@kritamcqs.com",
    CurrentDate: now.toLocaleDateString("en-IN"),
    ExpiryDate: "",
  };
}

async function enabledConfig(platform: "Android" | "iOS" | "Web") {
  if (platform === "Web") {
    return collection("reminder_configurations").findOne(
      { status: "enabled" },
      { sort: { priority: 1, updatedAt: -1 } },
    ) as Promise<ReminderConfiguration | null>;
  }
  return collection("reminder_configurations").findOne(
    { status: "enabled", platform: { $in: [platform, "Both"] } },
    { sort: { priority: 1, updatedAt: -1 } },
  ) as Promise<ReminderConfiguration | null>;
}

export async function listEnabledScripts(platformInput: unknown) {
  const platform = platformFrom(platformInput);
  const items = await collection("third_party_scripts")
    .find({ status: "enabled", platform: { $in: [platform, "All"] } })
    .sort({ priority: 1, updatedAt: -1 })
    .toArray();
  return items.map((item) => ({ ...item, id: String(item._id), _id: undefined }));
}

export async function trackSubscriptionReminder(userId: string, body: any) {
  const eventType = String(body?.eventType || "subscription_abandoned").trim();
  if (!eventTypes.has(eventType)) {
    const error = new Error("Unsupported reminder event type") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  const platform = platformFrom(body?.platform);
  const config = await enabledConfig(platform);
  if (!config) return { skipped: true, reason: "No enabled reminder configuration" };

  const userObjectId = new mongoose.Types.ObjectId(userId);
  const reminderCollection = collection("subscription_reminders");
  const existing = await reminderCollection.findOne({
    userId: userObjectId,
    status: "pending",
    purchaseCompleted: false,
  }) as SubscriptionReminder | null;
  const updateFields = {
    subscriptionId: String(body?.subscriptionId || body?.orderId || ""),
    subscriptionPlan: String(body?.subscriptionPlan || body?.planName || ""),
    eventType,
    eventTime: new Date(),
    platform,
    updatedAt: new Date(),
  };

  let reminder: SubscriptionReminder;
  let immediateResult: Awaited<ReturnType<typeof deliverReminder>> | null = null;
  const shouldSendImmediate = config.immediateReminderEnabled !== false && Number(existing?.reminderCount || 0) === 0;

  if (existing) {
    await reminderCollection.updateOne(
      { _id: existing._id },
      {
        $set: {
          ...updateFields,
          ...(shouldSendImmediate ? {} : { nextReminderDate: existing.reminderCount ? existing.nextReminderDate : nextDate(config) }),
        },
      },
    );
    reminder = { ...existing, ...updateFields };
  } else {
    const insert = {
      ...updateFields,
      ...(shouldSendImmediate ? {} : { nextReminderDate: nextDate(config) }),
      userId: userObjectId,
      status: "pending",
      reminderCount: 0,
      purchaseCompleted: false,
      createdAt: new Date(),
    };
    const result = await reminderCollection.insertOne(insert);
    reminder = {
      ...insert,
      _id: result.insertedId,
    };
  }

  if (shouldSendImmediate) {
    immediateResult = await deliverReminder(reminder, config, "initial", "immediate");
  }

  const latest = await reminderCollection.findOne({ _id: reminder._id });
  return {
    skipped: false,
    immediateSent: Boolean(immediateResult?.sent),
    reminder: { ...latest, id: String(latest?._id), _id: undefined },
  };
}

export async function completeSubscriptionReminders(userId: string) {
  await collection("subscription_reminders").updateMany(
    { userId: new mongoose.Types.ObjectId(userId), status: "pending" },
    {
      $set: {
        status: "completed",
        purchaseCompleted: true,
        completedDate: new Date(),
        stoppedReason: "Subscription purchased successfully",
        updatedAt: new Date(),
      },
    },
  );
}

async function deliverReminder(
  reminder: SubscriptionReminder,
  config: ReminderConfiguration,
  nextMode: "initial" | "repeat",
  trigger: "immediate" | "scheduled",
) {
  if (Number(reminder.reminderCount || 0) >= Number(config.maximumReminderCount || 1)) {
    await collection("subscription_reminders").updateOne(
      { _id: reminder._id },
      { $set: { status: "max_reached", updatedAt: new Date() } },
    );
    return { sent: false, reason: "Maximum reminder count reached" };
  }

  const user = await User.findById(reminder.userId).lean();
  if (!user) {
    await collection("subscription_reminders").updateOne(
      { _id: reminder._id },
      { $set: { status: "stopped", stoppedReason: "User not found", updatedAt: new Date() } },
    );
    return { sent: false, reason: "User not found" };
  }

  const values = placeholders(user, reminder, config);
  let notificationStatus = "not_applicable";
  let emailStatus = "not_applicable";
  let errorMessage = "";

  if (config.channels !== "Email") {
    try {
      const reminderNumber = Number(reminder.reminderCount || 0) + 1;
      const notification = await createUserNotification(
        {
          userId: String(reminder.userId),
          type: "subscription",
          title: render(config.notificationTitle, values),
          body: render(config.notificationMessage, values),
          dedupeKey: `subscription-reminder:${String(reminder._id)}:${reminderNumber}`,
          visibleInApp: true,
          linkUrl: "/subscription",
          targetGroup: "subscription_abandoned",
          deliveryMode: config.channels === "Both" ? "email_push" : "push",
          notificationStatus: "created",
          pushStatus: "pending",
          senderName: "Krita",
          sentAt: new Date(),
        },
        { autoPush: true },
      );
      notificationStatus = notification.pushStatus === "sent" ? "sent" : notification.pushStatus || "created";
      if (notification.pushError) errorMessage = notification.pushError;
    } catch (error) {
      notificationStatus = "failed";
      errorMessage = error instanceof Error ? error.message : "Push notification failed";
    }
  }

  if (config.channels !== "Notification") {
    try {
      const settings = await InvoiceSettings.findOneAndUpdate(
        { key: "default" },
        { $setOnInsert: { key: "default" } },
        { upsert: true, new: true },
      );
      const email = String((user as any).email || "").trim();
      if (!email) {
        emailStatus = "skipped";
      } else {
        const result = await sendEmail({
          smtp: settings.smtp,
          to: email,
          subject: render(config.emailSubject, values),
          html: render(config.emailTemplate, values),
          text: render(config.notificationMessage || config.emailSubject, values),
        });
        emailStatus = result.skipped ? "skipped" : "sent";
        if (result.reason) errorMessage = [errorMessage, result.reason].filter(Boolean).join("; ");
      }
    } catch (error) {
      emailStatus = "failed";
      errorMessage = [errorMessage, error instanceof Error ? error.message : "Email failed"].filter(Boolean).join("; ");
    }
  }

  const reminderCount = Number(reminder.reminderCount || 0) + 1;
  const maxReached = reminderCount >= Number(config.maximumReminderCount || 1);

  await collection("reminder_logs").insertOne({
    reminderId: reminder._id,
    configurationId: config._id,
    userId: reminder.userId,
    notificationStatus,
    emailStatus,
    status: notificationStatus === "failed" || emailStatus === "failed" ? "Failed" : "Success",
    errorMessage,
    retryCount: 0,
    payload: { trigger, reminderNumber: reminderCount },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await collection("subscription_reminders").updateOne(
    { _id: reminder._id },
    {
      $set: {
        reminderCount,
        lastReminderDate: new Date(),
        ...(maxReached ? {} : { nextReminderDate: nextDate(config, nextMode === "repeat") }),
        status: maxReached ? "max_reached" : "pending",
        updatedAt: new Date(),
      },
      ...(maxReached ? { $unset: { nextReminderDate: "" } } : {}),
    },
  );

  return { sent: notificationStatus === "sent" || emailStatus === "sent", notificationStatus, emailStatus };
}

/*
 * Kept separate from trackSubscriptionReminder so scheduled retries always use
 * the latest enabled configuration, while immediate reminder #1 uses the
 * configuration selected at cancellation time.
 */
async function sendDueReminder(reminder: SubscriptionReminder) {
  const platform = reminder.platform || "Android";
  const config = await enabledConfig(platform);
  if (!config) {
    await collection("subscription_reminders").updateOne(
      { _id: reminder._id },
      { $set: { status: "stopped", stoppedReason: "Reminder disabled", updatedAt: new Date() } },
    );
    return;
  }

  await deliverReminder(reminder, config, "repeat", "scheduled");
}

export async function runDueSubscriptionReminders(limit = 50) {
  const reminders = await collection("subscription_reminders")
    .find({
      status: "pending",
      purchaseCompleted: false,
      nextReminderDate: { $lte: new Date() },
    })
    .sort({ nextReminderDate: 1 })
    .limit(limit)
    .toArray() as SubscriptionReminder[];

  for (const reminder of reminders) {
    try {
      await sendDueReminder(reminder);
    } catch (error) {
      logger.error({ err: error, reminderId: String(reminder._id) }, "Subscription reminder delivery failed");
    }
  }
}

let scheduler: NodeJS.Timeout | null = null;

export function startSubscriptionReminderWorker() {
  if (scheduler) return scheduler;
  scheduler = setInterval(() => {
    runDueSubscriptionReminders().catch((error) => {
      logger.error({ err: error }, "Subscription reminder worker failed");
    });
  }, 60_000);
  scheduler.unref();
  return scheduler;
}
