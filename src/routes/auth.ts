import { Router, type IRouter } from "express";
import { AuthOtp, AuthSettings, InvoiceSettings, User } from "@api/db";
import jwt from "jsonwebtoken";
import { generateOtp, generateResetToken, hashOtp, hashPassword, hashResetToken, verifyPassword } from "../lib/password";
import { EMAIL_TEMPLATE_KEYS, sendTemplatedEmail } from "../lib/email-templates";

const router: IRouter = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "krita-secret-key";

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const googleCertCache: { certs: Record<string, string>; expiresAt: number } = { certs: {}, expiresAt: 0 };

function checkRateLimit(key: string, maxAttempts = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= maxAttempts) return false;
  current.count += 1;
  return true;
}

function userResponse(user: any) {
  const u = user.toJSON ? user.toJSON() : user;
  return {
    id: u.id,
    mobile: u.mobile,
    email: u.email,
    name: u.name,
    address: u.address,
    examMode: u.examMode,
    level: u.level,
    onboardingComplete: u.onboardingComplete,
    mobileVerified: u.mobileVerified,
    emailVerified: Boolean(u.emailVerified || u.authTypes?.includes("email") || u.authTypes?.includes("google")),
    authTypes: u.authTypes ?? [],
    requiresProfileCompletion: Boolean(u.requiresProfileCompletion),
    country: u.country,
    state: u.state,
    city: u.city,
    userType: u.userType,
    profileImage: u.profileImage,
    isActive: u.isActive,
    isBlocked: u.isBlocked,
    lastLoginAt: u.lastLoginAt,
    isPremium: u.isPremium,
    premiumExpiresAt: u.premiumExpiresAt,
    createdAt: u.createdAt,
    isAdmin: u.isAdmin,
    migratedFromOldApp: u.migratedFromOldApp,
  };
}

async function getAuthSettings() {
  return AuthSettings.findOneAndUpdate({ key: "default" }, { $setOnInsert: { key: "default" } }, { upsert: true, new: true });
}

