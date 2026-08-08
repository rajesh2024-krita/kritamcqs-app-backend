import mongoose, { Schema } from "mongoose";
import { InvoiceSettings, User, UserNotification } from "@api/db";
import { logger } from "../lib/logger";
import { sendEmail } from "../lib/simple-email";
import { insertUserNotifications, sendPushForUserNotifications } from "./notificationService";

const ScheduledNotification =
  mongoose.models["ScheduledNotification"]
  ?? mongoose.model("ScheduledNotification", new Schema({}, { strict: false, timestamps: true }));

const NotificationHistory =
  mongoose.models["NotificationHistory"]
  ?? mongoose.model("NotificationHistory", new Schema({}, { strict: false, timestamps: true }));

const INTERVAL_MS = Number(process.env["SCHEDULED_NOTIFICATION_WORKER_INTERVAL_MS"] || 15_000);
let timer: NodeJS.Timeout | null = null;
let running = false;

function selectedUserValues(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function deliveryChannelsForNotification(item: Record<string, any>) {
  const explicit = Array.isArray(item["deliveryChannels"])
    ? item["deliveryChannels"].map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
  if (explicit.length) return [...new Set(explicit.filter((value: string) => ["in_app", "push", "email"].includes(value)))];

  const type = String(item["deliveryType"] || "notification");
  if (type === "email") return ["email"];
  if (type === "both" || type === "all") return ["in_app", "push", "email"];
  if (type === "in_app") return ["in_app"];
  if (type === "push") return ["push"];
  if (type === "in_app_push" || type === "notification") return ["in_app", "push"];
  if (type === "in_app_email") return ["in_app", "email"];
  if (type === "push_email" || type === "email_push") return ["push", "email"];
  return ["in_app", "push"];
}

function deliveryTypeForChannels(channels: string[]) {
  const values = new Set(channels);
  if (values.has("in_app") && values.has("push") && values.has("email")) return "all";
  if (values.has("in_app") && values.has("push")) return "in_app_push";
  if (values.has("in_app") && values.has("email")) return "in_app_email";
  if (values.has("push") && values.has("email")) return "push_email";
  if (values.has("email")) return "email";
  if (values.has("push")) return "push";
  return "in_app";
}

function normalizeAutomationDays(days: unknown) {
  const source = Array.isArray(days) ? days : [];
  return [...new Set(source.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((left, right) => left - right);
}

const ASIA_KOLKATA_OFFSET_MS = 330 * 60 * 1000;

function parseScheduleTime(scheduleTime: unknown) {
  const [hours, minutes] = String(scheduleTime || "00:00").split(":").map(Number);
  return {
    hours: Math.max(0, Math.min(23, Number(hours || 0))),
    minutes: Math.max(0, Math.min(59, Number(minutes || 0))),
  };
}

function asiaKolkataParts(date = new Date()) {
  const shifted = new Date(date.getTime() + ASIA_KOLKATA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    day: shifted.getUTCDay(),
  };
}

function dateFromAsiaKolkataParts(year: number, month: number, date: number, scheduleTime: unknown) {
  const { hours, minutes } = parseScheduleTime(scheduleTime);
  return new Date(Date.UTC(year, month, date, hours, minutes, 0, 0) - ASIA_KOLKATA_OFFSET_MS);
}

function nextWeeklyDate(item: Record<string, any>, from = new Date()) {
  const days = normalizeAutomationDays(item["weeklyDays"]);
  if (!days.length) return null;
  const parts = asiaKolkataParts(from);
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = dateFromAsiaKolkataParts(parts.year, parts.month, parts.date + offset, item["scheduleTime"]);
    if (days.includes(asiaKolkataParts(candidate).day) && candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

function nextMonthlyDate(item: Record<string, any>, from = new Date()) {
  const day = Math.max(1, Math.min(31, Number(item["monthlyDay"] || 1)));
  const parts = asiaKolkataParts(from);
  for (let offset = 0; offset <= 14; offset += 1) {
    const monthStart = new Date(Date.UTC(parts.year, parts.month + offset, 1));
    const year = monthStart.getUTCFullYear();
    const month = monthStart.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (day > lastDay) continue;
    const candidate = dateFromAsiaKolkataParts(year, month, day, item["scheduleTime"]);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

function nextScheduleDate(item: Record<string, any>, from = new Date()) {
  if (item["scheduleType"] === "weekly") return nextWeeklyDate(item, from);
  if (item["scheduleType"] === "monthly") return nextMonthlyDate(item, from);
  return null;
}

function executionKey(item: Record<string, any>, scheduledFor: Date) {
  return `scheduled-notification:${String(item["_id"] || item["id"])}:${scheduledFor.toISOString()}`;
}

async function claimExecution(item: Record<string, any>, scheduledFor: Date) {
  const key = executionKey(item, scheduledFor);
  if (item["logsEnabled"] === false) {
    const result = await ScheduledNotification.updateOne(
      { _id: item["_id"], executionKeys: { $ne: key } },
      { $addToSet: { executionKeys: key } },
    );
    return { claimed: Boolean(result.modifiedCount), key };
  }

  const result = await NotificationHistory.updateOne(
    { executionKey: key },
    {
      $setOnInsert: {
        campaignName: item["campaignName"] || item["title"] || item["emailSubject"] || "Automated Notification",
        notificationType: item["notificationType"] || "standard",
        deliveryType: item["deliveryType"] || "notification",
        deliveryChannels: deliveryChannelsForNotification(item),
        targetType: item["targetType"] || "all",
        selectedUsers: selectedUserValues(item["selectedUsers"]),
        status: "scheduled",
        scheduledFor,
        executionKey: key,
        scheduledNotificationId: item["_id"],
        createdBy: item["createdBy"] || "app-backend-scheduler",
        createdByName: item["createdByName"] || "App Backend Scheduler",
      },
    },
    { upsert: true },
  );
  return { claimed: Boolean(result.upsertedCount), key };
}

async function usersForAudience(targetType: unknown, selectedUsers: unknown) {
  const target = String(targetType || "all");
  const base = { isAdmin: { $ne: true } };
  if (target === "all") return User.find(base).lean();
  if (target === "free" || target === "non_premium") return User.find({ ...base, isPremium: { $ne: true } }).lean();
  if (target === "premium") return User.find({ ...base, isPremium: true }).lean();
  if (target === "neet") return User.find({ ...base, examMode: { $in: ["NEET", "BOTH"] } }).lean();
  if (target === "jee") return User.find({ ...base, examMode: { $in: ["JEE", "BOTH"] } }).lean();
  if (target === "active") return User.find({ ...base, isActive: { $ne: false }, isBlocked: { $ne: true } }).lean();
  if (target === "inactive") return User.find({ ...base, $or: [{ isActive: false }, { isBlocked: true }] }).lean();
  if (target === "payment_pending") return User.find({ ...base, isPremium: { $ne: true }, "lastPurchase.paymentStatus": { $nin: ["success", "paid", "PAID"] } }).lean();
  if (target !== "selected") return User.find(base).lean();

  const values = selectedUserValues(selectedUsers);
  if (!values.length) return [];
  const objectIds = values.filter((value) => mongoose.isValidObjectId(value));
  const emails = values.filter((value) => value.includes("@")).map((value) => value.toLowerCase());
  const mobiles = values.filter((value) => !value.includes("@") && !mongoose.isValidObjectId(value)).map((value) => value.replace(/\D/g, "")).filter(Boolean);
  return User.find({
    ...base,
    $or: [
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
      ...(emails.length ? [{ email: { $in: emails } }] : []),
      ...(mobiles.length ? [{ mobile: { $in: mobiles } }] : []),
    ],
  }).lean();
}

function render(template: unknown, values: Record<string, unknown>) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => String(values[key] ?? ""));
}

async function sendAutomationEmails(item: Record<string, any>, users: any[]) {
  const result = { emailSentCount: 0, emailFailedCount: 0, emailSkippedCount: 0, logs: [] as Record<string, unknown>[] };
  const settings = await InvoiceSettings.findOne({ key: "default" }).lean();
  for (const user of users) {
    if (!user.email) {
      result.emailSkippedCount += 1;
      result.logs.push({ userId: String(user._id), channel: "email", status: "skipped", error: "User email missing" });
      continue;
    }
    const values = {
      user_name: user.name || user.email || user.mobile || "Learner",
      email: user.email || "",
      mobile: user.mobile || "",
      notification_title: item["title"] || item["emailSubject"] || "",
      notification_message: item["message"] || "",
      current_date: new Date().toLocaleDateString("en-IN"),
      current_time: new Date().toLocaleTimeString("en-IN"),
    };
    try {
      const sent = await sendEmail({
        smtp: settings?.["smtp"] || {},
        to: user.email,
        subject: render(item["emailSubject"] || item["title"], values),
        html: render(item["emailBody"] || item["message"], values),
      });
      if (sent.skipped) {
        result.emailSkippedCount += 1;
        result.logs.push({ userId: String(user._id), channel: "email", status: "skipped", error: sent.reason || "Email skipped" });
      } else {
        result.emailSentCount += 1;
        result.logs.push({ userId: String(user._id), channel: "email", status: "sent" });
      }
    } catch (error) {
      result.emailFailedCount += 1;
      result.logs.push({ userId: String(user._id), channel: "email", status: "failed", error: error instanceof Error ? error.message : "Email failed" });
    }
  }
  return result;
}

async function processAutomation(item: Record<string, any>) {
  const scheduledFor = new Date(item["nextScheduledAt"] || item["nextSendAt"] || item["scheduleDate"]);
  if (Number.isNaN(scheduledFor.getTime())) return null;

  const claim = await claimExecution(item, scheduledFor);
  if (!claim.claimed) return { id: String(item["_id"]), status: "duplicate_skipped" };

  const channels = deliveryChannelsForNotification(item);
  const shouldInApp = channels.includes("in_app");
  const shouldPush = channels.includes("push");
  const shouldEmail = channels.includes("email");
  const users = await usersForAudience(item["targetType"], item["selectedUsers"]);
  const deliveryMode = deliveryTypeForChannels(channels);
  const docs = users.map((user: any) => ({
    userId: String(user._id),
    type: item["category"] || "custom",
    title: item["title"] || item["campaignName"] || "Notification",
    body: item["message"] || "",
    pushTitle: item["title"] || item["campaignName"] || "Notification",
    pushBody: item["message"] || "",
    dedupeKey: `${claim.key}:${String(user._id)}`,
    visibleInApp: shouldInApp,
    linkUrl: item["deepLink"] || "/notifications",
    imageUrl: item["image"] || "",
    targetGroup: item["targetType"] || "all",
    deliveryMode,
    notificationStatus: shouldInApp ? "created" : "not_requested",
    pushStatus: shouldPush ? "pending" : "not_requested",
    pushError: "",
    emailTemplateKey: shouldEmail ? String(item["emailTemplateKey"] || "") : "",
    ctaConfigId: item["ctaConfigId"] || "",
    ctaText: item["ctaText"] || "",
    senderId: item["createdBy"] || "app-backend-scheduler",
    senderName: item["createdByName"] || "Automated Notification",
    sentAt: new Date(),
  }));

  const inserted = await insertUserNotifications(docs, { autoPush: false });
  const pushDocs = shouldPush ? inserted.notifications.filter((notification: any) => notification.pushStatus === "pending") : [];
  const pushDelivery = shouldPush ? await sendPushForUserNotifications(pushDocs) : { sentCount: 0, successCount: 0, failedCount: 0, noTokenCount: 0, skippedCount: 0 };
  const emailDelivery = shouldEmail ? await sendAutomationEmails(item, users) : { emailSentCount: 0, emailFailedCount: 0, emailSkippedCount: 0, logs: [] as Record<string, unknown>[] };

  const failed = Number(pushDelivery.failedCount || 0) + Number(emailDelivery.emailFailedCount || 0);
  const success = Number(pushDelivery.successCount || 0) + Number(emailDelivery.emailSentCount || 0) + (shouldInApp ? inserted.notifications.length : 0);
  const status = failed > 0 && success > 0 ? "partial" : failed > 0 && success === 0 ? "failed" : "sent";
  const next = nextScheduleDate(item, new Date(scheduledFor.getTime() + 1000));

  await ScheduledNotification.updateOne(
    { _id: item["_id"] },
    {
      $set: {
        status: next ? "pending" : status,
        scheduleDate: next,
        nextScheduledAt: next,
        nextSendAt: next,
        sentAt: new Date(),
        lastSentAt: new Date(),
        audienceCount: users.length,
        lastError: status === "failed" ? "Scheduled automation delivery failed" : "",
      },
    },
  );

  if (item["logsEnabled"] !== false) {
    await NotificationHistory.updateOne(
      { executionKey: claim.key },
      {
        $set: {
          campaignName: item["campaignName"] || item["title"] || item["emailSubject"] || "Automated Notification",
          notificationType: item["notificationType"] || "standard",
          deliveryType: item["deliveryType"] || deliveryMode,
          deliveryChannels: channels,
          title: item["title"] || "",
          message: item["message"] || "",
          image: item["image"] || "",
          deepLink: item["deepLink"] || "/notifications",
          ctaConfigId: item["ctaConfigId"] || "",
          ctaText: item["ctaText"] || "",
          targetScreen: item["targetScreen"] || "",
          emailTemplateId: item["emailTemplateId"] || "",
          emailTemplateKey: item["emailTemplateKey"] || "",
          emailSubject: item["emailSubject"] || "",
          emailBody: item["emailBody"] || "",
          targetType: item["targetType"] || "all",
          selectedUsers: selectedUserValues(item["selectedUsers"]),
          category: item["category"] || "custom",
          sound: item["sound"] || "default",
          priority: item["priority"] || "high",
          sentCount: pushDelivery.sentCount || 0,
          successCount: pushDelivery.successCount || 0,
          failedCount: pushDelivery.failedCount || 0,
          noTokenCount: pushDelivery.noTokenCount || 0,
          emailSentCount: emailDelivery.emailSentCount || 0,
          emailFailedCount: emailDelivery.emailFailedCount || 0,
          emailSkippedCount: emailDelivery.emailSkippedCount || 0,
          logs: [...(emailDelivery.logs || [])],
          status,
          sentAt: new Date(),
          executedAt: new Date(),
          scheduledFor,
          scheduledNotificationId: item["_id"],
        },
      },
    );
  }

  return { id: String(item["_id"]), status, audienceCount: users.length, nextScheduledAt: next, nextSendAt: next };
}

export async function processDueScheduledNotifications(limit = 25) {
  const now = new Date();
  const items = await ScheduledNotification.find({
    automationEnabled: true,
    status: "pending",
    scheduleType: { $in: ["weekly", "monthly"] },
    $or: [{ nextScheduledAt: { $lte: now } }, { nextSendAt: { $lte: now } }, { scheduleDate: { $lte: now } }],
  }).sort({ nextScheduledAt: 1, nextSendAt: 1, scheduleDate: 1 }).limit(limit).lean();

  const results = [];
  for (const item of items) {
    try {
      const result = await processAutomation(item as Record<string, any>);
      if (result) results.push(result);
    } catch (error) {
      logger.error({ err: error, scheduledNotificationId: String((item as any)._id || "") }, "Scheduled notification automation failed");
    }
  }
  return results;
}

export function startScheduledNotificationWorker() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await processDueScheduledNotifications();
      if (results.length) logger.info({ results }, "Processed scheduled notification automations");
    } catch (error) {
      logger.error({ err: error }, "Scheduled notification worker tick failed");
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), INTERVAL_MS);
  void tick();
}
