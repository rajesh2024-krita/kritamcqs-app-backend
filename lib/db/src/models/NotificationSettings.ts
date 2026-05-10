import mongoose, { Schema, Document } from "mongoose";

export interface INotificationSettings extends Document {
  key: string;
  enabled: boolean;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  reminders: Array<{ daysBefore: number; enabled: boolean; title: string; body: string; emailSubject: string; emailBody: string }>;
  createdAt: Date;
  updatedAt: Date;
}

const reminderSchema = new Schema(
  {
    daysBefore: { type: Number, required: true },
    enabled: { type: Boolean, default: true },
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    emailSubject: { type: String, default: "" },
    emailBody: { type: String, default: "" },
  },
  { _id: false },
);

const notificationSettingsSchema = new Schema<INotificationSettings>(
  {
    key: { type: String, default: "subscription-expiry", unique: true, index: true },
    enabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: true },
    inAppEnabled: { type: Boolean, default: true },
    reminders: { type: [reminderSchema], default: [] },
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

export const NotificationSettings =
  mongoose.models["NotificationSettings"] ?? mongoose.model<INotificationSettings>("NotificationSettings", notificationSettingsSchema);
