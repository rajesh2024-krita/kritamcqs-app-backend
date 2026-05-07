import mongoose, { Schema, Document } from "mongoose";

export interface IQuestionTypeConfig {
  id: string;
  label: string;
  description: string;
  responseType: "single" | "multiple" | "numeric";
}

export interface IExamCategoryConfig {
  id: "NEET" | "JEE_MAIN" | "JEE_ADVANCED";
  label: string;
  description: string;
  focus: string;
  subjects: string[];
  characteristics: string[];
  recommendations: string[];
  questionTypes: IQuestionTypeConfig[];
}

export interface IComparisonRow {
  feature: string;
  neet: string;
  jee: string;
}

export interface IExamFramework extends Document {
  id: string;
  mode: "NEET" | "JEE" | "BOTH";
  label: string;
  description: string;
  exams: IExamCategoryConfig[];
  comparisonRows: IComparisonRow[];
  createdAt: Date;
}

const QuestionTypeConfigSchema = new Schema<IQuestionTypeConfig>(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    responseType: { type: String, enum: ["single", "multiple", "numeric"], required: true },
  },
  { _id: false },
);

const ExamCategoryConfigSchema = new Schema<IExamCategoryConfig>(
  {
    id: { type: String, enum: ["NEET", "JEE_MAIN", "JEE_ADVANCED"], required: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    focus: { type: String, required: true },
    subjects: { type: [String], default: [] },
    characteristics: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    questionTypes: { type: [QuestionTypeConfigSchema], default: [] },
  },
  { _id: false },
);

const ComparisonRowSchema = new Schema<IComparisonRow>(
  {
    feature: { type: String, required: true },
    neet: { type: String, required: true },
    jee: { type: String, required: true },
  },
  { _id: false },
);

const ExamFrameworkSchema = new Schema<IExamFramework>(
  {
    mode: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true, unique: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    exams: { type: [ExamCategoryConfigSchema], default: [] },
    comparisonRows: { type: [ComparisonRowSchema], default: [] },
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

export const ExamFramework =
  mongoose.models["ExamFramework"] ??
  mongoose.model<IExamFramework>("ExamFramework", ExamFrameworkSchema);
