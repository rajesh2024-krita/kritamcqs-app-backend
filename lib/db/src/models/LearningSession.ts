import mongoose, { Schema, Document } from "mongoose";

export interface ILearningSession extends Document {
  id: string;
  userId: string;
  type: "test" | "practice" | "revision";
  origin: "daily_set" | "practice_filter" | "weak_area" | "revision" | "smart_test" | "retest" | "mock_test";
  modeId: string;
  modeKey: "NEET" | "JEE" | "BOTH";
  subjectId?: string;
  chapterId?: string;
  yearId?: string;
  questionTypeId?: string;
  questionIds: string[];
  filterSnapshot?: Record<string, unknown>;
  sourceSessionId?: string;
  isRetestGroup: boolean;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

const LearningSessionSchema = new Schema<ILearningSession>(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ["test", "practice", "revision"], required: true },
    origin: {
      type: String,
      enum: ["daily_set", "practice_filter", "weak_area", "revision", "smart_test", "retest", "mock_test"],
      required: true,
    },
    modeId: { type: String, required: true },
    modeKey: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true },
    subjectId: String,
    chapterId: String,
    yearId: String,
    questionTypeId: String,
    questionIds: { type: [String], default: [] },
    filterSnapshot: Schema.Types.Mixed,
    sourceSessionId: { type: String, index: true },
    isRetestGroup: { type: Boolean, default: false },
    title: String,
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

LearningSessionSchema.index({ userId: 1, createdAt: -1 });

export const LearningSession =
  mongoose.models["LearningSession"] ?? mongoose.model<ILearningSession>("LearningSession", LearningSessionSchema);
