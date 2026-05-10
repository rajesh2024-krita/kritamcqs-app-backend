import { Router, type IRouter } from "express";
import crypto from "crypto";
import { Coupon, PaymentGatewaySettings, Subscription, SubscriptionPlan, User } from "@api/db";
import { CreateOrderBody, VerifyPaymentBody } from "@api/zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { generateInvoiceForSubscription } from "../lib/invoices";

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

async function getRazorpaySettings() {
  const settings = await PaymentGatewaySettings.findOne({ provider: "razorpay" });
  const keyId = settings?.razorpayKeyId || process.env["RAZORPAY_KEY_ID"] || "";
  const keySecret = settings?.razorpayKeySecret || process.env["RAZORPAY_KEY_SECRET"] || "";
  const enabled = settings ? settings.enabled !== false && settings.connectionStatus === "connected" : Boolean(keyId && keySecret);

  if (!enabled || !keyId || !keySecret) {
    throw new Error("Razorpay is not configured. Please configure Razorpay in the admin panel.");
  }

  return { keyId, keySecret };
}

function razorpayAuthHeader(keyId: string, keySecret: string) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

async function createRazorpayOrder({
  keyId,
  keySecret,
  amount,
  receipt,
  notes,
}: {
  keyId: string;
  keySecret: string;
  amount: number;
  receipt: string;
  notes: Record<string, string>;
}) {
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: razorpayAuthHeader(keyId, keySecret),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
      receipt: receipt.slice(0, 40),
      notes,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.description || payload?.error?.reason || "Razorpay order creation failed");
  }
  return payload;
}

function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string, keySecret: string) {
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(signature || ""));
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function fetchRazorpayPayment(keyId: string, keySecret: string, paymentId: string) {
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: {
      Authorization: razorpayAuthHeader(keyId, keySecret),
      "Content-Type": "application/json",
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.description || payload?.error?.reason || "Unable to verify Razorpay payment status");
  }
  return payload;
}

async function fetchRazorpayOrder(keyId: string, keySecret: string, orderId: string) {
  const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: {
      Authorization: razorpayAuthHeader(keyId, keySecret),
      "Content-Type": "application/json",
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.description || payload?.error?.reason || "Unable to verify Razorpay order amount");
  }
  return payload;
}

async function captureRazorpayPayment(keyId: string, keySecret: string, paymentId: string, amount: number) {
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/capture`, {
    method: "POST",
    headers: {
      Authorization: razorpayAuthHeader(keyId, keySecret),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.description || payload?.error?.reason || "Unable to capture Razorpay payment");
  }
  return payload;
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
    const amountInPaise = Math.round(Number(pricing.finalAmount || 0) * 100);
    if (amountInPaise < 100) {
      throw new Error("Razorpay payment amount must be at least Rs. 1");
    }

    const gateway = await getRazorpaySettings();
    const order = await createRazorpayOrder({
      ...gateway,
      amount: amountInPaise,
      receipt: `sub_${Date.now()}_${req.userId}`,
      notes: {
        userId: String(req.userId),
        planId: String(body.planId),
        couponCode: String(body.couponCode || ""),
      },
    });

    await Subscription.findOneAndUpdate(
      { userId: req.userId, razorpayOrderId: order.id, status: "pending" },
      {
        userId: req.userId,
        planId: body.planId,
        razorpayOrderId: order.id,
        couponCode: pricing.coupon?.code,
        couponType: pricing.coupon?.type,
        couponValue: pricing.coupon?.value,
        baseAmount: pricing.baseAmount,
        discountAmount: pricing.discountAmount,
        amount: pricing.finalAmount,
        status: "pending",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({
      orderId: order.id,
      amount: Number(order.amount ?? amountInPaise),
      currency: order.currency ?? "INR",
      keyId: gateway.keyId,
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
    const gateway = await getRazorpaySettings();
    const pendingSubscription = await Subscription.findOne({
      userId: req.userId,
      razorpayOrderId: body.orderId,
      planId: body.planId,
      status: "pending",
    });

    if (!pendingSubscription) {
      throw new Error("Matching pending Razorpay order was not found");
    }

    const { coupon, pricing } = await resolveCoupon(plan, pendingSubscription.couponCode || body.couponCode);

    if (!verifyRazorpaySignature(body.orderId, body.paymentId, body.signature, gateway.keySecret)) {
      pendingSubscription.status = "failed";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      await pendingSubscription.save();
      throw new Error("Razorpay payment signature verification failed");
    }

    const razorpayOrder = await fetchRazorpayOrder(gateway.keyId, gateway.keySecret, body.orderId);
    const expectedAmount = Number(razorpayOrder.amount || 0);
    if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
      throw new Error("Unable to verify Razorpay order amount");
    }

    let payment = await fetchRazorpayPayment(gateway.keyId, gateway.keySecret, body.paymentId);
    let paidAmount = Number(payment.amount || 0);

    if (String(payment.order_id || "") !== String(body.orderId)) {
      pendingSubscription.status = "failed";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      await pendingSubscription.save();
      throw new Error("Razorpay payment does not belong to this order");
    }

    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
      pendingSubscription.status = "failed";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      await pendingSubscription.save();
      throw new Error("Unable to verify Razorpay payment amount");
    }

    if (paidAmount < expectedAmount) {
      pendingSubscription.status = "failed";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      await pendingSubscription.save();
      throw new Error(`Razorpay payment amount is less than this order. Paid ${paidAmount}, expected ${expectedAmount}`);
    }

    if (String(payment.status || "").toLowerCase() === "authorized") {
      payment = await captureRazorpayPayment(gateway.keyId, gateway.keySecret, body.paymentId, paidAmount);
      paidAmount = Number(payment.amount || paidAmount);
    }

    if (String(payment.status || "").toLowerCase() !== "captured") {
      pendingSubscription.status = "failed";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      await pendingSubscription.save();
      throw new Error(`Razorpay payment is not captured. Current status: ${payment.status || "unknown"}`);
    }

    if (paidAmount < expectedAmount) {
      pendingSubscription.status = "failed";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      await pendingSubscription.save();
      throw new Error(`Razorpay payment amount is less than this order. Paid ${paidAmount}, expected ${expectedAmount}`);
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + Number(plan.durationMonths || 0));

    pendingSubscription.razorpayPaymentId = body.paymentId;
    pendingSubscription.couponCode = coupon?.code;
    pendingSubscription.couponType = coupon?.type;
    pendingSubscription.couponValue = coupon?.value;
    pendingSubscription.baseAmount = pricing.baseAmount;
    pendingSubscription.discountAmount = pricing.discountAmount;
    pendingSubscription.amount = expectedAmount / 100;
    pendingSubscription.status = "active";
    pendingSubscription.startDate = new Date();
    pendingSubscription.endDate = expiresAt;
    await pendingSubscription.save();
    generateInvoiceForSubscription(String(pendingSubscription._id)).catch((err) =>
      req.log.error({ err }, "Automatic invoice generation failed"),
    );

    if (coupon) {
      coupon.usedCount = Number(coupon.usedCount || 0) + 1;
      await coupon.save();
    }

    await User.findByIdAndUpdate(req.userId, { isPremium: true, premiumExpiresAt: expiresAt });

    res.json({ isPremium: true, expiresAt: expiresAt.toISOString(), plan: plan.name, pricing });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment verification failed";
    req.log.error({ err: error, message }, "Verify payment failed");
    const status = /coupon|plan/i.test(message) ? 400 : 500;
    res.status(status).json({ error: "verify_failed", message });
  }
});

export default router;
