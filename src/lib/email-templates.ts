import { EmailLog, EmailTemplate, InvoiceSettings } from "@api/db";
import { sendEmail, type EmailAttachment } from "./simple-email";
import { logger } from "./logger";

export const EMAIL_TEMPLATE_KEYS = {
  SMTP_TEST: "smtp_test",
  AUTH_REGISTRATION: "auth_registration_email",
  AUTH_WELCOME: "auth_welcome_email",
  AUTH_ACCOUNT_VERIFICATION: "auth_account_verification",
  AUTH_FORGOT_PASSWORD_OTP: "auth_forgot_password_otp",
  AUTH_LOGIN_OTP: "auth_login_otp",
  INVOICE_GENERATED: "invoice_generated",
  INVOICE_TEST: "invoice_test",
  PAYMENT_SUCCESS: "payment_success",
  PAYMENT_REMINDER: "payment_reminder",
  NOTIFICATION_ANNOUNCEMENT: "notification_announcement",
  NOTIFICATION_UPDATE: "notification_update",
  NOTIFICATION_OFFER: "notification_offer",
  NOTIFICATION_GENERAL: "notification_general",
  NOTIFICATION_REMINDER: "notification_reminder",
  ADMIN_NOTIFICATION: "admin_notification",
  HELPDESK_TICKET_CREATED: "helpdesk_ticket_created",
  HELPDESK_TICKET_REPLY: "helpdesk_ticket_reply",
  HELPDESK_TICKET_CLOSED: "helpdesk_ticket_closed",
  HELPDESK_AUTO_REPLY: "helpdesk_auto_reply",
  SUBSCRIPTION_EXPIRY_REMINDER: "subscription_expiry_reminder",
  SUBSCRIPTION_RENEWAL_REMINDER: "subscription_renewal_reminder",
  SUBSCRIPTION_EXPIRED: "subscription_expired",
} as const;

