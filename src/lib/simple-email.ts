import net from "node:net";
import tls from "node:tls";

export type MailAttachment = { filename: string; contentType: string; content: Buffer };
export type SmtpConfig = {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  fromName?: string;
  fromEmail?: string;
};

function encodeBase64(value: string | Buffer) {
  return Buffer.from(value).toString("base64");
}

function escapeHeader(value: string) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function waitLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function command(socket: net.Socket, text: string, expected: number[]) {
  socket.write(`${text}\r\n`);
  const response = await waitLine(socket);
  const code = Number(response.slice(0, 3));
  if (!expected.includes(code)) throw new Error(`SMTP command failed: ${response.trim()}`);
}

export async function sendEmail({
  smtp,
  to,
  subject,
  text,
  attachments = [],
}: {
  smtp: SmtpConfig;
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}) {
  if (!smtp.host || !smtp.fromEmail || !to) {
    return { skipped: true, reason: "SMTP host, from email, or recipient email is missing" };
  }

  const port = Number(smtp.port || (smtp.secure ? 465 : 587));
  let socket: net.Socket = smtp.secure
    ? tls.connect(port, smtp.host, { servername: smtp.host })
    : net.connect(port, smtp.host);

  await waitLine(socket);
  await command(socket, `EHLO ${smtp.host}`, [250]);

  if (!smtp.secure) {
    await command(socket, "STARTTLS", [220]);
    socket = tls.connect({ socket, servername: smtp.host });
    await command(socket, `EHLO ${smtp.host}`, [250]);
  }

  if (smtp.user && smtp.pass) {
    await command(socket, "AUTH LOGIN", [334]);
    await command(socket, encodeBase64(smtp.user), [334]);
    await command(socket, encodeBase64(smtp.pass), [235]);
  }

  const boundary = `krita-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fromLabel = smtp.fromName ? `"${escapeHeader(smtp.fromName)}" <${smtp.fromEmail}>` : smtp.fromEmail;
  const parts = [
    `From: ${fromLabel}`,
    `To: ${escapeHeader(to)}`,
    `Subject: ${escapeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
  ];

  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${escapeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${escapeHeader(attachment.filename)}"`,
      "",
      attachment.content.toString("base64").replace(/(.{76})/g, "$1\r\n"),
    );
  }

  parts.push(`--${boundary}--`, "");
  const message = parts.join("\r\n");

  await command(socket, `MAIL FROM:<${smtp.fromEmail}>`, [250]);
  await command(socket, `RCPT TO:<${to}>`, [250, 251]);
  await command(socket, "DATA", [354]);
  await command(socket, `${message}\r\n.`, [250]);
  await command(socket, "QUIT", [221]);
  socket.end();

  return { skipped: false };
}
