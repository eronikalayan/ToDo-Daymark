const { env } = require('../config/env');

// Development prints the one-time link locally. Production must configure a real mail provider.
async function sendVerificationEmail(email, token) {
  const verificationUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/?verify=${encodeURIComponent(token)}`;
  if (env.NODE_ENV === 'development') {
    console.info(`Development email verification link for ${email}: ${verificationUrl}`);
    return;
  }
  if (env.NODE_ENV === 'test') return;
  if (!env.EMAIL_PROVIDER_URL || !env.EMAIL_PROVIDER_TOKEN || !env.EMAIL_FROM) {
    throw new Error('Production email delivery is not configured. Set EMAIL_PROVIDER_URL, EMAIL_PROVIDER_TOKEN, and EMAIL_FROM.');
  }
  const response = await fetch(env.EMAIL_PROVIDER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_PROVIDER_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Verify your Daymark email',
      text: `Verify your Daymark email by opening: ${verificationUrl}`
    })
  });
  if (!response.ok) throw new Error(`Email delivery provider returned ${response.status}.`);
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/?reset=${encodeURIComponent(token)}`;
  if (env.NODE_ENV === 'development') {
    console.info(`Development password reset link for ${email}: ${resetUrl}`);
    return;
  }
  if (env.NODE_ENV === 'test') return;
  const response = await fetch(env.EMAIL_PROVIDER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_PROVIDER_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Reset your Daymark password',
      text: `This link expires in one hour. If you did not request a reset, ignore this email. Reset your password: ${resetUrl}`
    })
  });
  if (!response.ok) throw new Error(`Email delivery provider returned ${response.status}.`);
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
