import nodemailer from 'nodemailer'
import { env, emailConfigured } from '../config/env'
import { logger } from '../config/logger'

const transporter = nodemailer.createTransport({
  host:   env.SMTP_HOST,
  port:   env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth:   { user: env.SMTP_USER, pass: env.SMTP_PASS },
})

const base = (content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#0a0a0a;color:#e2e8f0}
  .wrap{max-width:580px;margin:40px auto;background:#141414;border:1px solid #2a2a2a;border-radius:16px;overflow:hidden}
  .header{background:linear-gradient(135deg,#1c1c1c,#0a0a0a);padding:32px 40px;border-bottom:1px solid #2a2a2a;text-align:center}
  .logo{font-size:28px;font-weight:900;letter-spacing:4px;color:#fff}
  .logo span{color:#f97316}
  .body{padding:40px}
  .title{font-size:22px;font-weight:700;color:#fff;margin-bottom:12px}
  .text{font-size:15px;color:#94a3b8;line-height:1.7;margin-bottom:16px}
  .btn{display:inline-block;background:#f97316;color:#fff!important;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px;margin:20px 0}
  .card{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin:20px 0}
  .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #252525}
  .row:last-child{border-bottom:none}
  .label{color:#64748b;font-size:14px}
  .value{color:#e2e8f0;font-size:14px;font-weight:600}
  .footer{padding:24px 40px;text-align:center;border-top:1px solid #1e1e1e}
  .footer p{font-size:12px;color:#334155}
  .tag{display:inline-block;background:#f97316;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px}
  .warning{background:#7c2d12;border:1px solid #9a3412;border-radius:8px;padding:12px 16px;font-size:13px;color:#fed7aa;margin-top:16px}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">EU<span>GYM</span></div>
    <p style="color:#64748b;font-size:13px;margin-top:6px">Nigeria's Premier Fitness Platform</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    <p>© 2026 Eugym Fitness Ltd · Lagos, Nigeria</p>
    <p style="margin-top:6px">hello@eugym.ng · +234 800 EUGYM</p>
    <p style="margin-top:8px;color:#1e293b">You're receiving this because you have an account with Eugym Fitness.</p>
  </div>
</div>
</body>
</html>`

async function send(to: string, subject: string, html: string): Promise<void> {
  // No credentials: skip the send entirely. Attempting it opens a socket to
  // smtp.sendgrid.net with a placeholder key on every signup, waits for the
  // rejection, and logs an error for something nobody configured yet.
  if (!emailConfigured) {
    logger.warn('Email skipped — SMTP is not configured', { to, subject })
    return
  }

  try {
    await transporter.sendMail({
      from:    `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM}>`,
      to,
      subject,
      html,
    })
    logger.info('Email sent', { to, subject })
  } catch (err: unknown) {
    logger.error('Email send failed', { to, subject, error: (err as Error).message })
    throw err
  }
}

// ─── Email templates ──────────────────────────────────────────────────────────
export const emailService = {

  sendVerification: (to: string, name: string, token: string) =>
    send(to, 'Verify your Eugym account', base(`
      <div class="tag">Action Required</div>
      <div class="title">Welcome to Eugym, ${name}! 🎉</div>
      <p class="text">You're one step away from unlocking Nigeria's most flexible fitness platform.
      Click the button below to verify your email and activate your account.</p>
      <center>
        <a href="${env.FRONTEND_URL}/auth/verify-email?token=${token}" class="btn">
          Verify My Email
        </a>
      </center>
      <p class="text" style="font-size:13px">This link expires in <strong>24 hours</strong>.
      If you didn't create an account, you can safely ignore this email.</p>
    `)),

  /**
   * Sent when an admin creates an account on someone's behalf (UC-A8).
   *
   * Deliberately lands on the same set-password page as a reset: the account is
   * created without a password, so activating it and choosing a password are
   * the same action. The admin never sees or sets the password.
   */
  sendAccountActivation: (to: string, name: string, token: string, role: string) =>
    send(to, 'Activate your Eugym account', base(`
      <div class="tag">Action Required</div>
      <div class="title">Welcome to Eugym, ${name}!</div>
      <p class="text">An Eugym administrator has created a <strong>${role}</strong> account for you.
      Choose a password to activate it and sign in.</p>
      <center>
        <a href="${env.FRONTEND_URL}/auth/new-password?token=${token}" class="btn">
          Activate My Account
        </a>
      </center>
      <p class="text" style="font-size:13px">This link expires in <strong>7 days</strong>.
      Until you set a password, the account cannot be signed into.</p>
    `)),

  sendPasswordReset: (to: string, name: string, token: string) =>
    send(to, 'Reset your Eugym password', base(`
      <div class="tag">Security</div>
      <div class="title">Password Reset Request</div>
      <p class="text">Hi ${name}, we received a request to reset your Eugym password.
      Click the button below to set a new password.</p>
      <center>
        <a href="${env.FRONTEND_URL}/auth/new-password?token=${token}" class="btn">
          Reset My Password
        </a>
      </center>
      <p class="text" style="font-size:13px">This link expires in <strong>15 minutes</strong>.</p>
      <div class="warning">⚠️ If you didn't request a password reset, please secure your account immediately
      by changing your password and contacting support.</div>
    `)),

  sendSubscriptionConfirmation: (
    to: string, name: string,
    tier: string, duration: string, endDate: Date,
  ) => send(to, `Your Eugym ${tier} membership is active!`, base(`
    <div class="tag">Membership Active</div>
    <div class="title">You're all set, ${name}! 💪</div>
    <p class="text">Your <strong style="color:#f97316">${tier.toUpperCase()}</strong> membership
    is now active. Time to crush those goals.</p>
    <div class="card">
      <div class="row"><span class="label">Plan</span><span class="value">${tier} — ${duration}</span></div>
      <div class="row"><span class="label">Status</span><span class="value" style="color:#34d399">● Active</span></div>
      <div class="row"><span class="label">Valid Until</span><span class="value">${endDate.toDateString()}</span></div>
    </div>
    <center><a href="${env.FRONTEND_URL}/dashboard/user" class="btn">Go to Dashboard</a></center>
  `)),

  sendBookingConfirmation: (
    to: string, name: string,
    className: string, scheduledAt: Date, trainerName?: string,
  ) => send(to, `Booking confirmed: ${className}`, base(`
    <div class="tag">Booking Confirmed</div>
    <div class="title">See you there, ${name}!</div>
    <p class="text">Your spot has been reserved. Here are your booking details:</p>
    <div class="card">
      <div class="row"><span class="label">Class</span><span class="value">${className}</span></div>
      ${trainerName ? `<div class="row"><span class="label">Trainer</span><span class="value">${trainerName}</span></div>` : ''}
      <div class="row"><span class="label">Date & Time</span><span class="value">${scheduledAt.toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })}</span></div>
    </div>
    <p class="text" style="font-size:13px">Need to cancel? Do so at least 2 hours before class to avoid a strike.</p>
    <center><a href="${env.FRONTEND_URL}/dashboard/user/schedule" class="btn">View My Schedule</a></center>
  `)),

  sendBookingCancellation: (to: string, name: string, className: string, isLate: boolean) =>
    send(to, `Booking cancelled: ${className}`, base(`
      <div class="title">Booking Cancelled</div>
      <p class="text">Hi ${name}, your booking for <strong>${className}</strong> has been cancelled.</p>
      ${isLate ? `<div class="warning">⚠️ This was a late cancellation. A strike has been added to your account.
      Three strikes will result in a 7-day booking suspension.</div>` : ''}
      <center><a href="${env.FRONTEND_URL}/dashboard/user/schedule" class="btn">Book Another Class</a></center>
    `)),

  sendSubscriptionExpiring: (to: string, name: string, daysLeft: number, tier: string) =>
    send(to, `Your Eugym membership expires in ${daysLeft} days`, base(`
      <div class="tag">Renewal Reminder</div>
      <div class="title">Time to renew, ${name}</div>
      <p class="text">Your <strong style="color:#f97316">${tier}</strong> membership expires
      in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>.
      Renew now to keep uninterrupted access to all your facilities and classes.</p>
      <center><a href="${env.FRONTEND_URL}/dashboard/user/billing" class="btn">Renew My Membership</a></center>
      <p class="text" style="font-size:13px">Already renewed? You can ignore this email.</p>
    `)),

  sendOrderConfirmation: (
    to: string, name: string,
    orderId: string, items: { name: string; qty: number; price: number }[],
    total: number,
  ) => send(to, 'Order confirmed — Eugym Store', base(`
    <div class="tag">Order Confirmed</div>
    <div class="title">Order received, ${name}!</div>
    <p class="text">We've received your order and it's being processed. Here's a summary:</p>
    <div class="card">
      <div class="row"><span class="label">Order ID</span><span class="value">#${orderId.slice(-8).toUpperCase()}</span></div>
      ${items.map(i => `<div class="row"><span class="label">${i.name} ×${i.qty}</span><span class="value">₦${(i.price * i.qty).toLocaleString()}</span></div>`).join('')}
      <div class="row"><span class="label" style="font-weight:700;color:#e2e8f0">Total</span><span class="value" style="color:#f97316">₦${total.toLocaleString()}</span></div>
    </div>
    <center><a href="${env.FRONTEND_URL}/dashboard/user/orders" class="btn">Track My Order</a></center>
  `)),

  sendSettlementNotice: (
    to: string, affiliateName: string,
    period: string, visits: number, amount: number,
  ) => send(to, `Eugym Settlement — ${period}`, base(`
    <div class="tag">Settlement</div>
    <div class="title">Monthly Settlement — ${period}</div>
    <p class="text">Dear ${affiliateName}, your monthly settlement report is ready.</p>
    <div class="card">
      <div class="row"><span class="label">Period</span><span class="value">${period}</span></div>
      <div class="row"><span class="label">Total Visits</span><span class="value">${visits.toLocaleString()}</span></div>
      <div class="row"><span class="label">Rate per Visit</span><span class="value">₦10,000</span></div>
      <div class="row"><span class="label" style="color:#e2e8f0;font-weight:700">Settlement Amount</span>
        <span class="value" style="color:#f97316;font-size:16px">₦${amount.toLocaleString()}</span></div>
    </div>
    <p class="text">Payment will be processed within 3–5 business days.</p>
    <center><a href="${env.FRONTEND_URL}/dashboard/affiliate/settlements" class="btn">View Full Report</a></center>
  `)),

  sendWelcomeEmail: (to: string, name: string) =>
    send(to, 'Welcome to Eugym Fitness! 🏋️', base(`
      <div class="title">Welcome to Eugym, ${name}! 🎉</div>
      <p class="text">Your account is verified and ready to go.
      You now have access to our AI Fitness Trainer, daily wellness tips, and free outdoor events.</p>
      <div class="card">
        <div class="row"><span class="label">AI Trainer</span><span class="value" style="color:#34d399">✓ Unlocked</span></div>
        <div class="row"><span class="label">Daily Tips</span><span class="value" style="color:#34d399">✓ Unlocked</span></div>
        <div class="row"><span class="label">Gym Access</span><span class="value" style="color:#f97316">Upgrade to unlock</span></div>
      </div>
      <center><a href="${env.FRONTEND_URL}/#pricing" class="btn">Explore Memberships</a></center>
    `)),
}
