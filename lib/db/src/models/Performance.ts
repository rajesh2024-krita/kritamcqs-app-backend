import mongoose, { Schema, Document } from "mongoose";

export interface IPerformance extends Document {
  id: string;
  userId: string;
  questionId: string;
  isCorrect: boolean;
  timeTaken: number;
  createdAt: Date;
  updatedAt: Date;
}

const PerformanceSchema = new Schema<IPerformance>(
  {
    userId: { type: String, required: true, index: true },
    questionId: { type: String, required: true, index: true },
    isCorrect: { type: Boolean, required: true },
    timeTaken: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: "Performance",
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

PerformanceSchema.index({ userId: 1, createdAt: -1 });
PerformanceSchema.index({ userId: 1, questionId: 1, createdAt: -1 });

export const Performance =
  mongoose.models["Performance"] ?? mongoose.model<IPerformance>("Performance", PerformanceSchema);

