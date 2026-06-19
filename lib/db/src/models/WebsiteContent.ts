import mongoose, { Schema, Document } from "mongoose";

export interface IWebsiteContent extends Document {
  key: string;
  content: Record<string, unknown>;
  status: "draft" | "published";
  publishedAt?: Date;
}

const WebsiteContentSchema = new Schema<IWebsiteContent>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    content: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

WebsiteContentSchema.index({ key: 1, status: 1 });

export const WebsiteContent =
  mongoose.models["WebsiteContent"] ?? mongoose.model<IWebsiteContent>("WebsiteContent", WebsiteContentSchema);
