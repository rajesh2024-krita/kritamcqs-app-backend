import mongoose, { Schema, Document } from "mongoose";

export interface IQuestion extends Document {
  id: string;
  modeId?: string;
  subjectId: string;
  chapterId: string;
  yearId?: string;
  difficultyId?: string;
  question: string;
  questionImageUrl?: string;
  optionA?: string;
  optionAImageUrl?: string;
  optionB?: string;
  optionBImageUrl?: string;
  optionC?: string;
  optionCImageUrl?: string;
  optionD?: string;
  optionDImageUrl?: string;
  correctOption?: "A" | "B" | "C" | "D";
  explanation?: string;
  difficulty: "easy" | "medium" | "moderate" | "hard" | "mixed";
  examMode: "NEET" | "JEE" | "BOTH";
  questionTypeId?: string;
  exam?: "NEET" | "JEE_MAIN" | "JEE_ADVANCED";
  subject?: "Biology" | "Physics" | "Chemistry" | "Maths";
  questionType?: string;
  conceptTags?: string[];
  isNumerical?: boolean;
  hasDiagram?: boolean;
  source?: string;
  responseType?: "single" | "multiple" | "numeric";
  numericAnswer?: string;
  correctOptions?: string[];
  passage?: string;
  year?: number;
  createdAt: Date;
}

const QuestionSchema = new Schema<IQuestion>(
  {
    modeId: { type: String, index: true },
    subjectId: { type: String, required: true },
    chapterId: { type: String, required: true },
    yearId: { type: String, index: true },
    difficultyId: { type: Schema.Types.ObjectId, ref: "Difficulty", index: true },
    question: { type: String, required: true },
    questionImageUrl: String,
    optionA: String,
    optionAImageUrl: String,
    optionB: String,
    optionBImageUrl: String,
    optionC: String,
    optionCImageUrl: String,
    optionD: String,
    optionDImageUrl: String,
    correctOption: { type: String, enum: ["A", "B", "C", "D"] },
    explanation: String,
    difficulty: { type: String, enum: ["easy", "medium", "moderate", "hard", "mixed"], required: true },
    examMode: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true },
    questionTypeId: { type: Schema.Types.ObjectId, ref: "QuestionType" },
    exam: { type: String, enum: ["NEET", "JEE_MAIN", "JEE_ADVANCED"] },
    subject: { type: String, enum: ["Biology", "Physics", "Chemistry", "Maths"] },
    questionType: String,
    conceptTags: { type: [String], default: [] },
    isNumerical: { type: Boolean, default: false },
    hasDiagram: { type: Boolean, default: false },
    source: String,
    responseType: { type: String, enum: ["single", "multiple", "numeric"], default: "single" },
    numericAnswer: String,
    correctOptions: { type: [String], default: [] },
    passage: String,
    year: Number,
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

QuestionSchema.index({ modeId: 1, subjectId: 1, chapterId: 1, yearId: 1, questionTypeId: 1, difficultyId: 1, difficulty: 1 });

export const Question = mongoose.models["Question"] ?? mongoose.model<IQuestion>("Question", QuestionSchema);
