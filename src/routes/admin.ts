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
  EmailLog,
  Difficulty,
  EmailTemplate,
  ExamType,
  HelpDeskSettings,
  Invoice,
  InvoiceSettings,
  LearningLevel,
  LearningSession,
  MigrationLog,
  Mistake,
  Mode,
  NotificationSettings,
  Question,
  QuestionAttempt,
  QuestionType,
  SessionAttempt,
  Subject,
  Subscription,
  SubscriptionPlan,
  SupportTicket,
  Test,
  User,
  UserNotification,
  Year,
} from "@api/db";
import type { AuthenticatedRequest } from "../middlewares/auth";
import { requireAdmin } from "../middlewares/auth";
import { resolveDifficultySelection } from "../lib/difficulties";
import { getExamTypeLabel, normalizeQuestionDocument } from "../lib/question-framework";
import { generateInvoiceForSubscription, getActiveInvoiceTemplate, getInvoiceSettings, getNotificationSettings, processExpiryReminders, regenerateInvoicePdf, renderInvoicePdf } from "../lib/invoices";
import { COMMON_EMAIL_VARIABLES, EMAIL_TEMPLATE_DEFINITIONS, EMAIL_TEMPLATE_KEYS, buildTemplateFromDefinition, buildTemplatePreview, extractTemplateVariables, resolveTemplate, sampleEmailVariables, sendTemplatedEmail, templateVariablesFor, validateTemplateVariables } from "../lib/email-templates";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const CHUNK_SIZE = 100;
const QUESTION_ASSET_DIR = process.env["QUESTION_ASSET_DIR"]
  ? path.resolve(process.env["QUESTION_ASSET_DIR"])
  : path.resolve(process.cwd(), "../krita-neet-jee/public/uploads/question-assets");
const INVOICE_ASSET_DIR = path.resolve(process.cwd(), "uploads", "invoice-assets");
const SUPPORT_ASSET_DIR = path.resolve(process.cwd(), "uploads", "support");
const NOTIFICATION_ASSET_DIR = path.resolve(process.cwd(), "uploads", "notifications");
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
    if (value === undefined || value === "" || value === "all") return acc;
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

function serializeLearningLevel(level: any) {
  const raw = typeof level?.toJSON === "function" ? level.toJSON() : level;
  return {
    id: String(raw.id ?? raw._id),
    key: raw.key,
    label: raw.label,
    description: raw.description ?? "",
    sortOrder: Number(raw.sortOrder ?? 0),
    active: raw.active !== false,
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
  const rawValue = raw.value ?? Number(raw.name ?? raw.label);
  const value = Number.isFinite(rawValue) ? Number(rawValue) : undefined;
  return {
    id: String(raw.id ?? raw._id),
    name: raw.name,
    label: raw.label ?? raw.name,
    value,
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
  const label = String(body.label ?? name).trim();
  const rawValue = body.value ?? name;
  const value = Number(rawValue);
  return {
    name,
    label,
    value: Number.isFinite(value) ? value : undefined,
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

async function saveQuestionAsset(buffer: Buffer, extension: string, hashInput: string) {
  await fs.mkdir(QUESTION_ASSET_DIR, { recursive: true });
  const filename = `${crypto.createHash("sha1").update(hashInput).digest("hex")}${extension}`;
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
      [serializeYear(item).name, serializeYear(item).label, serializeYear(item).value, item.id].some((entry) => normalizeValue(entry) === value),
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
  const hashInput = `${req.file.originalname || "question-asset"}-${Date.now()}-${Math.random()}`;
  const assetPath = await saveQuestionAsset(req.file.buffer, extension, hashInput);
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

router.get("/learning-levels", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["active"]), ...buildSearchFilter(query, ["key", "label", "description"]) };
  const sort = normalizeSort(query, ["createdAt", "updatedAt", "sortOrder", "label", "key"], "sortOrder");
  const [items, total] = await Promise.all([
    LearningLevel.find(filters).sort(sort).skip(skip).limit(limit),
    LearningLevel.countDocuments(filters),
  ]);
  sendSuccess(res, items.map(serializeLearningLevel), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/learning-levels/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "learning level");
  const item = await LearningLevel.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Learning level not found"), { statusCode: 404 });
  sendSuccess(res, serializeLearningLevel(item));
}));

router.post("/learning-levels/bulk-delete", wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id: string) => mongoose.isValidObjectId(id)) : [];
  const result = ids.length ? await LearningLevel.deleteMany({ _id: { $in: ids } }) : { deletedCount: 0 };
  sendSuccess(res, { deletedCount: Number(result.deletedCount || 0), failedCount: 0 }, { message: "Learning levels deleted successfully" });
}));

router.post("/learning-levels", wrap(async (req, res) => {
  const item = await LearningLevel.create({
    key: String(req.body?.key ?? "").trim(),
    label: String(req.body?.label ?? "").trim(),
    description: String(req.body?.description ?? "").trim() || undefined,
    sortOrder: Number(req.body?.sortOrder ?? 0),
    active: req.body?.active === undefined ? true : Boolean(req.body.active),
  });
  sendSuccess(res, serializeLearningLevel(item), { status: 201, message: "Learning level created successfully" });
}));

router.put("/learning-levels/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "learning level");
  const item = await LearningLevel.findById(req.params.id);
  if (!item) throw Object.assign(new Error("Learning level not found"), { statusCode: 404 });
  if (req.body?.key !== undefined) item.key = String(req.body.key).trim();
  if (req.body?.label !== undefined) item.label = String(req.body.label).trim();
  if (req.body?.description !== undefined) item.description = String(req.body.description).trim();
  if (req.body?.sortOrder !== undefined) item.sortOrder = Number(req.body.sortOrder ?? 0);
  if (req.body?.active !== undefined) item.active = Boolean(req.body.active);
  await item.save();
  sendSuccess(res, serializeLearningLevel(item), { message: "Learning level updated successfully" });
}));

router.delete("/learning-levels/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "learning level");
  await LearningLevel.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Learning level deleted successfully" });
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

router.get("/invoice-settings", wrap(async (_req, res) => {
  sendSuccess(res, (await getInvoiceSettings()).toJSON());
}));

router.post("/invoice-settings/logo", upload.single("logo"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw Object.assign(new Error("Logo file is required"), { statusCode: 400 });
  await fs.mkdir(INVOICE_ASSET_DIR, { recursive: true });
  const extension = inferImageExtension(req.file.originalname || "", req.file.mimetype || "");
  const fileName = `invoice-logo-${Date.now()}${extension}`;
  const fullPath = path.join(INVOICE_ASSET_DIR, fileName);
  await fs.writeFile(fullPath, req.file.buffer);
  const logoUrl = `/uploads/invoice-assets/${fileName}`;
  const settings = await getInvoiceSettings();
  settings.logoUrl = logoUrl;
  await settings.save();
  sendSuccess(res, { logoUrl }, { message: "Invoice logo uploaded" });
}));

