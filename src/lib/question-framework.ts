import type { IQuestion } from "@api/db";

export function normalizeQuestionDocument(question: IQuestion | Record<string, any>) {
  const raw = typeof (question as any).toJSON === "function" ? (question as any).toJSON() : question;
  const questionTypeDoc = raw.questionTypeId && typeof raw.questionTypeId === "object"
    ? raw.questionTypeId
    : null;

  const subject = raw.subject ?? inferSubject(raw.subjectId, raw.subjectName, raw.examMode);
  const exam = raw.exam ?? inferExam(raw.examMode, subject, raw.difficulty);
  const responseType = raw.responseType ?? inferResponseType(raw);
  const questionType =
    raw.questionType ??
    questionTypeDoc?.label ??
    questionTypeDoc?.name ??
    questionTypeDoc?.key ??
    inferQuestionType(exam, responseType, subject, raw.hasDiagram);

  return {
    ...raw,
    exam,
    subject,
    questionType,
    responseType,
    conceptTags: Array.isArray(raw.conceptTags) ? raw.conceptTags : [],
    isNumerical: Boolean(raw.isNumerical ?? responseType === "numeric"),
    hasDiagram: Boolean(raw.hasDiagram),
    source: raw.source ?? `${exam} question bank`,
    correctOptions: Array.isArray(raw.correctOptions) ? raw.correctOptions : [],
    questionTypeId:
      typeof raw.questionTypeId === "string"
        ? raw.questionTypeId
        : questionTypeDoc?.id ?? questionTypeDoc?._id?.toString(),
    difficultyId:
      typeof raw.difficultyId === "string"
        ? raw.difficultyId
        : raw.difficultyId?.id ?? raw.difficultyId?._id?.toString(),
    questionTypeLabel: questionTypeDoc?.label ?? questionTypeDoc?.name ?? raw.questionTypeLabel ?? questionType,
  };
}

export function getExamTypeLabel(exam?: string, examMode?: string) {
  if (exam === "JEE_MAIN" || exam === "JEE_ADVANCED") return "JEE";
  if (exam === "NEET") return "NEET";
  if (examMode === "JEE") return "JEE";
  if (examMode === "NEET") return "NEET";
  return exam ?? examMode;
}

function inferSubject(subjectId?: string, subjectName?: string, examMode?: string) {
  const normalized = String(subjectName ?? "").toLowerCase();
  if (normalized.includes("bio") || normalized.includes("botany") || normalized.includes("zoology")) return "Biology";
  if (normalized.includes("chem")) return "Chemistry";
  if (normalized.includes("math")) return "Mathematics";
  if (normalized.includes("phys")) return "Physics";
  if (String(subjectId) === "5") return "Mathematics";
  if (examMode === "NEET") return "Biology";
  return "Physics";
}

function inferExam(examMode?: string, subject?: string, difficulty?: string) {
  if (examMode === "NEET") return "NEET";
  if (subject === "Biology") return "NEET";
  if (examMode === "JEE") return difficulty === "hard" ? "JEE_ADVANCED" : "JEE_MAIN";
  if (examMode === "BOTH") return difficulty === "hard" ? "JEE_ADVANCED" : "JEE_MAIN";
  return "NEET";
}

function inferResponseType(raw: Record<string, any>) {
  if (raw.responseType) return raw.responseType;
  if (raw.isNumerical || raw.numericAnswer) return "numeric";
  if (Array.isArray(raw.correctOptions) && raw.correctOptions.length > 0) return "multiple";
  return "single";
}

function inferQuestionType(exam: string, responseType: string, subject: string, hasDiagram?: boolean) {
  if (hasDiagram && exam === "NEET") return "NEET_DIAGRAM_BASED";
  if (responseType === "numeric") {
    if (exam === "NEET") return "NEET_MCQ";
    return "JEE_NUMERICAL_VALUE_BASED";
  }
  if (responseType === "multiple") return "JEE_MULTI_OPTION";
  if (exam === "NEET") return "NEET_MCQ";
  return "JEE_MAIN_MCQ_SINGLE_CORRECT";
}
