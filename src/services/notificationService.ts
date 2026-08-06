import mongoose from "mongoose";
import { PushDeviceToken, User, UserNotification } from "@api/db";
import { logger } from "../lib/logger";
import { isPushConfigured, sendPushToTokens } from "../lib/pushNotificationSender";

type NotificationPayload = {
  title: string;
  body: string;
  image?: string;
  imageUrl?: string;
  deepLink?: string;
  linkUrl?: string;
  category?: string;
  priority?: "high" | "low" | string;
  sound?: string;
  data?: Record<string, unknown>;
};

type RegisterTokenInput = {
  userId: string;
  token: string;
  platform?: "android" | "ios" | "web" | "unknown";
  deviceId?: string;
  appVersion?: string;
};

function normalizeData(data?: Record<string, unknown>) {
  return Object.entries(data ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value === undefined || value === null) return acc;
    acc[key] = typeof value === "string" ? value : JSON.stringify(value);
    return acc;
  }, {});
}

async function activeTokensForUsers(userIds: string[]) {
  if (!userIds.length) return [];
  const uniqueUserIds = [...new Set(userIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const objectIds = uniqueUserIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const tokens = await PushDeviceToken.find({
    $or: [
      { userId: { $in: uniqueUserIds } },
      ...(objectIds.length ? [{ userId: { $in: objectIds } }] : []),
    ],
    enabled: true,
    active: { $ne: false },
  }).select("token");
  return [...new Set(tokens.map((item: any) => String(item.token)).filter(Boolean))];
}

export async function registerToken(input: RegisterTokenInput) {
  const now = new Date();
  const user = await User.findById(input.userId).select("examMode isPremium").lean();
  const token = await PushDeviceToken.findOneAndUpdate(
    { token: input.token },
    {
      $set: {
        userId: input.userId,
        platform: input.platform ?? "unknown",
        mode: String((user as any)?.examMode || "").toLowerCase(),
        subscriptionType: (user as any)?.isPremium ? "premium" : "free",
        deviceId: input.deviceId ?? "",
        appVersion: input.appVersion ?? "",
        enabled: true,
        active: true,
        lastSeenAt: now,
        lastUpdated: now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await User.findByIdAndUpdate(input.userId, {
    $addToSet: { fcmTokens: input.token },
    $set: { fcmTokenLastUpdated: now },
  });

  return token;
}

export async function removeToken(userId: string, token: string) {
  await Promise.all([
    PushDeviceToken.updateOne({ userId, token }, { $set: { enabled: false, lastUpdated: new Date() } }),
    User.findByIdAndUpdate(userId, { $pull: { fcmTokens: token }, $set: { fcmTokenLastUpdated: new Date() } }),
  ]);
}

export async function removeInvalidTokens(tokens: string[]) {
  const uniqueTokens = [...new Set(tokens.filter(Boolean))];
  if (!uniqueTokens.length) return 0;

  const affectedUsers = await PushDeviceToken.find({ token: { $in: uniqueTokens } }).select("userId").lean();
  await PushDeviceToken.updateMany(
    { token: { $in: uniqueTokens } },
    { $set: { enabled: false, lastUpdated: new Date() } },
  );
  await User.updateMany(
    { fcmTokens: { $in: uniqueTokens } },
    { $pull: { fcmTokens: { $in: uniqueTokens } }, $set: { fcmTokenLastUpdated: new Date() } },
  );

  logger.warn({ tokenCount: uniqueTokens.length, userCount: affectedUsers.length }, "Removed invalid FCM tokens");
  return uniqueTokens.length;
}

async function sendToTokens(tokens: string[], payload: NotificationPayload) {
  const uniqueTokens = [...new Set(tokens.filter(Boolean))];
  const result = { successCount: 0, failureCount: 0, invalidTokens: [] as string[], errors: [] as string[] };
  if (!uniqueTokens.length) return result;

  if (!isPushConfigured()) {
    const error = "Firebase service account is not configured";
    logger.error({ tokenCount: uniqueTokens.length, title: payload.title }, "[FCM CONFIG MISSING]");
    result.failureCount = uniqueTokens.length;
    result.errors.push(error);
    return result;
  }

  const delivery = await sendPushToTokens(uniqueTokens, {
    title: payload.title,
    body: payload.body,
    image: payload.image || payload.imageUrl,
    deepLink: payload.deepLink || payload.linkUrl || String(payload.data?.["deepLink"] || payload.data?.["linkUrl"] || "/notifications"),
    linkUrl: payload.linkUrl || payload.deepLink || String(payload.data?.["linkUrl"] || payload.data?.["deepLink"] || "/notifications"),
    category: payload.category || String(payload.data?.["notificationType"] || "custom"),
    sound: payload.sound || "default",
    priority: payload.priority || "high",
    data: normalizeData(payload.data),
  });
  result.successCount = delivery.successCount || 0;
  result.failureCount = delivery.failedCount || 0;
  result.invalidTokens = delivery.invalidTokens || [];
  result.errors = delivery.errors || [];

  if (result.invalidTokens.length) await removeInvalidTokens(result.invalidTokens);

  return result;
}

export async function sendToUser(userId: string, payload: NotificationPayload) {
  const tokens = await activeTokensForUsers([userId]);
  return sendToTokens(tokens, payload);
}

export async function sendToUsers(userIds: string[], payload: NotificationPayload) {
  const tokens = await activeTokensForUsers(userIds);
  return sendToTokens(tokens, payload);
}

export async function broadcast(payload: NotificationPayload) {
  const users = await User.find({ isActive: { $ne: false }, isBlocked: { $ne: true } }).select("_id").lean();
  return sendToUsers(users.map((user: any) => String(user._id)), payload);
}

function payloadFromNotification(notification: any): NotificationPayload {
  return {
    title: String(notification.title || ""),
    body: String(notification.body || ""),
    image: String(notification.imageUrl || ""),
    deepLink: String(notification.linkUrl || "/notifications"),
    linkUrl: String(notification.linkUrl || "/notifications"),
    category: String(notification.type || "custom"),
    priority: "high",
    data: {
      notificationId: String(notification._id || notification.id || ""),
      notificationType: String(notification.type || ""),
      deepLink: String(notification.linkUrl || "/notifications"),
      linkUrl: String(notification.linkUrl || "/notifications"),
      ctaText: String(notification.ctaText || ""),
      ctaConfigId: String(notification.ctaConfigId || ""),
      imageUrl: String(notification.imageUrl || ""),
    },
  };
}

export async function sendPushForUserNotifications(notifications: any[]) {
  const visibleNotifications = notifications.filter((item) => item && (item.visibleInApp !== false || item.pushStatus === "pending"));
  const result = {
    sentCount: 0,
    successCount: 0,
    failedCount: 0,
    noTokenCount: 0,
    skippedCount: notifications.length - visibleNotifications.length,
  };

  for (const notification of visibleNotifications) {
    logger.info({
      notificationId: String(notification._id || notification.id || ""),
      userId: String(notification.userId || ""),
      type: notification.type,
      title: notification.title,
    }, "[NOTIFICATION SAVED]");
    try {
      const tokens = await activeTokensForUsers([String(notification.userId)]);
      logger.info({
        notificationId: String(notification._id || notification.id || ""),
        userId: String(notification.userId || ""),
        tokenCount: tokens.length,
      }, "[FCM TOKEN FOUND]");
      logger.info({
        notificationId: String(notification._id || notification.id || ""),
        userId: String(notification.userId || ""),
        payload: payloadFromNotification(notification),
      }, "[FCM PAYLOAD READY]");
      const delivery = await sendToTokens(tokens, payloadFromNotification(notification));
      const attempted = delivery.successCount + delivery.failureCount;
      result.sentCount += attempted;
      result.successCount += delivery.successCount;
      result.failedCount += delivery.failureCount;
      if (!attempted) result.noTokenCount += 1;

      const pushStatus = delivery.successCount > 0 ? "sent" : attempted ? "failed" : "no_token";
      logger.info({
        notificationId: String(notification._id || notification.id || ""),
        userId: String(notification.userId || ""),
        successCount: delivery.successCount,
        failedCount: delivery.failureCount,
        errors: delivery.errors || [],
        pushStatus,
      }, pushStatus === "sent" ? "[FCM SENT SUCCESS]" : "[FCM SENT FAILED]");
      await UserNotification.updateOne(
        { _id: notification._id },
        {
          $set: {
            pushStatus,
            pushError: pushStatus === "failed" ? (delivery.errors?.[0] || "Push delivery failed") : "",
            sentAt: notification.sentAt || new Date(),
          },
        },
      );
    } catch (error) {
      result.failedCount += 1;
      logger.error({
        notificationId: String(notification._id || notification.id || ""),
        userId: String(notification.userId || ""),
        err: error,
      }, "[FCM SENT FAILED]");
      await UserNotification.updateOne(
        { _id: notification._id },
        {
          $set: {
            pushStatus: "failed",
            pushError: error instanceof Error ? error.message : "Push delivery failed",
            sentAt: notification.sentAt || new Date(),
          },
        },
      );
    }
  }

  return result;
}

export async function createUserNotification(doc: Record<string, any>, options: { autoPush?: boolean } = {}) {
  logger.info({ userId: doc["userId"], type: doc["type"], title: doc["title"] }, "[NOTIFICATION CREATED]");
  const notification = await UserNotification.create(doc);
  if (options.autoPush !== false) {
    await sendPushForUserNotifications([notification]);
  }
  return notification;
}

export async function insertUserNotifications(docs: Record<string, any>[], options: { autoPush?: boolean; insertOptions?: Record<string, any> } = {}) {
  logger.info({ count: docs.length, type: docs[0]?.["type"] || "" }, "[NOTIFICATION CREATED]");
  let notifications: any[] = [];
  if (docs.length) {
    try {
      notifications = await UserNotification.insertMany(docs, { ordered: false, ...(options.insertOptions || {}) });
    } catch (error: any) {
      const writeErrors = error?.writeErrors || error?.result?.result?.writeErrors || [];
      const duplicateOnly = error?.code === 11000
        || (Array.isArray(writeErrors) && writeErrors.length > 0 && writeErrors.every((item: any) => item?.code === 11000));
      if (!duplicateOnly) throw error;

      const insertedDocs = Array.isArray(error?.insertedDocs) ? error.insertedDocs.filter(Boolean) : [];
      const insertedIds = Object.values(error?.result?.insertedIds || error?.insertedIds || {}).filter(Boolean);
      notifications = insertedDocs.length
        ? insertedDocs
        : insertedIds.length
          ? await UserNotification.find({ _id: { $in: insertedIds } })
          : [];
      logger.warn({
        requestedCount: docs.length,
        insertedCount: notifications.length,
        skippedDuplicates: docs.length - notifications.length,
      }, "[NOTIFICATION SAVED]");
    }
  }
  const pushDelivery = options.autoPush === false ? null : await sendPushForUserNotifications(notifications);
  return { notifications, pushDelivery };
}

export async function upsertUserNotificationOnInsert(
  filter: Record<string, any>,
  insertDoc: Record<string, any>,
  options: { autoPush?: boolean; updateOptions?: Record<string, any> } = {},
) {
  logger.info({ userId: insertDoc["userId"], type: insertDoc["type"], title: insertDoc["title"] }, "[NOTIFICATION CREATED]");
  const result = await UserNotification.updateOne(
    filter,
    { $setOnInsert: insertDoc },
    { upsert: true, ...(options.updateOptions || {}) },
  );
  if (!result.upsertedCount) return { created: false, notification: null, result, pushDelivery: null };

  const notification = await UserNotification.findOne(filter);
  const pushDelivery = options.autoPush === false || !notification ? null : await sendPushForUserNotifications([notification]);
  return { created: true, notification, result, pushDelivery };
}

export async function createAndSend(input: {
  title: string;
  body?: string;
  message?: string;
  userIds: string[];
  type?: string;
  image?: string;
  imageUrl?: string;
  linkUrl?: string;
  deepLink?: string;
  targetGroup?: string;
  deliveryMode?: string;
  senderId?: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
}) {
  const uniqueUserIds = [...new Set((input.userIds || []).map((id) => String(id || "")).filter(Boolean))];
  const now = Date.now();
  const docs = uniqueUserIds.map((userId) => ({
    userId,
    type: input.type || "custom",
    title: input.title,
    body: input.body || input.message || "",
    dedupeKey: `notification:${now}:${userId}`,
    visibleInApp: true,
    linkUrl: input.linkUrl || input.deepLink || "/notifications",
    imageUrl: input.imageUrl || input.image || "",
    targetGroup: input.targetGroup || "",
    deliveryMode: input.deliveryMode || "notification",
    notificationStatus: "created",
    pushStatus: "pending",
    senderId: input.senderId || "",
    senderName: input.senderName || "System",
    sentAt: new Date(),
  }));
  return insertUserNotifications(docs, { autoPush: true });
}