function getGoogleClientIds(settings: any) {
  return [...new Set([
    settings?.googleClientId,
    settings?.googleAndroidClientId,
    process.env["GOOGLE_WEB_CLIENT_ID"],
    process.env["GOOGLE_ANDROID_CLIENT_ID"],
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function looksLikeConfiguredAndroidClientId(value: unknown, settings: any) {
  const clientId = String(value || "").trim();
  const packageName = String(settings?.googleAndroidPackageName || "com.kritamcqs.androidapp").trim();
  return Boolean(
    clientId &&
      packageName &&
      clientId === String(settings?.googleClientId || "").trim() &&
      !String(settings?.googleAndroidClientId || "").trim() &&
      !String(process.env["GOOGLE_WEB_CLIENT_ID"] || "").trim() &&
      String(process.env["GOOGLE_ANDROID_CLIENT_ID"] || "").trim() === clientId
  );
}

function signUser(user: any, settings?: any) {
  const timeout = Math.max(15, Number(settings?.sessionTimeoutMinutes || 43200));
  return jwt.sign({ userId: user._id.toString(), mobile: user.mobile, email: user.email }, JWT_SECRET, { expiresIn: `${timeout}m` });
}

async function getGoogleCerts() {
  if (googleCertCache.expiresAt > Date.now() && Object.keys(googleCertCache.certs).length > 0) {
    return googleCertCache.certs;
  }

  const response = await fetch("https://www.googleapis.com/oauth2/v1/certs");
  const certs = (await response.json().catch(() => null)) as Record<string, string> | null;
  if (!response.ok || !certs) {
    throw new Error("Unable to fetch Google public keys.");
  }

  const cacheControl = response.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  googleCertCache.certs = certs;
  googleCertCache.expiresAt = Date.now() + Math.max(300, maxAgeSeconds - 60) * 1000;
  return certs;
}

async function verifyGoogleCredential(credential: string, allowedClientIds: string[]) {
  const decoded = jwt.decode(credential, { complete: true });
  const kid = typeof decoded === "object" && decoded?.header ? String(decoded.header.kid || "") : "";
  if (!kid) throw new Error("Google token is missing a key id.");

  const certs = await getGoogleCerts();
  const cert = certs[kid];
  if (!cert) throw new Error("Google token key is not recognized.");

  return jwt.verify(credential, cert, {
    algorithms: ["RS256"],
    audience: allowedClientIds,
    issuer: ["accounts.google.com", "https://accounts.google.com"],
  }) as jwt.JwtPayload;
}

async function markLogin(user: any) {
  if (user.isBlocked || user.isActive === false) {
    throw new Error("This account is not active. Contact support.");
  }
  user.lastLoginAt = new Date();
  await user.save();
}

function normalizeEmail(input: unknown) {
  const email = String(input || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePassword(input: unknown) {
  const password = String(input || "");
  const strongEnough = password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password);
  return strongEnough && password.length <= 128 ? password : null;
}

function normalizeOtp(input: string) {
  const otp = input.replace(/\D/g, "");
  return /^\d{6}$/.test(otp) ? otp : null;
}

function normalizeResetToken(input: unknown) {
  const token = String(input || "").trim();
  return /^[a-f0-9]{64}$/i.test(token) ? token : null;
}

router.get("/settings", async (_req, res) => {
  const settings = await getAuthSettings();
  const googleClientIds = getGoogleClientIds(settings);
  const configuredGoogleClientId = String(settings.googleClientId || process.env["GOOGLE_WEB_CLIENT_ID"] || "").trim();
  const androidClientId = String(settings.googleAndroidClientId || process.env["GOOGLE_ANDROID_CLIENT_ID"] || "").trim();
  const googleClientIdIsAndroidOnly = looksLikeConfiguredAndroidClientId(configuredGoogleClientId, settings);
  res.json({
    emailPasswordEnabled: settings.emailPasswordEnabled,
    googleEnabled: settings.googleEnabled && googleClientIds.length > 0,
    googleClientId: settings.googleEnabled && !googleClientIdIsAndroidOnly ? configuredGoogleClientId : "",
    googleAndroidClientId: settings.googleEnabled ? androidClientId || (googleClientIdIsAndroidOnly ? configuredGoogleClientId : "") : "",
    googleAndroidPackageName: settings.googleAndroidPackageName || "com.kritamcqs.androidapp",
    profileMobileRequired: Boolean(settings.profileMobileRequired),
  });
});

router.post("/register", async (req, res) => {
  try {
    const settings = await getAuthSettings();
    if (!settings.emailPasswordEnabled) {
      res.status(403).json({ error: "email_auth_disabled", message: "Email/password registration is currently disabled." });
      return;
    }
    const email = normalizeEmail(req.body?.email);
    const password = normalizePassword(req.body?.password);
    const name = String(req.body?.name || "").trim();
    if (!email || !password || name.length < 2) {
      res.status(400).json({ error: "invalid_registration", message: "Enter a valid name, email, and password." });
      return;
    }
    const existing = await User.findOne({ email });
    if (existing) {
      res.status(409).json({ error: "email_exists", message: "An account already exists for this email." });
      return;
    }
    const user = await new User({
      email,
      name,
      passwordHash: hashPassword(password),
      authTypes: ["email"],
      onboardingComplete: false,
      mobileVerified: false,
      isPremium: false,
      isAdmin: false,
    }).save();
    await markLogin(user);

    const invoiceSettings = await InvoiceSettings.findOne({ key: "default" });
    sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.AUTH_REGISTRATION, email, {
      user_name: user.name || "Learner",
      email: user.email,
      app_name: invoiceSettings?.companyName || "Krita",
      support_email: invoiceSettings?.companyEmail || invoiceSettings?.smtp?.fromEmail || "support@krita.com",
    }).catch((err) => {
      req.log.warn({ err, userId: String(user._id), email }, "Registration welcome email failed");
    });

    res.status(201).json({ token: signUser(user, settings), user: userResponse(user), isNewUser: true });
  } catch (error) {
    req.log.error({ error }, "Email registration failed");
    res.status(400).json({ error: "registration_failed", message: error instanceof Error ? error.message : "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const settings = await getAuthSettings();
    if (!settings.emailPasswordEnabled) {
      res.status(403).json({ error: "email_auth_disabled", message: "Email/password login is currently disabled." });
      return;
    }
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (email && !checkRateLimit(`login:${email}`)) {
      res.status(429).json({ error: "rate_limited", message: "Too many login attempts. Try again later." });
      return;
    }
    if (!email || !password) {
      res.status(400).json({ error: "invalid_login", message: "Enter a valid email and password." });
      return;
    }
    const user = await User.findOne({ email });
    if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: "invalid_credentials", message: "Invalid email or password." });
      return;
    }
    user.authTypes = [...new Set([...(user.authTypes || []), "email"])];
    await markLogin(user);
    res.json({ token: signUser(user, settings), user: userResponse(user), isNewUser: false });
  } catch (error) {
    req.log.error({ error }, "Email login failed");
    res.status(400).json({ error: "login_failed", message: "Login failed" });
  }
});

router.post("/google", async (req, res) => {
  try {
    const settings = await getAuthSettings();
    const allowedClientIds = getGoogleClientIds(settings);
    if (!settings.googleEnabled || allowedClientIds.length === 0) {
      res.status(403).json({ error: "google_disabled", message: "Google login is currently disabled." });
      return;
    }
    const credential = String(req.body?.credential || "");
    if (!credential) {
      res.status(400).json({ error: "missing_credential", message: "Google credential is required." });
      return;
    }
    let googleUser: jwt.JwtPayload;
    try {
      googleUser = await verifyGoogleCredential(credential, allowedClientIds);
    } catch (error) {
      req.log.warn({ error }, "Google token verification failed");
      res.status(401).json({ error: "invalid_google_token", message: "Google verification failed. Check the configured OAuth client IDs." });
      return;
    }

    if (!googleUser?.email) {
      res.status(401).json({ error: "invalid_google_token", message: "Google verification failed." });
      return;
    }

    const email = normalizeEmail(googleUser.email);
    if (!email) {
      res.status(400).json({ error: "invalid_google_email", message: "Google account did not provide a valid email." });
      return;
    }

    let user = await User.findOne({ $or: [{ googleId: googleUser.sub }, { email }] });
    let isNewUser = false;
    if (!user) {
      user = await new User({
        email,
        googleId: googleUser.sub,
        name: googleUser.name || "",
        profileImage: googleUser.picture || "",
        authTypes: ["google"],
        onboardingComplete: false,
        requiresProfileCompletion: true,
        isPremium: false,
        isAdmin: false,
      }).save();
      isNewUser = true;
    } else {
      user.googleId = user.googleId || googleUser.sub;
      user.email = user.email || email;
      user.name = user.name || googleUser.name || "";
      user.profileImage = user.profileImage || googleUser.picture || "";
      user.authTypes = [...new Set([...(user.authTypes || []), "google"])];
      user.requiresProfileCompletion = !user.name || !user.email;
    }
    await markLogin(user);

    if (isNewUser) {
      const invoiceSettings = await InvoiceSettings.findOne({ key: "default" });
      sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.AUTH_REGISTRATION, user.email, {
        user_name: user.name || "Learner",
        email: user.email,
        app_name: invoiceSettings?.companyName || "Krita",
        support_email: invoiceSettings?.companyEmail || invoiceSettings?.smtp?.fromEmail || "support@krita.com",
      }).catch((err) => {
        req.log.warn({ err, userId: String(user._id), email: user.email }, "Google registration welcome email failed");
      });
    }

    res.json({ token: signUser(user, settings), user: userResponse(user), isNewUser });
  } catch (error) {
    req.log.error({ error }, "Google login failed");
    res.status(400).json({ error: "google_login_failed", message: "Google login failed" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const settings = await getAuthSettings();
    if (!settings.emailPasswordEnabled) {
      res.status(403).json({ error: "email_auth_disabled", message: "Email/password login is currently disabled." });
      return;
    }
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "invalid_email", message: "Enter a valid registered email." });
      return;
    }
    if (!checkRateLimit(`forgot:${email}`, 5, 30 * 60 * 1000)) {
      res.status(429).json({ error: "rate_limited", message: "Too many reset requests. Try again later." });
      return;
    }
    // Allow OTP even if passwordHash is missing (some users may have been created without passwordHash yet).
    // Reset will create/override passwordHash in /reset-password.
    const user = await User.findOne({ email });
    if (!user) {
      res.status(404).json({ error: "email_not_found", message: "No account was found for this email." });
      return;
    }
    const latest = await AuthOtp.findOne({ email, purpose: "password_reset", used: false }).sort({ createdAt: -1 });
    if (latest && latest.resendCount >= settings.resetOtpMaxResends && latest.expiresAt > new Date()) {
      res.status(429).json({ error: "retry_limit", message: "OTP resend limit reached. Try again later." });
      return;
    }
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + settings.resetOtpExpiryMinutes * 60 * 1000);
    await AuthOtp.updateMany({ email, purpose: "password_reset", used: false }, { $set: { used: true } });
    await AuthOtp.create({
      email,
      purpose: "password_reset",
      otpHash: hashOtp(otp),
      expiresAt,
      resendCount: latest ? latest.resendCount + 1 : 1,
    });

    const invoiceSettings = await InvoiceSettings.findOne({ key: "default" });
    await sendTemplatedEmail(EMAIL_TEMPLATE_KEYS.AUTH_FORGOT_PASSWORD_OTP, email, {
      otp,
      otp_code: otp,
      otp_expiry: `${settings.resetOtpExpiryMinutes} minutes`,
      expiry_time: `${settings.resetOtpExpiryMinutes} minutes`,
      reset_link: "",
      user_name: user.name || "Learner",
      email,
      support_email: invoiceSettings?.companyEmail || invoiceSettings?.smtp?.fromEmail || "support@krita.com",
    });

    res.json({ success: true, message: "Password reset OTP sent to your registered email.", expiresIn: settings.resetOtpExpiryMinutes * 60 });
  } catch (error) {
    req.log.error({ error }, "Forgot password failed");
    res.status(400).json({ error: "forgot_password_failed", message: error instanceof Error ? error.message : "Unable to send reset OTP." });
  }
});

