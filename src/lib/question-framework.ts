import type { IQuestion } from "@api/db";

export function normalizeQuestionDocument(question: IQuestion | Record<string, any>) {
  const raw = typeof (question as any).toJSON === "function" ? (question as any).toJSON() : question;
  const questionTypeDoc = raw.questionTypeId && typeof raw.questionTypeId === "object"
    ? raw.questionTypeId
    : null;

  const subject = raw.subject ?? inferSubject(raw.subjectId, raw.subjectName, raw.examMode);
  const exam = raw.exam ?? inferExam(raw.examMode, subject, raw.difficulty);
  const responseType = raw.responseType ?? inferResponseType(raw);
  const yearValue = readYearValue(raw.year, raw.examYear, raw.previousYear);
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
    year: yearValue,
  };
}

export function readYearValue(...values: unknown[]) {
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;

    const parsed = Number(raw);
    if (/^\d{4}$/.test(raw) && Number.isFinite(parsed)) return parsed;

    const match = raw.match(/\b(19|20)\d{2}\b/);
    if (match?.[0]) {
      const matchedYear = Number(match[0]);
      if (Number.isFinite(matchedYear)) return matchedYear;
    }
  }
  return undefined;
}

export function normalizeYearDocument(year?: Record<string, any> | null) {
  if (!year) return null;
  const raw = typeof year.toJSON === "function" ? year.toJSON() : year;
  const yearValue = readYearValue(raw.value, raw.name, raw.label);
  const yearLabel = String(raw.label ?? raw.name ?? yearValue ?? "").trim();

  const normalized = {
    id: String(raw.id ?? raw._id ?? "").trim(),
    name: String(raw.name ?? yearLabel).trim(),
    label: yearLabel,
    value: yearValue,
    examType: raw.examType,
  };
  return normalized;
}

export function resolveQuestionYearFields(question: Record<string, any>, yearDoc?: Record<string, any> | null) {
  const normalizedYear = normalizeYearDocument(yearDoc);
  const yearValue = normalizedYear?.value ?? readYearValue(question.year, question.examYear, question.previousYear);
  const yearLabel =
    normalizedYear?.label ||
    normalizedYear?.name ||
    (yearValue ? String(yearValue) : undefined);

  const resolved = {
    yearId: normalizedYear?.id || question.yearId,
    year: yearValue,
    yearLabel,
  };
  return resolved;
}

export function getExamTypeLabel(exam?: string, examMode?: string) {
  const normalizedExam = String(exam ?? "").trim().toUpperCase();
  const normalizedExamMode = String(examMode ?? "").trim().toUpperCase();
  if (normalizedExam === "JEE_MAIN" || normalizedExam === "JEE_ADVANCED" || normalizedExam === "JEE") return "JEE";
  if (normalizedExam === "NEET" || normalizedExam === "NEET_UG") return "NEET";
  if (normalizedExamMode === "JEE_MAIN" || normalizedExamMode === "JEE_ADVANCED" || normalizedExamMode === "JEE") return "JEE";
  if (normalizedExamMode === "NEET" || normalizedExamMode === "NEET_UG") return "NEET";
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