router.post("/invoice-settings", wrap(async (req, res) => {
  const existing = await getInvoiceSettings();
  const body = req.body ?? {};
  existing.enabled = body.enabled === undefined ? existing.enabled : parseBoolean(body.enabled);
  existing.emailEnabled = body.emailEnabled === undefined ? existing.emailEnabled : parseBoolean(body.emailEnabled);
  existing.companyName = String(body.companyName ?? existing.companyName ?? "").trim() || "Krita NEET JEE";
  existing.companyAddress = String(body.companyAddress ?? "");
  existing.companyEmail = String(body.companyEmail ?? "");
  existing.companyPhone = String(body.companyPhone ?? "");
  existing.logoUrl = String(body.logoUrl ?? existing.logoUrl ?? "");
  existing.templateTitle = String(body.templateTitle ?? existing.templateTitle ?? "Tax Invoice");
  existing.templateIntro = String(body.templateIntro ?? existing.templateIntro ?? "");
  existing.footerText = String(body.footerText ?? existing.footerText ?? "");
  existing.productDetailsTitle = String(body.productDetailsTitle ?? existing.productDetailsTitle ?? "Product Details");
  existing.paidStampText = String(body.paidStampText ?? existing.paidStampText ?? "PAID");
  existing.defaultTaxPercent = Math.max(0, Math.min(100, Number(body.defaultTaxPercent ?? existing.defaultTaxPercent ?? 0)));
  existing.defaultConvenienceChargePercent = Math.max(0, Math.min(100, Number(body.defaultConvenienceChargePercent ?? existing.defaultConvenienceChargePercent ?? 0)));
  existing.defaultConvenienceChargeGstPercent = Math.max(0, Math.min(100, Number(body.defaultConvenienceChargeGstPercent ?? existing.defaultConvenienceChargeGstPercent ?? 0)));
  const normalizeFields = (fields: any[] = []) => fields.map((field: any) => ({
      ...field,
      id: String(field.id ?? `field-${Date.now()}`),
      type: String(field.type ?? "text"),
      label: String(field.label ?? field.content ?? ""),
      content: String(field.content ?? field.label ?? ""),
      src: String(field.src ?? ""),
      x: Math.max(0, Math.min(560, Number(field.x ?? 48))),
      y: Math.max(0, Math.min(820, Number(field.y ?? 120))),
      width: Math.max(10, Math.min(595, Number(field.width ?? 120))),
      height: Math.max(10, Math.min(842, Number(field.height ?? 80))),
      size: Math.max(6, Math.min(96, Number(field.size ?? field.style?.fontSize ?? 10))),
      rotation: Number(field.rotation ?? 0),
      opacity: Math.max(0, Math.min(1, Number(field.opacity ?? 1))),
      zIndex: Number(field.zIndex ?? 1),
      enabled: field.enabled !== false,
    }));
  if (Array.isArray(body.fields)) {
    existing.fields = normalizeFields(body.fields) as any;
  }
  existing.page = body.page || existing.page || {};
  if (Array.isArray(body.reusableBlocks)) {
    const blocks = body.reusableBlocks.map((block: any) => ({
      ...block,
      id: String(block.id || `template-${Date.now()}-${Math.floor(Math.random() * 1000)}`),
      name: String(block.name || "Invoice Template"),
      type: String(block.type || "fabric-template"),
      fields: Array.isArray(block.fields) ? normalizeFields(block.fields) : block.fields,
    }));
    const activeIndex = blocks.findIndex((block: any) => block.type === "fabric-template" && block.active);
    existing.reusableBlocks = blocks.map((block: any, index: number) => block.type === "fabric-template" ? { ...block, active: activeIndex >= 0 ? index === activeIndex : index === 0 } : block) as any;
    const active = getActiveInvoiceTemplate(existing);
    existing.activeTemplateId = active?.id || "";
    existing.activeTemplateName = active?.name || "";
    if (Array.isArray(active?.fields) && active.fields.length) existing.fields = normalizeFields(active.fields) as any;
  }
  existing.defaultTemplate = body.defaultTemplate === undefined ? existing.defaultTemplate : Boolean(body.defaultTemplate);
  existing.versions = [
    {
      savedAt: new Date(),
      label: `Version ${new Date().toLocaleString("en-IN")}`,
      fields: existing.fields,
      page: existing.page,
    },
    ...(Array.isArray(existing.versions) ? existing.versions.slice(0, 9) : []),
  ] as any;
  const smtp = body.smtp ?? {};
  existing.smtp = {
    host: String(smtp.host ?? existing.smtp?.host ?? ""),
    port: Number(smtp.port ?? existing.smtp?.port ?? 587),
    secure: parseBoolean(smtp.secure ?? existing.smtp?.secure),
    user: String(smtp.user ?? existing.smtp?.user ?? ""),
    pass: smtp.pass ? String(smtp.pass) : String(existing.smtp?.pass ?? ""),
    accessToken: smtp.accessToken ? String(smtp.accessToken) : String(existing.smtp?.accessToken ?? ""),
    fromName: String(smtp.fromName ?? existing.smtp?.fromName ?? "Krita Admin"),
    fromEmail: String(smtp.fromEmail ?? existing.smtp?.fromEmail ?? ""),
  } as any;
  await existing.save();
  sendSuccess(res, existing.toJSON(), { message: "Invoice settings saved" });
}));

router.post("/invoice-settings/test-email", wrap(async (req, res) => {
  const settings = await getInvoiceSettings();
  const to = String(req.body?.to || settings.companyEmail || settings.smtp?.fromEmail || "").trim();
  if (!to) throw Object.assign(new Error("Test recipient email is required"), { statusCode: 400 });
  const now = new Date();
  const result = await sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.SMTP_TEST, to, {
    user_name: "Test User",
    email: to,
    app_name: settings.companyName || "Krita",
    company_name: settings.companyName || "Krita",
    support_email: settings.companyEmail || settings.smtp?.fromEmail || "support@krita.com",
    current_date: now.toLocaleDateString("en-IN"),
    current_time: now.toLocaleTimeString("en-IN"),
    ...parseVariables(req.body?.variables),
  });
  sendSuccess(res, result, { message: result.skipped ? "SMTP test skipped" : "SMTP test email sent" });
}));

