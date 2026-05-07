import mongoose, { Schema, Document } from "mongoose";

export interface IChapter extends Document {
  id: string;
  subjectId: string;
  name: string;
  isLockedForFreeUsers: boolean;
  createdAt: Date;
}

const ChapterSchema = new Schema<IChapter>(
  {
    subjectId: { type: String, required: true },
    name: { type: String, required: true },
    isLockedForFreeUsers: { type: Boolean, default: false },
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

ChapterSchema.index({ subjectId: 1 });

export const Chapter = mongoose.models["Chapter"] ?? mongoose.model<IChapter>("Chapter", ChapterSchema);
