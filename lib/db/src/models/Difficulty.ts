import mongoose, { Schema, Document } from "mongoose";

export interface IDifficulty extends Document {
  id: string;
  key: string;
  name: string;
  description?: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const DifficultySchema = new Schema<IDifficulty>(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    sortOrder: { type: Number, default: 0 },
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

DifficultySchema.index({ sortOrder: 1, name: 1 });

export const Difficulty =
  mongoose.models["Difficulty"] ??
  mongoose.model<IDifficulty>("Difficulty", DifficultySchema);
