import mongoose, { Schema, Document } from "mongoose";

export interface IMode extends Document {
  id: string;
  key: "NEET" | "JEE" | "BOTH";
  label: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ModeSchema = new Schema<IMode>(
  {
    key: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true, unique: true },
    label: { type: String, required: true },
    description: String,
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

export const Mode = mongoose.models["Mode"] ?? mongoose.model<IMode>("Mode", ModeSchema);
