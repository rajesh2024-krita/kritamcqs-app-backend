import mongoose, { Schema, Document } from "mongoose";

export interface ITest extends Document {
  id: string;
  userId: string;
  mode: "smart" | "practice" | "revision";
  questionIds: string[];
  score?: number;
  accuracy?: number;
  timeTaken?: number;
  correctCount?: number;
  incorrectCount?: number;
  skippedCount?: number;
  totalQuestions: number;
  answersJson?: Record<string, unknown>;
  topicBreakdownJson?: Record<string, unknown>;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TestSchema = new Schema<ITest>(
  {
    userId: { type: String, required: true },
    mode: { type: String, enum: ["smart", "practice", "revision"], required: true },
    questionIds: [{ type: String }],
    score: Number,
    accuracy: Number,
    timeTaken: Number,
    correctCount: Number,
    incorrectCount: Number,
    skippedCount: Number,
    totalQuestions: { type: Number, required: true },
    answersJson: Schema.Types.Mixed,
    topicBreakdownJson: Schema.Types.Mixed,
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
  }
);

export const Test = mongoose.models["Test"] ?? mongoose.model<ITest>("Test", TestSchema);