router.post("/invoice-settings/test-invoice", wrap(async (req, res) => {
  const settings = await getInvoiceSettings();
  const to = String(req.body?.to || settings.companyEmail || settings.smtp?.fromEmail || "").trim();
  if (!to) throw Object.assign(new Error("Test recipient email is required"), { statusCode: 400 });
  const now = new Date();
  const testSubtotal = 1000;
  const testDiscount = 100;
  const testTaxPercent = Number(settings.defaultTaxPercent ?? 0);
  const testConveniencePercent = Number(settings.defaultConvenienceChargePercent ?? 0);
  const testConvenienceGstPercent = Number(settings.defaultConvenienceChargeGstPercent ?? 0);
  const testTaxable = Math.max(0, testSubtotal - testDiscount);
  const testTax = Math.round(((testTaxable * testTaxPercent) / 100) * 100) / 100;
  const testAmountBeforeCharges = Math.round((testTaxable + testTax) * 100) / 100;
  const testConvenience = Math.round(((testAmountBeforeCharges * testConveniencePercent) / 100) * 100) / 100;
  const testConvenienceGst = Math.floor(((testConvenience * testConvenienceGstPercent) / 100) * 100) / 100;
  const testGrandTotal = Math.round((testAmountBeforeCharges + testConvenience + testConvenienceGst) * 100) / 100;
  const sampleInvoice = {
    invoiceNumber: `TEST-${now.toISOString().slice(0, 10).replace(/-/g, "")}`,
    userName: "Test Customer",
    userEmail: to,
    userMobile: "8000000001",
    customerCompany: {
      name: "Test Customer",
      email: to,
      phone: "8000000001",
      address: "Sample billing address",
    },
    planId: "test-plan",
    planName: "Premium Plan",
    currency: "INR",
    status: "paid",
    invoiceDate: now,
    dueDate: now,
    transactionId: "test_txn_123456",
    subtotal: testSubtotal,
    discountTotal: testDiscount,
    taxTotal: testTax,
    convenienceCharge: testConvenience,
    convenienceChargeGst: testConvenienceGst,
    grandTotal: testGrandTotal,
    amount: testGrandTotal,
    notes: "This is a test invoice generated for template and email verification.",
    terms: "No payment is required for this test invoice.",
    items: [{
      product: "Premium Subscription",
      description: "Template test item",
      quantity: 1,
      price: testSubtotal,
      discount: testDiscount,
      tax: testTaxPercent,
      total: testAmountBeforeCharges,
    }],
  };
  const pdf = await renderInvoicePdf(sampleInvoice, settings, { planName: "Premium Plan" });
  const result = await sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.INVOICE_TEST, to, {
    user_name: sampleInvoice.userName,
    customer_name: sampleInvoice.userName,
    email: to,
    invoice_number: sampleInvoice.invoiceNumber,
    invoice_amount: `${sampleInvoice.currency} ${Number(sampleInvoice.amount || 0).toFixed(2)}`,
    payment_amount: `${sampleInvoice.currency} ${Number(sampleInvoice.amount || 0).toFixed(2)}`,
    invoice_date: now.toLocaleDateString("en-IN"),
    due_date: now.toLocaleDateString("en-IN"),
    tax_amount: `${sampleInvoice.currency} ${Number(sampleInvoice.taxTotal || 0).toFixed(2)}`,
    convenience_fee: `${sampleInvoice.currency} ${Number(sampleInvoice.convenienceCharge || 0).toFixed(2)}`,
    convenience_fee_gst: `${sampleInvoice.currency} ${Number(sampleInvoice.convenienceChargeGst || 0).toFixed(2)}`,
    total_amount: `${sampleInvoice.currency} ${Number(sampleInvoice.grandTotal || 0).toFixed(2)}`,
    payment_status: sampleInvoice.status,
    transaction_id: sampleInvoice.transactionId,
    support_email: settings.companyEmail || settings.smtp?.fromEmail || "support@krita.com",
    company_name: settings.companyName || "Krita",
    ...parseVariables(req.body?.variables),
  }, [{ filename: `${sampleInvoice.invoiceNumber}.pdf`, contentType: "application/pdf", content: pdf }]);
  sendSuccess(res, result, { message: result.skipped ? "Test invoice email skipped" : "Test invoice email sent" });
}));

function calculateInvoiceTotals(items: any[] = []) {
  return items.reduce(
    (acc, item) => {
      const quantity = Math.max(0, Number(item.quantity || 0));
      const price = Math.max(0, Number(item.price || 0));
      const discount = Math.max(0, Number(item.discount || 0));
      const tax = Math.max(0, Number(item.tax || 0));
      const lineBase = quantity * price;
      const lineDiscount = Math.min(lineBase, discount);
      const taxable = Math.max(0, lineBase - lineDiscount);
      const lineTax = (taxable * tax) / 100;
      const total = taxable + lineTax;
      acc.subtotal += lineBase;
      acc.discountTotal += lineDiscount;
      acc.taxTotal += lineTax;
      acc.grandTotal += total;
      acc.items.push({ ...item, quantity, price, discount: lineDiscount, tax, total });
      return acc;
    },
    { subtotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0, items: [] as any[] },
  );
}

function normalizeInvoicePayload(body: Record<string, any>, existing: any = {}) {
  const totals = calculateInvoiceTotals(Array.isArray(body.items) ? body.items : existing.items || []);
  const now = new Date();
  const allowedStatuses = new Set(["draft", "sent", "paid", "pending", "overdue", "cancelled", "void", "failed"]);
  const nextStatus = String(body.status || existing.status || "draft").toLowerCase();
  const paymentHistory = Array.isArray(body.paymentHistory)
    ? body.paymentHistory.map((item: any) => ({
      status: String(item.status || body.status || "pending").toLowerCase(),
      amount: Number(item.amount || 0),
      transactionId: String(item.transactionId || ""),
      paidAt: item.paidAt ? new Date(String(item.paidAt)) : new Date(),
      note: String(item.note || ""),
    }))
    : existing.paymentHistory || [];
  return {
    invoiceNumber: String(body.invoiceNumber || existing.invoiceNumber || `INV-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-6)}`).trim(),
    userId: String(body.userId || existing.userId || "manual"),
    subscriptionId: String(body.subscriptionId || existing.subscriptionId || `manual-${Date.now()}`),
    planId: String(body.planId || existing.planId || "manual"),
    userName: String(body.userName || body.customerCompany?.name || existing.userName || ""),
    userEmail: String(body.userEmail || body.customerCompany?.email || existing.userEmail || ""),
    userMobile: String(body.userMobile || body.customerCompany?.phone || existing.userMobile || ""),
    amount: Number(totals.grandTotal || body.amount || existing.amount || 0),
    currency: String(body.currency || existing.currency || "INR"),
    status: allowedStatuses.has(nextStatus) ? nextStatus : "draft",
    transactionId: String(body.transactionId || existing.transactionId || ""),
    invoiceDate: body.invoiceDate ? new Date(String(body.invoiceDate)) : existing.invoiceDate || now,
    dueDate: body.dueDate ? new Date(String(body.dueDate)) : existing.dueDate,
    billingCompany: body.billingCompany || existing.billingCompany || {},
    customerCompany: body.customerCompany || existing.customerCompany || {},
    taxDetails: body.taxDetails || existing.taxDetails || {},
    items: totals.items,
    subtotal: Math.round(totals.subtotal * 100) / 100,
    taxTotal: Math.round(totals.taxTotal * 100) / 100,
    discountTotal: Math.round(totals.discountTotal * 100) / 100,
    grandTotal: Math.round(totals.grandTotal * 100) / 100,
    notes: String(body.notes || existing.notes || ""),
    terms: String(body.terms || existing.terms || ""),
    signatureUrl: String(body.signatureUrl || existing.signatureUrl || ""),
    logoUrl: String(body.logoUrl || existing.logoUrl || ""),
    qrCode: String(body.qrCode || existing.qrCode || ""),
    templateId: String(body.templateId || existing.templateId || ""),
    templateName: String(body.templateName || existing.templateName || ""),
    shareToken: String(body.shareToken || existing.shareToken || crypto.randomBytes(12).toString("hex")),
    paymentHistory,
  };
}

router.get("/invoices", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters: Record<string, any> = { ...exactFilter(query, ["status", "emailStatus", "templateId"]), ...buildSearchFilter(query, ["invoiceNumber", "userName", "userEmail", "planId", "transactionId"]) };
  if (query.dateFrom || query.dateTo) {
    filters.createdAt = {};
    if (query.dateFrom) filters.createdAt.$gte = new Date(String(query.dateFrom));
    if (query.dateTo) {
      const end = new Date(String(query.dateTo));
      end.setHours(23, 59, 59, 999);
      filters.createdAt.$lte = end;
    }
  }
  const [items, total] = await Promise.all([
    Invoice.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Invoice.countDocuments(filters),
  ]);
  sendSuccess(res, items.map((item: any) => item.toJSON()), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.get("/invoices/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  sendSuccess(res, invoice.toJSON());
}));

router.post("/invoices", wrap(async (req, res) => {
  const settings = await getInvoiceSettings();
  const active = getActiveInvoiceTemplate(settings);
  const payload = normalizeInvoicePayload({
    ...(req.body ?? {}),
    templateId: req.body?.templateId || active?.id || settings.activeTemplateId || "",
    templateName: req.body?.templateName || active?.name || settings.activeTemplateName || "",
  });
  const invoice = await Invoice.create({
    ...payload,
    emailStatus: "pending",
    issuedAt: payload.invoiceDate || new Date(),
    activityLogs: [{ action: "created", message: "Manual invoice created", at: new Date() }],
  });
  await regenerateInvoicePdf(invoice, settings);
  await invoice.save();
  sendSuccess(res, invoice.toJSON(), { status: 201, message: "Invoice created" });
}));

