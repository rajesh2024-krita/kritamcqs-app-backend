import mongoose, { Schema, Document } from "mongoose";

export interface IMistakeBook extends Document {
  id: string;
  userId: string;
  questionId: string;
  chapter: string;
  attempts: number;
  lastAttempt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const MistakeBookSchema = new Schema<IMistakeBook>(
  {
    userId: { type: String, required: true, index: true },
    questionId: { type: String, required: true, index: true },
    chapter: { type: String, default: "" },
    attempts: { type: Number, default: 1 },
    lastAttempt: { type: Date, default: Date.now },
    status: { type: String, default: "new" },
  },
  {
    timestamps: true,
    collection: "MistakeBook",
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

MistakeBookSchema.index({ userId: 1, questionId: 1 }, { unique: true });

export const MistakeBook =
  mongoose.models["MistakeBook"] ?? mongoose.model<IMistakeBook>("MistakeBook", MistakeBookSchema);

