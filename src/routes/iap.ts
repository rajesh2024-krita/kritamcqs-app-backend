import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import {
  restoreApplePurchase,
  verifyApplePurchase,
} from "../controllers/appleIapController";

const router: IRouter = Router();

router.post("/verify", requireAuth, verifyApplePurchase);
router.post("/restore", requireAuth, restoreApplePurchase);

export default router;
