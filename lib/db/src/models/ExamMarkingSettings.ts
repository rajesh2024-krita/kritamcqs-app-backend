import mongoose, { Schema, Document } from "mongoose";

export interface IExamMarkingSettings extends Document {
  predictionMinimumMockTests: number;
  createdAt: Date;
  updatedAt: Date;
}

const schemeRuleSchema = new Schema(
  {
    correct: { type: Number, required: true, default: 4 },
    wrong: { type: Number, required: true, default: -1 },
    unanswered: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const examMarkingSchemeSchema = new Schema(
  {
    version: { type: String, required: true, default: "v1" },
    examType: { type: String, enum: ["NEET", "JEE_MAIN", "JEE_ADVANCED"], required: true },
    mcq: { type: schemeRuleSchema, required: true, default: () => ({ correct: 4, wrong: -1, unanswered: 0 }) },
    numerical: { type: schemeRuleSchema, required: true, default: () => ({ correct: 4, wrong: 0, unanswered: 0 }) },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const examMarkingSettingsSchema = new Schema<IExamMarkingSettings>(
  {
    neet: { type: examMarkingSchemeSchema },
    jeeMain: { type: examMarkingSchemeSchema },
    jeeAdvanced: { type: examMarkingSchemeSchema },
    predictionMinimumMockTests: { type: Number, default: 5, min: 1, max: 50 },
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

export const ExamMarkingSettings =
  mongoose.models["ExamMarkingSettings"] ?? mongoose.model<IExamMarkingSettings>("ExamMarkingSettings", examMarkingSettingsSchema);