router.put("/invoices/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  Object.assign(invoice, normalizeInvoicePayload(req.body ?? {}, invoice.toJSON()));
  invoice.activityLogs = [...(invoice.activityLogs || []), { action: "updated", message: "Invoice edited", at: new Date() }] as any;
  await regenerateInvoicePdf(invoice);
  await invoice.save();
  sendSuccess(res, invoice.toJSON(), { message: "Invoice updated" });
}));

router.post("/invoices/:id/duplicate", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  const raw = invoice.toJSON();
  delete raw.id;
  const copy = await Invoice.create({
    ...raw,
    invoiceNumber: `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-6)}`,
    status: "draft",
    emailStatus: "pending",
    shareToken: crypto.randomBytes(12).toString("hex"),
    activityLogs: [{ action: "duplicated", message: `Duplicated from ${invoice.invoiceNumber}`, at: new Date() }],
  });
  sendSuccess(res, copy.toJSON(), { status: 201, message: "Invoice duplicated" });
}));

router.post("/invoices/:id/send", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  const settings = await getInvoiceSettings();
  if (!invoice.userEmail) throw Object.assign(new Error("Invoice customer email is missing"), { statusCode: 400 });
  const pdf = await regenerateInvoicePdf(invoice, settings);
  const result = await sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.INVOICE_GENERATED, invoice.userEmail, {
    user_name: invoice.userName || "Customer",
    customer_name: invoice.userName || "Customer",
    email: invoice.userEmail || "",
    invoice_number: invoice.invoiceNumber,
    invoice_amount: `${invoice.currency || "INR"} ${Number(invoice.amount || 0).toFixed(2)}`,
    payment_amount: `${invoice.currency || "INR"} ${Number(invoice.amount || 0).toFixed(2)}`,
    invoice_date: new Date(invoice.invoiceDate || invoice.createdAt).toLocaleDateString("en-IN"),
    due_date: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("en-IN") : "",
    tax_amount: `${invoice.currency || "INR"} ${Number(invoice.taxTotal || 0).toFixed(2)}`,
    convenience_fee: `${invoice.currency || "INR"} ${Number(invoice.convenienceCharge || 0).toFixed(2)}`,
    convenience_fee_gst: `${invoice.currency || "INR"} ${Number(invoice.convenienceChargeGst || 0).toFixed(2)}`,
    total_amount: `${invoice.currency || "INR"} ${Number(invoice.grandTotal || invoice.amount || 0).toFixed(2)}`,
    payment_status: invoice.status || "sent",
    transaction_id: invoice.transactionId || "",
    support_email: settings.companyEmail || settings.smtp?.fromEmail || "support@krita.com",
    ...parseVariables(req.body?.variables),
  }, [{ filename: `${invoice.invoiceNumber}.pdf`, contentType: "application/pdf", content: pdf }]);
  invoice.emailStatus = result.skipped ? "skipped" : "sent";
  invoice.status = invoice.status === "draft" ? "sent" : invoice.status;
  invoice.sentAt = result.skipped ? undefined : new Date();
  invoice.emailError = result.skipped ? result.reason : "";
  invoice.activityLogs = [...(invoice.activityLogs || []), { action: "email", message: result.skipped ? "Email skipped" : "Invoice email sent", at: new Date() }] as any;
  await invoice.save();
  sendSuccess(res, invoice.toJSON(), { message: result.skipped ? "Invoice email skipped" : "Invoice email sent" });
}));

router.post("/invoices/:id/reminder", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  const settings = await getInvoiceSettings();
  if (!invoice.userEmail) throw Object.assign(new Error("Invoice customer email is missing"), { statusCode: 400 });
  const result = await sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.PAYMENT_REMINDER, invoice.userEmail, {
    user_name: invoice.userName || "Customer",
    email: invoice.userEmail || "",
    invoice_number: invoice.invoiceNumber,
    reminder_title: "Payment reminder",
    reminder_date: new Date().toLocaleDateString("en-IN"),
    description: `Payment reminder for invoice ${invoice.invoiceNumber}`,
    payment_amount: `${invoice.currency || "INR"} ${Number(invoice.grandTotal || invoice.amount || 0).toFixed(2)}`,
    due_date: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("en-IN") : "",
    support_email: settings.companyEmail || settings.smtp?.fromEmail || "support@krita.com",
    ...(parseVariables(req.body?.variables)),
  });
  invoice.emailStatus = result.skipped ? "skipped" : "sent";
  invoice.emailError = result.skipped ? result.reason : "";
  invoice.activityLogs = [...(invoice.activityLogs || []), { action: "email", message: result.skipped ? "Payment reminder skipped" : "Payment reminder sent", at: new Date() }] as any;
  await invoice.save();
  sendSuccess(res, { invoice: invoice.toJSON(), email: result }, { message: result.skipped ? "Payment reminder skipped" : "Payment reminder sent" });
}));

router.get("/invoices/:id/pdf", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  const pdf = await regenerateInvoicePdf(invoice);
  await invoice.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
}));

router.delete("/invoices/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "invoice");
  await Invoice.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Invoice deleted" });
}));

router.post("/invoices/subscriptions/:subscriptionId/generate", wrap(async (req, res) => {
  assertObjectId(String(req.params.subscriptionId), "subscription");
  const invoice = await generateInvoiceForSubscription(String(req.params.subscriptionId));
  sendSuccess(res, invoice.toJSON(), { status: 201, message: "Invoice generated" });
}));

router.get("/notification-settings", wrap(async (_req, res) => {
  sendSuccess(res, (await getNotificationSettings()).toJSON());
}));

router.post("/notification-settings", wrap(async (req, res) => {
  const settings = await getNotificationSettings();
  const body = req.body ?? {};
  settings.enabled = body.enabled === undefined ? settings.enabled : parseBoolean(body.enabled);
  settings.emailEnabled = body.emailEnabled === undefined ? settings.emailEnabled : parseBoolean(body.emailEnabled);
  settings.inAppEnabled = body.inAppEnabled === undefined ? settings.inAppEnabled : parseBoolean(body.inAppEnabled);
  if (Array.isArray(body.reminders)) {
    settings.reminders = body.reminders.map((item: any) => ({
      daysBefore: Math.max(-365, Math.min(365, Number(item.daysBefore ?? 0))),
      enabled: item.enabled !== false,
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
      emailSubject: String(item.emailSubject ?? ""),
      emailBody: String(item.emailBody ?? ""),
    })) as any;
  }
  await settings.save();
  sendSuccess(res, settings.toJSON(), { message: "Notification settings saved" });
}));

router.post("/notification-settings/run-expiry-reminders", wrap(async (_req, res) => {
  sendSuccess(res, await processExpiryReminders(), { message: "Expiry reminders processed" });
}));

function notificationTemplateKey(type: string) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("announcement")) return EMAIL_TEMPLATE_KEYS.NOTIFICATION_ANNOUNCEMENT;
  if (normalized.includes("update")) return EMAIL_TEMPLATE_KEYS.NOTIFICATION_UPDATE;
  if (normalized.includes("offer") || normalized.includes("promotion")) return EMAIL_TEMPLATE_KEYS.NOTIFICATION_OFFER;
  if (normalized.includes("reminder")) return EMAIL_TEMPLATE_KEYS.NOTIFICATION_REMINDER;
  return EMAIL_TEMPLATE_KEYS.NOTIFICATION_GENERAL;
}

