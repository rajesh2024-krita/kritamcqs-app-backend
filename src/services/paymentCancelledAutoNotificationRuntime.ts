import { InvoiceSettings, User, UserNotification, mongoose } from "@api/db";
import { logger } from "../lib/logger";
import { sendEmail } from "../lib/simple-email";
import { insertUserNotifications, sendPushForUserNotifications } from "./notificationService";

const CONFIG_COLLECTION = "payment_cancelled_auto_notification_configs";
const JOB_COLLECTION = "payment_cancelled_auto_notification_jobs";
const LOG_COLLECTION = "payment_cancelled_auto_notification_logs";
const HISTORY_COLLECTION = "notificationhistories";

type ReminderStage = {
  id: string;
  name: string;
  enabled: boolean;
  delayValue: number;
  delayUnit: "Minutes" | "Hours" | "Days";
  title: string;
  message: string;
  image?: string;
  deepLink?: string;
  ctaText?: string;
  ctaConfigId?: string;
  emailTemplateId?: string;
  emailTemplateKey?: string;
  emailSubject: string;
  emailBody: string;
};

type AutoConfig = {
  _id: mongoose.Types.ObjectId;
  name: string;
  status: "enabled" | "disabled";
  reminders: ReminderStage[];
  priority?: number;
};

type AutoJob = {
  _id: mongoose.Types.ObjectId;
  configId: string;
  userId: string;
  eventType: string;
  paymentReference: string;
  planName: string;
  planId: string;
  eventTime: Date;
  stageId: string;
  stageName: string;
  stageIndex: number;
  dueAt: Date;
  status: string;
  activeKey: string;
  dedupeKey: string;
  paymentCompleted?: boolean;
  sending?: boolean;
};

function collection(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is not connected");
  return db.collection(name);
}

function clean(value: unknown, fallback = "") {
  return String(value ?? fallback).replace(/\u0000/g, "").trim();
}

function unitMs(unit: string) {
  if (unit === "Days") return 24 * 60 * 60 * 1000;
  if (unit === "Hours") return 60 * 60 * 1000;
  return 60 * 1000;
}

function dueAt(stage: ReminderStage, eventTime: Date) {
  return new Date(eventTime.getTime() + Math.max(0, Number(stage.delayValue || 0)) * unitMs(stage.delayUnit));
}

function isPaymentCancelledEvent(value: string) {
  return [
    "cancelled",
    "canceled",
    "failed",
    "timeout",
    "timed_out",
    "abandoned",
    "incomplete",
    "razorpay_closed",
    "payment_failed",
    "payment_cancelled",
    "payment_timeout",
    "app_closed_during_payment",
    "subscription_abandoned",
  ].includes(String(value || "").toLowerCase());
}

function applyVariables(template = "", user: any, job: AutoJob) {
  const values: Record<string, string> = {
    user_name: clean(user?.name, "Learner"),
    customer_name: clean(user?.name, "Learner"),
    name: clean(user?.name, "Learner"),
    email: clean(user?.email),
    mobile: clean(user?.mobile),
    plan_name: clean(job.planName, "Premium"),
    plan_id: clean(job.planId),
    payment_reference: clean(job.paymentReference),
    event_type: clean(job.eventType),
    payment_link: "/subscription",
    button_link: "/subscription",
    app_name: "Krita MCQs",
    company_name: "Krita",
    support_email: "support@krita.com",
  };
  return Object.entries(values).reduce(
    (body, [key, value]) => body.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), value),
    String(template || ""),
  );
}

async function ensureIndexes() {
  await Promise.all([
    collection(CONFIG_COLLECTION).createIndex({ status: 1, priority: 1, updatedAt: -1 }),
    collection(JOB_COLLECTION).createIndex({ status: 1, dueAt: 1, sending: 1 }),
    collection(JOB_COLLECTION).createIndex({ dedupeKey: 1 }, { unique: true }),
    collection(JOB_COLLECTION).createIndex({ activeKey: 1, status: 1 }),
    collection(LOG_COLLECTION).createIndex({ jobId: 1, createdAt: -1 }),
    collection(LOG_COLLECTION).createIndex({ userId: 1, createdAt: -1 }),
  ]).catch((error) => logger.error({ err: error }, "[PAYMENT_CANCELLED_AUTO_INDEX_FAILED]"));
}

