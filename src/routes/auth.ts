import { Router, type IRouter } from "express";
import { Otp, User } from "@api/db";
import { SendOtpBody, VerifyOtpBody } from "@api/zod";
import jwt from "jsonwebtoken";
import { checkVerificationCode, isTwilioConfigured, sendVerificationSms } from "../lib/twilio";

const router: IRouter = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "krita-secret-key";

function userResponse(user: any) {
  const u = user.toJSON ? user.toJSON() : user;
  return {
    id: u.id,
    mobile: u.mobile,
    name: u.name,
    examMode: u.examMode,
    level: u.level,
    onboardingComplete: u.onboardingComplete,
    mobileVerified: u.mobileVerified,
    isPremium: u.isPremium,
    premiumExpiresAt: u.premiumExpiresAt,
    createdAt: u.createdAt,
    isAdmin: u.isAdmin,
    migratedFromOldApp: u.migratedFromOldApp,
  };
}

function normalizeIndianMobile(input: string) {
  const digits = input.replace(/\D/g, "");
  const normalized = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;

  if (!/^[6-9]\d{9}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function formatE164IndianMobile(mobile: string) {
  return `+91${mobile}`;
}

function normalizeOtp(input: string) {
  const otp = input.replace(/\D/g, "");
  return /^\d{6}$/.test(otp) ? otp : null;
}

function getAuthMode(req: { headers: Record<string, unknown> }) {
  return req.headers["x-auth-mode"] === "live" ? "live" : "development";
}

router.post("/send-otp", async (req, res) => {
  try {
    const body = SendOtpBody.parse(req.body);
    const mobile = normalizeIndianMobile(body.mobile);
    const authMode = getAuthMode(req);

    if (!mobile) {
      res.status(400).json({ error: "invalid_mobile", message: "Please enter a valid 10-digit mobile number" });
      return;
    }

    if (authMode === "development") {
      const otp = "123456";
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await Otp.findOneAndUpdate(
        { mobile },
        { mobile, otp, expiresAt, used: false },
        { upsert: true, new: true },
      );

      req.log.info({ mobile, authMode }, "Development OTP generated");
      res.json({
        success: true,
        message: `Development OTP ready for +91 ${mobile}`,
        expiresIn: 600,
        devOtp: otp,
      });
      return;
    }

    if (!isTwilioConfigured()) {
      req.log.error("Twilio Verify is not configured");
      res.status(500).json({ error: "twilio_not_configured", message: "OTP service is not configured on the server" });
      return;
    }

    await sendVerificationSms(formatE164IndianMobile(mobile));
    req.log.info({ mobile }, "OTP sent via Twilio Verify");

    res.json({
      success: true,
      message: `OTP sent to +91 ${mobile}`,
      expiresIn: 600,
    });
  } catch (error) {
    req.log.error({ error }, "Error sending OTP");
    res.status(400).json({ error: "send_otp_failed", message: error instanceof Error ? error.message : "Failed to send OTP" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const body = VerifyOtpBody.parse(req.body);
    const mobile = normalizeIndianMobile(body.mobile);
    const otp = normalizeOtp(body.otp);
    const authMode = getAuthMode(req);

    if (!mobile) {
      res.status(400).json({ error: "invalid_mobile", message: "Please enter a valid 10-digit mobile number" });
      return;
    }

    if (!otp) {
      res.status(400).json({ error: "invalid_otp", message: "OTP must be a 6-digit number" });
      return;
    }

    if (authMode === "development") {
      const validOtp = await Otp.findOne({
        mobile,
        otp,
        used: false,
        expiresAt: { $gt: new Date() },
      });

      if (!validOtp) {
        res.status(401).json({ error: "invalid_otp", message: "Invalid or expired OTP" });
        return;
      }

      await Otp.findByIdAndUpdate(validOtp._id, { used: true });
    } else if (!isTwilioConfigured()) {
      req.log.error("Twilio Verify is not configured");
      res.status(500).json({ error: "twilio_not_configured", message: "OTP service is not configured on the server" });
      return;
    } else {
      const verification = await checkVerificationCode(formatE164IndianMobile(mobile), otp);

      if (verification.status !== "approved" || !verification.valid) {
        res.status(401).json({ error: "invalid_otp", message: "Invalid or expired OTP" });
        return;
      }
    }

    let user = await User.findOne({ mobile });
    let isNewUser = false;

    if (!user) {
      user = await new User({ mobile, onboardingComplete: false, mobileVerified: true, isPremium: false, isAdmin: false }).save();
      isNewUser = true;
    } else if (!user.mobileVerified) {
      user.mobileVerified = true;
      await user.save();
    }

    const token = jwt.sign({ userId: user._id.toString(), mobile: user.mobile }, JWT_SECRET, { expiresIn: "30d" });

    res.json({ token, user: userResponse(user), isNewUser });
  } catch (error) {
    req.log.error({ error }, "Error verifying OTP");
    res.status(400).json({ error: "verify_failed", message: error instanceof Error ? error.message : "OTP verification failed" });
  }
});

router.post("/logout", (_req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
});

router.post("/demo-login", async (req, res) => {
  try {
    const { mobile } = req.body as { mobile?: string };
    if (!mobile) {
      res.status(400).json({ error: "mobile_required", message: "Mobile number is required" });
      return;
    }

    const user = await User.findOne({ mobile });

    if (!user) {
      res.status(404).json({ error: "user_not_found", message: "Demo user not found" });
      return;
    }

    const token = jwt.sign({ userId: user._id.toString(), mobile: user.mobile }, JWT_SECRET, { expiresIn: "30d" });

    res.json({ token, user: userResponse(user), isNewUser: false });
  } catch (error) {
    req.log.error({ error }, "Error in demo login");
    res.status(500).json({ error: "demo_login_failed", message: "Demo login failed" });
  }
});

export default router;
export { JWT_SECRET };