function normalizeDeliveryMode(value: unknown) {
  const mode = String(value || "notification").trim().toLowerCase();
  if (["app", "in_app", "notification"].includes(mode)) return "notification";
  if (["email"].includes(mode)) return "email";
  if (["push"].includes(mode)) return "push";
  if (["email_push", "email+push"].includes(mode)) return "email_push";
  if (["both", "app_email", "notification_email"].includes(mode)) return "both";
  return "notification";
}

function deliveryFlags(mode: string, settings: any) {
  return {
    inApp: ["notification", "both"].includes(mode) && settings.inAppEnabled !== false,
    email: ["email", "both", "email_push"].includes(mode) && settings.emailEnabled !== false,
    push: ["push", "email_push"].includes(mode),
  };
}

function parseVariables(input: unknown) {
  if (!input) return {};
  if (typeof input === "object") return input as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(input));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseTemplateVariableList(input: unknown) {
  if (Array.isArray(input)) return input.map((item) => String(item).trim()).filter(Boolean);
  return String(input || "")
    .split(/[,\n|]/)
    .map((item) => item.replace(/[{}]/g, "").trim())
    .filter(Boolean);
}

function assertValidTemplatePayload(payload: any) {
  const validation = validateTemplateVariables({
    key: payload.key,
    module: payload.module,
    type: payload.type,
    variables: payload.variables,
    subject: payload.subject,
    htmlContent: payload.htmlContent,
    textContent: payload.textContent,
  });
  if (validation.invalid.length) {
    throw Object.assign(new Error(`Unsupported variables for this template: ${validation.invalid.map((name) => `{{${name}}}`).join(", ")}`), {
      statusCode: 400,
      details: { invalidVariables: validation.invalid, allowedVariables: validation.allowed },
    });
  }
  return validation;
}

function templateImportRows(file: Express.Multer.File) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") return parseSheetBuffer(file.buffer);
  if (ext === ".csv") {
    return parseCsvBuffer(file.buffer).map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value])),
    );
  }
  throw Object.assign(new Error("Upload a .csv, .xlsx, or .xls file"), { statusCode: 400 });
}

function templateCell(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const normalized = normalizeHeader(key);
    const value = row[normalized] ?? row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function templatePayloadFromRow(row: Record<string, unknown>) {
  const key = String(templateCell(row, ["key", "template_key"])).trim();
  const type = String(templateCell(row, ["type", "template_type"])).trim();
  const module = String(templateCell(row, ["module", "module_name"]) || type || "notification").trim();
  const subject = String(templateCell(row, ["subject", "email_subject"])).trim();
  const htmlContent = String(templateCell(row, ["html_content", "html", "body_html"])).trim();
  const textContent = String(templateCell(row, ["text_content", "text", "body_text"])).trim();
  let sampleData = {};
  const sampleRaw = templateCell(row, ["sample_data", "sample_json"]);
  if (sampleRaw) {
    try {
      sampleData = JSON.parse(String(sampleRaw));
    } catch {
      sampleData = {};
    }
  }
  return {
    key,
    name: String(templateCell(row, ["name", "template_name"]) || key).trim(),
    type,
    module,
    description: String(templateCell(row, ["description"])).trim(),
    subject,
    htmlContent,
    textContent,
    variables: parseTemplateVariableList(templateCell(row, ["variables", "placeholders"])),
    sampleData,
    isActive: !["false", "0", "no", "inactive"].includes(String(templateCell(row, ["is_active", "active", "status"])).trim().toLowerCase()),
  };
}

async function saveNotificationAttachment(file?: Express.Multer.File) {
  if (!file?.buffer) return { attachmentUrl: "", attachmentName: "", emailAttachments: [] as any[] };
  await fs.mkdir(NOTIFICATION_ASSET_DIR, { recursive: true });
  const safeName = (file.originalname || "attachment").replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
  await fs.writeFile(path.join(NOTIFICATION_ASSET_DIR, filename), file.buffer);
  return {
    attachmentUrl: `/uploads/notifications/${filename}`,
    attachmentName: file.originalname || "attachment",
    emailAttachments: [{ filename: file.originalname || "attachment", contentType: file.mimetype, content: file.buffer }],
  };
}

router.get("/notifications", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["type", "targetGroup", "deliveryMode", "emailStatus"]), ...buildSearchFilter(query, ["title", "body", "userId", "emailTemplateKey"]) };
  const [items, total] = await Promise.all([
    UserNotification.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit),
    UserNotification.countDocuments(filters),
  ]);
  const userIds = [...new Set(items.map((item: any) => String(item.userId)).filter(Boolean))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select("_id name email mobile") : [];
  const userMap = new Map(users.map((user: any) => [String(user._id), serializeUser(user)]));
  sendSuccess(res, items.map((item: any) => ({ ...item.toJSON(), user: userMap.get(String(item.userId)) || null })), {
    meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
}));

router.post(["/notifications/send", "/notifications/broadcast"], upload.single("attachment"), wrap(async (req, res) => {
  const settings = await getNotificationSettings();
  const body = req.body ?? {};
  const type = String(body.type || "notification").trim();
  const deliveryMode = normalizeDeliveryMode(body.deliveryMode);
  const flags = deliveryFlags(deliveryMode, settings);
  const title = String(body.title || body.notification_title || "").trim();
  const message = String(body.message || body.body || body.notification_message || "").trim();
  if (!title || !message) throw Object.assign(new Error("Notification title and message are required"), { statusCode: 400 });

  const userIds = Array.isArray(body.userIds)
    ? body.userIds.map((id: any) => String(id))
    : String(body.userIds || "").split(",").map((id) => id.trim()).filter(Boolean);
  const filters: Record<string, any> = { isActive: { $ne: false } };
  if (userIds.length) filters._id = { $in: userIds };
  if (body.targetGroup) filters.userType = String(body.targetGroup);
  const users = await User.find(filters).select("_id name email mobile userType").limit(Math.min(Math.max(Number(body.limit || 500), 1), 5000));
  const now = new Date();
  const dedupePrefix = `admin-${type}-${now.getTime()}`;
  const savedAttachment = await saveNotificationAttachment(req.file);
  const docs = users.map((user: any) => ({
    userId: String(user._id),
    type,
    title,
    body: message,
    dedupeKey: `${dedupePrefix}-${String(user._id)}`,
    visibleInApp: flags.inApp,
    linkUrl: String(body.linkUrl || body.buttonLink || body.button_link || ""),
    attachmentUrl: savedAttachment.attachmentUrl,
    attachmentName: savedAttachment.attachmentName,
    targetGroup: String(body.targetGroup || ""),
    deliveryMode,
    notificationStatus: flags.inApp ? "created" : "skipped",
    pushStatus: flags.push ? "unsupported" : "",
    pushError: flags.push ? "Push provider is not configured" : "",
    emailTemplateKey: flags.email ? String(body.templateKey || notificationTemplateKey(type)) : "",
    senderId: String((req as any).admin?._id || ""),
    senderName: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
  }));
  const notifications = docs.length ? await UserNotification.insertMany(docs, { ordered: false }) : [];
  let emailSent = 0;
  let emailSkipped = 0;
  const attachments = savedAttachment.emailAttachments;
  const variables = parseVariables(body.variables);
  if (flags.email) {
    const templateKey = String(body.templateKey || notificationTemplateKey(type));
    const notificationByUser = new Map(notifications.map((item: any) => [String(item.userId), item]));
    for (const user of users) {
      const notification = notificationByUser.get(String(user._id));
      if (!user.email) {
        emailSkipped += 1;
        if (notification) {
          notification.emailStatus = "skipped";
          notification.emailError = "User email missing";
          await notification.save();
        }
        continue;
      }
      try {
        const result = await sendTemplatedEmail(templateKey, user.email, {
          user_name: user.name || user.email || "Learner",
          email: user.email,
          title,
          message,
          publish_date: now.toLocaleDateString("en-IN"),
          button_link: body.buttonLink || body.button_link || "",
          notification_title: title,
          notification_message: message,
          announcement_title: title,
          announcement_message: message,
          update_title: title,
          update_message: message,
          offer_title: title,
          offer_name: body.offerName || body.offer_name || title,
          offer_code: body.offerCode || body.offer_code || "",
          offer_discount: body.offerDiscount || body.offer_discount || "",
          discount: body.discount || body.offerDiscount || body.offer_discount || "",
          expiry_date: body.expiryDate || body.expiry_date || "",
          valid_until: body.validUntil || body.valid_until || body.expiryDate || body.expiry_date || "",
          current_date: now.toLocaleDateString("en-IN"),
          current_time: now.toLocaleTimeString("en-IN"),
          attachment_name: savedAttachment.attachmentName,
          ...variables,
        }, attachments);
        if (result.skipped) {
          emailSkipped += 1;
          if (notification) {
            notification.emailStatus = "skipped";
            notification.emailError = String(result.reason || "Email skipped");
            await notification.save();
          }
        } else {
          emailSent += 1;
          if (notification) {
            notification.emailStatus = "sent";
            notification.emailError = "";
            notification.sentAt = new Date();
            await notification.save();
          }
        }
      } catch (error) {
        emailSkipped += 1;
        if (notification) {
          notification.emailStatus = "failed";
          notification.emailError = error instanceof Error ? error.message : "Email failed";
          await notification.save();
        }
      }
    }
  } else if (notifications.length) {
    await UserNotification.updateMany({ _id: { $in: notifications.map((item: any) => item._id) } }, { $set: { emailStatus: "skipped", emailError: "Email delivery not selected" } });
  }
  sendSuccess(res, { totalRecipients: users.length, notificationsCreated: notifications.length, emailSent, emailSkipped, pushUnsupported: flags.push ? users.length : 0 }, { status: 201, message: "Notification processed" });
}));

