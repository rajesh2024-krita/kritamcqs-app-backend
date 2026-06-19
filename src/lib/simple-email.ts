import net from "node:net";
import tls from "node:tls";

function encodeBase64(value: string) {
  return Buffer.from(value).toString("base64");
}

export type EmailAttachment = {
  filename: string;
  contentType?: string;
  content: Buffer | string;
};

export type SendEmailInput = {
  smtp: any;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
};

function escapeHeader(value: string) {
  return String(value || "").replace(/[\r\n"]/g, "");
}

function normalizeAttachmentContent(content: Buffer | string) {
  return Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
}

function buildMimeMessage({ smtp, to, subject, text = "", html = "", attachments = [] }: SendEmailInput) {
  const fromLabel = smtp.fromName ? `"${escapeHeader(smtp.fromName)}" <${smtp.fromEmail}>` : smtp.fromEmail;
  const headers = [
    `From: ${fromLabel}`,
    `To: ${to}`,
    `Subject: ${escapeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];

  const hasHtml = String(html || "").trim().length > 0;
  const hasAttachments = attachments.length > 0;

  if (hasHtml && !hasAttachments) {
    return [
      ...headers,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
    ].join("\r\n");
  }

  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
  ];

  if (hasHtml) {
    parts.push(
      `--${mixedBoundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
    );
  } else {
    parts.push(
      `--${mixedBoundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
    );
  }

  for (const attachment of attachments) {
    const filename = escapeHeader(attachment.filename || "attachment");
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType || "application/octet-stream"}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      normalizeAttachmentContent(attachment.content).toString("base64").replace(/.{1,76}/g, "$&\r\n").trim(),
    );
  }

  parts.push(`--${mixedBoundary}--`);
  return parts.join("\r\n");
}

function wait(socket: net.Socket, expected: number[]) {
  return new Promise<string>((resolve, reject) => {
    const onData = (data: Buffer) => {
      const response = data.toString();
      const code = Number(response.slice(0, 3));
      if (expected.includes(code)) resolve(response);
      else reject(new Error(`SMTP command failed: ${response.trim()}`));
    };

    const onError = (error: Error) => reject(error);

    socket.once("data", onData);
    socket.once("error", onError);
  });
}

async function command(socket: net.Socket, line: string, expected: number[]) {
  socket.write(`${line}\r\n`);
  return wait(socket, expected);
}

function waitForTlsConnect(socket: tls.TLSSocket, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const onSecure = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("SMTP TLS handshake timed out"));
    };

    const cleanup = () => {
      socket.off("secureConnect", onSecure);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };

    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.setTimeout(timeoutMs);
  });
}

export async function sendEmail(input: SendEmailInput): Promise<any> {
  const { smtp, to, subject } = input;
  if (!smtp?.host || !smtp?.fromEmail || !to) {
    return { skipped: true, reason: "SMTP host, from email, or recipient email is missing" };
  }

  const port = Number(smtp.port || 587);
  const useImplicitTls = port === 465;
  const timeoutMs = 10000;

  let socket: net.Socket = useImplicitTls
    ? tls.connect({ host: smtp.host, port, servername: smtp.host, minVersion: "TLSv1.2", timeout: timeoutMs })
    : net.connect({ host: smtp.host, port, timeout: timeoutMs });

  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("SMTP connection timed out")));

  try {
    if (useImplicitTls) {
      await waitForTlsConnect(socket as tls.TLSSocket, timeoutMs);
    }

    await wait(socket, [220]);
    await command(socket, `EHLO ${smtp.host}`, [250]);

    if (!useImplicitTls) {
      await command(socket, "STARTTLS", [220]);
      socket = tls.connect({ socket, servername: smtp.host, minVersion: "TLSv1.2", timeout: timeoutMs });
      await waitForTlsConnect(socket as tls.TLSSocket, timeoutMs);
      await command(socket, `EHLO ${smtp.host}`, [250]);
    }

    if (smtp.user && smtp.pass) {
      await command(socket, "AUTH LOGIN", [334]);
      await command(socket, encodeBase64(smtp.user), [334]);
      await command(socket, encodeBase64(smtp.pass), [235]);
    } else if (smtp.user && smtp.accessToken) {
      const token = Buffer.from(`user=${smtp.user}\x01auth=Bearer ${smtp.accessToken}\x01\x01`).toString("base64");
      await command(socket, `AUTH XOAUTH2 ${token}`, [235]);
    }

    const message = buildMimeMessage(input);

    await command(socket, `MAIL FROM:<${smtp.fromEmail}>`, [250]);
    await command(socket, `RCPT TO:<${to}>`, [250, 251]);
    await command(socket, "DATA", [354]);
    socket.write(`${message}\r\n.\r\n`);
    await wait(socket, [250]);
    await command(socket, "QUIT", [221]);
    return { sent: true };
  } finally {
    if (!socket.destroyed) {
      socket.end();
      socket.destroy();
    }
  }
}
