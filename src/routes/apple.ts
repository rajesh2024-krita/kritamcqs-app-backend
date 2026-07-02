import { Router, type IRouter } from "express";
import { handleAppleWebhook } from "../controllers/appleWebhookController";

const router: IRouter = Router();

router.post("/webhook", handleAppleWebhook);

export default router;