export const EMAIL_TEMPLATE_DEFINITIONS = [
  { key: EMAIL_TEMPLATE_KEYS.SMTP_TEST, module: "system", type: "verification", name: "SMTP Test Email", trigger: "SMTP connectivity test", supportsAttachments: false, variables: ["user_name", "email", "app_name", "company_name", "support_email", "current_date", "current_time"] },
  { key: EMAIL_TEMPLATE_KEYS.AUTH_REGISTRATION, module: "auth", type: "registration", name: "Registration Email", trigger: "User registration", supportsAttachments: false, variables: ["user_name", "email", "mobile", "app_name", "company_name", "support_email", "login_link"] },
  { key: EMAIL_TEMPLATE_KEYS.AUTH_WELCOME, module: "auth", type: "welcome", name: "Welcome Email", trigger: "New user welcome", supportsAttachments: false, variables: ["user_name", "email", "mobile", "app_name", "company_name", "support_email", "login_link"] },
  { key: EMAIL_TEMPLATE_KEYS.AUTH_ACCOUNT_VERIFICATION, module: "auth", type: "verification", name: "Account Verification Email", trigger: "Account/email verification", supportsAttachments: false, variables: ["user_name", "email", "mobile", "otp", "otp_code", "expiry_time", "verification_link", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.AUTH_FORGOT_PASSWORD_OTP, module: "auth", type: "forgot_password", name: "Forgot Password OTP", trigger: "Forgot password OTP request", supportsAttachments: false, variables: ["user_name", "email", "otp", "expiry_time", "reset_link", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.AUTH_LOGIN_OTP, module: "auth", type: "otp_verification", name: "Login OTP / Verification", trigger: "Login OTP request", supportsAttachments: false, variables: ["user_name", "email", "otp", "expiry_time", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.INVOICE_GENERATED, module: "invoice", type: "invoice", name: "Invoice Email", trigger: "Invoice created or resent", supportsAttachments: true, variables: ["user_name", "customer_name", "email", "mobile", "invoice_no", "invoice_number", "invoice_date", "amount", "invoice_amount", "payment_amount", "tax_amount", "total_amount", "due_date", "payment_status", "transaction_id", "payment_date", "plan_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.INVOICE_TEST, module: "invoice", type: "invoice", name: "Test Invoice Email", trigger: "Invoice template test send", supportsAttachments: true, variables: ["user_name", "customer_name", "email", "invoice_no", "invoice_number", "invoice_date", "amount", "invoice_amount", "payment_amount", "tax_amount", "total_amount", "due_date", "payment_status", "transaction_id", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.PAYMENT_SUCCESS, module: "payment", type: "payment_success", name: "Payment Success Email", trigger: "Payment completed", supportsAttachments: false, variables: ["user_name", "email", "mobile", "amount", "payment_amount", "payment_status", "transaction_id", "payment_date", "plan_name", "expiry_date", "app_name", "company_name", "support_email", "login_link"] },
  { key: EMAIL_TEMPLATE_KEYS.PAYMENT_REMINDER, module: "payment", type: "reminder", name: "Reminder Email", trigger: "Payment due reminder", supportsAttachments: false, variables: ["user_name", "email", "reminder_title", "reminder_date", "description", "invoice_no", "invoice_number", "amount", "payment_amount", "due_date", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.NOTIFICATION_ANNOUNCEMENT, module: "notification", type: "announcement", name: "Announcement Email", trigger: "Announcement broadcast", supportsAttachments: true, variables: ["user_name", "email", "title", "message", "announcement_title", "announcement_message", "publish_date", "button_link", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.NOTIFICATION_UPDATE, module: "notification", type: "update", name: "Updates Email", trigger: "Update broadcast", supportsAttachments: true, variables: ["user_name", "email", "title", "message", "update_title", "update_message", "publish_date", "button_link", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.NOTIFICATION_OFFER, module: "notification", type: "offer", name: "Offers Email", trigger: "Offer broadcast", supportsAttachments: true, variables: ["user_name", "email", "offer_name", "offer_title", "offer_code", "discount", "offer_discount", "valid_until", "button_link", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.NOTIFICATION_GENERAL, module: "notification", type: "notification", name: "Notification Email", trigger: "General notification broadcast", supportsAttachments: true, variables: ["user_name", "email", "title", "message", "notification_title", "notification_message", "publish_date", "button_link", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.NOTIFICATION_REMINDER, module: "notification", type: "reminder", name: "Reminder Email", trigger: "Manual reminder broadcast", supportsAttachments: true, variables: ["user_name", "email", "title", "message", "reminder_title", "reminder_date", "description", "due_date", "expiry_date", "button_link", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.ADMIN_NOTIFICATION, module: "admin", type: "admin_notification", name: "Admin Notification Email", trigger: "System/admin alert", supportsAttachments: false, variables: ["user_name", "email", "admin_email", "title", "message", "current_date", "current_time", "app_name", "company_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CREATED, module: "helpdesk", type: "helpdesk", name: "Ticket Created", trigger: "Helpdesk ticket created", supportsAttachments: false, variables: ["user_name", "email", "ticket_id", "ticket_subject", "ticket_status", "reply_message", "attachment_name", "admin_email", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_REPLY, module: "helpdesk", type: "helpdesk", name: "Ticket Reply", trigger: "Helpdesk ticket reply", supportsAttachments: false, variables: ["user_name", "ticket_id", "ticket_subject", "ticket_status", "reply_message", "attachment_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CLOSED, module: "helpdesk", type: "helpdesk", name: "Ticket Closed", trigger: "Helpdesk ticket closed", supportsAttachments: false, variables: ["user_name", "ticket_id", "ticket_subject", "ticket_status", "reply_message", "attachment_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_EXPIRY_REMINDER, module: "subscription", type: "reminder", name: "Expiry Reminder", trigger: "Subscription expiry reminder", supportsAttachments: false, variables: ["user_name", "reminder_title", "reminder_date", "description", "expiry_date", "plan_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_RENEWAL_REMINDER, module: "subscription", type: "reminder", name: "Renewal Reminder", trigger: "Subscription renewal reminder", supportsAttachments: false, variables: ["user_name", "reminder_title", "reminder_date", "description", "expiry_date", "plan_name", "support_email"] },
  { key: EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_EXPIRED, module: "subscription", type: "expiry", name: "Subscription Expired", trigger: "Subscription expired notification", supportsAttachments: false, variables: ["user_name", "expiry_date", "plan_name", "description", "support_email"] },
  { key: "invoice_default", module: "invoice", type: "invoice", name: "Invoice Email", variables: ["user_name", "email", "invoice_number", "invoice_date", "payment_amount", "tax_amount", "convenience_fee", "convenience_fee_gst", "total_amount", "payment_status", "transaction_id", "support_email"] },
  { key: "announcement_default", module: "notification", type: "announcement", name: "Announcement", variables: ["user_name", "announcement_title", "announcement_message", "current_date"] },
  { key: "updates_default", module: "notification", type: "update", name: "Updates", variables: ["user_name", "update_title", "update_message", "current_date"] },
  { key: "forgot_password_default", module: "auth", type: "forgot_password", name: "Forgot Password OTP", variables: ["user_name", "email", "otp", "otp_code", "otp_expiry", "support_email"] },
  { key: "offers_default", module: "notification", type: "offer", name: "Offers / Promotions", variables: ["user_name", "offer_title", "offer_code", "offer_discount", "expiry_date"] },
  { key: "registration_success_default", module: "auth", type: "registration", name: "Registration Success", variables: ["user_name", "email", "app_name", "support_email"] },
  { key: "payment_success_default", module: "payment", type: "payment_success", name: "Payment Success", variables: ["user_name", "payment_amount", "payment_status", "transaction_id", "plan_name", "expiry_date"] },
  { key: "reminder_default", module: "notification", type: "reminder", name: "Reminder Notification", variables: ["user_name", "days_before", "expiry_date", "plan_name", "support_email"] },
  { key: "subscription_expiry_default", module: "expiry", type: "expiry", name: "Subscription Expiry", variables: ["user_name", "expiry_type", "days_before", "expiry_date", "plan_name", "support_email"] },
  { key: "plan_expiry_default", module: "expiry", type: "expiry", name: "Plan Expiry", variables: ["user_name", "expiry_type", "days_before", "expiry_date", "plan_name", "support_email"] },
  { key: "membership_expiry_default", module: "expiry", type: "expiry", name: "Membership Expiry", variables: ["user_name", "expiry_type", "days_before", "expiry_date", "plan_name", "support_email"] },
  { key: "trial_expiry_default", module: "expiry", type: "expiry", name: "Trial Expiry", variables: ["user_name", "expiry_type", "days_before", "expiry_date", "plan_name", "support_email"] },
  { key: "expired_default", module: "expiry", type: "expiry", name: "Expired Notification", variables: ["user_name", "expiry_type", "expiry_date", "plan_name", "support_email"] },
  { key: "helpdesk_auto_reply", module: "helpdesk", type: "helpdesk", name: "Help Desk Auto Reply", variables: ["user_name", "email", "ticket_id", "ticket_category", "ticket_message", "support_email"] },
  { key: "helpdesk_ticket_received", module: "helpdesk", type: "helpdesk", name: "Ticket Received Notification", variables: ["user_name", "email", "ticket_id", "ticket_category", "ticket_message", "admin_email"] },
  { key: "helpdesk_status_update", module: "helpdesk", type: "helpdesk", name: "Ticket Status Update", variables: ["user_name", "ticket_id", "ticket_status", "ticket_message", "support_email"] },
];

const DEFAULT_COPY: Record<string, { subject: string; textContent: string; htmlContent: string }> = {
  [EMAIL_TEMPLATE_KEYS.SMTP_TEST]: {
    subject: "{{app_name}} SMTP test email",
    textContent: "Hi {{user_name}},\n\nSMTP is configured correctly for {{app_name}} emails.\n\nSent on {{current_date}} at {{current_time}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>SMTP is configured correctly for <strong>{{app_name}}</strong> emails.</p><p>Sent on {{current_date}} at {{current_time}}.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.INVOICE_GENERATED]: {
    subject: "Your invoice {{invoice_number}} from {{company_name}}",
    textContent: "Hi {{customer_name}}, your invoice {{invoice_number}} for {{invoice_amount}} is attached. Due date: {{due_date}}.",
    htmlContent: "<p>Hi {{customer_name}},</p><p>Your invoice <strong>{{invoice_number}}</strong> for <strong>{{invoice_amount}}</strong> is attached.</p><p>Due date: {{due_date}}</p>",
  },
  invoice_default: {
    subject: "Your invoice {{invoice_number}} from {{company_name}}",
    textContent: "Hi {{user_name}}, your invoice {{invoice_number}} for {{total_amount}} is attached. Payment status: {{payment_status}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your invoice <strong>{{invoice_number}}</strong> for <strong>{{total_amount}}</strong> is attached.</p><p>Payment status: {{payment_status}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.INVOICE_TEST]: {
    subject: "Test invoice {{invoice_number}} from {{company_name}}",
    textContent: "Hi {{user_name}}, this is a test invoice from {{company_name}} for {{total_amount}}. No payment is required.",
    htmlContent: "<p>Hi {{user_name}},</p><p>This is a test invoice from <strong>{{company_name}}</strong>.</p><p>Total: <strong>{{total_amount}}</strong></p><p>No payment is required.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.AUTH_FORGOT_PASSWORD_OTP]: {
    subject: "Your password reset OTP is {{otp}}",
    textContent: "Hi {{user_name}}, your OTP is {{otp}}. It expires in {{expiry_time}}. {{reset_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your OTP is <strong>{{otp}}</strong>.</p><p>It expires in {{expiry_time}}.</p><p>{{reset_link}}</p>",
  },
  forgot_password_default: {
    subject: "Your password reset OTP is {{otp}}",
    textContent: "Hi {{user_name}}, your OTP is {{otp}}. It expires in {{otp_expiry}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your OTP is <strong>{{otp}}</strong>.</p><p>It expires in {{otp_expiry}}.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.AUTH_LOGIN_OTP]: {
    subject: "Your login OTP is {{otp}}",
    textContent: "Hi {{user_name}}, your login OTP is {{otp}}. It expires in {{expiry_time}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your login OTP is <strong>{{otp}}</strong>.</p><p>It expires in {{expiry_time}}.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.AUTH_REGISTRATION]: {
    subject: "Welcome to {{app_name}}, {{user_name}}!",
    textContent: "Hi {{user_name}},\n\nThanks for registering with {{app_name}}. We're excited to have you on board. For support, email {{support_email}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Thanks for registering with <strong>{{app_name}}</strong>. We're excited to have you on board.</p><p>For support, email {{support_email}}.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.AUTH_WELCOME]: {
    subject: "Welcome to {{app_name}}, {{user_name}}",
    textContent: "Hi {{user_name}}, welcome to {{app_name}}. You can sign in here: {{login_link}}. Support: {{support_email}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Welcome to <strong>{{app_name}}</strong>.</p><p><a href=\"{{login_link}}\">Sign in</a></p><p>Support: {{support_email}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.AUTH_ACCOUNT_VERIFICATION]: {
    subject: "Verify your {{app_name}} account",
    textContent: "Hi {{user_name}}, use OTP {{otp}} to verify your account. It expires in {{expiry_time}}. {{verification_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><p>Use OTP <strong>{{otp}}</strong> to verify your account. It expires in {{expiry_time}}.</p><p>{{verification_link}}</p>",
  },
  registration_success_default: {
    subject: "Welcome to {{app_name}}, {{user_name}}!",
    textContent: "Hi {{user_name}},\n\nThanks for registering with {{app_name}}. We're excited to have you on board. For support, email {{support_email}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Thanks for registering with <strong>{{app_name}}</strong>. We're excited to have you on board.</p><p>For support, email {{support_email}}.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.PAYMENT_SUCCESS]: {
    subject: "Payment successful: {{payment_amount}}",
    textContent: "Hi {{user_name}}, your payment of {{payment_amount}} was successful. Transaction ID: {{transaction_id}}. Plan: {{plan_name}}. Valid until {{expiry_date}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your payment of <strong>{{payment_amount}}</strong> was successful.</p><p>Transaction ID: <strong>{{transaction_id}}</strong></p><p>Plan: <strong>{{plan_name}}</strong><br/>Valid until {{expiry_date}}</p>",
  },
  payment_success_default: {
    subject: "Payment successful: {{payment_amount}}",
    textContent: "Hi {{user_name}}, your payment of {{payment_amount}} was successful. Transaction ID: {{transaction_id}}. Plan: {{plan_name}}. Valid until {{expiry_date}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your payment of <strong>{{payment_amount}}</strong> was successful.</p><p>Transaction ID: <strong>{{transaction_id}}</strong></p><p>Plan: <strong>{{plan_name}}</strong><br/>Valid until {{expiry_date}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.PAYMENT_REMINDER]: {
    subject: "{{reminder_title}}",
    textContent: "{{description}}\n\nReminder date: {{reminder_date}}\nInvoice: {{invoice_number}}\nAmount: {{payment_amount}}",
    htmlContent: "<p>{{description}}</p><p>Reminder date: {{reminder_date}}</p><p>Invoice: {{invoice_number}}<br/>Amount: {{payment_amount}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.NOTIFICATION_ANNOUNCEMENT]: {
    subject: "{{title}}",
    textContent: "Hi {{user_name}},\n\n{{message}}\n\n{{publish_date}}\n{{button_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><h2>{{title}}</h2><p>{{message}}</p><p>{{publish_date}}</p><p>{{button_link}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.NOTIFICATION_UPDATE]: {
    subject: "{{title}}",
    textContent: "Hi {{user_name}},\n\n{{message}}\n\n{{publish_date}}\n{{button_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><h2>{{title}}</h2><p>{{message}}</p><p>{{publish_date}}</p><p>{{button_link}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.NOTIFICATION_OFFER]: {
    subject: "{{offer_name}}",
    textContent: "Hi {{user_name}},\n\n{{offer_name}}\nCode: {{offer_code}}\nDiscount: {{discount}}\nValid until: {{valid_until}}\n{{button_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><h2>{{offer_name}}</h2><p>Code: <strong>{{offer_code}}</strong></p><p>Discount: {{discount}}</p><p>Valid until: {{valid_until}}</p><p>{{button_link}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.NOTIFICATION_GENERAL]: {
    subject: "{{title}}",
    textContent: "Hi {{user_name}},\n\n{{message}}\n\n{{publish_date}}\n{{button_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><h2>{{title}}</h2><p>{{message}}</p><p>{{publish_date}}</p><p>{{button_link}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.NOTIFICATION_REMINDER]: {
    subject: "{{reminder_title}}{{title}}",
    textContent: "Hi {{user_name}},\n\n{{description}}{{message}}\n\nReminder date: {{reminder_date}}\n{{button_link}}",
    htmlContent: "<p>Hi {{user_name}},</p><h2>{{reminder_title}}{{title}}</h2><p>{{description}}{{message}}</p><p>{{reminder_date}}</p><p>{{button_link}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.ADMIN_NOTIFICATION]: {
    subject: "{{app_name}} admin alert: {{title}}",
    textContent: "{{message}}\n\nAdmin: {{admin_email}}\nDate: {{current_date}} {{current_time}}",
    htmlContent: "<p><strong>{{title}}</strong></p><p>{{message}}</p><p>Admin: {{admin_email}}<br/>Date: {{current_date}} {{current_time}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CREATED]: {
    subject: "New support ticket {{ticket_id}}",
    textContent: "Ticket {{ticket_id}}\nSubject: {{ticket_subject}}\nStatus: {{ticket_status}}\nFrom: {{user_name}} ({{email}})\n\n{{reply_message}}",
    htmlContent: "<p>New support ticket <strong>{{ticket_id}}</strong></p><p>Subject: {{ticket_subject}}<br/>Status: {{ticket_status}}<br/>From: {{user_name}} ({{email}})</p><p>{{reply_message}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_REPLY]: {
    subject: "Reply on support ticket {{ticket_id}}",
    textContent: "Hi {{user_name}},\n\n{{reply_message}}\n\nStatus: {{ticket_status}}\nSupport: {{support_email}}",
    htmlContent: "<p>Hi {{user_name}},</p><p>{{reply_message}}</p><p>Status: {{ticket_status}}</p><p>Support: {{support_email}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CLOSED]: {
    subject: "Support ticket {{ticket_id}} closed",
    textContent: "Hi {{user_name}},\n\n{{reply_message}}\n\nStatus: {{ticket_status}}",
    htmlContent: "<p>Hi {{user_name}},</p><p>{{reply_message}}</p><p>Status: {{ticket_status}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.HELPDESK_AUTO_REPLY]: {
    subject: "We received your support ticket {{ticket_id}}",
    textContent: "Hi {{user_name}},\n\nWe received your support request. Ticket ID: {{ticket_id}}.\n\n{{reply_message}}",
    htmlContent: "<p>Hi {{user_name}},</p><p>We received your support request. Ticket ID: <strong>{{ticket_id}}</strong>.</p><p>{{reply_message}}</p>",
  },
  helpdesk_ticket_received: {
    subject: "New support ticket {{ticket_id}}",
    textContent: "Ticket {{ticket_id}}\nCategory: {{ticket_category}}\nFrom: {{user_name}} ({{email}})\n\n{{ticket_message}}",
    htmlContent: "<p>New support ticket <strong>{{ticket_id}}</strong></p><p>Category: {{ticket_category}}<br/>From: {{user_name}} ({{email}})</p><p>{{ticket_message}}</p>",
  },
  helpdesk_status_update: {
    subject: "Support ticket {{ticket_id}} update",
    textContent: "Hi {{user_name}},\n\n{{ticket_message}}\n\nStatus: {{ticket_status}}\nSupport: {{support_email}}",
    htmlContent: "<p>Hi {{user_name}},</p><p>{{ticket_message}}</p><p>Status: {{ticket_status}}</p><p>Support: {{support_email}}</p>",
  },
  [EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_EXPIRY_REMINDER]: {
    subject: "{{plan_name}} expires in {{days_before}} day(s)",
    textContent: "Hi {{user_name}}, your {{plan_name}} expires on {{expiry_date}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your <strong>{{plan_name}}</strong> expires on {{expiry_date}}.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_RENEWAL_REMINDER]: {
    subject: "Renew {{plan_name}} before {{expiry_date}}",
    textContent: "Hi {{user_name}}, renew your {{plan_name}} before {{expiry_date}} to keep access uninterrupted.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Renew your <strong>{{plan_name}}</strong> before {{expiry_date}} to keep access uninterrupted.</p>",
  },
  [EMAIL_TEMPLATE_KEYS.SUBSCRIPTION_EXPIRED]: {
    subject: "{{plan_name}} has expired",
    textContent: "Hi {{user_name}}, your {{plan_name}} expired on {{expiry_date}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your <strong>{{plan_name}}</strong> expired on {{expiry_date}}.</p>",
  },
  reminder_default: {
    subject: "{{plan_name}} expires in {{days_before}} day(s)",
    textContent: "Hi {{user_name}}, your {{plan_name}} expires on {{expiry_date}}.",
    htmlContent: "<p>Hi {{user_name}},</p><p>Your <strong>{{plan_name}}</strong> expires on {{expiry_date}}.</p>",
  },
};

function defaultCopy(definition: typeof EMAIL_TEMPLATE_DEFINITIONS[number]) {
  if (DEFAULT_COPY[definition.key]) return DEFAULT_COPY[definition.key];
  const title = definition.name;
  return {
    subject: `${title}: {{user_name}}`,
    textContent: `Hi {{user_name}},\n\n${title}\n\n{{notification_message}}{{announcement_message}}{{update_message}}{{ticket_message}}`,
    htmlContent: `<p>Hi {{user_name}},</p><p><strong>${title}</strong></p><p>{{notification_message}}{{announcement_message}}{{update_message}}{{ticket_message}}</p>`,
  };
}

export function findEmailTemplateDefinition(templateKey: string) {
  return EMAIL_TEMPLATE_DEFINITIONS.find((item) => item.key === templateKey);
}

export function templateVariablesFor(templateKey = "", module = "", type = "") {
  const exact = EMAIL_TEMPLATE_DEFINITIONS.find((item) => item.key === templateKey);
  if (exact) return exact.variables;
  const byModuleType = EMAIL_TEMPLATE_DEFINITIONS.find((item) => item.module === module && item.type === type);
  if (byModuleType) return byModuleType.variables;
  const byType = EMAIL_TEMPLATE_DEFINITIONS.find((item) => item.type === type);
  if (byType) return byType.variables;
  const byModule = EMAIL_TEMPLATE_DEFINITIONS.find((item) => item.module === module);
  return byModule?.variables || [];
}

export function extractTemplateVariables(...templates: Array<unknown>) {
  const found = new Set<string>();
  for (const template of templates) {
    String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
      found.add(String(key));
      return "";
    });
  }
  return [...found];
}

export function validateTemplateVariables(payload: { key?: string; module?: string; type?: string; variables?: string[]; subject?: string; htmlContent?: string; textContent?: string }) {
  const allowed = templateVariablesFor(payload.key || "", payload.module || "", payload.type || "");
  if (!allowed.length) return { allowed, invalid: [] as string[], used: extractTemplateVariables(payload.subject, payload.htmlContent, payload.textContent) };
  const used = [...new Set([...(payload.variables || []), ...extractTemplateVariables(payload.subject, payload.htmlContent, payload.textContent)])];
  const invalid = used.filter((name) => !allowed.includes(name));
  return { allowed, invalid, used };
}

export function buildTemplateFromDefinition(definition: typeof EMAIL_TEMPLATE_DEFINITIONS[number]) {
  const copy = defaultCopy(definition);
  return {
    key: definition.key,
    name: definition.name,
    module: definition.module,
    type: definition.type,
    description: `${definition.name} template for ${definition.module} functionality.`,
    subject: copy.subject,
    htmlContent: copy.htmlContent,
    textContent: copy.textContent,
    variables: definition.variables,
    sampleData: sampleEmailVariables(),
    isActive: true,
    isDefault: true,
    createdBy: "system",
    updatedBy: "system",
  } as any;
}

export async function resolveTemplate(templateKey: string) {
  const template = await EmailTemplate.findOne({ key: templateKey });
  if (template?.isActive) return template;
  if (template && template.isActive === false) return null;
  const definition = findEmailTemplateDefinition(templateKey);
  if (!definition) return null;
  logger.warn({ templateKey }, "Email template missing; using unsaved fallback copy");
  return buildTemplateFromDefinition(definition);
}

export const COMMON_EMAIL_VARIABLES = [
  "user_name", "email", "mobile", "app_name", "support_email", "company_name",
  "invoice_no", "invoice_number", "invoice_date", "customer_name", "amount", "payment_amount", "invoice_amount", "tax_amount", "convenience_fee", "convenience_fee_gst", "total_amount", "payment_status", "transaction_id", "payment_date",
  "otp", "otp_code", "otp_expiry", "expiry_time", "reset_link", "verification_link", "login_link",
  "expiry_date", "expiry_type", "days_before", "plan_name", "due_date",
  "title", "message", "publish_date", "button_link",
  "offer_name", "offer_title", "offer_code", "discount", "offer_discount", "valid_until",
  "reminder_title", "reminder_date", "description",
  "ticket_id", "ticket_category", "ticket_subject", "ticket_status", "ticket_message", "reply_message", "admin_email",
  "announcement_title", "announcement_message", "update_title", "update_message",
  "notification_title", "notification_message", "current_date", "current_time",
  "attachment_name", "document_name", "report_name",
];

export function renderTemplate(template: string, values: Record<string, unknown>) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => String(values[key] ?? ""));
}

export function normalizeEmailVariables(values: Record<string, unknown> = {}) {
  const normalized: Record<string, unknown> = { ...values };
  for (const [key, value] of Object.entries(values)) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const camel = key.replace(/_([a-z])/g, (_match, letter) => String(letter).toUpperCase());
    if (normalized[snake] === undefined) normalized[snake] = value;
    if (normalized[camel] === undefined) normalized[camel] = value;
  }
  if (normalized.user_name === undefined && normalized.name !== undefined) normalized.user_name = normalized.name;
  if (normalized.customer_name === undefined) normalized.customer_name = normalized.user_name || normalized.userName || normalized.name || "";
  if (normalized.user_name === undefined && normalized.customer_name !== undefined) normalized.user_name = normalized.customer_name;
  if (normalized.invoice_amount === undefined) normalized.invoice_amount = normalized.total_amount || normalized.payment_amount || "";
  if (normalized.total_amount === undefined) normalized.total_amount = normalized.invoice_amount || normalized.payment_amount || "";
  if (normalized.amount === undefined) normalized.amount = normalized.total_amount || normalized.payment_amount || normalized.invoice_amount || "";
  if (normalized.invoice_no === undefined) normalized.invoice_no = normalized.invoice_number || "";
  if (normalized.invoice_number === undefined) normalized.invoice_number = normalized.invoice_no || "";
  if (normalized.expiry_time === undefined) normalized.expiry_time = normalized.otp_expiry || normalized.expiryDate || "";
  if (normalized.otp_expiry === undefined) normalized.otp_expiry = normalized.expiry_time || "";
  if (normalized.reset_link === undefined) normalized.reset_link = "";
  if (normalized.verification_link === undefined) normalized.verification_link = "";
  if (normalized.login_link === undefined) normalized.login_link = "";
  if (normalized.title === undefined) normalized.title = normalized.announcement_title || normalized.update_title || normalized.notification_title || "";
  if (normalized.message === undefined) normalized.message = normalized.announcement_message || normalized.update_message || normalized.notification_message || "";
  if (normalized.announcement_title === undefined) normalized.announcement_title = normalized.title || "";
  if (normalized.announcement_message === undefined) normalized.announcement_message = normalized.message || "";
  if (normalized.update_title === undefined) normalized.update_title = normalized.title || "";
  if (normalized.update_message === undefined) normalized.update_message = normalized.message || "";
  if (normalized.notification_title === undefined) normalized.notification_title = normalized.title || "";
  if (normalized.notification_message === undefined) normalized.notification_message = normalized.message || "";
  if (normalized.publish_date === undefined) normalized.publish_date = normalized.current_date || "";
  if (normalized.button_link === undefined) normalized.button_link = "";
  if (normalized.offer_name === undefined) normalized.offer_name = normalized.offer_title || normalized.title || "";
  if (normalized.offer_title === undefined) normalized.offer_title = normalized.offer_name || "";
  if (normalized.discount === undefined) normalized.discount = normalized.offer_discount || "";
  if (normalized.offer_discount === undefined) normalized.offer_discount = normalized.discount || "";
  if (normalized.valid_until === undefined) normalized.valid_until = normalized.expiry_date || "";
  if (normalized.reminder_title === undefined) normalized.reminder_title = normalized.title || normalized.notification_title || "";
  if (normalized.reminder_date === undefined) normalized.reminder_date = normalized.due_date || normalized.expiry_date || normalized.current_date || "";
  if (normalized.description === undefined) normalized.description = normalized.message || normalized.notification_message || "";
  if (normalized.ticket_subject === undefined) normalized.ticket_subject = normalized.ticket_category || "";
  if (normalized.reply_message === undefined) normalized.reply_message = normalized.ticket_message || normalized.message || "";
  if (normalized.ticket_message === undefined) normalized.ticket_message = normalized.reply_message || "";
  if (normalized.notification_message === undefined && normalized.message !== undefined) normalized.notification_message = normalized.message;
  if (normalized.notification_title === undefined && normalized.title !== undefined) normalized.notification_title = normalized.title;
  if (normalized.current_date === undefined) normalized.current_date = new Date().toLocaleDateString("en-IN");
  if (normalized.current_time === undefined) normalized.current_time = new Date().toLocaleTimeString("en-IN");
  return normalized;
}

export function sampleEmailVariables(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    user_name: "Test User",
    email: "test@example.com",
    mobile: "+91 9876543210",
    app_name: "Krita",
    company_name: "Krita NEET JEE",
    support_email: "support@krita.com",
    invoice_number: "INV-TEST-001",
    invoice_no: "INV-TEST-001",
    invoice_date: now.toLocaleDateString("en-IN"),
    customer_name: "Test Customer",
    payment_amount: "INR 1000.00",
    amount: "INR 1000.00",
    invoice_amount: "INR 1000.00",
    tax_amount: "INR 180.00",
    convenience_fee: "INR 20.00",
    convenience_fee_gst: "INR 3.60",
    total_amount: "INR 1203.60",
    payment_status: "PAID",
    transaction_id: "pay_test_123456",
    payment_date: now.toLocaleDateString("en-IN"),
    otp: "123456",
    otp_code: "123456",
    otp_expiry: "10 minutes",
    expiry_time: "10 minutes",
    reset_link: "https://example.com/reset-password",
    verification_link: "https://example.com/verify-account",
    login_link: "https://example.com/login",
    due_date: now.toLocaleDateString("en-IN"),
    expiry_date: now.toLocaleDateString("en-IN"),
    expiry_type: "Subscription",
    days_before: "7",
    plan_name: "Premium Plan",
    ticket_id: "SUP-TEST-001",
    ticket_category: "Account Help",
    ticket_status: "Open",
    ticket_message: "This is a sample help desk message.",
    admin_email: "admin@example.com",
    announcement_title: "New Announcement",
    announcement_message: "This is a sample announcement.",
    update_title: "Product Update",
    update_message: "This is a sample update.",
    offer_title: "Special Offer",
    offer_name: "Special Offer",
    offer_code: "SAVE20",
    offer_discount: "20%",
    discount: "20%",
    valid_until: now.toLocaleDateString("en-IN"),
    title: "Sample Title",
    message: "This is a sample message.",
    publish_date: now.toLocaleDateString("en-IN"),
    button_link: "https://example.com",
    reminder_title: "Payment Reminder",
    reminder_date: now.toLocaleDateString("en-IN"),
    description: "This is a sample reminder.",
    notification_title: "Reminder",
    notification_message: "This is a sample notification.",
    ticket_subject: "Account Help",
    reply_message: "This is a sample help desk message.",
    current_date: now.toLocaleDateString("en-IN"),
    current_time: now.toLocaleTimeString("en-IN"),
    ...overrides,
  };
}

export function buildTemplatePreview(template: any, variables: Record<string, unknown> = {}) {
  const data = normalizeEmailVariables(sampleEmailVariables({ ...(template?.sampleData || {}), ...variables }));
  return renderEmailTemplate(template, data);
}

export function renderEmailTemplate(template: any, variables: Record<string, unknown> = {}) {
  const data = normalizeEmailVariables(variables);
  return {
    subject: renderTemplate(template?.subject || "", data),
    htmlContent: renderTemplate(template?.htmlContent || "", data),
    textContent: renderTemplate(template?.textContent || "", data),
    variables: data,
  };
}

function buildHtmlBody(htmlContent: string, textContent: string) {
  const html = String(htmlContent || "").trim();
  if (html) return html;

  const text = String(textContent || "").trim();
  const safeText = text
    ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br/>")
    : "This email contains no HTML content.";

  return `<html><body><div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:14px;line-height:1.5;">${safeText}</div></body></html>`;
}

export async function sendTemplatedEmail(templateKey: string, to: string, variables: Record<string, unknown>, attachments: EmailAttachment[] = []) {
  const settings = await InvoiceSettings.findOne({ key: "default" });
  const payload = normalizeEmailVariables(variables);
  const existingTemplate = await EmailTemplate.findOne({ key: templateKey });
  const template = existingTemplate?.isActive
    ? existingTemplate
    : existingTemplate
    ? null
    : await resolveTemplate(templateKey);
  const rendered = template ? renderEmailTemplate(template, payload) : { subject: `Email template disabled: ${templateKey}`, textContent: "", htmlContent: "", variables: payload };
  
  const htmlBody = buildHtmlBody(rendered.htmlContent, rendered.textContent);

  logger.info(
    `[EMAIL] Sending template: ${templateKey} | To: ${to} | Found: ${template ? "yes" : "no"} | Variables: ${Object.keys(variables || {}).join(", ")} | htmlLength=${htmlBody.length}`
  );

  const log = await EmailLog.create({
    templateKey,
    templateName: template?.name || existingTemplate?.name || "",
    module: template?.module || existingTemplate?.module || existingTemplate?.type || "",
    to,
    subject: rendered.subject,
    status: "pending",
    attempts: 0,
    payload,
    attachments: attachments.map((item) => ({ filename: item.filename, contentType: item.contentType })),
  });

  if (!template) {
    log.status = "skipped";
    log.error = existingTemplate ? "Email template is inactive" : `Email template '${templateKey}' not found`;
    log.lastAttemptAt = new Date();
    await log.save();
    logger.warn(`[EMAIL] Email skipped for ${templateKey}: ${log.error}`);
    return { skipped: true, reason: log.error, logId: String(log._id) };
  }

  if (settings?.emailEnabled === false) {
    log.status = "skipped";
    log.error = "Email sending disabled";
    log.lastAttemptAt = new Date();
    await log.save();
    logger.warn(`[EMAIL] Email skipped for ${templateKey}: Email sending disabled`);
    return { skipped: true, reason: "Email sending disabled", logId: String(log._id) };
  }

  try {
    const result = await sendEmail({
      smtp: settings?.smtp || {},
      to,
      subject: rendered.subject,
      html: htmlBody,
      attachments,
    });
    log.attempts = Number(log.attempts || 0) + 1;
    log.lastAttemptAt = new Date();
    log.status = result.skipped ? "skipped" : "sent";
    log.error = result.skipped ? result.reason || "" : "";
    log.sentAt = result.skipped ? undefined : new Date();
    await log.save();
    
    if (result.skipped) {
      logger.warn(`[EMAIL] Email skipped for ${templateKey}: ${result.reason}`);
    } else {
      logger.info(`[EMAIL] Email sent successfully for ${templateKey} to ${to} (LogId: ${log._id})`);
    }
    
    return { ...result, logId: String(log._id) };
  } catch (error) {
    log.attempts = Number(log.attempts || 0) + 1;
    log.lastAttemptAt = new Date();
    log.status = "failed";
    log.error = error instanceof Error ? error.message : "Email failed";
    await log.save();
    logger.error(`[EMAIL] Email send failed for ${templateKey}: ${log.error}`);
    throw error;
  }
}