async function enabledConfig() {
  await ensureIndexes();
  return collection(CONFIG_COLLECTION).findOne(
    { status: "enabled" },
    { sort: { priority: 1, updatedAt: -1 } },
  ) as Promise<AutoConfig | null>;
}

async function writeLog(job: Pick<AutoJob, "_id" | "userId" | "configId" | "stageId" | "stageName" | "eventType" | "paymentReference">, payload: Record<string, unknown>) {
  await collection(LOG_COLLECTION).insertOne({
    jobId: String(job._id),
    userId: String(job.userId),
    configId: String(job.configId),
    stageId: String(job.stageId),
    stageName: String(job.stageName),
    eventType: String(job.eventType),
    paymentReference: String(job.paymentReference),
    ...payload,
    createdAt: new Date(),
  });
}

async function stopIfPaid(job: AutoJob) {
  const user = await User.findById(job.userId).select("name email mobile isPremium lastPurchase").lean();
  if (!user) {
    await collection(JOB_COLLECTION).updateOne({ _id: job._id }, { $set: { status: "cancelled", stoppedReason: "User not found", updatedAt: new Date() } });
    return { stopped: true, user: null };
  }

  const status = String((user as any).lastPurchase?.paymentStatus || "").toLowerCase();
  if ((user as any).isPremium || status === "success" || status === "paid") {
    await collection(JOB_COLLECTION).updateMany(
      { activeKey: job.activeKey, status: "pending" },
      { $set: { status: "cancelled", paymentCompleted: true, stoppedReason: "Payment already completed", updatedAt: new Date() } },
    );
    await writeLog(job, { status: "skipped", reason: "Payment already completed" });
    return { stopped: true, user };
  }

  return { stopped: false, user };
}

