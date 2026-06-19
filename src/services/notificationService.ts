import { PushDeviceToken, User } from "@api/db";
import { getMessaging } from "../lib/firebase";
import { logger } from "../lib/logger";

type NotificationPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

type RegisterTokenInput = {
  userId: string;
  token: string;
  platform?: "android" | "ios" | "web" | "unknown";
  deviceId?: string;
  appVersion?: string;
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument",
]);

function normalizeData(data?: Record<string, unknown>) {
  return Object.entries(data ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value === undefined || value === null) return acc;
    acc[key] = typeof value === "string" ? value : JSON.stringify(value);
    return acc;
  }, {});
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function activeTokensForUsers(userIds: string[]) {
  if (!userIds.length) return [];
  const tokens = await PushDeviceToken.find({
    userId: { $in: [...new Set(userIds)] },
    enabled: true,
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
  const result = { successCount: 0, failureCount: 0, invalidTokens: [] as string[] };
  if (!uniqueTokens.length) return result;

  const messaging = getMessaging();
  const data = normalizeData(payload.data);

  for (const tokenChunk of chunk(uniqueTokens, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: tokenChunk,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data,
      android: {
        priority: "high",
        notification: {
          channelId: "default",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
    });

    result.successCount += response.successCount;
    result.failureCount += response.failureCount;
    response.responses.forEach((sendResponse, index) => {
      const code = sendResponse.error?.code;
      if (code && INVALID_TOKEN_CODES.has(code)) {
        result.invalidTokens.push(tokenChunk[index]);
      }
    });
  }

  if (result.invalidTokens.length) {
    await removeInvalidTokens(result.invalidTokens);
  }

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
