import { mongoose } from "@api/db";
import { logger } from "../lib/logger";

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
  pushTitle?: string;
  pushMessage?: string;
  inAppTitle?: string;
  inAppMessage?: string;
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

async function writeEventLog(payload: Record<string, unknown>) {
  await collection(LOG_COLLECTION).insertOne({
    jobId: "",
    userId: String(payload["userId"] || ""),
    configId: String(payload["configId"] || ""),
    stageId: "event",
    stageName: "Payment Cancelled Event",
    eventType: String(payload["eventType"] || ""),
    paymentReference: String(payload["paymentReference"] || ""),
    ...payload,
    createdAt: new Date(),
  });
}

export async function trackPaymentCancelledAutoNotification(userId: string, body: any) {
  const eventType = clean(body?.eventType || body?.status || "payment_cancelled");
  const eventTime = body?.eventTime ? new Date(body.eventTime) : new Date();
  const paymentReference = clean(body?.paymentReference || body?.orderId || body?.razorpayOrderId || body?.subscriptionId || body?.paymentId || eventTime.getTime());
  if (!isPaymentCancelledEvent(eventType)) {
    await writeEventLog({ userId, eventType, paymentReference, status: "event_skipped", reason: "Event is not a cancelled, failed, or abandoned payment" });
    return { skipped: true, reason: "Event is not a cancelled, failed, or abandoned payment" };
  }
  if (!mongoose.isValidObjectId(userId)) {
    await writeEventLog({ userId, eventType, paymentReference, status: "event_skipped", reason: "Invalid user id" });
    return { skipped: true, reason: "Invalid user id" };
  }

  const config = await enabledConfig();
  if (!config) {
    await writeEventLog({ userId, eventType, paymentReference, status: "event_skipped", reason: "Subscription Cancellation Reminder is disabled or missing" });
    return { skipped: true, reason: "Payment Cancelled Auto Notification is disabled" };
  }

  const activeKey = `payment-cancelled-auto:${userId}:${paymentReference}`;
  const stages = (config.reminders || []).filter((stage) => stage.enabled !== false);
  if (!stages.length) {
    await writeEventLog({ userId, configId: String(config._id), eventType, paymentReference, status: "event_skipped", reason: "No enabled reminder stages" });
    return { skipped: true, reason: "No enabled reminder stages" };
  }
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
    status: "event_received",
    reason: "Payment cancellation event received from app",
    scheduledCount: jobs.length,
    scheduledJobs: jobs.map((job) => ({
      stageId: job.stageId,
      stageName: job.stageName,
      dueAt: job.dueAt,
      dedupeKey: job.dedupeKey,
    })),
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
    await writeEventLog({ userId, configId: String(config._id), eventType, paymentReference, status: "event_duplicate", reason: "Duplicate reminder jobs already exist", activeKey });
    logger.warn({ userId, activeKey }, "[PAYMENT_CANCELLED_AUTO_DUPLICATE_JOB_SKIPPED]");
  }

  return { skipped: false, activeKey, scheduledCount: jobs.length };
}

export async function logPaymentCancelledAutoCheckoutStarted(userId: string, body: any) {
  const eventTime = body?.eventTime ? new Date(body.eventTime) : new Date();
  const paymentReference = clean(body?.paymentReference || body?.orderId || body?.razorpayOrderId || body?.subscriptionId || body?.paymentId || eventTime.getTime());
  await writeEventLog({
    userId,
    eventType: "checkout_started",
    paymentReference,
    status: "checkout_started",
    reason: "Subscription checkout/order created; waiting for payment success or cancellation event",
    planName: clean(body?.planName || body?.subscriptionPlan || "Premium"),
    planId: clean(body?.planId || body?.subscriptionId || ""),
  });
}

export async function completePaymentCancelledAutoNotifications(userId: string) {
  await collection(JOB_COLLECTION).updateMany(
    { userId: String(userId), status: "pending" },
    { $set: { status: "cancelled", paymentCompleted: true, stoppedReason: "Payment completed", updatedAt: new Date() } },
  );
}
