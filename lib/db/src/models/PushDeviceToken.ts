import mongoose, { Schema, Document } from "mongoose";

export interface IPushDeviceToken extends Document {
  id: string;
  userId: string;
  token: string;
  platform: "android" | "ios" | "web" | "unknown";
  mode?: string;
  subscriptionType?: "free" | "premium" | "unknown";
  deviceId?: string;
  appVersion?: string;
  enabled: boolean;
  active: boolean;
  lastSeenAt: Date;
  lastUpdated: Date;
}

const PushDeviceTokenSchema = new Schema<IPushDeviceToken>(
  {
    userId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ["android", "ios", "web", "unknown"], default: "unknown", index: true },
    mode: { type: String, trim: true, default: "", index: true },
    subscriptionType: { type: String, enum: ["free", "premium", "unknown"], default: "unknown", index: true },
    deviceId: { type: String, default: "" },
    appVersion: { type: String, default: "" },
    enabled: { type: Boolean, default: true, index: true },
    active: { type: Boolean, default: true, index: true },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    lastUpdated: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

PushDeviceTokenSchema.index({ userId: 1, platform: 1 });

export const PushDeviceToken =
  mongoose.models["PushDeviceToken"] ?? mongoose.model<IPushDeviceToken>("PushDeviceToken", PushDeviceTokenSchema);
