import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User, IUser } from "@api/db";
import { JWT_SECRET } from "../routes/auth";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: IUser;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await User.findById(decoded.userId);

    if (!user) {
      res.status(401).json({ error: "user_not_found", message: "User not found" });
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
  } catch {
    res.status(401).json({ error: "invalid_token", message: "Invalid or expired token" });
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
