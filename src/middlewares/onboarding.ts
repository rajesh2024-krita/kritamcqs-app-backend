import { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth";

export function requireOnboardingComplete(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user?.onboardingComplete) {
    res.status(403).json({
      error: "onboarding_required",
      message: "Complete onboarding before accessing this feature",
    });
    return;
  }

  next();
}
