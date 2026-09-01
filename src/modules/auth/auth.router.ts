import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import speakeasy from 'speakeasy'
import QRCode from 'qrcode'
import { z } from 'zod'
import { query, withTransaction } from '../../db/pool'
import { env } from '../../config/env'
import { logger } from '../../config/logger'
import { AppError, randomToken, hashToken, mapUser, mapSubscription } from '../../utils'
import { authenticate, authLimiter, passwordResetLimiter, validate } from '../../middleware'
import { emailService } from '../../lib/email'
import { ok, created } from '../../utils'
import type { UserRow, SubscriptionRow, JwtPayload } from '../../types'

export const authRouter = Router()

// ─── Schemas ─────────────────────────────────────────────────────────────────
// Every message here is written to be shown to the user verbatim — the frontend
// renders them under the offending field. Unmessaged rules emit "Invalid", which
// tells nobody anything.
//
// Password confirmation is deliberately absent: it is a client-side concern and
// the server has no use for a second copy of the password.
const registerSchema = z.object({
  firstName: z.string().min(2, 'First name needs at least 2 characters').max(100),
  lastName:  z.string().min(2, 'Last name needs at least 2 characters').max(100),
  email:     z.string().email('Enter a valid email address'),
  phone:     z.string().min(10, 'Enter a valid phone number').max(20),
  password:  z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password needs at least one capital letter')
    .regex(/[0-9]/, 'Password needs at least one number'),
})

const loginSchema = z.object({
  email:     z.string().email('Enter a valid email address'),
  password:  z.string().min(1, 'Enter your password'),
  rememberMe: z.boolean().optional(),
})

const refreshSchema    = z.object({ refreshToken: z.string().min(1) })
const companyRegisterSchema = z.object({
  companyName: z.string().min(2, "Enter your company name").max(200),
  firstName:   z.string().min(2, "First name needs at least 2 characters").max(100),
  lastName:    z.string().min(2, "Last name needs at least 2 characters").max(100),
  email:       z.string().email("Enter a valid email address"),
  phone:       z.string().min(10, "Enter a valid phone number").max(20),
  password:    z.string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password needs at least one capital letter")
    .regex(/[0-9]/, "Password needs at least one number"),
})

const forgotSchema     = z.object({ email: z.string().email() })
const resetSchema      = z.object({ token: z.string().min(1), password: z.string().min(8) })
const verifyEmailSchema = z.object({ token: z.string().min(1) })
const twoFAVerifySchema = z.object({ code: z.string().length(6) })

// ─── Token helpers ────────────────────────────────────────────────────────────
function signAccess(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  // `sub` is already in the payload — also passing `subject` makes jsonwebtoken throw.
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES,
  } as jwt.SignOptions)
}

async function createRefreshToken(userId: string, rememberMe = false): Promise<string> {
  const token     = randomToken(48)
  const tokenHash = hashToken(token)
  const days      = rememberMe ? 30 : 7
  const expiresAt = new Date(Date.now() + days * 86_400_000)

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  )
  return token
}

async function getUserWithSubscription(userId: string) {
  const { rows } = await query<UserRow & { sub_data?: string }>(
    `SELECT u.*,
            row_to_json(s.*) AS sub_data
     FROM users u
     LEFT JOIN LATERAL (
       SELECT * FROM subscriptions
       WHERE user_id = u.id AND status = 'active'
       ORDER BY created_at DESC LIMIT 1
     ) s ON true
     WHERE u.id = $1 AND u.is_active = true`,
    [userId],
  )
  return rows[0] ?? null
}

// ─── POST /auth/register ──────────────────────────────────────────────────────
authRouter.post('/register', authLimiter, validate(registerSchema), async (req: Request, res: Response) => {
  const { firstName, lastName, email, phone, password } = req.body as z.infer<typeof registerSchema>

  const { rows: exists } = await query(
    'SELECT id FROM users WHERE email = $1', [email.toLowerCase()],
  )
  if (exists.length) throw AppError.conflict('An account with this email already exists')

  const passwordHash  = await bcrypt.hash(password, env.BCRYPT_ROUNDS)
  const verifyToken   = randomToken(32)
  const tokenHash     = hashToken(verifyToken)
  const tokenExpiry   = new Date(Date.now() + 24 * 3_600_000)

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'regular') RETURNING *`,
      [firstName, lastName, email.toLowerCase(), phone, passwordHash],
    )
    const newUser = rows[0]
    await client.query(
      `INSERT INTO email_verifications (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [newUser.id, tokenHash, tokenExpiry],
    )
    return newUser
  })

  // Best-effort — a dead mailer must never fail a signup that already succeeded.
  emailService.sendVerification(user.email, user.first_name, verifyToken).catch(
    (err: Error) => logger.warn('Verification email not sent', { error: err.message }),
  )

  // Sign the user straight in. Returning the same envelope as /auth/login lets the
  // frontend reuse one code path for both.
  const accessToken  = signAccess({ sub: user.id, role: user.role, email: user.email })
  const refreshToken = await createRefreshToken(user.id)

  created(res, {
    user:   mapUser(user as unknown as Record<string, unknown>),
    tokens: { accessToken, refreshToken, expiresIn: 900 },
  }, 'Account created')
})