router.post("/verify-reset-otp", async (req, res) => {
  try {
    const settings = await getAuthSettings();
    const email = normalizeEmail(req.body?.email);
    const otp = normalizeOtp(String(req.body?.otp || ""));
    if (!email || !otp) {
      res.status(400).json({ error: "invalid_otp", message: "Enter the 6-digit OTP." });
      return;
    }

    const record = await AuthOtp.findOne({ email, purpose: "password_reset", used: false }).sort({ createdAt: -1 });
    if (!record) {
      res.status(401).json({ error: "invalid_otp", message: "Invalid OTP." });
      return;
    }
    if (record.expiresAt <= new Date()) {
      res.status(410).json({ error: "otp_expired", message: "OTP Expired" });
      return;
    }

    const attempts = Number(record.attempts ?? 0);
    if (attempts >= settings.resetOtpMaxAttempts) {
      res.status(429).json({ error: "attempt_limit", message: "OTP attempt limit reached. Request a new OTP." });
      return;
    }

    if (record.otpHash !== hashOtp(otp)) {
      record.attempts = attempts + 1;
      await record.save();
      res.status(401).json({ error: "invalid_otp", message: "Invalid OTP" });
      return;
    }

    const resetToken = generateResetToken();
    record.attempts = attempts + 1;
    record.verifiedAt = new Date();
    record.resetTokenHash = hashResetToken(resetToken);
    await record.save();
    res.json({ success: true, message: "OTP verified.", resetToken, expiresAt: record.expiresAt });
  } catch (error) {
    req.log.error({ error }, "Verify reset OTP failed");
    res.status(400).json({ error: "verify_otp_failed", message: "Unable to verify OTP." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const resetToken = normalizeResetToken(req.body?.resetToken);
    const password = normalizePassword(req.body?.password);
    if (!email || !resetToken || !password) {
      res.status(400).json({ error: "invalid_reset", message: "Verify OTP before resetting your password." });
      return;
    }
    const record = await AuthOtp.findOne({
      email,
      purpose: "password_reset",
      resetTokenHash: hashResetToken(resetToken),
      used: false,
    }).sort({ createdAt: -1 });
    if (!record?.verifiedAt) {
      res.status(401).json({ error: "otp_not_verified", message: "Verify OTP before resetting your password." });
      return;
    }
    if (record.expiresAt <= new Date()) {
      res.status(410).json({ error: "otp_expired", message: "OTP Expired" });
      return;
    }

    const user = await User.findOne({ email });
    if (!user) {
      res.status(404).json({ error: "user_not_found", message: "User not found." });
      return;
    }
    user.passwordHash = hashPassword(password);
    user.authTypes = [...new Set([...(user.authTypes || []), "email"])];
    record.used = true;
    await Promise.all([user.save(), record.save()]);
    res.json({ success: true, message: "Password reset successfully." });
  } catch (error) {
    req.log.error({ error }, "Reset password failed");
    res.status(400).json({ error: "reset_password_failed", message: "Unable to reset password." });
  }
});

router.post("/logout", (_req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
});

router.post("/demo-login", async (_req, res) => {
  res.status(410).json({ error: "demo_login_removed", message: "Demo/mobile login has been removed. Use email/password or Google login." });
});

export default router;
export { JWT_SECRET };
