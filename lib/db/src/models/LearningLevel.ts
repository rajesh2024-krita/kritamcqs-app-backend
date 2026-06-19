import mongoose, { Schema, Document } from "mongoose";

export interface ILearningLevel extends Document {
  id: string;
  key: string;
  label: string;
  description?: string;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const LearningLevelSchema = new Schema<ILearningLevel>(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true, index: true },
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

export const LearningLevel =
  mongoose.models["LearningLevel"] ?? mongoose.model<ILearningLevel>("LearningLevel", LearningLevelSchema);
