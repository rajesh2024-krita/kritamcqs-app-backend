import mongoose, { Schema, Document } from "mongoose";

export interface IFreeQuestionConfig extends Document {
  id: string;
  subjectId: string;
  selectionMode: "manual" | "automatic";
  questionCount: number;
  manualQuestionIds: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FreeQuestionConfigSchema = new Schema<IFreeQuestionConfig>(
  {
    subjectId: { type: String, required: true, index: true },
    selectionMode: { type: String, enum: ["manual", "automatic"], default: "automatic" },
    questionCount: { type: Number, default: 20, min: 1, max: 200 },
    manualQuestionIds: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
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

FreeQuestionConfigSchema.index({ subjectId: 1 }, { unique: true });

export const FreeQuestionConfig =
  mongoose.models["FreeQuestionConfig"] ?? mongoose.model<IFreeQuestionConfig>("FreeQuestionConfig", FreeQuestionConfigSchema);
