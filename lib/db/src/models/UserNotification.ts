import mongoose, { Schema, Document } from "mongoose";

export interface IUserNotification extends Document {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  dedupeKey: string;
  visibleInApp: boolean;
  linkUrl?: string;
  imageUrl?: string;
  attachmentUrl?: string;
  attachmentName?: string;
  targetGroup?: string;
  deliveryMode?: string;
  notificationStatus?: string;
  senderId?: string;
  senderName?: string;
  emailStatus?: string;
  emailError?: string;
  pushStatus?: string;
  pushError?: string;
  emailTemplateKey?: string;
  sentAt?: Date;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userNotificationSchema = new Schema<IUserNotification>(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    dedupeKey: { type: String, required: true, unique: true, index: true },
    visibleInApp: { type: Boolean, default: true, index: true },
    linkUrl: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    attachmentUrl: { type: String, default: "" },
    attachmentName: { type: String, default: "" },
    targetGroup: { type: String, default: "", index: true },
    deliveryMode: { type: String, default: "notification" },
    notificationStatus: { type: String, default: "pending", index: true },
    senderId: { type: String, default: "" },
    senderName: { type: String, default: "" },
    emailStatus: { type: String, default: "" },
    emailError: { type: String, default: "" },
    pushStatus: { type: String, default: "" },
    pushError: { type: String, default: "" },
    emailTemplateKey: { type: String, default: "", index: true },
    sentAt: Date,
    readAt: Date,
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

export const UserNotification =
  mongoose.models["UserNotification"] ?? mongoose.model<IUserNotification>("UserNotification", userNotificationSchema);
