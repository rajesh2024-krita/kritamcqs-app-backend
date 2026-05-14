import "dotenv/config";
import mongoose from "mongoose";

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  throw new Error("MONGODB_URI is required to seed the email templates.");
}

const emailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ["forgot_password", "otp_verification", "welcome", "notification", "offer", "announcement", "update", "invoice", "registration", "verification", "subscription", "payment_success", "reminder", "broadcast"] },
    subject: { type: String, required: true },
    htmlContent: { type: String, default: "" },
    textContent: { type: String, default: "" },
    variables: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

const EmailTemplate = mongoose.models.EmailTemplate || mongoose.model("EmailTemplate", emailTemplateSchema);

const defaultTemplates = [
  {
    key: "forgot_password_default",
    name: "Forgot Password Email",
    type: "forgot_password",
    subject: "Reset your Krita password",
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #2563eb; margin: 0;">Krita NEET JEE</h1>
  </div>

  <div style="background: #f8fafc; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
    <h2 style="color: #1e293b; margin-top: 0;">Reset Your Password</h2>
    <p>Hello {{user_name}},</p>
    <p>We received a request to reset your password for your Krita account. Use the OTP below to reset your password:</p>

    <div style="text-align: center; margin: 30px 0;">
      <div style="display: inline-block; background: #2563eb; color: white; padding: 15px 30px; border-radius: 6px; font-size: 24px; font-weight: bold; letter-spacing: 2px;">
        {{otp_code}}
      </div>
    </div>

    <p><strong>This OTP expires in {{otp_expiry}} minutes.</strong></p>
    <p>If you didn't request this password reset, please ignore this email. Your password will remain unchanged.</p>
  </div>

  <div style="text-align: center; color: #64748b; font-size: 14px;">
    <p>Need help? Contact our support team at {{support_email}}</p>
    <p>&copy; 2024 Krita NEET JEE. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim(),
    textContent: `
Hello {{user_name}},

We received a request to reset your password for your Krita account. Use the OTP below to reset your password:

OTP: {{otp_code}}

This OTP expires in {{otp_expiry}} minutes.

If you didn't request this password reset, please ignore this email. Your password will remain unchanged.

Need help? Contact our support team at {{support_email}}

© 2024 Krita NEET JEE. All rights reserved.
    `.trim(),
    variables: ["user_name", "otp_code", "otp_expiry", "support_email"],
    isActive: true,
    isDefault: true,
  },
  {
    key: "invoice_default",
    name: "Invoice Email",
    type: "invoice",
    subject: "Your Krita Invoice - {{invoice_number}}",
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Invoice</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #2563eb; margin: 0;">Krita NEET JEE</h1>
  </div>

  <div style="background: #f8fafc; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
    <h2 style="color: #1e293b; margin-top: 0;">Your Invoice is Ready</h2>
    <p>Hello {{user_name}},</p>
    <p>Thank you for your payment! Your invoice has been generated and is attached to this email.</p>

    <div style="background: white; padding: 20px; border-radius: 6px; margin: 20px 0;">
      <h3 style="margin-top: 0; color: #1e293b;">Invoice Details</h3>
      <p><strong>Invoice Number:</strong> {{invoice_number}}</p>
      <p><strong>Amount:</strong> {{invoice_amount}}</p>
      <p><strong>Date:</strong> {{invoice_date}}</p>
      <p><strong>Status:</strong> Paid</p>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="#" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Download Invoice</a>
    </div>

    <p>For any questions about your invoice, please contact our support team.</p>
  </div>

  <div style="text-align: center; color: #64748b; font-size: 14px;">
    <p>Need help? Contact our support team at {{support_email}}</p>
    <p>&copy; 2024 Krita NEET JEE. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim(),
    textContent: `
Hello {{user_name}},

Thank you for your payment! Your invoice has been generated and is attached to this email.

Invoice Details:
- Invoice Number: {{invoice_number}}
- Amount: {{invoice_amount}}
- Date: {{invoice_date}}
- Status: Paid

For any questions about your invoice, please contact our support team at {{support_email}}

© 2024 Krita NEET JEE. All rights reserved.
    `.trim(),
    variables: ["user_name", "invoice_number", "invoice_amount", "invoice_date", "support_email"],
    isActive: true,
    isDefault: true,
  },
  {
    key: "reminder_default",
    name: "Subscription Expiry Reminder",
    type: "reminder",
    subject: "Your Krita Premium expires in {{days_before}} days",
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscription Expiry Reminder</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #2563eb; margin: 0;">Krita NEET JEE</h1>
  </div>

  <div style="background: #f8fafc; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
    <h2 style="color: #1e293b; margin-top: 0;">Subscription Expiry Reminder</h2>
    <p>Hello {{user_name}},</p>
    <p>This is a friendly reminder that your Krita Premium subscription will expire in {{days_before}} days.</p>

    <div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 15px; border-radius: 6px; margin: 20px 0;">
      <p style="margin: 0; color: #92400e;"><strong>Expiry Date:</strong> {{expiry_date}}</p>
    </div>

    <p>Don't lose access to premium features! Renew your subscription today to continue enjoying:</p>
    <ul>
      <li>Unlimited smart tests</li>
      <li>Full question bank access</li>
      <li>Advanced analytics</li>
      <li>Priority support</li>
    </ul>

    <div style="text-align: center; margin: 30px 0;">
      <a href="#" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Renew Now</a>
    </div>
  </div>

  <div style="text-align: center; color: #64748b; font-size: 14px;">
    <p>Need help? Contact our support team at {{support_email}}</p>
    <p>&copy; 2024 Krita NEET JEE. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim(),
    textContent: `
Hello {{user_name}},

This is a friendly reminder that your Krita Premium subscription will expire in {{days_before}} days.

Expiry Date: {{expiry_date}}

Don't lose access to premium features! Renew your subscription today to continue enjoying unlimited smart tests, full question bank access, advanced analytics, and priority support.

Need help? Contact our support team at {{support_email}}

© 2024 Krita NEET JEE. All rights reserved.
    `.trim(),
    variables: ["user_name", "days_before", "expiry_date", "support_email"],
    isActive: true,
    isDefault: true,
  },
  {
    key: "broadcast_default",
    name: "Broadcast Email",
    type: "broadcast",
    subject: "{{notification_title}}",
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{notification_title}}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #2563eb; margin: 0;">Krita NEET JEE</h1>
  </div>

  <div style="background: #f8fafc; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
    <h2 style="color: #1e293b; margin-top: 0;">{{notification_title}}</h2>
    <div style="margin: 20px 0;">
      {{notification_message}}
    </div>
  </div>

  <div style="text-align: center; color: #64748b; font-size: 14px;">
    <p>&copy; 2024 Krita NEET JEE. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim(),
    textContent: `
{{notification_title}}

{{notification_message}}

© 2024 Krita NEET JEE. All rights reserved.
    `.trim(),
    variables: ["notification_title", "notification_message"],
    isActive: true,
    isDefault: true,
  },
];

async function run() {
  await mongoose.connect(mongoUri);

  for (const template of defaultTemplates) {
    await EmailTemplate.updateOne(
      { key: template.key },
      { ...template, updatedBy: "system" },
      { upsert: true, setDefaultsOnInsert: true }
    );
    console.log(`Seeded email template: ${template.name}`);
  }

  console.log("Email templates seeded successfully!");
  await mongoose.disconnect();
}

run().catch(console.error);