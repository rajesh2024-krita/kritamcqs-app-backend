import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const KEY_LENGTH = 64;
const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, storedHash = "") {
  const value = String(storedHash || "");
  if (!value) return false;

  if (value.startsWith("$2a$") || value.startsWith("$2b$") || value.startsWith("$2y$")) {
    return bcrypt.compareSync(String(password), value);
  }

  const parts = value.split(":");
  const salt = parts[0] === "scrypt" ? parts[1] : parts[0];
  const hash = parts[0] === "scrypt" ? parts[2] : parts[1];
  if (!salt || !hash) return false;

  try {
    const currentHash = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(currentHash, "hex"));
  } catch {
    return false;
  }
}

export function hashOtp(otp: string) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

export function generateResetToken() {
  return crypto.randomBytes(32).toString("hex");
}
