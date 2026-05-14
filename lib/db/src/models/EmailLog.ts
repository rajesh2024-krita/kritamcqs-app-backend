import mongoose, { Schema, Document } from "mongoose";

export interface IEmailLog extends Document {
  templateKey?: string;
  templateName?: string;
  module?: string;
  to: string;
  subject: string;
  status: "pending" | "sent" | "skipped" | "failed";
  error?: string;
  attempts: number;
  lastAttemptAt?: Date;
  sentAt?: Date;
  payload: Record<string, unknown>;
  attachments: Array<{ filename: string; contentType?: string }>;
  createdAt: Date;
  updatedAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
  {
    templateKey: { type: String, default: "", index: true },
    templateName: { type: String, default: "" },
    module: { type: String, default: "", index: true },
    to: { type: String, required: true, index: true },
    subject: { type: String, required: true },
    status: { type: String, enum: ["pending", "sent", "skipped", "failed"], default: "pending", index: true },
    error: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    payload: { type: Schema.Types.Mixed, default: {} },
    attachments: { type: [Schema.Types.Mixed], default: [] },
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

export const EmailLog = mongoose.models["EmailLog"] ?? mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);
