import mongoose, { Schema, Document } from "mongoose";

export const appNotificationAudienceValues = [
  "all",
  "premium",
  "nonPremium",
  "newRegistered",
  "active",
] as const;

export const appNotificationActionValues = [
  "dailyTest",
  "weakAreas",
  "subscription",
  "notifications",
  "custom",
] as const;

export const appNotificationDeliveryModeValues = ["app", "email", "both"] as const;

export type AppNotificationAudience = (typeof appNotificationAudienceValues)[number];
export type AppNotificationAction = (typeof appNotificationActionValues)[number];
export type AppNotificationDeliveryMode = (typeof appNotificationDeliveryModeValues)[number];

export interface IAppNotificationSchedule {
  enabled: boolean;
  time: string;
}

export interface IAppNotificationReminder {
  enabled: boolean;
  title?: string;
  message?: string;
  image?: string;
  ctaAction: AppNotificationAction;
  ctaLink?: string;
  audience: AppNotificationAudience;
  deliveryMode: AppNotificationDeliveryMode;
  schedules: IAppNotificationSchedule[];
}

export interface IAppNotificationSettings extends Document {
  id: string;
  key: string;
  dailyTest: IAppNotificationReminder;
  weakAreas: IAppNotificationReminder;
  updatedById?: mongoose.Types.ObjectId;
}

const ScheduleSchema = new Schema<IAppNotificationSchedule>(
  {
    enabled: { type: Boolean, default: true },
    time: { type: String, default: "09:00" },
  },
  { _id: false },
);

const ReminderSchema = new Schema<IAppNotificationReminder>(
  {
    enabled: { type: Boolean, default: false },
    title: { type: String, default: "" },
    message: { type: String, default: "" },
    image: { type: String, default: "" },
    ctaAction: { type: String, enum: appNotificationActionValues, default: "notifications" },
    ctaLink: { type: String, default: "" },
    audience: { type: String, enum: appNotificationAudienceValues, default: "all" },
    deliveryMode: { type: String, enum: appNotificationDeliveryModeValues, default: "app" },
    schedules: { type: [ScheduleSchema], default: [] },
  },
  { _id: false },
);

const AppNotificationSettingsSchema = new Schema<IAppNotificationSettings>(
  {
    key: { type: String, default: "app-reminders", unique: true, index: true },
    dailyTest: { type: ReminderSchema, default: {} },
    weakAreas: { type: ReminderSchema, default: {} },
    updatedById: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export const AppNotificationSettings =
  mongoose.models["AppNotificationSettings"] ??
  mongoose.model<IAppNotificationSettings>("AppNotificationSettings", AppNotificationSettingsSchema);
