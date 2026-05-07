import mongoose, { Schema, Document } from "mongoose";

export interface IChapterPerformance extends Document {
  id: string;
  userId: string;
  chapterId: string;
  subjectId: string;
  totalAttempts: number;
  correctCount: number;
  wrongCount: number;
  accuracy: number;
  isWeak: boolean;
  averageTimeSpent: number;
  strength: "strong" | "medium" | "weak" | "untested";
  lastPracticed?: Date;
  updatedAt: Date;
}

const ChapterPerformanceSchema = new Schema<IChapterPerformance>(
  {
    userId: { type: String, required: true },
    chapterId: { type: String, required: true },
    subjectId: { type: String, required: true },
    totalAttempts: { type: Number, default: 0 },
    correctCount: { type: Number, default: 0 },
    wrongCount: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    isWeak: { type: Boolean, default: false },
    averageTimeSpent: { type: Number, default: 0 },
    strength: { type: String, enum: ["strong", "medium", "weak", "untested"], default: "untested" },
    lastPracticed: Date,
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
  }
);

ChapterPerformanceSchema.index({ userId: 1, chapterId: 1 }, { unique: true });

export const ChapterPerformance =
  mongoose.models["ChapterPerformance"] ??
  mongoose.model<IChapterPerformance>("ChapterPerformance", ChapterPerformanceSchema);
