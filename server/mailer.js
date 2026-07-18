// Email sending via Resend API (https://resend.com) — plain fetch, no SDK.
//
// API key: set RESEND_API_KEY in .env (git-ignored). Never hardcode it here —
// this file is committed, and a key in source history is a leaked secret.
//
// NOTE on "from": without a verified domain on Resend, you must send from
// onboarding@resend.dev and Resend only delivers to the email address of
// the Resend account owner. Verify your domain in Resend to send to anyone
// and set RESEND_FROM (e.g. "Agentura <noreply@tvojdomen.rs>").

import { t } from './i18n.js';

const API_URL = 'https://api.resend.com/emails';

export async function sendEmail({ to, subject, text }) {
  if (!to) throw new Error(t('No recipient email address provided'));
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) throw new Error(t('RESEND_API_KEY is not set in .env — the email cannot be sent'));
  const from = process.env.RESEND_FROM || 'Agentura <onboarding@resend.dev>';

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: String(to).split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}