async function addHistory(config: AutoConfig, stage: ReminderStage, job: AutoJob, pushDelivery: any, emailResult: any, status: string) {
  await collection(HISTORY_COLLECTION).insertOne({
    campaignName: `${config.name || "Payment Cancelled Auto Notification"} - ${stage.name || job.stageName}`,
    deliveryType: "both",
    notificationType: "payment_cancelled_auto",
    title: stage.title,
    message: stage.message,
    image: stage.image || "",
    deepLink: stage.deepLink || "/subscription",
    ctaConfigId: stage.ctaConfigId || "",
    ctaText: stage.ctaText || "",
    emailTemplateId: stage.emailTemplateId || "",
    emailTemplateKey: stage.emailTemplateKey || "",
    emailSubject: stage.emailSubject,
    emailBody: stage.emailBody,
    targetType: "payment_cancelled",
    selectedUsers: [String(job.userId)],
    category: "subscription",
    sound: "default",
    priority: "high",
    sentCount: pushDelivery?.sentCount || 0,
    successCount: pushDelivery?.successCount || 0,
    failedCount: pushDelivery?.failedCount || 0,
    noTokenCount: pushDelivery?.noTokenCount || 0,
    emailSentCount: emailResult?.sent ? 1 : 0,
    emailFailedCount: emailResult?.sent || emailResult?.skipped ? 0 : 1,
    emailSkippedCount: emailResult?.skipped ? 1 : 0,
    logs: [{ userId: String(job.userId), eventType: job.eventType, paymentReference: job.paymentReference, pushDelivery, emailResult }],
    status,
    createdBy: "payment-cancelled-auto",
    createdByName: "Payment Cancelled Auto Notification",
    sentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function deliver(job: AutoJob) {
  logger.info({ jobId: String(job._id), userId: job.userId, stageId: job.stageId }, "[PAYMENT_CANCELLED_AUTO_TRIGGERED]");
  const config = await collection(CONFIG_COLLECTION).findOne({ _id: new mongoose.Types.ObjectId(job.configId), status: "enabled" }) as AutoConfig | null;
  if (!config) {
    await collection(JOB_COLLECTION).updateOne({ _id: job._id }, { $set: { status: "cancelled", stoppedReason: "Configuration disabled or missing", updatedAt: new Date() } });
    return;
  }

  const stage = (config.reminders || []).find((item) => item.id === job.stageId && item.enabled !== false);
  if (!stage) {
    await collection(JOB_COLLECTION).updateOne({ _id: job._id }, { $set: { status: "cancelled", stoppedReason: "Reminder stage disabled or missing", updatedAt: new Date() } });
    return;
  }

  const { stopped, user } = await stopIfPaid(job);
  if (stopped || !user) return;

  const notificationDoc = {
    userId: String(job.userId),
    type: "payment_cancelled_auto",
    title: applyVariables(stage.title, user, job),
    body: applyVariables(stage.message, user, job),
    dedupeKey: job.dedupeKey,
    visibleInApp: true,
    linkUrl: stage.deepLink || "/subscription",
    imageUrl: stage.image || "",
    targetGroup: "payment_cancelled",
    deliveryMode: "both",
    notificationStatus: "created",
    pushStatus: "pending",
    senderId: "payment-cancelled-auto",
    senderName: "Payment Cancelled Auto Notification",
    templateKey: stage.emailTemplateKey || "",
    ctaConfigId: stage.ctaConfigId || "",
    ctaText: stage.ctaText || "",
    sentAt: new Date(),
  };

  let pushDelivery: any = { sentCount: 0, successCount: 0, failedCount: 0, noTokenCount: 0, skippedCount: 0 };
  try {
    const inserted = await insertUserNotifications([notificationDoc], { autoPush: false });
    let notifications = inserted.notifications;
    if (!notifications.length) {
      const existing = await UserNotification.findOne({ dedupeKey: job.dedupeKey });
      notifications = existing ? [existing] : [];
    }
    pushDelivery = await sendPushForUserNotifications(notifications);
    await writeLog(job, { status: "push_sent", pushDelivery });
  } catch (error) {
    pushDelivery = { ...pushDelivery, failedCount: 1, errors: [error instanceof Error ? error.message : "Push failed"] };
    await writeLog(job, { status: "push_failed", errorMessage: pushDelivery.errors[0] });
  }

  let emailResult: any = { skipped: true, reason: "User email or SMTP settings missing" };
  try {
    const settings = await InvoiceSettings.findOne({ key: "default" });
    const html = applyVariables(stage.emailBody, user, job);
    if ((user as any).email && settings?.smtp?.host && settings?.smtp?.fromEmail) {
      emailResult = await sendEmail({
        smtp: settings.smtp,
        to: String((user as any).email),
        subject: applyVariables(stage.emailSubject, user, job),
        html,
        text: html.replace(/<[^>]*>/g, " "),
      });
    }
    await writeLog(job, { status: emailResult.sent ? "email_sent" : "email_skipped", emailResult });
  } catch (error) {
    emailResult = { sent: false, reason: error instanceof Error ? error.message : "Email failed" };
    await writeLog(job, { status: "email_failed", errorMessage: emailResult.reason });
  }

  const pushOk = (pushDelivery?.successCount || 0) > 0;
  const emailOk = Boolean(emailResult?.sent);
  const finalStatus = pushOk && (emailOk || emailResult?.skipped) ? "sent" : pushOk || emailOk ? "partial" : "failed";
  await addHistory(config, stage, job, pushDelivery, emailResult, finalStatus);
  await writeLog(job, {
    status: finalStatus,
    reason: "Reminder completed",
    pushStatus: pushOk ? "sent" : (pushDelivery?.noTokenCount || 0) > 0 ? "no_token" : "failed",
    emailStatus: emailOk ? "sent" : emailResult?.skipped ? "skipped" : "failed",
  });
  await collection(JOB_COLLECTION).updateOne(
    { _id: job._id },
    {
      $set: {
        status: finalStatus === "failed" ? "failed" : "sent",
        pushStatus: pushOk ? "sent" : (pushDelivery?.noTokenCount || 0) > 0 ? "no_token" : "failed",
        emailStatus: emailOk ? "sent" : emailResult?.skipped ? "skipped" : "failed",
        lastReminderDate: new Date(),
        updatedAt: new Date(),
      },
      $unset: { sending: "" },
    },
  );
}

export async function trackPaymentCancelledAutoNotification(userId: string, body: any) {
  const eventType = clean(body?.eventType || body?.status || "payment_cancelled");
  if (!isPaymentCancelledEvent(eventType)) return { skipped: true, reason: "Event is not a cancelled, failed, or abandoned payment" };
  if (!mongoose.isValidObjectId(userId)) return { skipped: true, reason: "Invalid user id" };

  const config = await enabledConfig();
  if (!config) return { skipped: true, reason: "Payment Cancelled Auto Notification is disabled" };

  const eventTime = body?.eventTime ? new Date(body.eventTime) : new Date();
  const paymentReference = clean(body?.paymentReference || body?.orderId || body?.razorpayOrderId || body?.subscriptionId || body?.paymentId || eventTime.getTime());
  const activeKey = `payment-cancelled-auto:${userId}:${paymentReference}`;
  const stages = (config.reminders || []).filter((stage) => stage.enabled !== false);
  const jobs = stages.map((stage, index) => ({
    configId: String(config._id),
    userId: String(userId),
    eventType,
    paymentReference,
    planName: clean(body?.planName || body?.subscriptionPlan || "Premium"),
    planId: clean(body?.planId || body?.subscriptionId || ""),
    eventTime,
    stageId: stage.id || `stage-${index + 1}`,
    stageName: stage.name || `Reminder ${index + 1}`,
    stageIndex: index,
    dueAt: dueAt(stage, eventTime),
    status: "pending",
    pushStatus: "pending",
    emailStatus: "pending",
    activeKey,
    dedupeKey: `payment-cancelled-auto:${userId}:${paymentReference}:${stage.id || index}`,
    paymentCompleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  await collection(LOG_COLLECTION).insertOne({
    userId,
    configId: String(config._id),
    stageId: "event",
    stageName: "Payment Cancelled",
    eventType,
    paymentReference,
    status: "payment_cancelled",
    scheduledCount: jobs.length,
    createdAt: new Date(),
  });
  await collection(CONFIG_COLLECTION).updateOne(
    { _id: config._id },
    { $set: { lastTriggerAt: new Date(), updatedAt: new Date() } },
  );

  try {
    if (jobs.length) await collection(JOB_COLLECTION).insertMany(jobs, { ordered: false });
  } catch (error: any) {
    const writeErrors = error?.writeErrors || [];
    const duplicateOnly = error?.code === 11000 || (writeErrors.length > 0 && writeErrors.every((item: any) => item?.code === 11000));
    if (!duplicateOnly) throw error;
    logger.warn({ userId, activeKey }, "[PAYMENT_CANCELLED_AUTO_DUPLICATE_JOB_SKIPPED]");
  }

  const dueNow = await collection(JOB_COLLECTION)
    .find({ activeKey, status: "pending", dueAt: { $lte: new Date(Date.now() + 1000) } })
    .toArray() as AutoJob[];
  for (const job of dueNow) await processPaymentCancelledAutoNotificationJob(job._id);

  return { skipped: false, activeKey, scheduledCount: jobs.length };
}

export async function completePaymentCancelledAutoNotifications(userId: string) {
  await collection(JOB_COLLECTION).updateMany(
    { userId: String(userId), status: "pending" },
    { $set: { status: "cancelled", paymentCompleted: true, stoppedReason: "Payment completed", updatedAt: new Date() } },
  );
}

export async function processPaymentCancelledAutoNotificationJob(id: mongoose.Types.ObjectId) {
  const locked = await collection(JOB_COLLECTION).findOneAndUpdate(
    { _id: id, status: "pending", sending: { $ne: true } },
    { $set: { sending: true, sendingAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const job = locked as AutoJob | null;
  if (!job) return;
  try {
    await deliver(job);
  } catch (error) {
    logger.error({ err: error, jobId: String(job._id) }, "[PAYMENT_CANCELLED_AUTO_DELIVERY_FAILED]");
    await writeLog(job, { status: "failed", errorMessage: error instanceof Error ? error.message : "Reminder delivery failed" });
    await collection(JOB_COLLECTION).updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Reminder delivery failed",
          updatedAt: new Date(),
        },
        $unset: { sending: "" },
      },
    );
  }
}

export async function runDuePaymentCancelledAutoNotifications(limit = 50) {
  await ensureIndexes();
  const jobs = await collection(JOB_COLLECTION)
    .find({ status: "pending", paymentCompleted: { $ne: true }, dueAt: { $lte: new Date() }, sending: { $ne: true } })
    .sort({ dueAt: 1 })
    .limit(limit)
    .toArray() as AutoJob[];
  for (const job of jobs) await processPaymentCancelledAutoNotificationJob(job._id);
  return jobs.length;
}

let workerStarted = false;

export function startPaymentCancelledAutoNotificationWorker() {
  if (workerStarted) return;
  workerStarted = true;
  void runDuePaymentCancelledAutoNotifications().catch((error) => logger.error({ err: error }, "[PAYMENT_CANCELLED_AUTO_WORKER_FAILED]"));
  setInterval(() => {
    runDuePaymentCancelledAutoNotifications().catch((error) => logger.error({ err: error }, "[PAYMENT_CANCELLED_AUTO_WORKER_FAILED]"));
  }, 60_000);
}
