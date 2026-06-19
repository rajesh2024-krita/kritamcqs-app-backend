import mongoose, { Schema, Document } from "mongoose";

export interface IRevisionHistory extends Document {
  id: string;
  userId: string;
  questionIds: string[];
  totalQuestions: number;
  correctAnswers: number;
  accuracy: number;
  completedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RevisionHistorySchema = new Schema<IRevisionHistory>(
  {
    userId: { type: String, required: true, index: true },
    questionIds: { type: [String], default: [] },
    totalQuestions: { type: Number, required: true, default: 0 },
    correctAnswers: { type: Number, required: true, default: 0 },
    accuracy: { type: Number, required: true, default: 0 },
    completedAt: { type: Date, required: true, default: Date.now, index: true },
  },
  {
    timestamps: true,
    collection: "RevisionHistory",
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

RevisionHistorySchema.index({ userId: 1, completedAt: -1 });

export const RevisionHistory =
  mongoose.models["RevisionHistory"] ?? mongoose.model<IRevisionHistory>("RevisionHistory", RevisionHistorySchema);