router.get("/helpdesk-settings", wrap(async (_req, res) => {
  const settings = await HelpDeskSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  sendSuccess(res, settings.toJSON());
}));

router.post("/helpdesk-settings", wrap(async (req, res) => {
  const settings = await HelpDeskSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const body = req.body ?? {};
  const mode = String(body.mode || settings.mode || "both");
  settings.mode = (["database", "email", "both"].includes(mode) ? mode : "both") as any;
  settings.adminEmail = String(body.adminEmail ?? settings.adminEmail ?? "").trim();
  settings.autoReplyTemplateKey = String(body.autoReplyTemplateKey || settings.autoReplyTemplateKey || EMAIL_TEMPLATE_KEYS.HELPDESK_AUTO_REPLY);
  settings.ticketReceivedTemplateKey = String(body.ticketReceivedTemplateKey || settings.ticketReceivedTemplateKey || EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CREATED);
  settings.ticketStatusTemplateKey = String(body.ticketStatusTemplateKey || settings.ticketStatusTemplateKey || EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_REPLY);
  await settings.save();
  sendSuccess(res, settings.toJSON(), { message: "Help desk settings saved" });
}));

async function saveSupportAttachment(file?: Express.Multer.File) {
  if (!file?.buffer) return { attachmentUrl: "", attachmentName: "", emailAttachments: [] as any[] };
  await fs.mkdir(SUPPORT_ASSET_DIR, { recursive: true });
  const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
  await fs.writeFile(path.join(SUPPORT_ASSET_DIR, filename), file.buffer);
  return {
    attachmentUrl: `/uploads/support/${filename}`,
    attachmentName: file.originalname,
    emailAttachments: [{ filename: file.originalname, contentType: file.mimetype, content: file.buffer }],
  };
}

async function sendSupportStatusEmail(ticket: any, templateKey: string, message: string, attachments: any[] = []) {
  const settings = await getInvoiceSettings();
  if (!ticket.userEmail) return { skipped: true, reason: "Ticket user email missing" };
  return sendTemplatedEmail(templateKey, ticket.userEmail, {
    user_name: ticket.userName || ticket.userEmail || "Learner",
    email: ticket.userEmail || "",
    mobile: ticket.userMobile || "",
    ticket_id: ticket.ticketId,
    ticket_category: ticket.category,
    ticket_subject: ticket.category,
    ticket_status: ticket.status,
    ticket_message: message,
    reply_message: message,
    attachment_name: attachments[0]?.filename || "",
    support_email: settings.companyEmail || settings.smtp?.fromEmail || "support@krita.com",
  }, attachments);
}

router.get("/support-tickets", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["status", "userId"]), ...buildSearchFilter(query, ["ticketId", "userName", "userEmail", "category"]) };
  const [items, total] = await Promise.all([
    SupportTicket.find(filters).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    SupportTicket.countDocuments(filters),
  ]);
  sendSuccess(res, items.map((item: any) => item.toJSON()), { meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
}));

router.post("/support-tickets/:id/reply", upload.single("attachment"), wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "support ticket");
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw Object.assign(new Error("Support ticket not found"), { statusCode: 404 });
  const message = String(req.body?.message || "").trim();
  if (!message) throw Object.assign(new Error("Reply message is required"), { statusCode: 400 });
  const saved = await saveSupportAttachment(req.file);
  ticket.messages = [...(ticket.messages || []), {
    sender: "admin",
    message,
    attachmentUrl: saved.attachmentUrl,
    attachmentName: saved.attachmentName,
    createdAt: new Date(),
  }] as any;
  ticket.status = String(req.body?.status || ticket.status || "pending") === "closed" ? "closed" : "pending";
  ticket.isReadByAdmin = true;
  await ticket.save();
  const helpSettings = await HelpDeskSettings.findOneAndUpdate({ key: "default" }, { $setOnInsert: { key: "default" } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const templateKey = ticket.status === "closed"
    ? EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CLOSED
    : helpSettings.ticketStatusTemplateKey || EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_REPLY;
  const emailResult = await sendSupportStatusEmail(ticket, templateKey, message, saved.emailAttachments).catch((error) => ({ skipped: true, reason: error instanceof Error ? error.message : "Email failed" }));
  await UserNotification.create({
    userId: ticket.userId,
    type: "support",
    title: ticket.status === "closed" ? "Support ticket closed" : "Support reply received",
    body: message,
    dedupeKey: `support-reply-${ticket.ticketId}-${Date.now()}`,
    visibleInApp: true,
    linkUrl: "/help-support",
    attachmentUrl: saved.attachmentUrl,
    attachmentName: saved.attachmentName,
    emailStatus: (emailResult as any).skipped ? "skipped" : "sent",
    emailError: (emailResult as any).reason || "",
    sentAt: (emailResult as any).skipped ? undefined : new Date(),
  });
  sendSuccess(res, { ticket: ticket.toJSON(), email: emailResult }, { message: ticket.status === "closed" ? "Ticket closed" : "Reply sent" });
}));

