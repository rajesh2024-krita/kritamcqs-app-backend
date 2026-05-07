import mongoose, { Schema, Document } from "mongoose";

export interface IExamType extends Document {
  id: string;
  name: "NEET" | "JEE";
  key?: "NEET" | "JEE";
  label?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExamTypeSchema = new Schema<IExamType>(
  {
    name: { type: String, enum: ["NEET", "JEE"], required: true, unique: true },
    key: { type: String, enum: ["NEET", "JEE"], unique: true, sparse: true },
    label: { type: String },
    description: String,
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.name = ret.name ?? ret.key ?? ret.label;
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.key;
        delete ret.label;
        return ret;
      },
    },
  },
);

ExamTypeSchema.pre("validate", function syncLegacyExamTypeFields(next) {
  const normalizedName = String(this.name ?? this.key ?? this.label ?? "").trim().toUpperCase();
  if (normalizedName === "NEET" || normalizedName === "JEE") {
    this.name = normalizedName as IExamType["name"];
    this.key = normalizedName as IExamType["name"];
    this.label = normalizedName;
  }
  next();
});

export const ExamType =
  mongoose.models["ExamType"] ?? mongoose.model<IExamType>("ExamType", ExamTypeSchema);
