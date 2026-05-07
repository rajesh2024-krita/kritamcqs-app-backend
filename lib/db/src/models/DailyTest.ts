import mongoose, { Schema, Document } from "mongoose";

export interface IDailyTest extends Document {
  id: string;
  userId: string;
  testDate: Date;
  questionIds: string[];
  totalQuestions: number;
  completed: boolean;
  score: number;
  accuracy: number;
  createdAt: Date;
  updatedAt: Date;
}

const DailyTestSchema = new Schema<IDailyTest>(
  {
    userId: { type: String, required: true, index: true },
    testDate: { type: Date, required: true, index: true },
    questionIds: { type: [String], default: [] },
    totalQuestions: { type: Number, default: 20 },
    completed: { type: Boolean, default: false },
    score: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: "DailyTests",
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

DailyTestSchema.index({ userId: 1, testDate: 1 }, { unique: true });

export const DailyTest = mongoose.models["DailyTest"] ?? mongoose.model<IDailyTest>("DailyTest", DailyTestSchema);

