function getTwilioConfig() {
  const TWILIO_ACCOUNT_SID = process.env["TWILIO_ACCOUNT_SID"];
  const TWILIO_AUTH_TOKEN = process.env["TWILIO_AUTH_TOKEN"];
  const TWILIO_VERIFY_SERVICE_SID = process.env["TWILIO_VERIFY_SERVICE_SID"];

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    return null;
  }

  return {
    accountSid: TWILIO_ACCOUNT_SID,
    authToken: TWILIO_AUTH_TOKEN,
    verifyServiceSid: TWILIO_VERIFY_SERVICE_SID,
  };
}

function getAuthorizationHeader(accountSid: string, authToken: string) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

async function parseTwilioResponse(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text };
  }
}

export function isTwilioConfigured() {
  return !!getTwilioConfig();
}

export async function sendVerificationSms(to: string) {
  const config = getTwilioConfig();

  if (!config) {
    throw new Error("Twilio Verify is not configured");
  }

  const body = new URLSearchParams({
    To: to,
    Channel: "sms",
  });

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/Verifications`,
    {
      method: "POST",
      headers: {
        Authorization: getAuthorizationHeader(config.accountSid, config.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  const payload = await parseTwilioResponse(response);

  if (!response.ok) {
    throw new Error(payload.message ?? "Failed to send verification code");
  }

  return payload;
}

export async function checkVerificationCode(to: string, code: string) {
  const config = getTwilioConfig();

  if (!config) {
    throw new Error("Twilio Verify is not configured");
  }

  const body = new URLSearchParams({
    To: to,
    Code: code,
  });

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${config.verifyServiceSid}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        Authorization: getAuthorizationHeader(config.accountSid, config.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  const payload = await parseTwilioResponse(response);

  if (!response.ok) {
    throw new Error(payload.message ?? "Failed to verify code");
  }

  return payload;
}
