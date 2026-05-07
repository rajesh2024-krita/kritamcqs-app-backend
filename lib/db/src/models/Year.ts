import mongoose, { Schema, Document } from "mongoose";

export interface IYear extends Document {
  id: string;
  name: string;
  examType?: "NEET" | "JEE";
  createdAt: Date;
  updatedAt: Date;
}

const YearSchema = new Schema<IYear>(
  {
    name: { type: String, required: true, trim: true, index: true },
    examType: { type: String, enum: ["NEET", "JEE"], index: true },
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

YearSchema.index({ name: 1, examType: 1 }, { unique: true });

export const Year = mongoose.models["Year"] ?? mongoose.model<IYear>("Year", YearSchema);
