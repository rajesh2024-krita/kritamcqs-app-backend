import mongoose, { Schema, Document } from "mongoose";

export interface IRevisionSettings extends Document {
  id: string;
  wrongQuestionLimit: number;
  oldQuestionLimit: number;
  revisionEnabled: boolean;
  spacedDays: number[];
  createdAt: Date;
  updatedAt: Date;
}

const RevisionSettingsSchema = new Schema<IRevisionSettings>(
  {
    wrongQuestionLimit: { type: Number, default: 10, min: 1, max: 100 },
    oldQuestionLimit: { type: Number, default: 5, min: 1, max: 100 },
    revisionEnabled: { type: Boolean, default: true },
    spacedDays: {
      type: [Number],
      default: [1, 2, 5, 10],
      validate: {
        validator: (value: number[]) =>
          Array.isArray(value) && value.length > 0 && value.every((day) => Number.isFinite(day) && day > 0),
        message: "spacedDays must contain one or more positive numbers",
      },
    },
  },
  {
    timestamps: true,
    collection: "revisionsettings",
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

export const RevisionSettings =
  mongoose.models["RevisionSettings"] ?? mongoose.model<IRevisionSettings>("RevisionSettings", RevisionSettingsSchema);
