import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User, IUser } from "@api/db";
import { JWT_SECRET } from "../routes/auth";
import { getFirebaseAuth } from "../lib/firebase";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: IUser;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;
  req.log.info(
    {
      path: req.originalUrl,
      hasAuthorizationHeader: Boolean(authHeader),
      authorizationScheme: authHeader.split(/\s+/, 1)[0] || null,
      tokenExtracted: Boolean(token),
      tokenLength: token?.length || 0,
    },
    "Application authentication request received",
  );

  if (!token) {
    const reason = authHeader
      ? "malformed_bearer_token"
      : "missing_authorization_header";
    req.log.warn({ path: req.originalUrl, reason }, "Application authentication rejected with 401");
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }

  try {
    const unverifiedToken = jwt.decode(token, { complete: true });
    const algorithm =
      typeof unverifiedToken === "object" && unverifiedToken?.header
        ? String(unverifiedToken.header.alg || "")
        : "";
    let user: IUser | null;
    let verifiedUserId = "";
    let tokenType: "firebase" | "app-session";

    if (algorithm === "RS256") {
      tokenType = "firebase";
      const decoded = await getFirebaseAuth().verifyIdToken(token, true);
      verifiedUserId = decoded.uid;
      req.log.info(
        {
          path: req.originalUrl,
          tokenType,
          uid: decoded.uid,
          provider: decoded.firebase?.sign_in_provider || null,
          audience: decoded.aud,
        },
        "Firebase Bearer token verification succeeded",
      );
      user = await User.findOne({ firebaseUid: decoded.uid });
    } else {
      tokenType = "app-session";
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
      }) as { userId?: string };
      if (!decoded?.userId) {
        req.log.warn(
          { path: req.originalUrl, reason: "missing_user_id_claim", tokenType },
          "Application authentication rejected with 401",
        );
        res.status(401).json({ error: "invalid_token", message: "Invalid or expired token" });
        return;
      }
      verifiedUserId = decoded.userId;
      req.log.info(
        { path: req.originalUrl, tokenType, userId: decoded.userId },
        "Application session token verification succeeded",
      );
      user = await User.findById(decoded.userId);
    }

    req.log.info(
      {
        path: req.originalUrl,
        tokenType,
        verifiedUserId,
        found: Boolean(user),
      },
      "Application user lookup completed",
    );

    if (!user) {
      req.log.warn(
        { path: req.originalUrl, reason: "user_not_found", verifiedUserId, tokenType },
        "Application authentication rejected with 401",
      );
      res.status(401).json({ error: "user_not_found", message: "User not found" });
      return;
    }

    if (user.isBlocked || user.isActive === false) {
      res.status(403).json({ error: "account_disabled", message: "This account is not active. Contact support." });
      return;
    }

    req.userId = user._id.toString();
    req.user = user;
    if (user.isPremium && user.premiumExpiresAt && user.premiumExpiresAt < new Date()) {
      user.isPremium = false;
      user.premiumExpiresAt = undefined;
      await user.save();
      req.user = user;
    }
    next();
  } catch (error) {
    const authError = error as { code?: string; message?: string };
    const reason = authError?.code === "auth/id-token-expired"
      ? "firebase_token_expired"
      : authError?.code === "auth/id-token-revoked"
        ? "firebase_token_revoked"
        : authError?.code
          ? authError.code
          : error instanceof jwt.TokenExpiredError
            ? "token_expired"
            : error instanceof jwt.JsonWebTokenError
              ? "invalid_token"
              : "token_verification_failed";
    req.log.warn(
      {
        path: req.originalUrl,
        reason,
        message: authError?.message || "Unknown token verification error",
      },
      "Application authentication rejected with 401",
    );
    res.status(401).json({
      error: reason,
      message: reason.includes("expired") ? "Session expired" : "Invalid token",
    });
  }
}

export async function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  await requireAuth(req, res, async () => {
    if (!req.user?.isAdmin) {
      res.status(403).json({ error: "forbidden", message: "Admin access required" });
      return;
    }
    next();
  });
}
