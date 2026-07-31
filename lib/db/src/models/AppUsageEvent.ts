import mongoose, { Schema, Document } from "mongoose";

export interface IAppUsageEvent extends Document {
  eventId: string;
  sessionId: string;
  userId: string;
  userName?: string;
  email?: string;
  mobile?: string;
  userType?: "Free" | "Premium";
  loginMethod?: string;
  deviceId?: string;
  platform?: string;
  appVersion?: string;
  deviceBrand?: string;
  deviceModel?: string;
  osVersion?: string;
  androidVersion?: string;
  screenResolution?: string;
  networkType?: string;
  ramGb?: number;
  batteryLevel?: number;
  batteryCharging?: boolean;
  rootedDevice?: boolean;
  isVirtualDevice?: boolean;
  ipAddress?: string;
  eventType: string;
  screen?: string;
  previousScreen?: string;
  nextScreen?: string;
  componentName?: string;
  componentType?: string;
  action?: string;
  timestamp: Date;
  enterTime?: Date;
  exitTime?: Date;
  durationSeconds: number;
  coordinates?: { x?: number; y?: number };
  metadata?: Record<string, unknown>;
}

const AppUsageEventSchema = new Schema<IAppUsageEvent>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "", index: true },
    mobile: { type: String, trim: true, default: "", index: true },
    userType: { type: String, enum: ["Free", "Premium"], default: "Free", index: true },
    loginMethod: { type: String, trim: true, default: "" },
    deviceId: { type: String, trim: true, default: "", index: true },
    platform: { type: String, trim: true, lowercase: true, default: "unknown", index: true },
    appVersion: { type: String, trim: true, default: "", index: true },
    deviceBrand: { type: String, trim: true, default: "", index: true },
    deviceModel: { type: String, trim: true, default: "", index: true },
    osVersion: { type: String, trim: true, default: "" },
    androidVersion: { type: String, trim: true, default: "", index: true },
    screenResolution: { type: String, trim: true, default: "" },
    networkType: { type: String, trim: true, default: "", index: true },
    ramGb: { type: Number },
    batteryLevel: { type: Number },
    batteryCharging: { type: Boolean },
    rootedDevice: { type: Boolean, default: false },
    isVirtualDevice: { type: Boolean, default: false },
    ipAddress: { type: String, trim: true, default: "" },
    eventType: { type: String, required: true, trim: true, index: true },
    screen: { type: String, trim: true, default: "", index: true },
    previousScreen: { type: String, trim: true, default: "" },
    nextScreen: { type: String, trim: true, default: "" },
    componentName: { type: String, trim: true, default: "", index: true },
    componentType: { type: String, trim: true, default: "", index: true },
    action: { type: String, trim: true, default: "" },
    timestamp: { type: Date, required: true, index: true },
    enterTime: { type: Date },
    exitTime: { type: Date },
    durationSeconds: { type: Number, default: 0, min: 0 },
    coordinates: {
      x: { type: Number },
      y: { type: Number },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

AppUsageEventSchema.index({ userId: 1, timestamp: -1 });
AppUsageEventSchema.index({ email: 1, timestamp: -1 });
AppUsageEventSchema.index({ sessionId: 1, timestamp: 1 });
AppUsageEventSchema.index({ platform: 1, timestamp: -1 });
AppUsageEventSchema.index({ screen: 1, eventType: 1, timestamp: -1 });

export const AppUsageEvent =
  mongoose.models["AppUsageEvent"] ?? mongoose.model<IAppUsageEvent>("AppUsageEvent", AppUsageEventSchema);
