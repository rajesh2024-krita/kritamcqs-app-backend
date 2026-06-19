import mongoose, { Schema, Document } from "mongoose";

export interface IAppUsageSettings extends Document {
  key: string;
  enabled: boolean;
}

const AppUsageSettingsSchema = new Schema<IAppUsageSettings>(
  {
    key: { type: String, default: "default", unique: true, index: true },
    enabled: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

export const AppUsageSettings =
  mongoose.models["AppUsageSettings"] ?? mongoose.model<IAppUsageSettings>("AppUsageSettings", AppUsageSettingsSchema);
