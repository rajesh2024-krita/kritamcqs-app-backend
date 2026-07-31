import mongoose, { Schema, Document } from "mongoose";

export interface IAppUsageSession extends Document {
  sessionId: string;
  userId: string;
  userName?: string;
  email?: string;
  userType?: "Free" | "Premium";
  loginMethod?: string;
  deviceId?: string;
  platform?: string;
  appVersion?: string;
  deviceModel?: string;
  osVersion?: string;
  startedAt: Date;
  endedAt?: Date;
  durationSeconds: number;
  foregroundSeconds: number;
  backgroundSeconds: number;
  entryScreen?: string;
  exitScreen?: string;
  screenViews: number;
  clicks: number;
  lastActiveAt: Date;
}

const AppUsageSessionSchema = new Schema<IAppUsageSession>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "", index: true },
    userType: { type: String, enum: ["Free", "Premium"], default: "Free", index: true },
    loginMethod: { type: String, trim: true, default: "" },
    deviceId: { type: String, trim: true, default: "", index: true },
    platform: { type: String, trim: true, lowercase: true, default: "unknown", index: true },
    appVersion: { type: String, trim: true, default: "", index: true },
    deviceModel: { type: String, trim: true, default: "", index: true },
    osVersion: { type: String, trim: true, default: "" },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, index: true },
    durationSeconds: { type: Number, default: 0, min: 0 },
    foregroundSeconds: { type: Number, default: 0, min: 0 },
    backgroundSeconds: { type: Number, default: 0, min: 0 },
    entryScreen: { type: String, trim: true, default: "", index: true },
    exitScreen: { type: String, trim: true, default: "", index: true },
    screenViews: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    lastActiveAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

AppUsageSessionSchema.index({ userId: 1, startedAt: -1 });
AppUsageSessionSchema.index({ email: 1, startedAt: -1 });
AppUsageSessionSchema.index({ platform: 1, startedAt: -1 });

export const AppUsageSession =
  mongoose.models["AppUsageSession"] ?? mongoose.model<IAppUsageSession>("AppUsageSession", AppUsageSessionSchema);
