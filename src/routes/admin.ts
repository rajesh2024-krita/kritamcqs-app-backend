import { Router, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import multer from "multer";
import * as XLSX from "xlsx";
import {
  Chapter,
  ChapterPerformance,
  Difficulty,
  ExamType,
  LearningSession,
  MigrationLog,
  Mistake,
  Mode,
  Question,
  QuestionAttempt,
  QuestionType,
  SessionAttempt,
  Subject,
  Subscription,
  Test,
  User,
  Year,
} from "@api/db";
import type { AuthenticatedRequest } from "../middlewares/auth";
import { requireAdmin } from "../middlewares/auth";
import { resolveDifficultySelection } from "../lib/difficulties";
import { getExamTypeLabel, normalizeQuestionDocument } from "../lib/question-framework";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const CHUNK_SIZE = 100;
const QUESTION_ASSET_DIR = process.env["QUESTION_ASSET_DIR"]
  ? path.resolve(process.env["QUESTION_ASSET_DIR"])
  : path.resolve(process.cwd(), "../krita-neet-jee/public/uploads/question-assets");
const IMAGE_URL_FIELDS = [
  "questionImageUrl",
  "optionAImageUrl",
  "optionBImageUrl",
  "optionCImageUrl",
  "optionDImageUrl",
] as const;
const QUESTION_COLUMNS = {
  subject: ["subject", "subject_name"],
  chapter: ["chapter", "chapter_name"],
  year: ["year", "year_label", "year_value"],
  questionType: ["question_type", "question_type_label", "question_type_key"],
  examType: ["exam_type", "examType"],
  examMode: ["exam_mode", "examMode"],
  exam: ["exam"],
  difficulty: ["difficulty", "level"],
  responseType: ["response_type", "responseType"],
  question: ["question", "question_text"],
  questionImage: ["question_image", "question_image_url", "question_image_file"],
  optionA: ["option_a", "optionA"],
  optionAImage: ["option_a_image", "optionAImage"],
  optionB: ["option_b", "optionB"],
  optionBImage: ["option_b_image", "optionBImage"],
  optionC: ["option_c", "optionC"],
  optionCImage: ["option_c_image", "optionCImage"],
  optionD: ["option_d", "optionD"],
  optionDImage: ["option_d_image", "optionDImage"],
  correctOption: ["correct_option", "correctOption"],
  explanation: ["explanation", "solution", "answer_explanation"],
  numericAnswer: ["numeric_answer", "numericAnswer"],
  passage: ["passage"],
  conceptTags: ["concept_tags", "conceptTags"],
  hasDiagram: ["has_diagram", "hasDiagram"],
  isNumerical: ["is_numerical", "isNumerical"],
} as const;

type AdminHandler = (req: AuthenticatedRequest, res: Response) => Promise<void>;

router.use(requireAdmin);

function wrap(handler: AdminHandler) {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const status =
        typeof error === "object" && error && "statusCode" in error && typeof (error as any).statusCode === "number"
          ? (error as any).statusCode
          : 500;

      req.log.error({ error }, "Admin route failed");
      res.status(status).json({ success: false, message });
    }
  };
}

function sendSuccess(res: Response, data: unknown, options: { status?: number; message?: string; meta?: unknown } = {}) {
  res.status(options.status ?? 200).json({
    success: true,
    ...(options.message ? { message: options.message } : {}),
    data,
    ...(options.meta ? { meta: options.meta } : {}),
  });
}

function assertObjectId(id: string, label = "resource") {
  if (!mongoose.isValidObjectId(id)) {
    const error = new Error(`Invalid ${label} id`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
}

function getPagination(query: Record<string, unknown>) {
  const page = Math.max(Number(query.page ?? 1), 1);
  const limit = Math.min(Math.max(Number(query.limit ?? 10), 1), 500);
  return { page, limit, skip: (page - 1) * limit };
}

function normalizeSort(query: Record<string, unknown>, allowedSorts: string[], fallback = "createdAt") {
  const sortBy = typeof query.sortBy === "string" && allowedSorts.includes(query.sortBy) ? query.sortBy : fallback;
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  return { [sortBy]: sortOrder };
}

function buildSearchFilter(query: Record<string, unknown>, searchFields: string[]) {
  const search = String(query.search ?? "").trim();
  if (!search || searchFields.length === 0) return {};
  const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    $or: searchFields.map((field) => ({
      [field]: { $regex: safeSearch, $options: "i" },
    })),
  };
}

function exactFilter(query: Record<string, unknown>, keys: string[]) {
  return keys.reduce<Record<string, unknown>>((acc, key) => {
    const value = query[key];
    if (value === undefined || value === "") return acc;
    acc[key] = value === "true" ? true : value === "false" ? false : value;
    return acc;
  }, {});
}

function parseBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "y"].includes(String(value ?? "").trim().toLowerCase());
}

function normalizeExamType(value: unknown) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "NEET") return "NEET";
  if (normalized === "JEE" || normalized === "JEE_MAIN" || normalized === "JEE_ADVANCED") return "JEE";
  const error = new Error("Invalid exam type. Use NEET or JEE.") as Error & { statusCode: number };
  error.statusCode = 400;
  throw error;
}

