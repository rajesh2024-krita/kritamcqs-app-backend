import mongoose, { Schema, Document } from "mongoose";

export interface IAppUsageSettings extends Document {
  key: string;
  enabled: boolean;
  automaticCleanupEnabled: boolean;
  retentionDays: number;
  sessionTimeoutMinutes: number;
}

const AppUsageSettingsSchema = new Schema<IAppUsageSettings>(
  {
    key: { type: String, default: "default", unique: true, index: true },
    enabled: { type: Boolean, default: true, index: true },
    automaticCleanupEnabled: { type: Boolean, default: false },
    retentionDays: { type: Number, default: 90, min: 7, max: 365 },
    sessionTimeoutMinutes: { type: Number, default: 30, min: 5, max: 240 },
  },
  { timestamps: true },
);

export const AppUsageSettings =
  mongoose.models["AppUsageSettings"] ?? mongoose.model<IAppUsageSettings>("AppUsageSettings", AppUsageSettingsSchema);
