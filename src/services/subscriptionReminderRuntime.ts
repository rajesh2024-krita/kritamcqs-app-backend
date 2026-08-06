import mongoose from "mongoose";
import { InvoiceSettings, User } from "@api/db";
import { sendEmail } from "../lib/simple-email";
import { logger } from "../lib/logger";
import { upsertUserNotificationOnInsert } from "./notificationService";

type ReminderStep = {
  id?: string;
  name?: string;
  enabled?: boolean;
  delayAmount?: number;
  delayUnit?: "Minutes" | "Hours" | "Days";
  inApp?: {
    title?: string;
    message?: string;
    ctaText?: string;
    ctaAction?: string;
  };
  push?: {
    title?: string;
    message?: string;
    ctaText?: string;
    ctaAction?: string;
  };
  email?: {
    subject?: string;
    body?: string;
    ctaText?: string;
    ctaUrl?: string;
  };
};

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
  reminders?: ReminderStep[];
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

let indexesReady: Promise<void> | null = null;

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

function dateAfter(amount?: number, unit?: string) {
  return new Date(Date.now() + Math.max(0, Number(amount || 0)) * unitToMs(unit));
}

function enabledReminderSteps(config: ReminderConfiguration): ReminderStep[] {
  const configured = Array.isArray(config.reminders) ? config.reminders.filter((item) => item?.enabled !== false) : [];
  if (configured.length) return configured;
  return [
    {
      id: "legacy-initial",
      enabled: true,
      delayAmount: config.initialDelay,
      delayUnit: config.delayUnit,
      push: {
        title: config.notificationTitle,
        message: config.notificationMessage,
        ctaAction: "/subscription",
      },
      email: {
        subject: config.emailSubject,
        body: config.emailTemplate,
        ctaUrl: "/subscription",
      },
    },
    ...Array.from({ length: Math.max(0, Number(config.maximumReminderCount || 1) - 1) }, (_item, index) => ({
      id: `legacy-repeat-${index + 1}`,
      enabled: true,
      delayAmount: config.repeatInterval,
      delayUnit: config.delayUnit,
      push: {
        title: config.notificationTitle,
        message: config.notificationMessage,
        ctaAction: "/subscription",
      },
      email: {
        subject: config.emailSubject,
        body: config.emailTemplate,
        ctaUrl: "/subscription",
      },
    })),
  ];
}

function nextDateForStep(config: ReminderConfiguration, stepIndex: number) {
  const step = enabledReminderSteps(config)[stepIndex];
  if (!step) return null;
  return dateAfter(step.delayAmount, step.delayUnit || config.delayUnit);
}

function render(template: string | undefined, values: Record<string, string>) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

function placeholders(user: any, reminder: SubscriptionReminder, config: ReminderConfiguration) {
  const now = new Date();
  return {
    UserName: String(user?.name || user?.email || user?.mobile || "Learner"),
    StudentName: String(user?.name || user?.email || user?.mobile || "Learner"),
    PlanName: String(reminder.subscriptionPlan || config.applicablePlan || "Premium Plan"),
    PlanPrice: "",
    PurchaseLink: "https://app.kritamcqs.com/cta?target=%2Fsubscription",
    SupportEmail: "support@kritamcqs.com",
    CurrentDate: now.toLocaleDateString("en-IN"),
    ExpiryDate: "",
  };
}

