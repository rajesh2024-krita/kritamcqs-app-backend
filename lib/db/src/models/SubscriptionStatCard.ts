import mongoose, { Schema, Document } from "mongoose";

export interface ISubscriptionStatCard extends Document {
  id: string;
  key: string;
  label: string;
  valueType: "number" | "text";
  valueMode: "manual" | "live";
  manualValue: number;
  manualText?: string;
  liveSource: "users" | "premiumUsers" | "subscriptions";
  suffix?: string;
  iconKey: "users" | "shield" | "zap";
  active: boolean;
  sortOrder: number;
}

const SubscriptionStatCardSchema = new Schema<ISubscriptionStatCard>(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    label: { type: String, required: true, trim: true },
    valueType: { type: String, enum: ["number", "text"], default: "number", index: true },
    valueMode: { type: String, enum: ["manual", "live"], default: "manual", index: true },
    manualValue: { type: Number, min: 0, default: 0 },
    manualText: { type: String, trim: true, default: "" },
    liveSource: { type: String, enum: ["users", "premiumUsers", "subscriptions"], default: "users" },
    suffix: { type: String, trim: true, default: "" },
    iconKey: { type: String, enum: ["users", "shield", "zap"], default: "users" },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const SubscriptionStatCard =
  mongoose.models["SubscriptionStatCard"] ??
  mongoose.model<ISubscriptionStatCard>("SubscriptionStatCard", SubscriptionStatCardSchema);
