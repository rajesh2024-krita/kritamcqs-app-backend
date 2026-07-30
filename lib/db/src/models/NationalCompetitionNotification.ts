import mongoose, { Schema, Document } from "mongoose";

export interface INationalCompetitionNotification extends Document {
  id: string;
  competitionId: string;
  channel: "push" | "email" | "in_app";
  audience: "registered" | "eligible" | "all" | "winners";
  eventKey: string;
  title: string;
  message: string;
  scheduledAt?: Date;
  sentAt?: Date;
  status: "draft" | "scheduled" | "sent" | "failed";
  createdAt: Date;
  updatedAt: Date;
}

const NationalCompetitionNotificationSchema = new Schema<INationalCompetitionNotification>(
  {
    competitionId: { type: String, required: true, index: true },
    channel: { type: String, enum: ["push", "email", "in_app"], default: "in_app", index: true },
    audience: { type: String, enum: ["registered", "eligible", "all", "winners"], default: "registered" },
    eventKey: { type: String, required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    scheduledAt: { type: Date },
    sentAt: { type: Date },
    status: { type: String, enum: ["draft", "scheduled", "sent", "failed"], default: "draft", index: true },
  },
  {
    timestamps: true,
    collection: "NationalCompetitionNotifications",
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

export const NationalCompetitionNotification =
  mongoose.models["NationalCompetitionNotification"] ??
  mongoose.model<INationalCompetitionNotification>("NationalCompetitionNotification", NationalCompetitionNotificationSchema);
