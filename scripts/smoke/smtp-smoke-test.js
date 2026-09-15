"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const nodemailer = __importStar(require("nodemailer"));
function requireEnv(name) {
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
    if (preview)
        console.log('  preview:', preview);
    if (info.rejected && info.rejected.length > 0) {
        console.error('Some recipients were rejected.');
        process.exit(1);
    }
}
main().catch((err) => {
    console.error('SMTP smoke test failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=smtp-smoke-test.js.map