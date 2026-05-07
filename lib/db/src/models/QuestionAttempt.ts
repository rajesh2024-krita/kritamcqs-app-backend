import mongoose, { Schema, Document } from "mongoose";

export interface IQuestionAttempt extends Document {
  id: string;
  userId: string;
  sessionId: string;
  sessionAttemptId: string;
  questionId: string;
  modeId?: string;
  subjectId: string;
  chapterId: string;
  yearId?: string;
  questionTypeId?: string;
  isCorrect: boolean;
  selectedOption?: string;
  selectedOptions?: string[];
  numericAnswer?: string;
  skipped: boolean;
  timeSpent: number;
  createdAt: Date;
  updatedAt: Date;
}

const QuestionAttemptSchema = new Schema<IQuestionAttempt>(
  {
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    sessionAttemptId: { type: String, required: true, index: true },
    questionId: { type: String, required: true, index: true },
    modeId: String,
    subjectId: { type: String, required: true },
    chapterId: { type: String, required: true },
    yearId: String,
    questionTypeId: String,
    isCorrect: { type: Boolean, required: true },
    selectedOption: String,
    selectedOptions: { type: [String], default: [] },
    numericAnswer: String,
    skipped: { type: Boolean, default: false },
    timeSpent: { type: Number, default: 0 },
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

QuestionAttemptSchema.index({ userId: 1, createdAt: -1 });
QuestionAttemptSchema.index({ userId: 1, questionId: 1, createdAt: -1 });

export const QuestionAttempt =
  mongoose.models["QuestionAttempt"] ?? mongoose.model<IQuestionAttempt>("QuestionAttempt", QuestionAttemptSchema);
