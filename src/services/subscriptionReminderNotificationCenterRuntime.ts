import { InvoiceSettings, User, UserNotification, mongoose } from "@api/db";
import { sendEmail } from "../lib/simple-email";
import { logger } from "../lib/logger";
import { insertUserNotifications, sendPushForUserNotifications } from "./notificationService";

const CONFIG_COLLECTION = "subscription_reminder_notification_center_configs";
const JOB_COLLECTION = "subscription_reminder_notification_center_jobs";
const LOG_COLLECTION = "subscription_reminder_notification_center_logs";
const HISTORY_COLLECTION = "notificationhistories";

type ReminderStage = {
  id: string;
  name: string;
  enabled: boolean;
  delayAmount: number;
  delayUnit: "Minutes" | "Hours" | "Days";
  push: {
    title: string;
    message: string;
    ctaText?: string;
    ctaAction?: string;
  };
  email: {
    subject: string;
    body: string;
    ctaText?: string;
    ctaUrl?: string;
    templateId?: string;
    templateKey?: string;
  };
};

type ReminderConfig = {
  _id: mongoose.Types.ObjectId;
  reminderName: string;
  status: "enabled" | "disabled";
  reminders: ReminderStage[];
  priority?: number;
};

type ReminderJob = {
  _id: mongoose.Types.ObjectId;
  configId: string;
  userId: string;
  eventType: string;
  subscriptionId?: string;
  subscriptionPlan?: string;
  eventTime: Date;
  stageId: string;
  stageName: string;
  stageIndex: number;
  dueAt: Date;
  status: string;
  dedupeKey: string;
  activeKey: string;
  purchaseCompleted?: boolean;
  sending?: boolean;
};

function collection(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is not connected");
  return db.collection(name);
}

function unitToMs(unit: string) {
  if (unit === "Days") return 24 * 60 * 60 * 1000;
  if (unit === "Hours") return 60 * 60 * 1000;
  return 60 * 1000;
}

function dateWithDelay(stage: ReminderStage, eventTime = new Date()) {
  return new Date(eventTime.getTime() + Math.max(0, Number(stage.delayAmount || 0)) * unitToMs(stage.delayUnit));
}

function isFailureEvent(value: string) {
  return ["cancelled", "canceled", "failed", "timeout", "timed_out", "abandoned", "incomplete", "payment_failed", "payment_cancelled"].includes(
    String(value || "").toLowerCase(),
  );
}

function text(value: unknown, fallback = "") {
  return String(value ?? fallback).replace(/\u0000/g, "").trim();
}

function applyPlaceholders(template = "", user: any, job: ReminderJob) {
  const replacements: Record<string, string> = {
    StudentName: text(user?.name, "Learner"),
    UserName: text(user?.name, "Learner"),
    Email: text(user?.email),
    Mobile: text(user?.mobile),
    PlanName: text(job.subscriptionPlan, "Premium"),
    PurchaseLink: "/subscription",
    SupportEmail: "support@krita.com",
  };
  return Object.entries(replacements).reduce((body, [key, value]) => body.replace(new RegExp(`{{\\s*${key}\\s*}}`, "g"), value), template);
}

async function ensureIndexes() {
  await Promise.all([
    collection(CONFIG_COLLECTION).createIndex({ status: 1, priority: 1, updatedAt: -1 }),
    collection(JOB_COLLECTION).createIndex({ status: 1, dueAt: 1, sending: 1 }),
    collection(JOB_COLLECTION).createIndex({ dedupeKey: 1 }, { unique: true }),
    collection(JOB_COLLECTION).createIndex({ activeKey: 1, status: 1 }),
    collection(LOG_COLLECTION).createIndex({ jobId: 1, createdAt: -1 }),
  ]).catch((error) => logger.error({ err: error }, "[SUBSCRIPTION REMINDER INDEX FAILED]"));
}

async function getEnabledConfig() {
  await ensureIndexes();
  return collection(CONFIG_COLLECTION).findOne({ status: "enabled" }, { sort: { priority: 1, updatedAt: -1 } }) as Promise<ReminderConfig | null>;
}