router.post("/support-tickets/:id/close", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "support ticket");
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw Object.assign(new Error("Support ticket not found"), { statusCode: 404 });
  const message = String(req.body?.message || "Your support ticket has been closed.").trim();
  ticket.status = "closed";
  ticket.messages = [...(ticket.messages || []), { sender: "admin", message, createdAt: new Date() }] as any;
  ticket.isReadByAdmin = true;
  await ticket.save();
  const emailResult = await sendSupportStatusEmail(ticket, EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CLOSED, message).catch((error) => ({ skipped: true, reason: error instanceof Error ? error.message : "Email failed" }));
  sendSuccess(res, { ticket: ticket.toJSON(), email: emailResult }, { message: "Ticket closed" });
}));

// Email Template Management Routes
router.get("/email-templates/catalog", wrap(async (_req, res) => {
  const existingTemplates = await EmailTemplate.find({ key: { $in: EMAIL_TEMPLATE_DEFINITIONS.map((item) => item.key) } });
  const statusMap = existingTemplates.reduce((acc: Record<string, any>, template) => {
    acc[String(template.key)] = {
      exists: true,
      isActive: template.isActive !== false,
      templateId: String(template._id),
      updatedAt: template.updatedAt,
      createdAt: template.createdAt,
    };
    return acc;
  }, {});

  sendSuccess(res, {
    modules: [...new Set(EMAIL_TEMPLATE_DEFINITIONS.map((item) => item.module))],
    types: [...new Set(EMAIL_TEMPLATE_DEFINITIONS.map((item) => item.type))],
    templates: EMAIL_TEMPLATE_DEFINITIONS.map((item) => {
      const defaultTemplate = buildTemplateFromDefinition(item);
      return {
        ...item,
        subject: defaultTemplate.subject,
        htmlContent: defaultTemplate.htmlContent,
        textContent: defaultTemplate.textContent,
        placeholders: item.variables.map((name) => `{{${name}}}`),
        sampleData: sampleEmailVariables(),
        status: statusMap[item.key] || { exists: false, isActive: false },
      };
    }),
    mappings: EMAIL_TEMPLATE_DEFINITIONS.reduce((acc: Record<string, any>, item) => {
      acc[item.key] = { module: item.module, type: item.type, variables: item.variables, placeholders: item.variables.map((name) => `{{${name}}}`) };
      return acc;
    }, {}),
    variables: COMMON_EMAIL_VARIABLES,
    sampleData: sampleEmailVariables(),
  });
}));

router.get("/email-templates/audit", wrap(async (_req, res) => {
  const templates = await EmailTemplate.find({ key: { $in: EMAIL_TEMPLATE_DEFINITIONS.map((item) => item.key) } });
  const templateMap = new Map(templates.map((template: any) => [String(template.key), template]));
  const hardcodedLocations = [
    { file: "App/api-server/lib/db/src/models/AuthSettings.ts", note: "Legacy reset OTP subject/body fields remain for backward settings compatibility; runtime uses auth_forgot_password_otp." },
    { file: "App/api-server/src/lib/invoices.ts", note: "Reminder title/body are in-app notification copy; email delivery uses subscription templates." },
  ];
  const modules = EMAIL_TEMPLATE_DEFINITIONS.map((definition) => {
    const template: any = templateMap.get(definition.key);
    const status = !template ? "Missing" : template.isActive === false ? "Broken" : "Working";
    return {
      moduleName: definition.module,
      functionality: definition.name,
      emailTriggerEvent: definition.trigger || `${definition.module} ${definition.type}`,
      templateKey: definition.key,
      connectedModule: definition.module,
      supportedVariables: definition.variables,
      status,
      reason: !template ? "Template has not been created in database" : template.isActive === false ? "Template is disabled" : "Template exists and is active",
      lastUpdated: template?.updatedAt || null,
    };
  });
  const summary = modules.reduce((acc: Record<string, number>, item) => {
    acc[item.status] = Number(acc[item.status] || 0) + 1;
    return acc;
  }, {});
  sendSuccess(res, {
    generatedAt: new Date(),
    summary,
    modules,
    hardcodedLocations,
    sendingModules: [
      { moduleName: "auth", functionality: "registration, Google first login, forgot password", templateKeys: [EMAIL_TEMPLATE_KEYS.AUTH_REGISTRATION, EMAIL_TEMPLATE_KEYS.AUTH_FORGOT_PASSWORD_OTP] },
      { moduleName: "subscription", functionality: "payment success and invoice generation", templateKeys: [EMAIL_TEMPLATE_KEYS.PAYMENT_SUCCESS, EMAIL_TEMPLATE_KEYS.INVOICE_GENERATED] },
      { moduleName: "invoice", functionality: "invoice send, payment reminder, invoice test", templateKeys: [EMAIL_TEMPLATE_KEYS.INVOICE_GENERATED, EMAIL_TEMPLATE_KEYS.PAYMENT_REMINDER, EMAIL_TEMPLATE_KEYS.INVOICE_TEST] },
      { moduleName: "notification", functionality: "admin broadcast notifications", templateKeys: [EMAIL_TEMPLATE_KEYS.NOTIFICATION_GENERAL, EMAIL_TEMPLATE_KEYS.NOTIFICATION_ANNOUNCEMENT, EMAIL_TEMPLATE_KEYS.NOTIFICATION_UPDATE, EMAIL_TEMPLATE_KEYS.NOTIFICATION_OFFER, EMAIL_TEMPLATE_KEYS.NOTIFICATION_REMINDER] },
      { moduleName: "helpdesk", functionality: "ticket created, auto reply, reply, close", templateKeys: [EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CREATED, EMAIL_TEMPLATE_KEYS.HELPDESK_AUTO_REPLY, EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_REPLY, EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CLOSED] },
      { moduleName: "subscription-reminder", functionality: "expiry, renewal, expired reminders", templateKeys: [EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_EXPIRY_REMINDER, EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_RENEWAL_REMINDER, EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_EXPIRED] },
    ],
  });
}));

router.get("/email-templates", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["type", "module", "isActive"]), ...buildSearchFilter(query, ["name", "key", "module"]) };
  const [items, total] = await Promise.all([
    EmailTemplate.find(filters).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    EmailTemplate.countDocuments(filters),
  ]);
  sendSuccess(res, items.map((item: any) => item.toJSON()), {
    meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
}));

router.post("/email-templates/preview", wrap(async (req, res) => {
  const templateKey = String(req.body?.templateKey || "").trim();
  if (!templateKey) throw Object.assign(new Error("Template key is required"), { statusCode: 400 });
  const template = await EmailTemplate.findOne({ key: templateKey }) || await resolveTemplate(templateKey);
  if (!template) throw Object.assign(new Error("Email template not found"), { statusCode: 404 });
  sendSuccess(res, buildTemplatePreview(template, parseVariables(req.body?.variables)));
}));

