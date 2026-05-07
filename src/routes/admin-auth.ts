import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { User } from "@api/db";
import { JWT_SECRET } from "./auth";
import { requireAdmin, type AuthenticatedRequest } from "../middlewares/auth";

const router: IRouter = Router();
const SCRYPT_KEYLEN = 64;

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash = "") {
  const [salt, originalHash] = storedHash.split(":");
  if (!salt || !originalHash) return false;
  const currentHash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(currentHash, "hex"));
}

function signAdminToken(userId: string) {
  return jwt.sign({ userId, isAdmin: true }, JWT_SECRET, { expiresIn: "12h" });
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
    isPremium: Boolean(raw.isPremium),
    premiumExpiresAt: raw.premiumExpiresAt,
    createdAt: raw.createdAt,
    isAdmin: Boolean(raw.isAdmin),
  };
}

function sendSuccess(res: any, data: unknown, status = 200, message?: string) {
  res.status(status).json({
    success: true,
    ...(message ? { message } : {}),
    data,
  });
}

function sendError(res: any, status: number, message: string) {
  res.status(status).json({ success: false, message });
}

function normalizeEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  return email || undefined;
}

function normalizeMobile(value: unknown) {
  return String(value ?? "").trim();
}

router.get("/status", async (_req, res) => {
  const hasAdmin = (await User.countDocuments({ isAdmin: true })) > 0;
  sendSuccess(res, { hasAdmin });
});

router.post("/bootstrap", async (req, res) => {
  const hasAdmin = await User.exists({ isAdmin: true });
  if (hasAdmin) {
    sendError(res, 409, "Admin account already exists");
    return;
  }

  const { mobile, email, name, password, examMode, level } = req.body ?? {};
  if (!mobile || !name || !password) {
    sendError(res, 400, "Mobile, name, and password are required");
    return;
  }

  const existingUser = await User.findOne({
    $or: [
      { mobile: normalizeMobile(mobile) },
      ...(email ? [{ email: normalizeEmail(email) }] : []),
    ],
  });

  if (existingUser) {
    sendError(res, 409, "An admin with this mobile or email already exists");
    return;
  }

  const admin = await User.create({
    mobile: normalizeMobile(mobile),
    email: normalizeEmail(email),
    name: String(name).trim(),
    examMode: examMode || "BOTH",
    level: level || "Topper",
    passwordHash: hashPassword(String(password)),
    onboardingComplete: true,
    isPremium: true,
    isAdmin: true,
  });

  sendSuccess(
    res,
    {
      token: signAdminToken(String(admin._id)),
      admin: serializeUser(admin),
    },
    201,
    "Admin bootstrapped successfully",
  );
});

router.post("/register", async (req, res) => {
  const { mobile, email, name, password, examMode, level } = req.body ?? {};
  if (!mobile || !name || !password) {
    sendError(res, 400, "Mobile, name, and password are required");
    return;
  }

  const existingUser = await User.findOne({
    $or: [
      { mobile: normalizeMobile(mobile) },
      ...(email ? [{ email: normalizeEmail(email) }] : []),
    ],
  });

  if (existingUser) {
    sendError(res, 409, "An admin with this mobile or email already exists");
    return;
  }

  const admin = await User.create({
    mobile: normalizeMobile(mobile),
    email: normalizeEmail(email),
    name: String(name).trim(),
    examMode: examMode || "BOTH",
    level: level || "Topper",
    passwordHash: hashPassword(String(password)),
    onboardingComplete: true,
    isAdmin: true,
  });

  sendSuccess(
    res,
    {
      token: signAdminToken(String(admin._id)),
      admin: serializeUser(admin),
    },
    201,
    "Admin registered successfully",
  );
});

router.post("/login", async (req, res) => {
  const identifier = String(req.body?.identifier ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!identifier || !password) {
    sendError(res, 400, "Identifier and password are required");
    return;
  }

  const admin = await User.findOne({
    $or: [{ email: identifier.toLowerCase() }, { mobile: identifier }],
    isAdmin: true,
  });

  if (!admin || !verifyPassword(password, admin.passwordHash)) {
    sendError(res, 401, "Invalid admin credentials");
    return;
  }

  sendSuccess(
    res,
    {
      token: signAdminToken(String(admin._id)),
      admin: serializeUser(admin),
    },
    200,
    "Login successful",
  );
});

router.get("/me", requireAdmin, async (req: AuthenticatedRequest, res) => {
  sendSuccess(res, serializeUser(req.user));
});

export default router;