async function ensureRuntimeIndexes() {
  if (!indexesReady) {
    indexesReady = Promise.all([
      collection("subscription_reminders").createIndex(
        { activeKey: 1 },
        { unique: true, partialFilterExpression: { activeKey: { $type: "string", $gt: "" } } },
      ),
      collection("reminder_logs").createIndex({ reminderId: 1, "payload.reminderNumber": 1 }),
    ]).then(() => undefined);
  }
  await indexesReady;
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

  await ensureRuntimeIndexes();
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const reminderCollection = collection("subscription_reminders");
  const activeKey = `subscription-reminder:${String(userObjectId)}`;
  const legacyPending = await reminderCollection.findOne({
    userId: userObjectId,
    status: "pending",
    purchaseCompleted: false,
    activeKey: { $exists: false },
  });
  if (legacyPending) {
    await reminderCollection.updateOne({ _id: legacyPending._id }, { $set: { activeKey, updatedAt: new Date() } });
  }
  const updateFields = {
    subscriptionId: String(body?.subscriptionId || body?.orderId || ""),
    subscriptionPlan: String(body?.subscriptionPlan || body?.planName || ""),
    eventType,
    eventTime: new Date(),
    platform,
    updatedAt: new Date(),
  };

  const reminder = await reminderCollection.findOneAndUpdate(
    {
      activeKey,
      status: "pending",
      purchaseCompleted: false,
    },
    {
      $set: updateFields,
      $setOnInsert: {
        activeKey,
        userId: userObjectId,
        status: "pending",
        reminderCount: 0,
        purchaseCompleted: false,
        createdAt: new Date(),
        ...(config.immediateReminderEnabled === false ? { nextReminderDate: nextDateForStep(config, 0) } : {}),
      },
    },
    { upsert: true, returnDocument: "after" },
  ) as SubscriptionReminder | null;
  if (!reminder) return { skipped: true, reason: "Unable to create reminder" };

  let immediateResult: Awaited<ReturnType<typeof deliverReminder>> | null = null;
  const shouldAttemptImmediate = config.immediateReminderEnabled !== false && Number(reminder.reminderCount || 0) === 0;

  if (shouldAttemptImmediate) {
    const lock = await reminderCollection.updateOne(
      {
        _id: reminder._id,
        status: "pending",
        purchaseCompleted: false,
        reminderCount: 0,
        immediateReminderSentAt: { $exists: false },
        immediateReminderSending: { $ne: true },
      },
      {
        $set: {
          immediateReminderSending: true,
          updatedAt: new Date(),
        },
      },
    );

    if (lock.modifiedCount > 0) {
      try {
        immediateResult = await deliverReminder(reminder, config, "immediate");
      } catch (error) {
        await reminderCollection.updateOne(
          { _id: reminder._id },
          { $unset: { immediateReminderSending: "" }, $set: { updatedAt: new Date() } },
        );
        throw error;
      }
    }
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
      $unset: { activeKey: "" },
    },
  );
}

