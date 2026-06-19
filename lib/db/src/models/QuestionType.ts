import mongoose, { Schema, Document } from "mongoose";

export interface IQuestionType extends Document {
  id: string;
  name: string;
  key: string;
  label: string;
  mode?: "NEET" | "JEE" | "BOTH";
  examCategory?: "NEET" | "JEE_MAIN" | "JEE_ADVANCED";
  responseType?: "single" | "multiple" | "numeric";
  displayVariant?: "single_choice" | "multiple_choice" | "numeric" | "assertion_reasoning" | "statement_set" | "matching" | "diagram";
  description?: string;
  exampleQuestion?: string;
  exampleOptions?: string;
  exampleAnswer?: string;
  exampleExplanation?: string;
  createdAt: Date;
}

const QuestionTypeSchema = new Schema<IQuestionType>(
  {
    name: { type: String, required: true },
    key: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    mode: { type: String, enum: ["NEET", "JEE", "BOTH"] },
    examCategory: { type: String, enum: ["NEET", "JEE_MAIN", "JEE_ADVANCED"] },
    responseType: { type: String, enum: ["single", "multiple", "numeric"], default: "single" },
    displayVariant: {
      type: String,
      enum: ["single_choice", "multiple_choice", "numeric", "assertion_reasoning", "statement_set", "matching", "diagram"],
      default: "single_choice",
    },
    description: String,
    exampleQuestion: String,
    exampleOptions: String,
    exampleAnswer: String,
    exampleExplanation: String,
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

QuestionTypeSchema.index({ mode: 1, examCategory: 1, responseType: 1 });

QuestionTypeSchema.pre("validate", function syncMode(next) {
  if (!this.label && this.name) this.label = this.name;
  if (!this.name && this.label) this.name = this.label;

  if (!this.mode) {
    if (this.examCategory === "NEET") this.mode = "NEET";
    else if (this.examCategory === "JEE_MAIN" || this.examCategory === "JEE_ADVANCED") this.mode = "JEE";
  }

  if (!this.examCategory) {
    if (this.mode === "NEET") this.examCategory = "NEET";
    else if (this.mode === "JEE") this.examCategory = "JEE_MAIN";
  }

  next();
});

export const QuestionType =
  mongoose.models["QuestionType"] ??
  mongoose.model<IQuestionType>("QuestionType", QuestionTypeSchema);