// ─── POST /auth/company-register ─────────────────────────────────────────────
// Corporate self-signup (SRS §2.2 "Corporate/Bulk Package"). The organisation
// and its first corporate_admin are created together: an organisation with no
// administrator cannot be managed, and an admin with no organisation has
// nothing to administer, so both rows commit or neither does.
authRouter.post("/company-register", authLimiter, validate(companyRegisterSchema), async (req: Request, res: Response) => {
  const { companyName, firstName, lastName, email, phone, password } =
    req.body as z.infer<typeof companyRegisterSchema>

  const normalised = email.toLowerCase()

  // Both uniqueness checks matter: users.email and corporate_accounts.email
  // are separately unique, so either can reject the insert mid-transaction.
  const [{ rows: userExists }, { rows: orgExists }] = await Promise.all([
    query("SELECT id FROM users WHERE email = $1", [normalised]),
    query("SELECT id FROM corporate_accounts WHERE email = $1", [normalised]),
  ])
  if (userExists.length) throw AppError.conflict("An account with this email already exists")
  if (orgExists.length) throw AppError.conflict("An organisation is already registered with this email")

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS)
  const verifyToken  = randomToken(32)
  const tokenHash    = hashToken(verifyToken)
  const tokenExpiry  = new Date(Date.now() + 24 * 3_600_000)

  const user = await withTransaction(async (client) => {
    const { rows: orgRows } = await client.query(
      `INSERT INTO corporate_accounts (company_name, email, phone)
       VALUES ($1, $2, $3) RETURNING id`,
      [companyName, normalised, phone],
    )
    const corporateId = orgRows[0].id

    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, role, corporate_id)
       VALUES ($1, $2, $3, $4, $5, 'corporate_admin', $6) RETURNING *`,
      [firstName, lastName, normalised, phone, passwordHash, corporateId],
    )
    const newUser = rows[0]

    await client.query(
      `INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [newUser.id, tokenHash, tokenExpiry],
    )
    return newUser
  })

  // Best-effort — a dead mailer must never fail a signup that already succeeded.
  emailService.sendVerification(user.email, user.first_name, verifyToken).catch(
    (err: Error) => logger.warn("Verification email not sent", { error: err.message }),
  )

  const accessToken  = signAccess({ sub: user.id, role: user.role, email: user.email })
  const refreshToken = await createRefreshToken(user.id)

  created(res, {
    user:   mapUser(user as unknown as Record<string, unknown>),
    tokens: { accessToken, refreshToken, expiresIn: 900 },
  }, "Organisation created")
})

// ─── POST /auth/login ─────────────────────────────────────────────────────────
authRouter.post('/login', authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
  const { email, password, rememberMe } = req.body as z.infer<typeof loginSchema>

  const { rows } = await query<UserRow>(
    `SELECT * FROM users WHERE email = $1 AND is_active = true`,
    [email.toLowerCase()],
  )
  if (!rows.length) throw AppError.unauthorized('Invalid email or password')

  const user = rows[0]
  const valid = await bcrypt.compare(password, user.password_hash ?? '')
  if (!valid) throw AppError.unauthorized('Invalid email or password')

  // Off by default — blocking sign-in on a verification email that SMTP cannot
  // send locks every new user out. Flip REQUIRE_EMAIL_VERIFICATION once SMTP works.
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.is_email_verified) {
    throw new AppError('Please verify your email before signing in', 403, 'EMAIL_NOT_VERIFIED')
  }

  // 2FA check
  if (user.is_2fa_enabled) {
    const tempToken = jwt.sign(
      { sub: user.id, pending2fa: true },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '5m' },
    )
    ok(res, { requires2FA: true, tempToken })
    return
  }

  const accessToken  = signAccess({ sub: user.id, role: user.role, email: user.email })
  const refreshToken = await createRefreshToken(user.id, rememberMe)

  // Update last login
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])

  // Get current subscription
  const { rows: subRows } = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  )

  const userData = {
    ...mapUser(user as unknown as Record<string, unknown>),
    subscription: subRows[0] ? mapSubscription(subRows[0] as unknown as Record<string, unknown>) : undefined,
  }

  ok(res, {
    user: userData,
    tokens: { accessToken, refreshToken, expiresIn: 900 },
  })
})

