import mongoose, { Schema, Document } from "mongoose";

export interface ISubject extends Document {
  id: string;
  name: string;
  examMode: string;
  examType?: string;
  modeId?: string;
  icon?: string;
  color?: string;
  createdAt: Date;
}

const SubjectSchema = new Schema<ISubject>(
  {
    name: { type: String, required: true },
    examMode: { type: String, required: true, trim: true },
    examType: { type: String, trim: true },
    modeId: { type: String, index: true },
    icon: String,
    color: String,
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

SubjectSchema.pre("validate", function syncExamFields(next) {
  if (!this.examMode && this.examType) {
    this.examMode = this.examType;
  }

  if (!this.examType && this.examMode) {
    this.examType = this.examMode;
  }

  next();
});

export const Subject = mongoose.models["Subject"] ?? mongoose.model<ISubject>("Subject", SubjectSchema);
