import mongoose, { Schema, Document } from "mongoose";

export const clarityStatuses = [
  "Initializing",
  "Connected",
  "Waiting for Data",
  "Uploading",
  "Recording",
  "Disabled",
  "Configuration API Failed",
  "Cordova Not Ready",
  "Device Not Ready",
  "Initialization Failed",
  "Plugin Not Loaded",
  "Plugin Missing",
  "Project ID Invalid",
  "Internet Unavailable",
  "Native Error",
  "SDK Initialization Failed",
  "Session Not Created",
  "Upload Blocked",
  "Upload Failed",
] as const;

export interface IMicrosoftClarityLog extends Document {
  deviceId?: string;
  platform?: string;
  appVersion?: string;
  projectId?: string;
  status: typeof clarityStatuses[number];
  level: "success" | "warning" | "error" | "info";
  message?: string;
  sessionId?: string;
  sdkVersion?: string;
  pluginVersion?: string;
  capacitorVersion?: string;
  sdkStatus?: string;
  errorMessage?: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
  lastHeartbeatAt?: Date;
  lastUploadAt?: Date;
}

const MicrosoftClarityLogSchema = new Schema<IMicrosoftClarityLog>(
  {
    deviceId: { type: String, trim: true, default: "", index: true },
    platform: { type: String, trim: true, default: "", index: true },
    appVersion: { type: String, trim: true, default: "", index: true },
    projectId: { type: String, trim: true, default: "", index: true },
    status: { type: String, enum: clarityStatuses, default: "Initializing", index: true },
    level: { type: String, enum: ["success", "warning", "error", "info"], default: "info", index: true },
    message: { type: String, trim: true, default: "" },
    sessionId: { type: String, trim: true, default: "", index: true },
    sdkVersion: { type: String, trim: true, default: "" },
    pluginVersion: { type: String, trim: true, default: "" },
    capacitorVersion: { type: String, trim: true, default: "" },
    sdkStatus: { type: String, trim: true, default: "" },
    errorMessage: { type: String, trim: true, default: "" },
    stack: { type: String, trim: true, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now, index: true },
    lastHeartbeatAt: { type: Date, index: true },
    lastUploadAt: { type: Date, index: true },
  },
  { timestamps: true },
);

MicrosoftClarityLogSchema.index({ status: 1, timestamp: -1 });
MicrosoftClarityLogSchema.index({ deviceId: 1, timestamp: -1 });

export const MicrosoftClarityLog =
  mongoose.models["MicrosoftClarityLog"] ??
  mongoose.model<IMicrosoftClarityLog>("MicrosoftClarityLog", MicrosoftClarityLogSchema);
