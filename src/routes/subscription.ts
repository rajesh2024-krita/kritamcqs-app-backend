import { Router, type IRouter } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import { Coupon, Invoice, PaymentGatewaySettings, Subscription, SubscriptionPlan, User } from "@api/db";
import { CreateOrderBody, VerifyPaymentBody } from "@api/zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { generateInvoiceForSubscription, getInvoiceSettings, regenerateInvoicePdf } from "../lib/invoices";

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

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function floorMoney(value: number) {
  return Math.floor(Number(value || 0) * 100) / 100;
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

  const settings = await getInvoiceSettings();
  const taxPercent = Math.max(0, Number(settings.defaultTaxPercent ?? 0));
  const convenienceChargePercent = Math.max(0, Number(settings.defaultConvenienceChargePercent ?? 0));
  const convenienceChargeGstPercent = Math.max(0, Number(settings.defaultConvenienceChargeGstPercent ?? 0));
  const calculatePricing = (discountAmount: number, coupon: any = null) => {
    const taxableAmount = Math.max(0, baseAmount - discountAmount);
    const taxAmount = roundMoney((taxableAmount * taxPercent) / 100);
    const amountBeforeCharges = roundMoney(taxableAmount + taxAmount);
    const convenienceCharge = roundMoney((amountBeforeCharges * convenienceChargePercent) / 100);
    const convenienceChargeGst = floorMoney((convenienceCharge * convenienceChargeGstPercent) / 100);
    const finalAmount = roundMoney(amountBeforeCharges + convenienceCharge + convenienceChargeGst);
    return {
      planAmount: baseAmount,
      baseAmount,
      subtotal: baseAmount,
      discountAmount,
      taxableAmount,
      taxPercent,
      taxAmount,
      amountBeforeCharges,
      convenienceChargePercent,
      convenienceCharge,
      convenienceChargeGstPercent,
      convenienceChargeGst,
      finalAmount,
      currency: "INR",
      coupon,
    };
  };

  if (!normalizedCode) {
    return {
      coupon: null,
      pricing: calculatePricing(0),
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
  const discountAmount = Math.min(baseAmount, Math.max(0, Math.round(rawDiscount * 100) / 100));

  return {
    coupon,
    pricing: calculatePricing(discountAmount, {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
    }),
  };
}

router.get("/plans", async (_req, res) => {
  const plan = await SubscriptionPlan.findOne({ active: true }).sort({ sortOrder: 1, createdAt: 1 });
  res.json(plan ? [mapPlan(plan)] : []);
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

function mapInvoice(invoice: any) {
  const raw = invoice.toJSON?.() || invoice;
  return {
    id: String(raw.id || raw._id),
    invoiceNumber: raw.invoiceNumber,
    planId: raw.planId,
    planName: raw.items?.[0]?.product || raw.planId,
    amount: raw.grandTotal ?? raw.amount,
    subtotal: raw.subtotal ?? 0,
    discountTotal: raw.discountTotal ?? 0,
    taxTotal: raw.taxTotal ?? 0,
    convenienceCharge: raw.convenienceCharge ?? 0,
    convenienceChargeGst: raw.convenienceChargeGst ?? 0,
    grandTotal: raw.grandTotal ?? raw.amount,
    taxDetails: raw.taxDetails || {},
    currency: raw.currency || "INR",
    status: raw.status,
    emailStatus: raw.emailStatus,
    invoiceDate: raw.invoiceDate || raw.issuedAt || raw.createdAt,
    dueDate: raw.dueDate,
    transactionId: raw.transactionId,
    templateName: raw.templateName,
    pdfPath: raw.pdfPath,
    paymentHistory: raw.paymentHistory || [],
    items: raw.items || [],
  };
}

router.get("/invoices", requireAuth, async (req: AuthenticatedRequest, res) => {
  const invoices = await Invoice.find({ userId: req.userId }).sort({ invoiceDate: -1, createdAt: -1 }).lean();
  res.json({ invoices: invoices.map(mapInvoice) });
});

router.get("/invoices/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ error: "invalid_invoice", message: "Invalid invoice id" });
    return;
  }
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) {
    res.status(404).json({ error: "not_found", message: "Invoice not found" });
    return;
  }
  res.json(mapInvoice(invoice));
});

router.get("/invoices/:id/pdf", requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ error: "invalid_invoice", message: "Invalid invoice id" });
    return;
  }
  const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.userId });
  if (!invoice) {
    res.status(404).json({ error: "not_found", message: "Invoice not found" });
    return;
  }
  const pdf = await regenerateInvoicePdf(invoice);
  await invoice.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
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
        taxPercent: pricing.taxPercent,
        taxAmount: pricing.taxAmount,
        amountBeforeCharges: pricing.amountBeforeCharges,
        convenienceChargePercent: pricing.convenienceChargePercent,
        convenienceCharge: pricing.convenienceCharge,
        convenienceChargeGstPercent: pricing.convenienceChargeGstPercent,
        convenienceChargeGst: pricing.convenienceChargeGst,
        finalAmount: pricing.finalAmount,
        currency: pricing.currency,
        amount: pricing.finalAmount,
        status: "pending",
        paymentStatus: "PENDING",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    req.log.info({ orderId: order.id, userId: req.userId, planId: body.planId, amount: pricing.finalAmount, taxAmount: pricing.taxAmount, discountAmount: pricing.discountAmount }, "Razorpay order created and pending subscription stored");

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
    req.log.info({ orderId: body.orderId, paymentId: body.paymentId, planId: body.planId, userId: req.userId }, "Payment verification received");
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

    const { coupon, pricing: livePricing } = await resolveCoupon(plan, pendingSubscription.couponCode || body.couponCode);
    let pricing = {
      ...livePricing,
      baseAmount: Number(pendingSubscription.baseAmount ?? livePricing.baseAmount),
      discountAmount: Number(pendingSubscription.discountAmount ?? livePricing.discountAmount),
      taxPercent: Number(pendingSubscription.taxPercent ?? livePricing.taxPercent),
      taxAmount: Number(pendingSubscription.taxAmount ?? livePricing.taxAmount),
      amountBeforeCharges: Number(pendingSubscription.amountBeforeCharges ?? livePricing.amountBeforeCharges),
      convenienceChargePercent: Number(pendingSubscription.convenienceChargePercent ?? livePricing.convenienceChargePercent),
      convenienceCharge: Number(pendingSubscription.convenienceCharge ?? livePricing.convenienceCharge),
      convenienceChargeGstPercent: Number(pendingSubscription.convenienceChargeGstPercent ?? livePricing.convenienceChargeGstPercent),
      convenienceChargeGst: Number(pendingSubscription.convenienceChargeGst ?? livePricing.convenienceChargeGst),
      finalAmount: Number(pendingSubscription.finalAmount ?? pendingSubscription.amount ?? livePricing.finalAmount),
      currency: pendingSubscription.currency || livePricing.currency || "INR",
    };

    if (!verifyRazorpaySignature(body.orderId, body.paymentId, body.signature, gateway.keySecret)) {
      pendingSubscription.status = "failed";
      pendingSubscription.paymentStatus = "FAILED";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      pendingSubscription.razorpaySignature = body.signature;
      await pendingSubscription.save();
      throw new Error("Razorpay payment signature verification failed");
    }

    const razorpayOrder = await fetchRazorpayOrder(gateway.keyId, gateway.keySecret, body.orderId);
    const expectedAmount = Number(razorpayOrder.amount || 0);
    const expectedPricingAmount = Math.round(Number(pricing.finalAmount || 0) * 100);
    if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
      throw new Error("Unable to verify Razorpay order amount");
    }
    if (expectedAmount !== expectedPricingAmount) {
      throw new Error(`Razorpay order amount does not match stored checkout amount. Order ${expectedAmount}, expected ${expectedPricingAmount}`);
    }

    let payment = await fetchRazorpayPayment(gateway.keyId, gateway.keySecret, body.paymentId);
    let paidAmount = Number(payment.amount || 0);

    if (String(payment.order_id || "") !== String(body.orderId)) {
      pendingSubscription.status = "failed";
      pendingSubscription.paymentStatus = "FAILED";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      pendingSubscription.razorpaySignature = body.signature;
      await pendingSubscription.save();
      throw new Error("Razorpay payment does not belong to this order");
    }

    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
      pendingSubscription.status = "failed";
      pendingSubscription.paymentStatus = "FAILED";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      pendingSubscription.razorpaySignature = body.signature;
      await pendingSubscription.save();
      throw new Error("Unable to verify Razorpay payment amount");
    }

    if (paidAmount < expectedAmount) {
      pendingSubscription.status = "failed";
      pendingSubscription.paymentStatus = "FAILED";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      pendingSubscription.razorpaySignature = body.signature;
      await pendingSubscription.save();
      throw new Error(`Razorpay payment amount does not match this order. Paid ${paidAmount}, expected ${expectedAmount}`);
    }

    if (String(payment.status || "").toLowerCase() === "authorized") {
      payment = await captureRazorpayPayment(gateway.keyId, gateway.keySecret, body.paymentId, paidAmount);
      paidAmount = Number(payment.amount || paidAmount);
    }

    if (String(payment.status || "").toLowerCase() !== "captured") {
      pendingSubscription.status = "failed";
      pendingSubscription.paymentStatus = "FAILED";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      pendingSubscription.razorpaySignature = body.signature;
      await pendingSubscription.save();
      throw new Error(`Razorpay payment is not captured. Current status: ${payment.status || "unknown"}`);
    }

    if (paidAmount < expectedAmount) {
      pendingSubscription.status = "failed";
      pendingSubscription.paymentStatus = "FAILED";
      pendingSubscription.razorpayPaymentId = body.paymentId;
      pendingSubscription.razorpaySignature = body.signature;
      await pendingSubscription.save();
      throw new Error(`Razorpay payment amount does not match this order. Paid ${paidAmount}, expected ${expectedAmount}`);
    }

    if (paidAmount > expectedAmount) {
      const gatewayExtra = roundMoney((paidAmount - expectedAmount) / 100);
      const reportedFee = roundMoney(Number(payment.fee || 0) / 100);
      const reportedTax = roundMoney(Number(payment.tax || 0) / 100);
      const extraGst = reportedTax > 0 && reportedTax <= gatewayExtra ? reportedTax : 0;
      const extraCharge = reportedFee > 0 && reportedFee <= gatewayExtra
        ? roundMoney(Math.max(0, reportedFee - extraGst))
        : roundMoney(Math.max(0, gatewayExtra - extraGst));

      const totalCharge = roundMoney(Number(pricing.convenienceCharge || 0) + extraCharge);
      const totalGst = roundMoney(Number(pricing.convenienceChargeGst || 0) + extraGst);
      const effectiveGstPercent = totalCharge > 0 && totalGst > 0 ? (totalGst / totalCharge) * 100 : 0;
      pricing = {
        ...pricing,
        convenienceCharge: totalCharge,
        convenienceChargeGst: totalGst,
        convenienceChargeGstPercent: Number(pricing.convenienceChargeGstPercent || 0) > 0
          ? pricing.convenienceChargeGstPercent
          : Math.abs(effectiveGstPercent - Math.round(effectiveGstPercent)) < 0.1
            ? Math.round(effectiveGstPercent)
            : Number(effectiveGstPercent.toFixed(2)),
        finalAmount: roundMoney(paidAmount / 100),
      };
      req.log.info({ orderId: body.orderId, paymentId: body.paymentId, expectedAmount, paidAmount, gatewayExtra, extraCharge, extraGst }, "Razorpay payment included gateway-side customer charges");
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + Number(plan.durationMonths || 0));

    pendingSubscription.razorpayPaymentId = body.paymentId;
    pendingSubscription.razorpaySignature = body.signature;
    (pendingSubscription as any).razorpayPaidAmount = paidAmount / 100;
    (pendingSubscription as any).razorpayFeeAmount = Number(payment.fee || 0) / 100;
    (pendingSubscription as any).razorpayTaxAmount = Number(payment.tax || 0) / 100;
    pendingSubscription.couponCode = coupon?.code;
    pendingSubscription.couponType = coupon?.type;
    pendingSubscription.couponValue = coupon?.value;
    pendingSubscription.baseAmount = pricing.baseAmount;
    pendingSubscription.discountAmount = pricing.discountAmount;
    pendingSubscription.taxPercent = pricing.taxPercent;
    pendingSubscription.taxAmount = pricing.taxAmount;
    pendingSubscription.amountBeforeCharges = pricing.amountBeforeCharges;
    pendingSubscription.convenienceChargePercent = pricing.convenienceChargePercent;
    pendingSubscription.convenienceCharge = pricing.convenienceCharge;
    pendingSubscription.convenienceChargeGstPercent = pricing.convenienceChargeGstPercent;
    pendingSubscription.convenienceChargeGst = pricing.convenienceChargeGst;
    pendingSubscription.finalAmount = pricing.finalAmount;
    pendingSubscription.currency = pricing.currency;
    pendingSubscription.amount = paidAmount / 100;
    pendingSubscription.status = "active";
    pendingSubscription.paymentStatus = "PAID";
    pendingSubscription.transactionDate = new Date();
    pendingSubscription.startDate = new Date();
    pendingSubscription.endDate = expiresAt;
    await pendingSubscription.save();
    req.log.info({ subscriptionId: String(pendingSubscription._id), paymentId: body.paymentId, amount: pendingSubscription.amount }, "Payment verified and subscription updated");
    let invoice = null;
    try {
      invoice = await generateInvoiceForSubscription(String(pendingSubscription._id));
      req.log.info({ subscriptionId: String(pendingSubscription._id), invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber }, "Invoice generated after payment");
    } catch (err) {
      req.log.error({ err, subscriptionId: String(pendingSubscription._id) }, "Automatic invoice generation failed");
    }

    if (coupon) {
      coupon.usedCount = Number(coupon.usedCount || 0) + 1;
      await coupon.save();
    }

    await User.findByIdAndUpdate(req.userId, {
      isPremium: true,
      premiumExpiresAt: expiresAt,
      lastPurchase: {
        subscriptionId: String(pendingSubscription._id),
        planId: String(pendingSubscription.planId || ""),
        planAmount: pricing.baseAmount,
        discountAmount: pricing.discountAmount,
        taxAmount: pricing.taxAmount,
        convenienceCharge: pricing.convenienceCharge,
        convenienceChargeGst: pricing.convenienceChargeGst,
        finalAmount: pricing.finalAmount,
        currency: pricing.currency,
        razorpayOrderId: body.orderId,
        razorpayPaymentId: body.paymentId,
        paymentStatus: "PAID",
        transactionDate: pendingSubscription.transactionDate,
      },
    });

    res.json({ isPremium: true, expiresAt: expiresAt.toISOString(), plan: plan.name, pricing, invoice: invoice ? { id: String(invoice._id), invoiceNumber: invoice.invoiceNumber, emailStatus: invoice.emailStatus } : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment verification failed";
    req.log.error({ err: error, message }, "Verify payment failed");
    const status = /coupon|plan/i.test(message) ? 400 : 500;
    res.status(status).json({ error: "verify_failed", message });
  }
});

export default router;
