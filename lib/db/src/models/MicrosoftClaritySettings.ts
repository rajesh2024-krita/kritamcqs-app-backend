import mongoose, { Schema, Document } from "mongoose";

export const clarityLogLevels = ["None", "Error", "Warning", "Info", "Verbose"] as const;

export interface IMicrosoftClaritySettings extends Document {
  key: string;
  enabled: boolean;
  projectId: string;
  logLevel: typeof clarityLogLevels[number];
}

const MicrosoftClaritySettingsSchema = new Schema<IMicrosoftClaritySettings>(
  {
    key: { type: String, default: "default", unique: true, index: true },
    enabled: { type: Boolean, default: false },
    projectId: { type: String, trim: true, default: "" },
    logLevel: { type: String, enum: clarityLogLevels, default: "None" },
  },
  { timestamps: true },
);

export const MicrosoftClaritySettings =
  mongoose.models["MicrosoftClaritySettings"] ??
  mongoose.model<IMicrosoftClaritySettings>("MicrosoftClaritySettings", MicrosoftClaritySettingsSchema);
