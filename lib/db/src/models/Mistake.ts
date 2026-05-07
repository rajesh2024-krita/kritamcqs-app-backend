import mongoose, { Schema, Document } from "mongoose";

export interface IMistake extends Document {
  id: string;
  userId: string;
  questionId: string;
  status: "new" | "improving" | "weak";
  attempts: number;
  lastAttemptDate: Date;
  createdAt: Date;
}

const MistakeSchema = new Schema<IMistake>(
  {
    userId: { type: String, required: true },
    questionId: { type: String, required: true },
    status: { type: String, enum: ["new", "improving", "weak"], default: "new" },
    attempts: { type: Number, default: 1 },
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