async function deliverReminder(
  reminder: SubscriptionReminder,
  config: ReminderConfiguration,
  trigger: "immediate" | "scheduled",
) {
  const steps = enabledReminderSteps(config);
  const reminderIndex = Number(reminder.reminderCount || 0);
  const step = steps[reminderIndex];
  const maxCount = Math.min(Number(config.maximumReminderCount || steps.length || 1), steps.length || 1);

  if (reminderIndex >= maxCount || !step) {
    await collection("subscription_reminders").updateOne(
      { _id: reminder._id },
      { $set: { status: "max_reached", updatedAt: new Date() }, $unset: { immediateReminderSending: "", activeKey: "", scheduledReminderSending: "" } },
    );
    return { sent: false, reason: "Maximum reminder count reached" };
  }

  const user = await User.findById(reminder.userId).lean();
  if (!user) {
    await collection("subscription_reminders").updateOne(
      { _id: reminder._id },
      {
        $set: { status: "stopped", stoppedReason: "User not found", updatedAt: new Date() },
        $unset: { immediateReminderSending: "", scheduledReminderSending: "", activeKey: "" },
      },
    );
    return { sent: false, reason: "User not found" };
  }

  const values = placeholders(user, reminder, config);
  let notificationStatus = "not_applicable";
  let emailStatus = "not_applicable";
  let errorMessage = "";
  const reminderNumber = reminderIndex + 1;
  const pushTitle = step.push?.title || step.inApp?.title || config.notificationTitle || "";
  const pushMessage = step.push?.message || step.inApp?.message || config.notificationMessage || "";
  const pushLink = step.push?.ctaAction || step.inApp?.ctaAction || "/subscription";
  const emailSubject = step.email?.subject || config.emailSubject || pushTitle;
  const emailBody = step.email?.body || config.emailTemplate || pushMessage;

  if (config.channels !== "Email") {
    try {
      const dedupeKey = `subscription-reminder:${String(reminder._id)}:${reminderNumber}`;
      const { notification, created } = await upsertUserNotificationOnInsert(
        { dedupeKey },
        {
          userId: String(reminder.userId),
          type: "subscription",
          title: render(pushTitle, values),
          body: render(pushMessage, values),
          dedupeKey,
          visibleInApp: true,
          linkUrl: pushLink,
          targetGroup: "subscription_abandoned",
          deliveryMode: config.channels === "Both" ? "email_push" : "push",
          notificationStatus: "created",
          pushStatus: "pending",
          senderName: "Krita",
          sentAt: new Date(),
        },
        { autoPush: true },
      );
      notificationStatus = created
        ? notification?.pushStatus === "sent" ? "sent" : notification?.pushStatus || "created"
        : "skipped";
      if (notification?.pushError) errorMessage = notification.pushError;
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
          subject: render(emailSubject, values),
          html: render(emailBody, values),
          text: render(pushMessage || emailSubject, values),
        });
        emailStatus = result.skipped ? "skipped" : "sent";
        if (result.reason) errorMessage = [errorMessage, result.reason].filter(Boolean).join("; ");
      }
    } catch (error) {
      emailStatus = "failed";
      errorMessage = [errorMessage, error instanceof Error ? error.message : "Email failed"].filter(Boolean).join("; ");
    }
  }

  const reminderCount = reminderNumber;
  const maxReached = reminderCount >= maxCount;
  const nextReminderDate = maxReached ? null : nextDateForStep(config, reminderCount);

  await collection("reminder_logs").updateOne(
    { reminderId: reminder._id, "payload.reminderNumber": reminderCount },
    {
      $setOnInsert: {
        reminderId: reminder._id,
        configurationId: config._id,
        userId: reminder.userId,
        notificationStatus,
        emailStatus,
        status: notificationStatus === "failed" || emailStatus === "failed" ? "Failed" : "Success",
        errorMessage,
        retryCount: 0,
        payload: { trigger, reminderNumber: reminderCount, reminderId: step.id || "", reminderName: step.name || "" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  await collection("subscription_reminders").updateOne(
    { _id: reminder._id },
    {
      $set: {
        reminderCount,
        lastReminderDate: new Date(),
        ...(nextReminderDate ? { nextReminderDate } : {}),
        ...(trigger === "immediate" ? { immediateReminderSentAt: new Date() } : {}),
        status: maxReached ? "max_reached" : "pending",
        updatedAt: new Date(),
      },
      $unset: {
        ...(maxReached ? { nextReminderDate: "", activeKey: "" } : {}),
        ...(trigger === "immediate" ? { immediateReminderSending: "" } : {}),
        ...(trigger === "scheduled" ? { scheduledReminderSending: "" } : {}),
      },
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
      {
        $set: { status: "stopped", stoppedReason: "Reminder disabled", updatedAt: new Date() },
        $unset: { activeKey: "", scheduledReminderSending: "" },
      },
    );
    return;
  }

  await deliverReminder(reminder, config, "scheduled");
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
      const lockedReminder = await collection("subscription_reminders").findOneAndUpdate(
        {
          _id: reminder._id,
          status: "pending",
          purchaseCompleted: false,
          nextReminderDate: { $lte: new Date() },
          scheduledReminderSending: { $ne: true },
        },
        {
          $set: {
            scheduledReminderSending: true,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" },
      ) as SubscriptionReminder | null;
      if (lockedReminder) await sendDueReminder(lockedReminder);
    } catch (error) {
      await collection("subscription_reminders").updateOne(
        { _id: reminder._id },
        { $unset: { scheduledReminderSending: "" }, $set: { updatedAt: new Date() } },
      );
      logger.error({ err: error, reminderId: String(reminder._id) }, "Subscription reminder delivery failed");
    }
  }
}

let scheduler: NodeJS.Timeout | null = null;

export function startSubscriptionReminderWorker() {
  if (scheduler) return scheduler;
  ensureRuntimeIndexes().catch((error) => {
    logger.error({ err: error }, "Subscription reminder index setup failed");
  });
  scheduler = setInterval(() => {
    runDueSubscriptionReminders().catch((error) => {
      logger.error({ err: error }, "Subscription reminder worker failed");
    });
  }, 60_000);
  scheduler.unref();
  return scheduler;
}