async function writeLog(job: ReminderJob, payload: Record<string, unknown>) {
  await collection(LOG_COLLECTION).insertOne({
    jobId: String(job._id),
    userId: String(job.userId),
    configId: String(job.configId),
    stageId: job.stageId,
    stageName: job.stageName,
    eventType: job.eventType,
    ...payload,
    createdAt: new Date(),
  });
}

async function createHistory(config: ReminderConfig, stage: ReminderStage, job: ReminderJob, pushDelivery: any, emailResult: any, status: string) {
  await collection(HISTORY_COLLECTION).insertOne({
    campaignName: `${config.reminderName || "Subscription Reminder"} - ${stage.name || job.stageName}`,
    deliveryType: "both",
    title: stage.push.title,
    message: stage.push.message,
    deepLink: stage.push.ctaAction || "/subscription",
    ctaText: stage.push.ctaText || "",
    emailTemplateId: stage.email.templateId || "",
    emailTemplateKey: stage.email.templateKey || "",
    emailSubject: stage.email.subject,
    emailBody: stage.email.body,
    targetType: "subscription_reminder",
    selectedUsers: [String(job.userId)],
    category: "subscription_reminder",
    sound: "default",
    priority: "high",
    sentCount: pushDelivery?.sentCount || 0,
    successCount: pushDelivery?.successCount || 0,
    failedCount: pushDelivery?.failedCount || 0,
    noTokenCount: pushDelivery?.noTokenCount || 0,
    emailSentCount: emailResult?.sent ? 1 : 0,
    emailFailedCount: emailResult?.sent ? 0 : emailResult?.skipped ? 0 : 1,
    emailSkippedCount: emailResult?.skipped ? 1 : 0,
    logs: [{ userId: String(job.userId), pushDelivery, emailResult }],
    status,
    createdBy: "subscription-reminder",
    createdByName: "Subscription Reminder",
    sentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function stopIfPurchased(job: ReminderJob) {
  const user = await User.findById(job.userId).select("name email mobile isPremium lastPurchase").lean();
  if (!user) {
    await collection(JOB_COLLECTION).updateOne({ _id: job._id }, { $set: { status: "cancelled", stoppedReason: "User not found", updatedAt: new Date() } });
    return { stopped: true, user: null };
  }
  if ((user as any).isPremium || String((user as any).lastPurchase?.paymentStatus || "").toLowerCase() === "success") {
    await collection(JOB_COLLECTION).updateMany(
      { activeKey: job.activeKey, status: "pending" },
      { $set: { status: "cancelled", purchaseCompleted: true, stoppedReason: "Subscription completed", updatedAt: new Date() } },
    );
    return { stopped: true, user };
  }
  return { stopped: false, user };
}

async function deliverJob(job: ReminderJob) {
  logger.info({ jobId: String(job._id), userId: job.userId, stageId: job.stageId }, "[SUBSCRIPTION REMINDER TRIGGERED]");
  const config = await collection(CONFIG_COLLECTION).findOne({ _id: new mongoose.Types.ObjectId(job.configId), status: "enabled" }) as ReminderConfig | null;
  if (!config) {
    await collection(JOB_COLLECTION).updateOne({ _id: job._id }, { $set: { status: "cancelled", stoppedReason: "Configuration disabled or missing", updatedAt: new Date() } });
    return;
  }

  const stage = (config.reminders || []).find((item) => item.id === job.stageId && item.enabled !== false);
  if (!stage) {
    await collection(JOB_COLLECTION).updateOne({ _id: job._id }, { $set: { status: "cancelled", stoppedReason: "Stage disabled or missing", updatedAt: new Date() } });
    return;
  }

  const { stopped, user } = await stopIfPurchased(job);
  logger.info({ jobId: String(job._id), userId: job.userId, purchaseStopped: stopped }, "[SUBSCRIPTION REMINDER USER LOADED]");
  if (stopped || !user) return;

  const now = new Date();
  const title = applyPlaceholders(stage.push.title, user, job);
  const body = applyPlaceholders(stage.push.message, user, job);
  const notificationDoc = {
    userId: String(job.userId),
    type: "subscription_reminder",
    title,
    body,
    dedupeKey: job.dedupeKey,
    visibleInApp: true,
    linkUrl: stage.push.ctaAction || "/subscription",
    imageUrl: "",
    targetGroup: "subscription_reminder",
    deliveryMode: "both",
    notificationStatus: "created",
    pushStatus: "pending",
    senderId: "subscription-reminder",
    senderName: "Subscription Reminder",
    emailTemplateKey: stage.email.templateKey || "",
    ctaText: stage.push.ctaText || "",
    sentAt: now,
  };

  logger.info({ jobId: String(job._id), userId: job.userId, dedupeKey: job.dedupeKey, payload: notificationDoc }, "[SUBSCRIPTION REMINDER NOTIFICATION SAVE]");
  const inserted = await insertUserNotifications([notificationDoc], { autoPush: false });
  let notifications = inserted.notifications;
  if (!notifications.length) {
    const existing = await UserNotification.findOne({ dedupeKey: job.dedupeKey });
    notifications = existing ? [existing] : [];
  }

  logger.info({ jobId: String(job._id), userId: job.userId, notificationCount: notifications.length }, "[SUBSCRIPTION REMINDER FCM SEND REQUEST]");
  const pushDelivery = await sendPushForUserNotifications(notifications);
  logger.info({ jobId: String(job._id), pushDelivery }, "[SUBSCRIPTION REMINDER FCM RESPONSE]");

  const settings = await InvoiceSettings.findOne({ key: "default" });
  const html = applyPlaceholders(stage.email.body, user, job);
  logger.info({ jobId: String(job._id), userId: job.userId, to: (user as any).email, subject: stage.email.subject }, "[SUBSCRIPTION REMINDER EMAIL SEND REQUEST]");
  let emailResult: any = { skipped: true, reason: "User email or SMTP settings missing" };
  if ((user as any).email && settings?.smtp?.host && settings?.smtp?.fromEmail) {
    emailResult = await sendEmail({
      smtp: settings.smtp,
      to: String((user as any).email),
      subject: applyPlaceholders(stage.email.subject, user, job),
      html,
      text: html.replace(/<[^>]*>/g, " "),
    });
  }
  logger.info({ jobId: String(job._id), emailResult }, "[SUBSCRIPTION REMINDER EMAIL RESPONSE]");

  const pushOk = (pushDelivery?.successCount || 0) > 0;
  const emailOk = Boolean(emailResult?.sent);
  const finalStatus = pushOk && (emailOk || emailResult?.skipped) ? "sent" : pushOk || emailOk ? "partial" : "failed";
  await createHistory(config, stage, job, pushDelivery, emailResult, finalStatus);
  await writeLog(job, {
    status: finalStatus,
    pushStatus: pushOk ? "sent" : (pushDelivery?.noTokenCount || 0) > 0 ? "no_token" : "failed",
    emailStatus: emailOk ? "sent" : emailResult?.skipped ? "skipped" : "failed",
    errorMessage: [...(pushDelivery?.errors || []), emailResult?.reason || ""].filter(Boolean).join("; "),
    pushDelivery,
    emailResult,
  });
  await collection(JOB_COLLECTION).updateOne(
    { _id: job._id },
    {
      $set: {
        status: finalStatus === "failed" ? "failed" : "sent",
        pushStatus: pushOk ? "sent" : (pushDelivery?.noTokenCount || 0) > 0 ? "no_token" : "failed",
        emailStatus: emailOk ? "sent" : emailResult?.skipped ? "skipped" : "failed",
        lastReminderDate: now,
        updatedAt: now,
      },
      $unset: { sending: "" },
    },
  );
  logger.info({ jobId: String(job._id), finalStatus }, "[SUBSCRIPTION REMINDER FINAL STATUS]");
}

export async function trackSubscriptionReminder(userId: string, body: any) {
  const eventType = text(body?.eventType || body?.status || "abandoned");
  if (!isFailureEvent(eventType)) return { skipped: true, reason: "Event is not a failed/cancelled/abandoned payment" };
  if (!mongoose.isValidObjectId(userId)) return { skipped: true, reason: "Invalid user id" };

  const config = await getEnabledConfig();
  if (!config) return { skipped: true, reason: "Subscription Reminder is disabled" };

  const eventTime = body?.eventTime ? new Date(body.eventTime) : new Date();
  const subscriptionId = text(body?.subscriptionId || body?.orderId || body?.razorpayOrderId || body?.paymentId);
  const activeKey = `subscription-reminder-nc:${userId}:${subscriptionId || eventTime.toISOString().slice(0, 10)}`;
  const stages = (config.reminders || []).filter((stage) => stage.enabled !== false);
  const jobs = stages.map((stage, index) => ({
    configId: String(config._id),
    userId: String(userId),
    eventType,
    subscriptionId,
    subscriptionPlan: text(body?.subscriptionPlan || body?.planName || body?.planId || "Premium"),
    eventTime,
    stageId: stage.id,
    stageName: stage.name,
    stageIndex: index,
    dueAt: dateWithDelay(stage, eventTime),
    status: "pending",
    pushStatus: "pending",
    emailStatus: "pending",
    activeKey,
    dedupeKey: `subscription-reminder-nc:${userId}:${subscriptionId || eventTime.getTime()}:${stage.id}`,
    purchaseCompleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  logger.info({ userId, eventType, activeKey, jobCount: jobs.length }, "[SUBSCRIPTION REMINDER JOB CREATE REQUEST]");
  try {
    await collection(JOB_COLLECTION).insertMany(jobs, { ordered: false });
  } catch (error: any) {
    const writeErrors = error?.writeErrors || [];
    const duplicateOnly = error?.code === 11000 || (writeErrors.length > 0 && writeErrors.every((item: any) => item?.code === 11000));
    if (!duplicateOnly) throw error;
    logger.warn({ userId, activeKey }, "[SUBSCRIPTION REMINDER DUPLICATE JOB SKIPPED]");
  }

  const dueNow = await collection(JOB_COLLECTION)
    .find({ activeKey, status: "pending", dueAt: { $lte: new Date(Date.now() + 1000) } })
    .toArray() as ReminderJob[];
  for (const job of dueNow) await processReminderJob(job._id);

  return { skipped: false, activeKey, scheduledCount: jobs.length };
}

export async function completeSubscriptionReminders(userId: string) {
  await collection(JOB_COLLECTION).updateMany(
    { userId: String(userId), status: "pending" },
    { $set: { status: "cancelled", purchaseCompleted: true, stoppedReason: "Subscription completed", updatedAt: new Date() } },
  );
}

export async function processReminderJob(id: mongoose.Types.ObjectId) {
  const locked = await collection(JOB_COLLECTION).findOneAndUpdate(
    { _id: id, status: "pending", sending: { $ne: true } },
    { $set: { sending: true, sendingAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const job = locked as ReminderJob | null;
  if (!job) return;
  try {
    await deliverJob(job);
  } catch (error) {
    logger.error({ err: error, jobId: String(job._id), stack: (error as Error)?.stack }, "[SUBSCRIPTION REMINDER DELIVERY FAILED]");
    await writeLog(job, {
      status: "failed",
      pushStatus: "failed",
      emailStatus: "failed",
      errorMessage: (error as Error)?.message || "Reminder delivery failed",
      stack: (error as Error)?.stack || "",
    });
    await collection(JOB_COLLECTION).updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          errorMessage: (error as Error)?.message || "Reminder delivery failed",
          updatedAt: new Date(),
        },
        $unset: { sending: "" },
      },
    );
  }
}

export async function runDueSubscriptionReminders(limit = 50) {
  await ensureIndexes();
  const jobs = await collection(JOB_COLLECTION)
    .find({ status: "pending", purchaseCompleted: { $ne: true }, dueAt: { $lte: new Date() }, sending: { $ne: true } })
    .sort({ dueAt: 1 })
    .limit(limit)
    .toArray() as ReminderJob[];
  for (const job of jobs) await processReminderJob(job._id);
  return jobs.length;
}

let workerStarted = false;

export function startSubscriptionReminderWorker() {
  if (workerStarted) return;
  workerStarted = true;
  void runDueSubscriptionReminders().catch((error) => logger.error({ err: error }, "[SUBSCRIPTION REMINDER WORKER FAILED]"));
  setInterval(() => {
    runDueSubscriptionReminders().catch((error) => logger.error({ err: error }, "[SUBSCRIPTION REMINDER WORKER FAILED]"));
  }, 60_000);
}