router.post("/email-templates/bulk-upload", upload.single("file"), wrap(async (req, res) => {
  if (!req.file?.buffer) throw Object.assign(new Error("CSV or XLSX file is required"), { statusCode: 400 });
  const rows = templateImportRows(req.file);
  const updateExisting = String(req.body?.updateExisting || "").toLowerCase() === "true";
  const created: any[] = [];
  const updated: any[] = [];
  const skipped: any[] = [];
  const failed: any[] = [];

  for (const [index, row] of rows.entries()) {
    try {
      const payload = templatePayloadFromRow(row as Record<string, unknown>);
      if (!payload.key || !payload.name || !payload.type || !payload.subject || (!payload.htmlContent && !payload.textContent)) {
        skipped.push({ row: index + 2, key: payload.key, reason: "Missing required template fields" });
        continue;
      }
      const validation = assertValidTemplatePayload(payload);
      payload.variables = validation.used.length ? validation.used : validation.allowed;
      const existing = await EmailTemplate.findOne({ key: payload.key });
      if (existing && !updateExisting) {
        skipped.push({ row: index + 2, key: payload.key, reason: "Template key already exists" });
        continue;
      }
      if (existing) {
        Object.assign(existing, {
          ...payload,
          updatedBy: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
        });
        await existing.save();
        updated.push({ row: index + 2, key: payload.key, id: String(existing._id) });
      } else {
        const template = await new EmailTemplate({
          ...payload,
          isDefault: false,
          createdBy: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
          updatedBy: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
        }).save();
        created.push({ row: index + 2, key: payload.key, id: String(template._id) });
      }
    } catch (error) {
      failed.push({ row: index + 2, reason: error instanceof Error ? error.message : "Import failed" });
    }
  }

  sendSuccess(res, { created, updated, skipped, failed, totalRows: rows.length }, { message: "Email template import processed" });
}));

router.get("/email-templates/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "template");
  const template = await EmailTemplate.findById(req.params.id);
  if (!template) throw Object.assign(new Error("Email template not found"), { statusCode: 404 });
  sendSuccess(res, template.toJSON());
}));

router.post("/email-templates", wrap(async (req, res) => {
  const body = req.body ?? {};
  const template = new EmailTemplate({
    key: String(body.key || "").trim(),
    name: String(body.name || "").trim(),
    type: String(body.type || "").trim(),
    module: String(body.module || body.type || "notification").trim(),
    description: String(body.description || "").trim(),
    subject: String(body.subject || "").trim(),
    htmlContent: String(body.htmlContent || "").trim(),
    textContent: String(body.textContent || "").trim(),
    variables: parseTemplateVariableList(body.variables),
    sampleData: body.sampleData || {},
    isActive: body.isActive !== false,
    isDefault: body.isDefault === true,
    createdBy: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
    updatedBy: String((req as any).admin?.name || (req as any).admin?.email || "Admin"),
  });
  if (!template.key || !template.name || !template.type || !template.subject) {
    throw Object.assign(new Error("Key, name, type, and subject are required"), { statusCode: 400 });
  }
  const validation = assertValidTemplatePayload(template);
  template.variables = validation.used.length ? validation.used : validation.allowed;
  const existing = await EmailTemplate.findOne({ key: template.key });
  if (existing) {
    throw Object.assign(new Error("An email template already exists for this key. Edit the existing template instead."), { statusCode: 409 });
  }
  await template.save();
  sendSuccess(res, template.toJSON(), { status: 201, message: "Email template created" });
}));

router.put("/email-templates/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "template");
  const body = req.body ?? {};
  const template = await EmailTemplate.findById(req.params.id);
  if (!template) throw Object.assign(new Error("Email template not found"), { statusCode: 404 });

  template.name = String(body.name || template.name).trim();
  template.module = String(body.module || template.module || template.type).trim();
  template.description = String(body.description ?? template.description ?? "").trim();
  template.subject = String(body.subject || template.subject).trim();
  template.htmlContent = String(body.htmlContent || template.htmlContent).trim();
  template.textContent = String(body.textContent || template.textContent).trim();
  template.variables = body.variables === undefined ? template.variables : parseTemplateVariableList(body.variables);
  template.sampleData = body.sampleData || template.sampleData || {};
  template.isActive = body.isActive === undefined ? template.isActive : Boolean(body.isActive);
  template.updatedBy = String((req as any).admin?.name || (req as any).admin?.email || "Admin");
  const validation = assertValidTemplatePayload(template);
  template.variables = validation.used.length ? validation.used : validation.allowed;

  await template.save();
  sendSuccess(res, template.toJSON(), { message: "Email template updated" });
}));

router.delete("/email-templates/:id", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "template");
  const template = await EmailTemplate.findById(req.params.id);
  if (!template) throw Object.assign(new Error("Email template not found"), { statusCode: 404 });
  if (template.isDefault) throw Object.assign(new Error("Cannot delete default template"), { statusCode: 400 });
  await EmailTemplate.findByIdAndDelete(req.params.id);
  sendSuccess(res, null, { message: "Email template deleted" });
}));

router.post("/email-templates/:id/preview", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "template");
  const template = await EmailTemplate.findById(req.params.id);
  if (!template) throw Object.assign(new Error("Email template not found"), { statusCode: 404 });
  sendSuccess(res, buildTemplatePreview(template, req.body?.variables || {}));
}));

router.post("/email-templates/:id/test", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "template");
  const template = await EmailTemplate.findById(req.params.id);
  if (!template) throw Object.assign(new Error("Email template not found"), { statusCode: 404 });

  const body = req.body ?? {};
  const to = String(body.to || "").trim();
  if (!to) throw Object.assign(new Error("Recipient email is required"), { statusCode: 400 });

  const settings = await getInvoiceSettings();
  const testData: Record<string, unknown> = {
    user_name: "Test User",
    email: to,
    user_email: to,
    user_phone: "+91 9876543210",
    otp: "123456",
    otp_code: "123456",
    otp_expiry: "10 minutes",
    invoice_number: "TEST-001",
    invoice_amount: "INR 1000",
    invoice_date: new Date().toLocaleDateString(),
    app_name: settings.companyName || "Krita",
    support_email: settings.companyEmail || "support@krita.com",
    company_name: settings.companyName || "Krita",
    notification_title: "Test Notification",
    notification_message: "This is a test notification message.",
    current_date: new Date().toLocaleDateString(),
    current_time: new Date().toLocaleTimeString(),
  };

  const result = await sendTemplatedEmail(template.key, to, { ...testData, ...parseVariables(body.variables) });
  sendSuccess(res, { result }, { message: result.skipped ? "Test email skipped" : "Test email sent" });
}));

router.get("/email-logs", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["status", "module", "templateKey"]), ...buildSearchFilter(query, ["to", "subject", "templateName", "templateKey"]) };
  const [items, total] = await Promise.all([
    EmailLog.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit),
    EmailLog.countDocuments(filters),
  ]);
  sendSuccess(res, items.map((item: any) => item.toJSON()), {
    meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
}));

router.post("/email-logs/:id/retry", wrap(async (req, res) => {
  assertObjectId(String(req.params.id), "email log");
  const log = await EmailLog.findById(req.params.id);
  if (!log) throw Object.assign(new Error("Email log not found"), { statusCode: 404 });
  if (!log.templateKey) throw Object.assign(new Error("Only templated emails can be retried"), { statusCode: 400 });
  const result = await sendTemplatedEmail(log.templateKey, log.to, { ...(log.payload || {}), ...parseVariables(req.body?.variables) });
  sendSuccess(res, { result }, { message: result.skipped ? "Retry skipped" : "Retry email sent" });
}));

router.get("/sessions", wrap(async (req, res) => {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = getPagination(query);
  const filters = { ...exactFilter(query, ["type", "origin", "userId"]), ...buildSearchFilter(query, ["title"]) };
  const [items, total] = await Promise.all([
    LearningSession.find(filters).sort({ createdAt: -1 }).skip(skip).limit(limit),
    LearningSession.countDocuments(filters),
  ]);
  const userIds = [...new Set(items.map((item: any) => String(item.userId)).filter(Boolean))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }) : [];
  const userMap = new Map(users.map((user: any) => [String(user._id), serializeUser(user)]));
  sendSuccess(res, items.map((item: any) => ({ ...item.toJSON(), user: userMap.get(String(item.userId)) ?? null })), {
    meta: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
}));

export default router;
