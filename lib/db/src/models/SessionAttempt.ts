import mongoose, { Schema, Document } from "mongoose";

export interface ISessionAttempt extends Document {
  id: string;
  userId: string;
  sessionId: string;
  sourceSessionId?: string;
  attemptNumber: number;
  score?: number;
  accuracy?: number;
  timeTaken?: number;
  correctCount?: number;
  incorrectCount?: number;
  skippedCount?: number;
  totalQuestions: number;
  answersJson?: Record<string, unknown>;
  topicBreakdownJson?: Record<string, unknown>;
  comparisonJson?: Record<string, unknown>;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SessionAttemptSchema = new Schema<ISessionAttempt>(
  {
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    sourceSessionId: { type: String, index: true },
    attemptNumber: { type: Number, required: true },
    score: Number,
    accuracy: Number,
    timeTaken: Number,
    correctCount: Number,
    incorrectCount: Number,
    skippedCount: Number,
    totalQuestions: { type: Number, required: true },
    answersJson: Schema.Types.Mixed,
    topicBreakdownJson: Schema.Types.Mixed,
    comparisonJson: Schema.Types.Mixed,
    completedAt: Date,
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

SessionAttemptSchema.index({ userId: 1, sourceSessionId: 1, createdAt: -1 });

export const SessionAttempt =
  mongoose.models["SessionAttempt"] ?? mongoose.model<ISessionAttempt>("SessionAttempt", SessionAttemptSchema);
