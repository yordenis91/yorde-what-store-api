/**
 * Real-SMTP smoke test — sends one actual email through the exact transport
 * config EmailProcessor uses in production (src/queue/processors/email.processor.ts),
 * so a pass here is a genuine signal that SMTP delivery works end to end.
 *
 * This does NOT run in CI or in a network-restricted sandbox: it needs real
 * outbound SMTP access. Run it from a machine/CI runner where that port is open.
 *
 * Usage:
 *   SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
 *   MAIL_FROM=no-reply@example.com SMOKE_TEST_TO=you@example.com \
 *   npx ts-node scripts/smoke/smtp-smoke-test.ts
 */
import * as nodemailer from 'nodemailer';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const host = requireEnv('SMTP_HOST');
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
  const user = process.env.SMTP_USER || undefined;
  const password = process.env.SMTP_PASSWORD || undefined;
  const from = process.env.MAIL_FROM ?? 'no-reply@example.com';
  const to = requireEnv('SMOKE_TEST_TO');

  // Mirrors EmailProcessor.getTransporter exactly — same secure/STARTTLS logic.
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: password } : undefined,
  });

  console.log(`Connecting to ${host}:${port} (secure=${port === 465})...`);
  await transporter.verify();
  console.log('SMTP connection + auth OK.');

  const timestamp = new Date().toISOString();
  const info = await transporter.sendMail({
    from,
    to,
    subject: `[YWS smoke test] SMTP delivery check — ${timestamp}`,
    text: `This is an automated smoke test of the Yorde What Store SMTP integration, sent at ${timestamp}.\n\nIf you received this, real outbound email delivery works.`,
  });

  console.log('Message sent.');
  console.log('  messageId:', info.messageId);
  console.log('  accepted:', info.accepted);
  console.log('  rejected:', info.rejected);
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log('  preview:', preview);

  if (info.rejected && info.rejected.length > 0) {
    console.error('Some recipients were rejected.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('SMTP smoke test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
