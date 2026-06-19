import mongoose, { Schema, Document } from "mongoose";

export interface IAppNavigationEvent extends Document {
  userId?: string;
  path: string;
  title?: string;
  durationSeconds: number;
  startedAt?: Date;
  endedAt?: Date;
  platform?: string;
}

const AppNavigationEventSchema = new Schema<IAppNavigationEvent>(
  {
    userId: { type: String, index: true },
    path: { type: String, required: true, trim: true, index: true },
    title: { type: String, trim: true, default: "" },
    durationSeconds: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date },
    endedAt: { type: Date },
    platform: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

AppNavigationEventSchema.index({ path: 1, createdAt: -1 });

export const AppNavigationEvent =
  mongoose.models["AppNavigationEvent"] ?? mongoose.model<IAppNavigationEvent>("AppNavigationEvent", AppNavigationEventSchema);
