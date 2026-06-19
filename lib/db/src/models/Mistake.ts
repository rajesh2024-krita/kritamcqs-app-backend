import mongoose, { Schema, Document } from "mongoose";

export interface IMistake extends Document {
  id: string;
  userId: string;
  questionId: string;
  status: "new" | "improving" | "weak";
  attempts: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  accuracy: number;
  previousAccuracy: number;
  improvementPercentage: number;
  completionStatus: "in_progress" | "completed";
  firstIncorrectAt?: Date;
  correctedAt?: Date;
  incorrectAttemptsBeforeCorrection?: number;
  mode?: string;
  subjectId?: string;
  chapterId?: string;
  topicId?: string;
  examType?: string;
  sourceType?: string;
  sourceName?: string;
  sourceSessionId?: string;
  sessionId?: string;
  sessionAttemptId?: string;
  category?: string;
  difficulty?: string;
  selectedOption?: string;
  selectedOptions?: string[];
  numericAnswer?: string;
  lastAttemptDate: Date;
  createdAt: Date;
}

const MistakeSchema = new Schema<IMistake>(
  {
    userId: { type: String, required: true },
    questionId: { type: String, required: true },
    status: { type: String, enum: ["new", "improving", "weak"], default: "new" },
    attempts: { type: Number, default: 1 },
    correctCount: { type: Number, default: 0 },
    wrongCount: { type: Number, default: 1 },
    skippedCount: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    previousAccuracy: { type: Number, default: 0 },
    improvementPercentage: { type: Number, default: 0 },
    completionStatus: { type: String, enum: ["in_progress", "completed"], default: "in_progress", index: true },
    firstIncorrectAt: Date,
    correctedAt: Date,
    incorrectAttemptsBeforeCorrection: { type: Number, default: 0 },
    mode: { type: String, trim: true, index: true },
    subjectId: String,
    chapterId: String,
    topicId: String,
    examType: { type: String, trim: true, index: true },
    sourceType: { type: String, trim: true, index: true },
    sourceName: { type: String, trim: true },
    sourceSessionId: { type: String, trim: true, index: true },
    sessionId: { type: String, trim: true, index: true },
    sessionAttemptId: { type: String, trim: true, index: true },
    category: { type: String, trim: true, index: true },
    difficulty: { type: String, trim: true, index: true },
    selectedOption: String,
    selectedOptions: { type: [String], default: [] },
    numericAnswer: String,
    lastAttemptDate: { type: Date, default: Date.now },
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

MistakeSchema.index({ userId: 1, questionId: 1 }, { unique: true });

export const Mistake = mongoose.models["Mistake"] ?? mongoose.model<IMistake>("Mistake", MistakeSchema);
