import mongoose, { Schema, Document } from "mongoose";

export interface IChapterPerformance extends Document {
  id: string;
  userId: string;
  chapterId: string;
  subjectId: string;
  topicId?: string;
  totalAttempts: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  attemptCount: number;
  accuracy: number;
  previousAccuracy: number;
  improvementPercentage: number;
  completionPercentage: number;
  masteryPercentage: number;
  isWeak: boolean;
  isMastered: boolean;
  examMode?: string;
  sourceType?: string;
  sourceName?: string;
  sourceSessionId?: string;
  completedAt?: Date;
  topicIds?: string[];
  incorrectQuestionIds?: string[];
  weakQuestionIds?: string[];
  lastTestStatus?: string;
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
    topicId: { type: String, default: "", index: true },
    totalAttempts: { type: Number, default: 0 },
    correctCount: { type: Number, default: 0 },
    wrongCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    attemptCount: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    previousAccuracy: { type: Number, default: 0 },
    improvementPercentage: { type: Number, default: 0 },
    completionPercentage: { type: Number, default: 0 },
    masteryPercentage: { type: Number, default: 0 },
    isWeak: { type: Boolean, default: false },
    isMastered: { type: Boolean, default: false, index: true },
    examMode: { type: String, trim: true, index: true },
    sourceType: { type: String, trim: true, index: true },
    sourceName: { type: String, trim: true },
    sourceSessionId: { type: String, trim: true, index: true },
    completedAt: Date,
    topicIds: { type: [String], default: [] },
    incorrectQuestionIds: { type: [String], default: [] },
    weakQuestionIds: { type: [String], default: [] },
    lastTestStatus: { type: String, default: "" },
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

ChapterPerformanceSchema.index({ userId: 1, chapterId: 1, topicId: 1 }, { unique: true });

export const ChapterPerformance =
  mongoose.models["ChapterPerformance"] ??
  mongoose.model<IChapterPerformance>("ChapterPerformance", ChapterPerformanceSchema);
