import { Router, type IRouter } from "express";
import { Coupon, Subscription, SubscriptionPlan, User } from "@api/db";
import { CreateOrderBody, VerifyPaymentBody } from "@api/zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";

const router: IRouter = Router();

function mapPlan(plan: any) {
  if (!plan) return null;
  return {
    id: plan.planId,
    name: plan.name,
    price: Number(plan.price || 0),
    duration: Number(plan.durationMonths || 0),
    durationMonths: Number(plan.durationMonths || 0),
    durationUnit: "months",
    savings: plan.savings || "",
    features: Array.isArray(plan.features) ? plan.features.filter(Boolean) : [],
    active: Boolean(plan.active),
    sortOrder: Number(plan.sortOrder || 0),
  };
}

async function getSubscriptionPlan(planId: string) {
  const normalizedPlanId = String(planId || "").trim();
  if (!normalizedPlanId) {
    throw new Error("Plan id is required");
  }
  const plan = await SubscriptionPlan.findOne({ planId: normalizedPlanId });
  if (!plan) {
    throw new Error("Plan not found");
  }
  return plan;
}

async function resolveCoupon(plan: any, couponCode?: string) {
  const normalizedCode = String(couponCode ?? "").trim().toUpperCase();
  const mappedPlan = mapPlan(plan);
  const baseAmount = Number(mappedPlan?.price || 0);

  if (!normalizedCode) {
    return {
      coupon: null,
      pricing: {
        baseAmount,
        discountAmount: 0,
        finalAmount: baseAmount,
        coupon: null,
      },
    };
  }

  const coupon = await Coupon.findOne({ code: normalizedCode });
  if (!coupon) {
    throw new Error("Coupon not found");
  }
  if (!coupon.active) {
    throw new Error("Coupon is inactive");
  }
  if (coupon.validFrom && new Date(coupon.validFrom) > new Date()) {
    throw new Error("Coupon is not active yet");
  }
  if (coupon.validUntil && new Date(coupon.validUntil) < new Date()) {
    throw new Error("Coupon has expired");
  }
  if (coupon.usageLimit && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) {
    throw new Error("Coupon usage limit reached");
  }

  const rawDiscount = coupon.type === "percent" ? (baseAmount * Number(coupon.value)) / 100 : Number(coupon.value);
  const discountAmount = Math.min(baseAmount, Math.max(0, Math.round(rawDiscount)));
  const finalAmount = Math.max(0, baseAmount - discountAmount);

  return {
    coupon,
    pricing: {
      baseAmount,
      discountAmount,
      finalAmount,
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
      },
    },
  };
}

router.get("/plans", async (_req, res) => {
  const plans = await SubscriptionPlan.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 });
  res.json(plans.map(mapPlan));
});

router.post("/apply-coupon", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const couponCode = String(req.body?.couponCode ?? "");
    const planId = String(req.body?.planId ?? "");
    const plan = await getSubscriptionPlan(planId);
    const { pricing } = await resolveCoupon(plan, couponCode);
    res.json(pricing);
  } catch (error) {
    req.log.error({ error }, "Apply coupon failed");
    res.status(400).json({ error: "coupon_invalid", message: error instanceof Error ? error.message : "Coupon could not be applied" });
  }
});

router.get("/history", requireAuth, async (req: AuthenticatedRequest, res) => {
  const purchases = await Subscription.find({ userId: req.userId }).sort({ createdAt: -1 });
  const current = purchases.find((item) => item.status === "active" && (!item.endDate || item.endDate >= new Date())) ?? null;
  const planIds = [...new Set(purchases.map((item) => String(item.planId)).filter(Boolean))];
  const plans = planIds.length ? await SubscriptionPlan.find({ planId: { $in: planIds } }) : [];
  const planMap = new Map(plans.map((item) => [String(item.planId), mapPlan(item)]));

  res.json({
    currentPurchase: current
      ? {
          ...current.toJSON(),
          planName: planMap.get(String(current.planId))?.name ?? current.planId,
        }
      : null,
    purchases: purchases.map((item) => ({
      ...item.toJSON(),
      planName: planMap.get(String(item.planId))?.name ?? item.planId,
    })),
  });
});

router.post("/create-order", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = CreateOrderBody.parse(req.body);
    const plan = await getSubscriptionPlan(body.planId);
    const { pricing } = await resolveCoupon(plan, body.couponCode);
    const orderId = `order_${Date.now()}_${req.userId}`;
    res.json({
      orderId,
      amount: pricing.finalAmount * 100,
      currency: "INR",
      keyId: process.env["RAZORPAY_KEY_ID"] ?? "rzp_test_demo",
      pricing,
      plan: mapPlan(plan),
    });
  } catch (error) {
    req.log.error({ error }, "Create order failed");
    const message = error instanceof Error ? error.message : "Failed to create order";
    const status = /coupon|plan/i.test(message) ? 400 : 500;
    res.status(status).json({ error: "order_failed", message });
  }
});

router.post("/verify-payment", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const body = VerifyPaymentBody.parse(req.body);
    const plan = await getSubscriptionPlan(body.planId);
    const { coupon, pricing } = await resolveCoupon(plan, body.couponCode);
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + Number(plan.durationMonths || 0));

    await new Subscription({
      userId: req.userId,
      planId: body.planId,
      razorpayOrderId: body.orderId,
      razorpayPaymentId: body.paymentId,
      couponCode: coupon?.code,
      couponType: coupon?.type,
      couponValue: coupon?.value,
      baseAmount: pricing.baseAmount,
      discountAmount: pricing.discountAmount,
      amount: pricing.finalAmount,
      status: "active",
      startDate: new Date(),
      endDate: expiresAt,
    }).save();

    if (coupon) {
      coupon.usedCount = Number(coupon.usedCount || 0) + 1;
      await coupon.save();
    }

    await User.findByIdAndUpdate(req.userId, { isPremium: true, premiumExpiresAt: expiresAt });

    res.json({ isPremium: true, expiresAt: expiresAt.toISOString(), plan: plan.name, pricing });
  } catch (error) {
    req.log.error({ error }, "Verify payment failed");
    const message = error instanceof Error ? error.message : "Payment verification failed";
    const status = /coupon|plan/i.test(message) ? 400 : 500;
    res.status(status).json({ error: "verify_failed", message });
  }
});

export default router;