async function ensureExamTypeExists(value: unknown) {
  const name = normalizeExamType(value);
  const exists = await ExamType.exists({ $or: [{ name }, { key: name }, { label: name }] });
  if (!exists) {
    const error = new Error(`Exam type ${name} is not configured`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return name;
}

function serializeUser(user: any) {
  const raw = typeof user?.toJSON === "function" ? user.toJSON() : user;
  return {
    id: String(raw.id ?? raw._id),
    mobile: raw.mobile,
    email: raw.email,
    name: raw.name,
    examMode: raw.examMode,
    level: raw.level,
    onboardingComplete: Boolean(raw.onboardingComplete),
    mobileVerified: Boolean(raw.mobileVerified),
    isPremium: Boolean(raw.isPremium),
    premiumExpiresAt: raw.premiumExpiresAt,
    createdAt: raw.createdAt,
    isAdmin: Boolean(raw.isAdmin),
    migratedFromOldApp: Boolean(raw.migratedFromOldApp),
  };
}

function serializeMode(mode: any) {
  const raw = typeof mode?.toJSON === "function" ? mode.toJSON() : mode;
  return {
    id: String(raw.id ?? raw._id),
    key: raw.key,
    label: raw.label,
    description: raw.description ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function serializeExamType(examType: any) {
  const raw = typeof examType?.toJSON === "function" ? examType.toJSON() : examType;
  return {
    id: String(raw.id ?? raw._id),
    name: raw.name ?? raw.key ?? raw.label,
    description: raw.description ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function serializeDifficulty(difficulty: any) {
  const raw = typeof difficulty?.toJSON === "function" ? difficulty.toJSON() : difficulty;
  return {
    id: String(raw.id ?? raw._id),
    key: String(raw.key ?? raw.name ?? "").trim().toLowerCase(),
    name: raw.name ?? raw.key ?? "",
    description: raw.description ?? "",
    sortOrder: Number(raw.sortOrder ?? 0),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function serializeSubject(subject: any) {
  const raw = typeof subject?.toJSON === "function" ? subject.toJSON() : subject;
  const examType = raw.examType ?? raw.examMode;
  return {
    id: String(raw.id ?? raw._id),
    name: raw.name,
    examType,
    examMode: raw.examMode ?? examType,
    icon: raw.icon ?? "",
    color: raw.color ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function serializeYear(year: any) {
  const raw = typeof year?.toJSON === "function" ? year.toJSON() : year;
  return {
    id: String(raw.id ?? raw._id),
    name: raw.name,
    examType: raw.examType,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function serializeQuestionType(questionType: any) {
  const raw = typeof questionType?.toJSON === "function" ? questionType.toJSON() : questionType;
  const examType = normalizeExamType(raw.examType ?? raw.examCategory ?? "NEET");
  return {
    id: String(raw.id ?? raw._id),
    name: raw.name ?? raw.label ?? raw.key ?? "",
    examType,
    mode: raw.mode ?? (examType === "JEE" ? "JEE" : "NEET"),
    examCategory: raw.examCategory ?? examType,
    responseType: raw.responseType ?? "single",
    displayVariant: raw.displayVariant ?? "single_choice",
    description: raw.description ?? "",
    exampleQuestion: raw.exampleQuestion ?? "",
    exampleOptions: raw.exampleOptions ?? "",
    exampleAnswer: raw.exampleAnswer ?? "",
    exampleExplanation: raw.exampleExplanation ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function normalizeYearPayload(body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  return {
    name,
    examType: body.examType ? String(body.examType) : body.examCategory ? String(body.examCategory) : undefined,
  };
}

function normalizeQuestionTypePayload(body: Record<string, unknown>) {
  const examType = body.examType ? String(body.examType) : body.examCategory ? String(body.examCategory) : undefined;
  const name = String(body.name ?? "").trim();
  return {
    name,
    examType,
    key:
      String(body.key ?? "").trim()
      || `${String(examType ?? "").toUpperCase()}_${name}`.replace(/[^A-Z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase()
      || undefined,
    label: name || undefined,
    examCategory: examType,
    responseType: body.responseType ? String(body.responseType) : undefined,
    displayVariant: body.displayVariant ? String(body.displayVariant) : undefined,
    description: String(body.description ?? "").trim() || undefined,
    exampleQuestion: String(body.exampleQuestion ?? "").trim() || undefined,
    exampleOptions: String(body.exampleOptions ?? "").trim() || undefined,
    exampleAnswer: String(body.exampleAnswer ?? "").trim() || undefined,
    exampleExplanation: String(body.exampleExplanation ?? "").trim() || undefined,
  };
}

function normalizeUserPayload(body: Record<string, unknown>) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "").trim();
  return {
    mobile: String(body.mobile ?? "").trim(),
    email: email || undefined,
    password,
    name: String(body.name ?? "").trim() || undefined,
    examMode: body.examMode ? String(body.examMode) : undefined,
    level: body.level ? String(body.level) : undefined,
    onboardingComplete: body.onboardingComplete === undefined ? undefined : parseBoolean(body.onboardingComplete),
    isPremium: body.isPremium === undefined ? undefined : parseBoolean(body.isPremium),
    premiumExpiresAt: body.premiumExpiresAt ? new Date(String(body.premiumExpiresAt)) : undefined,
    isAdmin: body.isAdmin === undefined ? undefined : parseBoolean(body.isAdmin),
  };
}

type OldAppUserRow = Record<string, unknown>;

const OLD_USER_COLUMNS = {
  name: ["name", "user_name", "fullname", "full_name"],
  mobile: ["mobile", "mobile_number", "phone", "phone_number", "contact", "contact_number"],
  email: ["email", "email_id", "mail"],
  role: ["role", "user_role"],
  planId: ["planid", "plan_id", "plan"],
  createdDateTime: ["createddatetime", "created_date_time", "created_at", "createddate", "created_date"],
} as const;

function oldUserCell(row: OldAppUserRow, keys: readonly string[]) {
  const normalizedRow = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  return getCell(normalizedRow, keys);
}

type PreparedMigrationUser = {
  source: OldAppUserRow;
  sourceIndex: number;
  normalized: {
    name?: string;
    mobile: string;
    email?: string;
    examMode: "BOTH";
    level: "Beginner";
    onboardingComplete: true;
    mobileVerified: true;
    isPremium: boolean;
    isAdmin: boolean;
    migratedFromOldApp: true;
    createdAt: Date;
    updatedAt: Date;
  };
};

function cleanMigrationMobile(input: unknown) {
  const raw = String(input ?? "").trim();
  if (!raw || /^(na|n\/a|null|undefined|none)$/i.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  const mobile = digits.slice(-10);
  const invalidValues = new Set(["0000000000", "1111111111", "2222222222", "3333333333", "4444444444", "5555555555", "6666666666", "7777777777", "8888888888", "9999999999", "1234567890"]);
  if (!mobile || mobile.length < 10 || invalidValues.has(mobile)) return null;
  if (!/^[6-9]\d{9}$/.test(mobile)) return null;
  return mobile;
}

function normalizeMigrationEmail(input: unknown) {
  const email = String(input ?? "").trim().toLowerCase();
  return email && email.includes("@") ? email : undefined;
}

function parseMigrationDate(input: unknown) {
  const parsed = new Date(String(input ?? "").trim());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseMigrationTimestamp(input: unknown) {
  const parsed = new Date(String(input ?? "").trim());
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function normalizeSqlValue(value: string) {
  const trimmed = value.trim();
  if (/^null$/i.test(trimmed)) return "";
  const quote = trimmed[0];
  if ((quote === "'" || quote === "\"") && trimmed.endsWith(quote)) {
    return trimmed
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, "\"")
      .replace(/''/g, "'")
      .replace(/""/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function splitDelimitedRow(row: string, delimiter = ",") {
  const values: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    const next = row[index + 1];
    if (char === "\\" && quote && next !== undefined) {
      current += char + next;
      index += 1;
      continue;
    }
    if ((char === "'" || char === "\"") && (!quote || quote === char)) {
      if (quote === char && next === char) {
        current += char;
        index += 1;
      } else {
        quote = quote ? null : char;
      }
      continue;
    }
    if (char === delimiter && !quote) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

function splitDelimitedRecords(text: string) {
  const records: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\\" && quote && next !== undefined) {
      current += char + next;
      index += 1;
      continue;
    }
    if ((char === "'" || char === "\"") && (!quote || quote === char)) {
      if (quote === char && next === char) {
        current += char;
        index += 1;
      } else {
        quote = quote ? null : char;
      }
      continue;
    }
    if ((char === "\n" || char === "\r") && !quote) {
      if (current.trim()) records.push(current);
      current = "";
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }
    current += char;
  }

  if (current.trim()) records.push(current);
  return records;
}

function parseCsvBuffer(buffer: Buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const records = splitDelimitedRecords(text);
  if (records.length < 2) return [];
  const headers = splitDelimitedRow(records[0]).map((header) => normalizeSqlValue(header));
  return records.slice(1).map((line) => {
    const values = splitDelimitedRow(line).map(normalizeSqlValue);
    return headers.reduce<Record<string, unknown>>((row, header, index) => {
      row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function extractSqlTuples(valuesText: string) {
  const tuples: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;

  for (let index = 0; index < valuesText.length; index += 1) {
    const char = valuesText[index];
    const next = valuesText[index + 1];
    if (char === "\\" && quote && next !== undefined) {
      if (depth > 0) current += char + next;
      index += 1;
      continue;
    }
    if ((char === "'" || char === "\"") && (!quote || quote === char)) {
      if (quote === char && next === char) {
        if (depth > 0) current += char;
        index += 1;
      } else {
        quote = quote ? null : char;
        if (depth > 0) current += char;
      }
      continue;
    }
    if (char === "(" && !quote) {
      if (depth === 0) {
        current = "";
      } else {
        current += char;
      }
      depth += 1;
      continue;
    }
    if (char === ")" && !quote) {
      depth -= 1;
      if (depth === 0) {
        tuples.push(current);
        current = "";
      } else if (depth > 0) {
        current += char;
      }
      continue;
    }
    if (depth > 0) current += char;
  }

  return tuples;
}

function parseSqlBuffer(buffer: Buffer) {
  const text = buffer.toString("utf8");
  const rows: OldAppUserRow[] = [];
  const insertRegex = /insert\s+into\s+`?user`?\s*\(([^)]+)\)\s*values\s*([\s\S]*?);/gi;
  let match: RegExpExecArray | null;

  while ((match = insertRegex.exec(text))) {
    const columns = match[1].split(",").map((column) => column.trim().replace(/[`"']/g, ""));
    const valuesText = match[2];
    for (const tuple of extractSqlTuples(valuesText)) {
      const values = splitDelimitedRow(tuple).map(normalizeSqlValue);
      rows.push(columns.reduce<Record<string, unknown>>((row, column, index) => {
        row[column] = values[index] ?? "";
        return row;
      }, {}));
    }
  }

  return rows;
}

function parseMigrationFile(file: Express.Multer.File) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") return parseSheetBuffer(file.buffer) as OldAppUserRow[];
  if (ext === ".csv") return parseCsvBuffer(file.buffer) as OldAppUserRow[];
  if (ext === ".sql") return parseSqlBuffer(file.buffer);
  throw Object.assign(new Error("Upload a .sql, .csv, or .xlsx file"), { statusCode: 400 });
}

async function prepareMigrationUsers(rows: OldAppUserRow[]) {
  const validRows: Array<{ row: OldAppUserRow; mobile: string; email?: string; sourceIndex: number; createdTimestamp: number }> = [];
  const invalidRows: Array<{ row: number; reason: string; mobile?: unknown; email?: unknown; name?: unknown }> = [];
  let sourceDuplicateCount = 0;

  rows.forEach((row, index) => {
    const rawMobileValue = oldUserCell(row, OLD_USER_COLUMNS.mobile);
    const rawEmailValue = oldUserCell(row, OLD_USER_COLUMNS.email);
    const mobile = cleanMigrationMobile(rawMobileValue);
    const email = normalizeMigrationEmail(rawEmailValue);
    if (!mobile) {
      invalidRows.push({
        row: index + 2,
        reason: "Invalid mobile number",
        name: oldUserCell(row, OLD_USER_COLUMNS.name),
        mobile: rawMobileValue,
        email: rawEmailValue,
      });
      return;
    }
    validRows.push({
      row,
      mobile,
      email,
      sourceIndex: index,
      createdTimestamp: parseMigrationTimestamp(oldUserCell(row, OLD_USER_COLUMNS.createdDateTime)),
    });
  });

  const usedMobiles = new Set<string>();
  const usedEmails = new Set<string>();
  const selectedRows: typeof validRows = [];
  validRows
    .sort((left, right) => {
      const dateDiff = right.createdTimestamp - left.createdTimestamp;
      return dateDiff || right.sourceIndex - left.sourceIndex;
    })
    .forEach((item) => {
      if (usedMobiles.has(item.mobile) || (item.email && usedEmails.has(item.email))) {
        sourceDuplicateCount += 1;
        return;
      }
      usedMobiles.add(item.mobile);
      if (item.email) usedEmails.add(item.email);
      selectedRows.push(item);
    });
  const prepared = selectedRows.map<PreparedMigrationUser>((item) => {
    const row = item.row;
    const createdAt = parseMigrationDate(oldUserCell(row, OLD_USER_COLUMNS.createdDateTime));
    return {
      source: row,
      sourceIndex: item.sourceIndex,
      normalized: {
        name: String(oldUserCell(row, OLD_USER_COLUMNS.name) ?? "").trim() || undefined,
        mobile: item.mobile,
        email: item.email,
        examMode: "BOTH",
        level: "Beginner",
        onboardingComplete: true,
        mobileVerified: true,
        isPremium: Number(oldUserCell(row, OLD_USER_COLUMNS.planId) ?? 0) > 1,
        isAdmin: String(oldUserCell(row, OLD_USER_COLUMNS.role) ?? "").trim().toLowerCase() === "admin",
        migratedFromOldApp: true,
        createdAt,
        updatedAt: new Date(),
      },
    };
  });

  const mobiles = [...new Set(prepared.map((item) => item.normalized.mobile))];
  const emails = [...new Set(prepared.map((item) => item.normalized.email).filter(Boolean))];
  const duplicateFilters = [
    ...(mobiles.length ? [{ mobile: { $in: mobiles } }] : []),
    ...(emails.length ? [{ email: { $in: emails } }] : []),
  ];
  const existingUsers = duplicateFilters.length ? await User.find({ $or: duplicateFilters }).select("mobile email") : [];
  const existingMobiles = new Set(existingUsers.map((user: any) => String(user.mobile)));
  const existingEmails = new Set(existingUsers.map((user: any) => String(user.email ?? "").toLowerCase()).filter(Boolean));
  const importable = prepared.filter((item) => !existingMobiles.has(item.normalized.mobile) && (!item.normalized.email || !existingEmails.has(item.normalized.email)));
  const existingDuplicateCount = prepared.length - importable.length;

  return {
    totalUsers: rows.length,
    prepared,
    importable,
    invalidRows,
    invalidUsers: invalidRows.length,
    duplicateUsers: sourceDuplicateCount + existingDuplicateCount,
    sourceDuplicateCount,
    existingDuplicateCount,
  };
}

function getQuestionExamFields(input: { examType?: unknown; examMode?: unknown; exam?: unknown }) {
  const examType = normalizeExamType(input.examType ?? input.examMode ?? input.exam);
  return {
    examType,
    examMode: examType,
    exam: String(input.exam ?? "").trim().toUpperCase() || (examType === "JEE" ? "JEE_MAIN" : "NEET"),
  };
}

function normalizeTagList(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function normalizeQuestionPayload(body: Record<string, unknown>) {
  const { examMode, exam } = getQuestionExamFields(body);
  const resolvedDifficulty = await resolveDifficultySelection({
    difficulty: body.difficulty,
    difficultyId: body.difficultyId,
  });
  return {
    subjectId: String(body.subjectId ?? ""),
    chapterId: String(body.chapterId ?? ""),
    yearId: body.yearId ? String(body.yearId) : undefined,
    questionTypeId: body.questionTypeId ? String(body.questionTypeId) : undefined,
    modeId: body.modeId ? String(body.modeId) : undefined,
    question: String(body.question ?? "").trim(),
    questionImageUrl: String(body.questionImageUrl ?? "").trim() || undefined,
    optionA: String(body.optionA ?? "").trim() || undefined,
    optionAImageUrl: String(body.optionAImageUrl ?? "").trim() || undefined,
    optionB: String(body.optionB ?? "").trim() || undefined,
    optionBImageUrl: String(body.optionBImageUrl ?? "").trim() || undefined,
    optionC: String(body.optionC ?? "").trim() || undefined,
    optionCImageUrl: String(body.optionCImageUrl ?? "").trim() || undefined,
    optionD: String(body.optionD ?? "").trim() || undefined,
    optionDImageUrl: String(body.optionDImageUrl ?? "").trim() || undefined,
    correctOption: body.correctOption ? String(body.correctOption).trim().toUpperCase() : undefined,
    explanation: String(body.explanation ?? "").trim() || undefined,
    difficultyId: resolvedDifficulty.difficultyId,
    difficulty: resolvedDifficulty.difficultyKey,
    examMode,
    exam,
    responseType: String(body.responseType ?? "single").trim().toLowerCase(),
    conceptTags: normalizeTagList(body.conceptTags),
    numericAnswer: String(body.numericAnswer ?? "").trim() || undefined,
    passage: String(body.passage ?? "").trim() || undefined,
    hasDiagram: parseBoolean(body.hasDiagram) || Boolean(String(body.questionImageUrl ?? "").trim()),
    isNumerical: parseBoolean(body.isNumerical) || String(body.responseType ?? "").trim().toLowerCase() === "numeric",
  };
}

async function hydrateChapters(items: any[]) {
  const subjectIds = [...new Set(items.map((item) => String(item.subjectId)).filter(Boolean))];
  const subjects = await Subject.find({ _id: { $in: subjectIds } });
  const subjectMap = new Map(subjects.map((item) => [String(item._id), item]));

  return items.map((item) => {
    const raw = typeof item?.toJSON === "function" ? item.toJSON() : item;
    const subject = subjectMap.get(String(raw.subjectId));
    return {
      ...raw,
      id: String(raw.id ?? raw._id),
      subjectId: subject ? serializeSubject(subject) : raw.subjectId,
    };
  });
}

async function hydrateQuestions(items: any[]) {
  const normalizedItems = items.map((item) => normalizeQuestionDocument(item));
  const subjectIds = [...new Set(normalizedItems.map((item) => String(item.subjectId)).filter(Boolean))];
  const chapterIds = [...new Set(normalizedItems.map((item) => String(item.chapterId)).filter(Boolean))];
  const yearIds = [...new Set(normalizedItems.map((item) => String(item.yearId)).filter(Boolean))];
  const questionTypeIds = [...new Set(normalizedItems.map((item) => String(item.questionTypeId)).filter(Boolean))];
  const difficultyIds = [...new Set(normalizedItems.map((item) => String(item.difficultyId)).filter(Boolean))];

  const [subjects, chapters, years, questionTypes, difficulties] = await Promise.all([
    Subject.find({ _id: { $in: subjectIds } }),
    Chapter.find({ _id: { $in: chapterIds } }),
    Year.find({ _id: { $in: yearIds } }),
    QuestionType.find({ _id: { $in: questionTypeIds } }),
    Difficulty.find({ _id: { $in: difficultyIds } }),
  ]);

  const subjectMap = new Map(subjects.map((item) => [String(item._id), item]));
  const chapterMap = new Map(chapters.map((item) => [String(item._id), item]));
  const yearMap = new Map(years.map((item) => [String(item._id), item]));
  const questionTypeMap = new Map(questionTypes.map((item) => [String(item._id), item]));
  const difficultyMap = new Map(difficulties.map((item) => [String(item._id), item]));

  return normalizedItems.map((item) => {
    const subject = subjectMap.get(String(item.subjectId));
    const chapter = chapterMap.get(String(item.chapterId));
    const year = yearMap.get(String(item.yearId));
    const questionType = questionTypeMap.get(String(item.questionTypeId));
    const difficulty = difficultyMap.get(String(item.difficultyId));

    return {
      ...item,
      subjectId: subject ? serializeSubject(subject) : item.subjectId,
      chapterId: chapter ? { ...(chapter.toJSON ? chapter.toJSON() : chapter), id: String(chapter._id) } : item.chapterId,
      yearId: year ? serializeYear(year) : item.yearId,
      questionTypeId: questionType ? serializeQuestionType(questionType) : item.questionTypeId,
      difficultyId: difficulty ? serializeDifficulty(difficulty) : item.difficultyId,
      difficulty: difficulty?.key ?? item.difficulty,
      questionTypeLabel: questionType?.name ?? questionType?.label ?? item.questionTypeLabel,
      yearLabel: year?.name ?? item.yearLabel,
      subjectName: subject?.name ?? item.subjectName,
      chapterName: chapter?.name ?? item.chapterName,
      examTypeLabel: getExamTypeLabel(item.exam, item.examMode),
    };
  });
}

async function getUserOverview(userId: string) {
  assertObjectId(userId, "user");
  const user = await User.findById(userId);
  if (!user) throw Object.assign(new Error("User not found"), { statusCode: 404 });

  const id = String(user._id);
  const [
    sessionAttempts,
    questionAttempts,
    subscriptions,
    mistakes,
    weakAreas,
    subjects,
    chapters,
    questions,
    years,
    questionTypes,
  ] = await Promise.all([
    SessionAttempt.find({ userId: id }).sort({ createdAt: -1 }).limit(30),
    QuestionAttempt.find({ userId: id }).sort({ createdAt: -1 }).limit(40),
    Subscription.find({ userId: id }).sort({ createdAt: -1 }),
    Mistake.find({ userId: id }).sort({ updatedAt: -1 }).limit(30),
    ChapterPerformance.find({ userId: id }).sort({ accuracy: 1, updatedAt: -1 }).limit(20),
    Subject.find(),
    Chapter.find(),
    Question.find().select("_id question subjectId chapterId yearId questionTypeId difficulty responseType examMode exam"),
    Year.find(),
    QuestionType.find(),
  ]);

  const subjectMap = new Map(subjects.map((item) => [String(item._id), item]));
  const chapterMap = new Map(chapters.map((item) => [String(item._id), item]));
  const questionMap = new Map(questions.map((item) => [String(item._id), item]));
  const yearMap = new Map(years.map((item) => [String(item._id), item]));
  const questionTypeMap = new Map(questionTypes.map((item) => [String(item._id), item]));

  const average = (items: any[], key: string) => {
    const values = items.map((item) => Number(item[key] || 0)).filter((value) => Number.isFinite(value));
    if (values.length === 0) return 0;
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
  };

  return {
    profile: serializeUser(user),
    performance: {
      attendanceCount: sessionAttempts.length,
      reportCount: sessionAttempts.filter((item) => item.completedAt).length,
      submissionCount: questionAttempts.length,
      averageScore: average(sessionAttempts, "score"),
      averageAccuracy: average(sessionAttempts, "accuracy"),
      averageTimeTaken: average(sessionAttempts, "timeTaken"),
      latestActivityAt:
        sessionAttempts[0]?.createdAt ??
        questionAttempts[0]?.createdAt ??
        mistakes[0]?.updatedAt ??
        user.updatedAt,
    },
    subscriptionSummary: {
      totalSubscriptions: subscriptions.length,
      activeSubscription:
        subscriptions.find((item) => item.status === "active") ??
        subscriptions.find((item) => item.endDate && new Date(item.endDate) > new Date()) ??
        null,
      history: subscriptions.map((item) => (typeof item?.toJSON === "function" ? item.toJSON() : item)),
    },
    mistakeSummary: {
      total: mistakes.length,
      weak: mistakes.filter((item) => item.status === "weak").length,
      improving: mistakes.filter((item) => item.status === "improving").length,
      fresh: mistakes.filter((item) => item.status === "new").length,
    },
    reports: sessionAttempts.map((attempt) => ({
      ...(typeof attempt?.toJSON === "function" ? attempt.toJSON() : attempt),
      attendanceStatus: attempt.completedAt ? "completed" : "started",
    })),
    submissions: questionAttempts.map((attempt) => {
      const question = questionMap.get(String(attempt.questionId));
      const subject = subjectMap.get(String(attempt.subjectId || question?.subjectId));
      const chapter = chapterMap.get(String(attempt.chapterId || question?.chapterId));
      const year = yearMap.get(String(attempt.yearId || question?.yearId));
      const questionType = questionTypeMap.get(String(attempt.questionTypeId || question?.questionTypeId));

      return {
        ...(typeof attempt?.toJSON === "function" ? attempt.toJSON() : attempt),
        question: question?.question || "Question unavailable",
        subjectName: subject?.name || "-",
        chapterName: chapter?.name || "-",
        yearLabel: year?.name ?? "-",
        questionTypeLabel: questionType?.name || questionType?.label || "-",
      };
    }),
    mistakes: mistakes.map((mistake) => {
      const question = questionMap.get(String(mistake.questionId));
      const chapter = chapterMap.get(String(question?.chapterId));
      const subject = subjectMap.get(String(question?.subjectId));
      return {
        ...(typeof mistake?.toJSON === "function" ? mistake.toJSON() : mistake),
        question: question?.question || "Question unavailable",
        chapterName: chapter?.name || "-",
        subjectName: subject?.name || "-",
      };
    }),
    weakAreas: weakAreas.map((area) => {
      const chapter = chapterMap.get(String(area.chapterId));
      const subject = subjectMap.get(String(area.subjectId));
      return {
        ...(typeof area?.toJSON === "function" ? area.toJSON() : area),
        chapterName: chapter?.name || "-",
        subjectName: subject?.name || "-",
      };
    }),
  };
}

function normalizeHeader(header: unknown) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getCell(row: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function normalizeValue(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function resolvePublicBaseUrl(req: AuthenticatedRequest) {
  const appFrontendBaseUrl = String(process.env["APP_FRONTEND_BASE_URL"] || "").trim().replace(/\/+$/, "");
  if (appFrontendBaseUrl) return appFrontendBaseUrl;
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = req.get("host");
  return host ? `${protocol}://${host}` : "";
}

function toPublicImageUrl(req: AuthenticatedRequest, assetPath: string) {
  const base = resolvePublicBaseUrl(req);
  return base ? `${base}${assetPath}` : assetPath;
}

function inferImageExtension(urlValue: string, contentType = "") {
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
  };

  const normalizedType = String(contentType).split(";")[0].trim().toLowerCase();
  if (normalizedType && byMime[normalizedType]) return byMime[normalizedType];

  try {
    const parsed = new URL(urlValue);
    const extension = path.extname(parsed.pathname || "").toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif", ".bmp"].includes(extension)) {
      return extension === ".jpeg" ? ".jpg" : extension;
    }
  } catch {
    return ".jpg";
  }

  return ".jpg";
}

async function saveQuestionAsset(buffer: Buffer, extension: string, seed: string) {
  await fs.mkdir(QUESTION_ASSET_DIR, { recursive: true });
  const filename = `${crypto.createHash("sha1").update(seed).digest("hex")}${extension}`;
  const absolutePath = path.join(QUESTION_ASSET_DIR, filename);
  await fs.writeFile(absolutePath, buffer);
  return `/uploads/question-assets/${filename}`;
}

async function ownImageFromUrl(
  req: AuthenticatedRequest,
  sourceValue: unknown,
  cache: Map<string, Promise<string>>,
) {
  const sourceUrl = String(sourceValue ?? "").trim();
  if (!sourceUrl) return "";

  if (sourceUrl.startsWith("/uploads/")) return sourceUrl;
  if (sourceUrl.startsWith("data:")) return sourceUrl;

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return sourceUrl;
  const host = req.get("host");
  const appFrontendHost = (() => {
    try {
      const base = String(process.env["APP_FRONTEND_BASE_URL"] || "").trim();
      return base ? new URL(base).host : "";
    } catch {
      return "";
    }
  })();
  if ((host && parsed.host === host && parsed.pathname.startsWith("/uploads/")) || (appFrontendHost && parsed.host === appFrontendHost && parsed.pathname.startsWith("/uploads/"))) {
    return parsed.pathname;
  }

  if (cache.has(sourceUrl)) {
    return cache.get(sourceUrl) as Promise<string>;
  }

  const ownershipTask = (async () => {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status})`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error("URL does not return an image");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error("Image response is empty");
    }

    const extension = inferImageExtension(sourceUrl, contentType);
    return saveQuestionAsset(buffer, extension, sourceUrl);
  })();

  cache.set(sourceUrl, ownershipTask);
  try {
    return await ownershipTask;
  } catch (error) {
    cache.delete(sourceUrl);
    throw error;
  }
}

function createLookupKey(subjectValue: unknown, chapterValue: unknown) {
  return `${normalizeValue(subjectValue)}::${normalizeValue(chapterValue)}`;
}

function parseSheetBuffer(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("Spreadsheet must contain at least one sheet");
  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
  return rawRows.map((row) =>
    Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [normalizeHeader(key), value])),
  );
}

function normalizeMappings(rawMappings: unknown) {
  if (!rawMappings) return { subjects: {}, chapters: {}, years: {}, questionTypes: {} };
  if (typeof rawMappings === "string") {
    try {
      return normalizeMappings(JSON.parse(rawMappings));
    } catch {
      return { subjects: {}, chapters: {}, years: {}, questionTypes: {} };
    }
  }
  const mappings = rawMappings as Record<string, Record<string, string>>;
  return {
    subjects: mappings.subjects || {},
    chapters: mappings.chapters || {},
    years: mappings.years || {},
    questionTypes: mappings.questionTypes || {},
  };
}

function formatSubjectLabel(subject: any) {
  return `${subject.name} (${subject.examType ?? subject.examMode})`;
}

async function getBulkIndexes() {
  const [subjects, chapters, years, questionTypes] = await Promise.all([
    Subject.find(),
    Chapter.find(),
    Year.find(),
    QuestionType.find(),
  ]);

  return {
    subjects,
    chapters,
    years,
    questionTypes,
    subjectOptions: subjects.map((item) => ({ id: String(item._id), label: formatSubjectLabel(item) })),
    yearOptions: years.map((item) => ({ id: String(item._id), label: serializeYear(item).name })),
    questionTypeOptions: questionTypes.map((item) => ({ id: String(item._id), label: item.name ?? item.label ?? item.key })),
  };
}

function findSubject(subjects: any[], rawValue: unknown, examType: string, overrideId?: string) {
  if (overrideId) return subjects.find((item) => String(item._id) === String(overrideId)) || null;
  const value = normalizeValue(rawValue);
  return (
    subjects.find(
      (item) =>
        [item.name, item.id].some((entry) => normalizeValue(entry) === value) &&
        String(item.examType ?? item.examMode).toUpperCase() === examType,
    ) || null
  );
}

function findChapter(chapters: any[], rawValue: unknown, subjectId?: string, overrideId?: string) {
  if (!subjectId) return null;
  if (overrideId) {
    const override = chapters.find((item) => String(item._id) === String(overrideId));
    return override && String(override.subjectId) === String(subjectId) ? override : null;
  }
  const value = normalizeValue(rawValue);
  return (
    chapters.find(
      (item) =>
        String(item.subjectId) === String(subjectId) &&
        [item.name, item.id].some((entry) => normalizeValue(entry) === value),
    ) || null
  );
}

function findYear(years: any[], rawValue: unknown, overrideId?: string) {
  if (overrideId) return years.find((item) => String(item._id) === String(overrideId)) || null;
  const value = normalizeValue(rawValue);
  return (
    years.find((item) =>
      [serializeYear(item).name, item.id].some((entry) => normalizeValue(entry) === value),
    ) || null
  );
}

function findQuestionType(questionTypes: any[], rawValue: unknown, overrideId?: string) {
  if (overrideId) return questionTypes.find((item) => String(item._id) === String(overrideId)) || null;
  const value = normalizeValue(rawValue);
  return questionTypes.find((item) => [item.name, item.label, item.key, item.id].some((entry) => normalizeValue(entry) === value)) || null;
}

function buildChapterOptions(chapters: any[], subjectId?: string) {
  if (!subjectId) return [];
  return chapters
    .filter((item) => String(item.subjectId) === String(subjectId))
    .map((item) => ({ id: String(item._id), label: item.name }));
}

async function resolveBulkRow(
  row: Record<string, unknown>,
  indexes: Awaited<ReturnType<typeof getBulkIndexes>>,
  mappings: ReturnType<typeof normalizeMappings>,
  req: AuthenticatedRequest,
  imageCache: Map<string, Promise<string>>,
) {
  const examType = normalizeExamType(getCell(row, QUESTION_COLUMNS.examType) || getCell(row, QUESTION_COLUMNS.examMode));
  const subjectValue = getCell(row, QUESTION_COLUMNS.subject);
  const chapterValue = getCell(row, QUESTION_COLUMNS.chapter);
  const yearValue = getCell(row, QUESTION_COLUMNS.year);
  const questionTypeValue = getCell(row, QUESTION_COLUMNS.questionType);

  const subject = findSubject(indexes.subjects, subjectValue, examType, mappings.subjects?.[normalizeValue(subjectValue)]);
  const chapter = findChapter(
    indexes.chapters,
    chapterValue,
    subject ? String(subject._id) : undefined,
    mappings.chapters?.[createLookupKey(subjectValue, chapterValue)],
  );
  const year = findYear(indexes.years, yearValue, mappings.years?.[normalizeValue(yearValue)]);
  const questionType = findQuestionType(
    indexes.questionTypes,
    questionTypeValue,
    mappings.questionTypes?.[normalizeValue(questionTypeValue)],
  );

  const ownedImageUrls: Partial<Record<(typeof IMAGE_URL_FIELDS)[number], string>> = {};
  const imageErrors: string[] = [];
  const imageSources = {
    questionImageUrl: getCell(row, QUESTION_COLUMNS.questionImage),
    optionAImageUrl: getCell(row, QUESTION_COLUMNS.optionAImage),
    optionBImageUrl: getCell(row, QUESTION_COLUMNS.optionBImage),
    optionCImageUrl: getCell(row, QUESTION_COLUMNS.optionCImage),
    optionDImageUrl: getCell(row, QUESTION_COLUMNS.optionDImage),
  };

  for (const field of IMAGE_URL_FIELDS) {
    const rawValue = String(imageSources[field] ?? "").trim();
    if (!rawValue) continue;
    try {
      const ownedPath = await ownImageFromUrl(req, rawValue, imageCache);
      ownedImageUrls[field] = ownedPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image ownership failed";
      imageErrors.push(`${field}: ${message}`);
    }
  }

  const payload = await normalizeQuestionPayload({
    examType,
    subjectId: subject ? String(subject._id) : "",
    chapterId: chapter ? String(chapter._id) : "",
    yearId: year ? String(year._id) : "",
    questionTypeId: questionType ? String(questionType._id) : "",
    question: getCell(row, QUESTION_COLUMNS.question),
    questionImageUrl: ownedImageUrls.questionImageUrl || imageSources.questionImageUrl,
    optionA: getCell(row, QUESTION_COLUMNS.optionA),
    optionAImageUrl: ownedImageUrls.optionAImageUrl || imageSources.optionAImageUrl,
    optionB: getCell(row, QUESTION_COLUMNS.optionB),
    optionBImageUrl: ownedImageUrls.optionBImageUrl || imageSources.optionBImageUrl,
    optionC: getCell(row, QUESTION_COLUMNS.optionC),
    optionCImageUrl: ownedImageUrls.optionCImageUrl || imageSources.optionCImageUrl,
    optionD: getCell(row, QUESTION_COLUMNS.optionD),
    optionDImageUrl: ownedImageUrls.optionDImageUrl || imageSources.optionDImageUrl,
    correctOption: getCell(row, QUESTION_COLUMNS.correctOption),
    explanation: getCell(row, QUESTION_COLUMNS.explanation),
    difficulty: getCell(row, QUESTION_COLUMNS.difficulty),
    responseType: getCell(row, QUESTION_COLUMNS.responseType),
    numericAnswer: getCell(row, QUESTION_COLUMNS.numericAnswer),
    passage: getCell(row, QUESTION_COLUMNS.passage),
    conceptTags: getCell(row, QUESTION_COLUMNS.conceptTags),
    hasDiagram: getCell(row, QUESTION_COLUMNS.hasDiagram),
    isNumerical: getCell(row, QUESTION_COLUMNS.isNumerical),
  });

  const unresolved = [];
  if (!subject) unresolved.push({ type: "subject", rawValue: String(subjectValue) });
  if (!chapter) {
    unresolved.push({
      type: "chapter",
      rawValue: String(chapterValue),
      subjectRawValue: String(subjectValue),
      key: createLookupKey(subjectValue, chapterValue),
      options: buildChapterOptions(indexes.chapters, subject ? String(subject._id) : undefined),
    });
  }
  if (!year) unresolved.push({ type: "year", rawValue: String(yearValue) });
  if (!questionType) unresolved.push({ type: "questionType", rawValue: String(questionTypeValue) });

  let validationError: string | null = null;
  if (!payload.question && !payload.questionImageUrl) validationError = "Question text or image is required.";
  if (payload.responseType === "numeric" && !payload.numericAnswer) validationError = "Numeric answer is required.";
  if (payload.responseType !== "numeric" && !payload.correctOption) validationError = "Correct option is required.";
  if (imageErrors.length > 0) {
    const imageIssueMessage = `Image ownership failed (${imageErrors.join(" | ")})`;
    validationError = validationError ? `${validationError} | ${imageIssueMessage}` : imageIssueMessage;
  }

  return {
    unresolved,
    payload,
    validationError,
    ownedImages: {
      questionImageUrl: payload.questionImageUrl ? toPublicImageUrl(req, payload.questionImageUrl) : "",
      optionAImageUrl: payload.optionAImageUrl ? toPublicImageUrl(req, payload.optionAImageUrl) : "",
      optionBImageUrl: payload.optionBImageUrl ? toPublicImageUrl(req, payload.optionBImageUrl) : "",
      optionCImageUrl: payload.optionCImageUrl ? toPublicImageUrl(req, payload.optionCImageUrl) : "",
      optionDImageUrl: payload.optionDImageUrl ? toPublicImageUrl(req, payload.optionDImageUrl) : "",
    },
    matched: {
      subject: subject ? { id: String(subject._id), label: formatSubjectLabel(subject) } : null,
      chapter: chapter ? { id: String(chapter._id), label: chapter.name } : null,
      year: year ? { id: String(year._id), label: serializeYear(year).name } : null,
      questionType: questionType ? { id: String(questionType._id), label: questionType.name ?? questionType.label ?? questionType.key } : null,
    },
  };
}

router.get("/stats", wrap(async (_req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [totalUsers, premiumUsers, totalQuestions, totalSubjects, totalChapters, totalSessions, totalTests, subscriptionsThisMonth] =
    await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isPremium: true }),
      Question.countDocuments(),
      Subject.countDocuments(),
      Chapter.countDocuments(),
      LearningSession.countDocuments(),
      Test.countDocuments(),
      Subscription.find({ createdAt: { $gte: monthStart }, status: "active" }).select("amount"),
    ]);

  const revenueThisMonth = subscriptionsThisMonth.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);

  sendSuccess(res, {
    totalUsers,
    premiumUsers,
    totalQuestions,
    totalSubjects,
    totalChapters,
    totalSessions,
    totalTests,
    revenueThisMonth,
  });
}));

router.get("/dashboard", wrap(async (_req, res) => {
  const [stats, recentUsers, recentQuestions, recentSessions, totalReports, totalSubmissions, totalSubscriptions, totalMistakes, totalWeakAreas] =
    await Promise.all([
      Promise.all([
        User.countDocuments(),
        User.countDocuments({ isPremium: true }),
        Question.countDocuments(),
        Subject.countDocuments(),
        Chapter.countDocuments(),
        LearningSession.countDocuments(),
        Test.countDocuments(),
      ]),
      User.find().sort({ createdAt: -1 }).limit(5),
      Question.find().sort({ createdAt: -1 }).limit(5),
      LearningSession.find().sort({ createdAt: -1 }).limit(5),
      SessionAttempt.countDocuments(),
      QuestionAttempt.countDocuments(),
      Subscription.countDocuments(),
      Mistake.countDocuments(),
      ChapterPerformance.countDocuments({ isWeak: true }),
    ]);

  const [totalUsers, premiumUsers, totalQuestions, totalSubjects, totalChapters, totalSessions, totalTests] = stats;

  sendSuccess(res, {
    totalUsers,
    premiumUsers,
    totalQuestions,
    totalSubjects,
    totalChapters,
    totalSessions,
    totalTests,
    userDataSummary: {
      totalReports,
      totalSubmissions,
      totalSubscriptions,
      totalMistakes,
      totalWeakAreas,
    },
    recentActivity: {
      users: recentUsers.map(serializeUser),
      questions: await hydrateQuestions(recentQuestions),
      sessions: recentSessions.map((item) => (typeof item?.toJSON === "function" ? item.toJSON() : item)),
    },
  });
}));

router.get("/catalog", wrap(async (_req, res) => {
  const [modes, subjects, chapters, years, questionTypes, questions] = await Promise.all([
    Mode.countDocuments(),
    ExamType.countDocuments(),
    Subject.countDocuments(),
    Chapter.countDocuments(),
    Year.countDocuments(),
    QuestionType.countDocuments(),
    Question.countDocuments(),
  ]);

  sendSuccess(res, { modes, examTypes, subjects, chapters, years, questionTypes, questions });
}));

router.get("/users/:id/overview", wrap(async (req, res) => {
  sendSuccess(res, await getUserOverview(String(req.params.id)));
}));

router.post("/questions/upload-asset", upload.single("image"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw Object.assign(new Error("Image file is required"), { statusCode: 400 });
  const extension = inferImageExtension(req.file.originalname || "", req.file.mimetype || "");
  const seed = `${req.file.originalname || "question-asset"}-${Date.now()}-${Math.random()}`;
  const assetPath = await saveQuestionAsset(req.file.buffer, extension, seed);
  sendSuccess(res, {
    path: assetPath,
    url: toPublicImageUrl(req, assetPath),
  }, { status: 201, message: "Image uploaded successfully" });
}));

router.post("/questions/own-asset-url", wrap(async (req, res) => {
  const sourceUrl = String(req.body?.url ?? "").trim();
  if (!sourceUrl) {
    throw Object.assign(new Error("Image URL is required"), { statusCode: 400 });
  }

  const ownedPath = await ownImageFromUrl(req, sourceUrl, new Map<string, Promise<string>>());
  sendSuccess(res, {
    sourceUrl,
    path: ownedPath,
    url: toPublicImageUrl(req, ownedPath),
  }, { message: "Image URL converted to owned storage" });
}));

router.post("/questions/bulk-upload/preview", upload.single("sheet"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw new Error("Spreadsheet file is required");
  const rows = parseSheetBuffer(req.file.buffer);
  const mappings = normalizeMappings(req.body?.mappings);
  const indexes = await getBulkIndexes();
  const imageCache = new Map<string, Promise<string>>();
  const resolutions = await Promise.all(rows.map((row) => resolveBulkRow(row, indexes, mappings, req, imageCache)));

  const unresolved = { subjects: [] as any[], chapters: [] as any[], years: [] as any[], questionTypes: [] as any[] };
  const seen = { subjects: new Set<string>(), chapters: new Set<string>(), years: new Set<string>(), questionTypes: new Set<string>() };

  resolutions.forEach((resolution) => {
    resolution.unresolved.forEach((item: any) => {
      if (item.type === "subject" && !seen.subjects.has(normalizeValue(item.rawValue))) {
        seen.subjects.add(normalizeValue(item.rawValue));
        unresolved.subjects.push({ rawValue: item.rawValue, options: indexes.subjectOptions });
      }
      if (item.type === "chapter" && !seen.chapters.has(item.key)) {
        seen.chapters.add(item.key);
        unresolved.chapters.push(item);
      }
      if (item.type === "year" && !seen.years.has(normalizeValue(item.rawValue))) {
        seen.years.add(normalizeValue(item.rawValue));
        unresolved.years.push({ rawValue: item.rawValue, options: indexes.yearOptions });
      }
      if (item.type === "questionType" && !seen.questionTypes.has(normalizeValue(item.rawValue))) {
        seen.questionTypes.add(normalizeValue(item.rawValue));
        unresolved.questionTypes.push({ rawValue: item.rawValue, options: indexes.questionTypeOptions });
      }
    });
  });

  const readyRows = resolutions.filter((item) => item.unresolved.length === 0 && !item.validationError).length;
  sendSuccess(res, {
    totalRows: rows.length,
    readyRows,
    unresolvedCounts: {
      subjects: unresolved.subjects.length,
      chapters: unresolved.chapters.length,
      years: unresolved.years.length,
      questionTypes: unresolved.questionTypes.length,
    },
    unresolved,
    previewRows: rows.slice(0, 12).map((row, index) => ({
      row: index + 2,
      question: String(getCell(row, QUESTION_COLUMNS.question)).slice(0, 120) || "[Image Question]",
      matched: resolutions[index].matched,
      ownedImages: resolutions[index].ownedImages,
      unresolved: resolutions[index].unresolved,
      validationError: resolutions[index].validationError,
    })),
    chunkPlan: {
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(readyRows / CHUNK_SIZE) || 0,
    },
  });
}));

router.post("/questions/bulk-upload", upload.single("sheet"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw new Error("Spreadsheet file is required");
  const rows = parseSheetBuffer(req.file.buffer);
  const mappings = normalizeMappings(req.body?.mappings);
  const indexes = await getBulkIndexes();
  const imageCache = new Map<string, Promise<string>>();
  const preparedDocs: Record<string, unknown>[] = [];
  const skippedRows: Array<{ row: number; reason: string }> = [];

  for (const [index, row] of rows.entries()) {
    const resolution = await resolveBulkRow(row, indexes, mappings, req, imageCache);
    if (resolution.unresolved.length > 0 || resolution.validationError) {
      skippedRows.push({
        row: index + 2,
        reason:
          resolution.validationError ||
          resolution.unresolved.map((item: any) => `${item.type}: ${item.rawValue}`).join(", "),
      });
      continue;
    }
    preparedDocs.push(resolution.payload);
  }

  const chunks = [];
  let createdCount = 0;
  for (let index = 0; index < preparedDocs.length; index += CHUNK_SIZE) {
    const chunk = preparedDocs.slice(index, index + CHUNK_SIZE);
    const inserted = await Question.insertMany(chunk, { ordered: false });
    createdCount += inserted.length;
    chunks.push({ batch: chunks.length + 1, size: chunk.length, inserted: inserted.length });
  }

  sendSuccess(res, {
    totalRows: rows.length,
    readyRows: preparedDocs.length,
    skippedCount: skippedRows.length,
    createdCount,
    chunks,
    skippedRows: skippedRows.slice(0, 100),
  }, { status: 201, message: "Bulk question upload completed" });
}));

router.get("/modes", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = buildSearchFilter(query, ["key", "label", "description"]);
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "label", "key"]);
  const [items, total] = await Promise.all([
    Mode.find(filters).sort(sort).skip(skip).limit(limit),
    Mode.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeMode), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/exam-types", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = buildSearchFilter(query, ["name", "key", "label", "description"]);
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "name", "key", "label"], "name");
  const [items, total] = await Promise.all([
    ExamType.find(filters).sort(sort).skip(skip).limit(limit),
    ExamType.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeExamType), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/exam-types/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "exam type");
  const item = await ExamType.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Exam type not found"), { statusCode: 404 });
  sendSuccess(res, serializeExamType(item));
}));

router.post("/exam-types", wrap(async (req, res) => {
  const item = await ExamType.create({
    name: normalizeExamType(req.body?.name),
    description: String(req.body?.description ?? "").trim() || undefined,
  });
  sendSuccess(res, serializeExamType(item), { status: 201, message: "Exam type created successfully" });
}));

router.put("/exam-types/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "exam type");
  const item = await ExamType.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Exam type not found"), { statusCode: 404 });
  if (req.body?.name !== undefined) item.set("name", normalizeExamType(req.body.name));
  if (req.body?.description !== undefined) item.description = String(req.body.description).trim();
  await item.save();
  sendSuccess(res, serializeExamType(item), { message: "Exam type updated successfully" });
}));

router.delete("/exam-types/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "exam type");
  const item = await ExamType.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Exam type not found"), { statusCode: 404 });
  const examTypeName = String(item.get("name") ?? item.get("key") ?? item.get("label") ?? "").trim().toUpperCase();
  const questionTypeFilters =
    examTypeName === "JEE"
      ? {
          $or: [
            { examType: "JEE" },
            { examCategory: "JEE" },
            { examCategory: "JEE_MAIN" },
            { examCategory: "JEE_ADVANCED" },
          ],
        }
      : {
          $or: [
            { examType: examTypeName },
            { examCategory: examTypeName },
          ],
        };
  const [subjectCount, yearCount, questionTypeCount] = await Promise.all([
    Subject.countDocuments({ examType: examTypeName }),
    Year.countDocuments({ examType: examTypeName }),
    QuestionType.countDocuments(questionTypeFilters),
  ]);
  if (subjectCount > 0 || yearCount > 0 || questionTypeCount > 0) {
    throw Object.assign(new Error("Remove or reassign related subjects, years, and question types before deleting this exam type"), { statusCode: 400 });
  }
  await item.deleteOne();
  sendSuccess(res, null, { message: "Exam type deleted successfully" });
}));

router.get("/modes/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "mode");
  const item = await Mode.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Mode not found"), { statusCode: 404 });
  sendSuccess(res, serializeMode(item));
}));

router.post("/modes", wrap(async (req, res) => {
  const item = await Mode.create({
    key: String(req.body?.key ?? "").trim().toUpperCase(),
    label: String(req.body?.label ?? "").trim(),
    description: String(req.body?.description ?? "").trim() || undefined,
  });
  sendSuccess(res, serializeMode(item), { status: 201, message: "Mode created successfully" });
}));

router.put("/modes/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "mode");
  const item = await Mode.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Mode not found"), { statusCode: 404 });
  if (req.body?.key) item.key = String(req.body.key).trim().toUpperCase() as any;
  if (req.body?.label !== undefined) item.label = String(req.body.label).trim();
  if (req.body?.description !== undefined) item.description = String(req.body.description).trim();
  await item.save();
  sendSuccess(res, serializeMode(item), { message: "Mode updated successfully" });
}));

router.delete("/modes/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "mode");
  await Mode.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Mode deleted successfully" });
}));

router.get("/subjects", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["examType"]), ...buildSearchFilter(query, ["name", "icon", "color"]) };
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "name", "examType"], "name");
  const [items, total] = await Promise.all([
    Subject.find(filters).sort(sort).skip(skip).limit(limit),
    Subject.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeSubject), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/subjects/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "subject");
  const item = await Subject.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Subject not found"), { statusCode: 404 });
  sendSuccess(res, serializeSubject(item));
}));

router.post("/subjects", wrap(async (req, res) => {
  const examType = await ensureExamTypeExists(req.body?.examType);
  const item = await Subject.create({
    name: String(req.body?.name ?? "").trim(),
    examType,
    examMode: examType,
    icon: String(req.body?.icon ?? "").trim() || undefined,
    color: String(req.body?.color ?? "").trim() || undefined,
  });
  sendSuccess(res, serializeSubject(item), { status: 201, message: "Subject created successfully" });
}));

router.put("/subjects/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "subject");
  const item = await Subject.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Subject not found"), { statusCode: 404 });
  if (req.body?.name !== undefined) item.name = String(req.body.name).trim();
  if (req.body?.examType !== undefined) {
    const examType = await ensureExamTypeExists(req.body.examType);
    item.examType = examType as any;
    item.examMode = examType as any;
  }
  if (req.body?.icon !== undefined) item.icon = String(req.body.icon).trim();
  if (req.body?.color !== undefined) item.color = String(req.body.color).trim();
  await item.save();
  sendSuccess(res, serializeSubject(item), { message: "Subject updated successfully" });
}));

router.delete("/subjects/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "subject");
  const [chapterCount, questionCount] = await Promise.all([
    Chapter.countDocuments({ subjectId: req.params.id }),
    Question.countDocuments({ subjectId: req.params.id }),
  ]);
  if (chapterCount > 0 || questionCount > 0) {
    throw Object.assign(new Error("Delete related chapters and questions before removing this subject"), { statusCode: 400 });
  }
  await Subject.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Subject deleted successfully" });
}));

router.get("/chapters", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["subjectId"]), ...buildSearchFilter(query, ["name"]) };
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "name"], "name");
  const [items, total] = await Promise.all([
    Chapter.find(filters).sort(sort).skip(skip).limit(limit),
    Chapter.countDocuments(filters),
  ]);
  sendSuccess(res, await hydrateChapters(items), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/chapters/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "chapter");
  const item = await Chapter.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Chapter not found"), { statusCode: 404 });
  sendSuccess(res, (await hydrateChapters([item]))[0]);
}));

router.post("/chapters", wrap(async (req, res) => {
  const item = await Chapter.create({
    subjectId: String(req.body?.subjectId ?? ""),
    name: String(req.body?.name ?? "").trim(),
    isLockedForFreeUsers: req.body?.isLockedForFreeUsers === undefined ? false : parseBoolean(req.body.isLockedForFreeUsers),
  });
  sendSuccess(res, (await hydrateChapters([item]))[0], { status: 201, message: "Chapter created successfully" });
}));

router.put("/chapters/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "chapter");
  const item = await Chapter.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Chapter not found"), { statusCode: 404 });
  if (req.body?.subjectId !== undefined) item.subjectId = String(req.body.subjectId);
  if (req.body?.name !== undefined) item.name = String(req.body.name).trim();
  if (req.body?.isLockedForFreeUsers !== undefined) item.isLockedForFreeUsers = parseBoolean(req.body.isLockedForFreeUsers);
  await item.save();
  sendSuccess(res, (await hydrateChapters([item]))[0], { message: "Chapter updated successfully" });
}));

router.delete("/chapters/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "chapter");
  const questionCount = await Question.countDocuments({ chapterId: req.params.id });
  if (questionCount > 0) throw Object.assign(new Error("Delete related questions before removing this chapter"), { statusCode: 400 });
  await Chapter.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Chapter deleted successfully" });
}));

router.get("/years", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["examType"]), ...buildSearchFilter(query, ["name"]) };
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "name", "examType"], "name");
  const [items, total] = await Promise.all([
    Year.find(filters).sort(sort).skip(skip).limit(limit),
    Year.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeYear), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/years/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "year");
  const item = await Year.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Year not found"), { statusCode: 404 });
  sendSuccess(res, serializeYear(item));
}));

router.post("/years", wrap(async (req, res) => {
  const payload = normalizeYearPayload(req.body ?? {});
  if (payload.examType) payload.examType = await ensureExamTypeExists(payload.examType);
  const item = await Year.create(payload);
  sendSuccess(res, serializeYear(item), { status: 201, message: "Year created successfully" });
}));

router.put("/years/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "year");
  const item = await Year.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Year not found"), { statusCode: 404 });
  const payload = normalizeYearPayload(req.body ?? {});
  if (payload.examType) payload.examType = await ensureExamTypeExists(payload.examType);
  Object.assign(item, payload);
  await item.save();
  sendSuccess(res, serializeYear(item), { message: "Year updated successfully" });
}));

router.delete("/years/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "year");
  await Year.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Year deleted successfully" });
}));

router.get("/question-types", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["examType", "examCategory"]), ...buildSearchFilter(query, ["name", "key", "label", "description"]) };
  if ("examType" in filters && !("examCategory" in filters)) {
    filters.examCategory = filters.examType;
    delete filters.examType;
  }
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "name", "examType", "label", "key"], "name");
  const [items, total] = await Promise.all([
    QuestionType.find(filters).sort(sort).skip(skip).limit(limit),
    QuestionType.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeQuestionType), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/question-types/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "question type");
  const item = await QuestionType.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Question type not found"), { statusCode: 404 });
  sendSuccess(res, serializeQuestionType(item));
}));

router.post("/question-types", wrap(async (req, res) => {
  const payload = normalizeQuestionTypePayload(req.body ?? {});
  const resolvedExamType = await ensureExamTypeExists(payload.examType || payload.examCategory);
  payload.examType = resolvedExamType;
  payload.examCategory = resolvedExamType;
  const item = await QuestionType.create(payload);
  sendSuccess(res, serializeQuestionType(item), { status: 201, message: "Question type created successfully" });
}));

router.put("/question-types/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "question type");
  const item = await QuestionType.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Question type not found"), { statusCode: 404 });
  const payload = normalizeQuestionTypePayload(req.body ?? {});
  const resolvedExamType = await ensureExamTypeExists(payload.examType || payload.examCategory || item.examType || item.examCategory);
  payload.examType = resolvedExamType;
  payload.examCategory = resolvedExamType;
  Object.assign(item, payload);
  await item.save();
  sendSuccess(res, serializeQuestionType(item), { message: "Question type updated successfully" });
}));

router.delete("/question-types/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "question type");
  await QuestionType.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Question type deleted successfully" });
}));

router.get("/questions", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters: Record<string, unknown> = {
    ...exactFilter(query, ["subjectId", "chapterId", "yearId", "questionTypeId", "difficulty", "responseType"]),
    ...buildSearchFilter(query, ["question", "explanation"]),
  };
  if (query.examType) filters.examMode = normalizeExamType(query.examType);
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "difficulty"], "createdAt");
  const [items, total] = await Promise.all([
    Question.find(filters).sort(sort).skip(skip).limit(limit),
    Question.countDocuments(filters),
  ]);
  sendSuccess(res, await hydrateQuestions(items), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/questions/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "question");
  const item = await Question.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Question not found"), { statusCode: 404 });
  sendSuccess(res, (await hydrateQuestions([item]))[0]);
}));

router.post("/questions", wrap(async (req, res) => {
  const item = await Question.create(await normalizeQuestionPayload(req.body ?? {}));
  sendSuccess(res, (await hydrateQuestions([item]))[0], { status: 201, message: "Question created successfully" });
}));

router.put("/questions/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "question");
  const item = await Question.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Question not found"), { statusCode: 404 });
  Object.assign(item, await normalizeQuestionPayload({ ...item.toJSON(), ...(req.body ?? {}) }));
  await item.save();
  sendSuccess(res, (await hydrateQuestions([item]))[0], { message: "Question updated successfully" });
}));

router.delete("/questions/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "question");
  await Question.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Question deleted successfully" });
}));

router.get("/users", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["isPremium", "isAdmin", "onboardingComplete", "examMode"]), ...buildSearchFilter(query, ["name", "mobile", "email"]) };
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "name", "mobile"], "createdAt");
  const [items, total] = await Promise.all([
    User.find(filters).sort(sort).skip(skip).limit(limit),
    User.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeUser), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.post("/users/migration/preview", upload.single("file"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw Object.assign(new Error("Migration file is required"), { statusCode: 400 });
  const rows = parseMigrationFile(req.file);
  const summary = await prepareMigrationUsers(rows);
  sendSuccess(res, {
    totalUsers: summary.totalUsers,
    importableUsers: summary.importable.length,
    duplicateUsers: summary.duplicateUsers,
    invalidUsers: summary.invalidUsers,
    sourceDuplicateUsers: summary.sourceDuplicateCount,
    existingDuplicateUsers: summary.existingDuplicateCount,
    previewRows: summary.importable.slice(0, 12).map((item) => ({
      name: item.normalized.name,
      mobile: item.normalized.mobile,
      email: item.normalized.email,
      isPremium: item.normalized.isPremium,
      isAdmin: item.normalized.isAdmin,
      createdAt: item.normalized.createdAt,
    })),
    invalidRows: summary.invalidRows.slice(0, 25),
  });
}));

router.post("/users/migration/import", upload.single("file"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw Object.assign(new Error("Migration file is required"), { statusCode: 400 });
  const rows = parseMigrationFile(req.file);
  const summary = await prepareMigrationUsers(rows);
  const docs = summary.importable.map((item) => item.normalized);
  const inserted = docs.length ? await User.insertMany(docs, { ordered: false }) : [];
  const log = await MigrationLog.create({
    totalUsers: summary.totalUsers,
    importedUsers: inserted.length,
    duplicateUsers: summary.duplicateUsers,
    invalidUsers: summary.invalidUsers,
    migrationDate: new Date(),
  });

  sendSuccess(res, {
    totalUsers: summary.totalUsers,
    importedUsers: inserted.length,
    duplicateUsers: summary.duplicateUsers,
    invalidUsers: summary.invalidUsers,
    migrationDate: log.migrationDate,
    logId: String(log._id),
  }, { status: 201, message: "Old app users imported successfully" });
}));

router.get("/users/migration/logs", wrap(async (_req, res) => {
  const logs = await MigrationLog.find().sort({ migrationDate: -1 }).limit(20);
  sendSuccess(res, logs.map((log: any) => {
    const raw = log.toJSON ? log.toJSON() : log;
    return {
      id: String(raw.id ?? raw._id),
      totalUsers: raw.totalUsers,
      importedUsers: raw.importedUsers,
      duplicateUsers: raw.duplicateUsers,
      invalidUsers: raw.invalidUsers,
      migrationDate: raw.migrationDate,
    };
  }));
}));

router.get("/users/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "user");
  const item = await User.findById(req.params.id);
  if (!item) throw Object.assign(new Error("User not found"), { statusCode: 404 });
  sendSuccess(res, serializeUser(item));
}));

router.post("/users", wrap(async (req, res) => {
  const payload = normalizeUserPayload(req.body ?? {});
  const item = await User.create({
    mobile: payload.mobile,
    email: payload.email,
    name: payload.name,
    examMode: payload.examMode,
    level: payload.level,
    onboardingComplete: payload.onboardingComplete ?? false,
    isPremium: payload.isPremium ?? false,
    premiumExpiresAt: payload.premiumExpiresAt,
    isAdmin: payload.isAdmin ?? false,
    ...(payload.password ? { passwordHash: hashPassword(payload.password) } : {}),
  });
  sendSuccess(res, serializeUser(item), { status: 201, message: "User created successfully" });
}));

router.put("/users/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "user");
  const item = await User.findById(req.params.id);
  if (!item) throw Object.assign(new Error("User not found"), { statusCode: 404 });
  const payload = normalizeUserPayload(req.body ?? {});
  if (payload.mobile) item.mobile = payload.mobile;
  if (req.body?.email !== undefined) item.email = payload.email;
  if (req.body?.name !== undefined) item.name = payload.name;
  if (req.body?.examMode !== undefined) item.examMode = payload.examMode as any;
  if (req.body?.level !== undefined) item.level = payload.level as any;
  if (req.body?.onboardingComplete !== undefined) item.onboardingComplete = Boolean(payload.onboardingComplete);
  if (req.body?.isPremium !== undefined) item.isPremium = Boolean(payload.isPremium);
  if (req.body?.premiumExpiresAt !== undefined) item.premiumExpiresAt = payload.premiumExpiresAt;
  if (req.body?.isAdmin !== undefined) item.isAdmin = Boolean(payload.isAdmin);
  if (payload.password) item.passwordHash = hashPassword(payload.password);
  await item.save();
  sendSuccess(res, serializeUser(item), { message: "User updated successfully" });
}));

router.delete("/users/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "user");
  await User.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "User deleted successfully" });
}));

export default router;