// ─── POST /auth/2fa/verify ────────────────────────────────────────────────────
authRouter.post('/2fa/verify', validate(twoFAVerifySchema), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) throw AppError.unauthorized()

  const payload = jwt.verify(authHeader.slice(7), env.JWT_ACCESS_SECRET) as JwtPayload & { pending2fa?: boolean }
  if (!payload.pending2fa) throw AppError.badRequest('Not a 2FA pending token')

  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [payload.sub])
  const user = rows[0]
  if (!user) throw AppError.notFound('User not found')

  const valid = speakeasy.totp.verify({
    secret: user.two_fa_secret ?? '',
    encoding: 'base32',
    token: req.body.code,
    window: 1,
  })
  if (!valid) throw AppError.unauthorized('Invalid 2FA code')

  const accessToken  = signAccess({ sub: user.id, role: user.role, email: user.email })
  const refreshToken = await createRefreshToken(user.id)
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])

  ok(res, {
    user: mapUser(user as unknown as Record<string, unknown>),
    tokens: { accessToken, refreshToken, expiresIn: 900 },
  })
})

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
authRouter.post('/refresh', validate(refreshSchema), async (req: Request, res: Response) => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>
  const tokenHash = hashToken(refreshToken)

  const { rows } = await query(
    `SELECT rt.*, u.role, u.email, u.is_active
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
    [tokenHash],
  )
  if (!rows.length) throw AppError.unauthorized('Invalid or expired refresh token')

  const { user_id, role, email, is_active, id: tokenId } = rows[0] as {
    user_id: string; role: string; email: string; is_active: boolean; id: string
  }
  if (!is_active) throw AppError.unauthorized('Account deactivated')

  // Rotate token
  await withTransaction(async (client) => {
    await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [tokenId])
  })

  const newAccessToken  = signAccess({ sub: user_id, role: role as never, email })
  const newRefreshToken = await createRefreshToken(user_id)

  ok(res, { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 900 })
})

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query<UserRow>(
    'SELECT * FROM users WHERE id = $1 AND is_active = true', [req.user!.id],
  )
  if (!rows.length) throw AppError.notFound('User not found')

  const { rows: subRows } = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [req.user!.id],
  )

  ok(res, {
    ...mapUser(rows[0] as unknown as Record<string, unknown>),
    subscription: subRows[0] ? mapSubscription(subRows[0] as unknown as Record<string, unknown>) : undefined,
  })
})

// ─── POST /auth/logout ────────────────────────────────────────────────────────
authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [req.user!.id],
  )
  ok(res, null, 'Logged out successfully')
})

// ─── POST /auth/verify-email ──────────────────────────────────────────────────
authRouter.post('/verify-email', validate(verifyEmailSchema), async (req: Request, res: Response) => {
  const tokenHash = hashToken(req.body.token)
  const { rows } = await query(
    `SELECT * FROM email_verifications WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [tokenHash],
  )
  if (!rows.length) throw AppError.badRequest('Invalid or expired verification token')

  const { user_id, id } = rows[0] as { user_id: string; id: string }
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET is_email_verified = true WHERE id = $1', [user_id])
    await client.query('UPDATE email_verifications SET used_at = NOW() WHERE id = $1', [id])
  })
  ok(res, null, 'Email verified successfully')
})

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
authRouter.post('/forgot-password', passwordResetLimiter, validate(forgotSchema), async (req: Request, res: Response) => {
  const { email } = req.body as z.infer<typeof forgotSchema>
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])

  // Always 200 to prevent enumeration
  if (rows.length) {
    const user  = rows[0] as UserRow
    const token = randomToken(32)
    const hash  = hashToken(token)
    const exp   = new Date(Date.now() + 15 * 60_000)

    await query(
      `INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [user.id, hash, exp],
    )
    emailService.sendPasswordReset(user.email, `${user.first_name}`, token).catch(
      (err) => logger.error('Failed to send reset email', { error: err.message }),
    )
  }
  ok(res, null, 'If that email exists, a reset link has been sent')
})

// ─── POST /auth/reset-password ────────────────────────────────────────────────
authRouter.post('/reset-password', validate(resetSchema), async (req: Request, res: Response) => {
  const { token, password } = req.body as z.infer<typeof resetSchema>
  const tokenHash = hashToken(token)

  const { rows } = await query(
    `SELECT * FROM password_resets WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [tokenHash],
  )
  if (!rows.length) throw AppError.badRequest('Invalid or expired reset token')

  const { user_id, id } = rows[0] as { user_id: string; id: string }
  const newHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS)

  await withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user_id])
    await client.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [id])
    // Revoke all refresh tokens for security
    await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [user_id])
  })
  ok(res, null, 'Password reset successfully')
})

// ─── POST /auth/2fa/enable ────────────────────────────────────────────────────
authRouter.post('/2fa/enable', authenticate, async (req: Request, res: Response) => {
  const secret = speakeasy.generateSecret({ name: env.TWO_FA_APP_NAME, length: 20 })
  await query('UPDATE users SET two_fa_secret = $1 WHERE id = $2', [secret.base32, req.user!.id])
  const qrCode = await QRCode.toDataURL(secret.otpauth_url!)
  ok(res, { qrCode, secret: secret.base32 })
})

// ─── POST /auth/2fa/disable ───────────────────────────────────────────────────
authRouter.post('/2fa/disable', authenticate, validate(twoFAVerifySchema), async (req: Request, res: Response) => {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  const valid = speakeasy.totp.verify({
    secret: rows[0].two_fa_secret ?? '',
    encoding: 'base32',
    token: req.body.code,
    window: 1,
  })
  if (!valid) throw AppError.unauthorized('Invalid 2FA code')
  await query('UPDATE users SET is_2fa_enabled = false, two_fa_secret = NULL WHERE id = $1', [req.user!.id])
  ok(res, null, '2FA disabled')
})
