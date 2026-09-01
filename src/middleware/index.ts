import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import { ZodSchema } from 'zod'
import { env, paystackConfigured } from '../config/env'
import { logger } from '../config/logger'
import { AppError } from '../utils'
import type { JwtPayload, UserRole } from '../types'

// ─── JWT Authenticate ─────────────────────────────────────────────────────────
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw AppError.unauthorized()

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload
    req.user = { id: payload.sub, role: payload.role, email: payload.email }
    next()
  } catch (err: unknown) {
    if ((err as Error).name === 'TokenExpiredError') throw AppError.unauthorized('Token expired')
    throw AppError.unauthorized('Invalid token')
  }
}

// ─── Optional auth (attach user if token present, don't fail) ─────────────────
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET) as JwtPayload
      req.user = { id: payload.sub, role: payload.role, email: payload.email }
    } catch { /* ignore */ }
  }
  next()
}

// ─── RBAC ────────────────────────────────────────────────────────────────────
export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw AppError.unauthorized()
    if (!roles.includes(req.user.role)) throw AppError.forbidden()
    next()
  }
}

// ─── Zod request validation ───────────────────────────────────────────────────
export function validate(
  schema: ZodSchema,
  source: 'body' | 'query' | 'params' = 'body',
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      const errors: Record<string, string[]> = {}
      result.error.errors.forEach((e) => {
        const key = e.path.join('.') || 'general'
        if (!errors[key]) errors[key] = []
        errors[key].push(e.message)
      })
      throw AppError.badRequest('Validation failed', errors)
    }
    req[source] = result.data
    next()
  }
}

// ─── Global error handler ─────────────────────────────────────────────────────
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      data:    null,
      message: err.message,
      code:    err.code,
      ...(err.errors && { errors: err.errors }),
    })
    return
  }

  // Postgres unique violation
  const pgErr = err as { code?: string; detail?: string }
  if (pgErr.code === '23505') {
    res.status(409).json({ success: false, data: null, message: 'Already exists', code: 'CONFLICT' })
    return
  }

  logger.error('Unhandled error', {
    url:    req.url,
    method: req.method,
    error:  (err as Error).message,
    stack:  (err as Error).stack,
  })

  res.status(500).json({
    success: false,
    data:    null,
    message: env.NODE_ENV === 'production' ? 'Internal server error' : (err as Error).message,
    code:    'INTERNAL',
  })
}

// ─── Rate limiters ────────────────────────────────────────────────────────────
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, data: null, message: 'Too many requests, please try again later' },
})

/**
 * Throttles sign-in and sign-up.
 *
 * `skipSuccessfulRequests` means only *failed* attempts count. Someone logging in
 * normally never approaches the limit no matter how often they sign in, while a
 * password-guesser still gets cut off after AUTH_RATE_LIMIT misses.
 *
 * Keyed on req.ip, which is only meaningful if the Next.js proxy forwards the
 * caller's address — otherwise every user shares one bucket. See the
 * x-forwarded-for header set in Frontend/app/api/lib/authSession.ts.
 */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  max:      env.AUTH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    // Tell the user how long to wait. "Too many attempts" with no timeframe just
    // invites them to keep retrying, which extends the lockout.
    const resetAt = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime
    const seconds = resetAt
      ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
      : 60

    res.setHeader('Retry-After', String(seconds))
    res.status(429).json({
      success: false,
      data:    null,
      message: `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
      code:    'RATE_LIMITED',
    })
  },
})

export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60_000, // 15 min
  max:      3,
  message: { success: false, data: null, message: 'Too many password reset requests' },
})

// ─── Paystack webhook signature verifier ──────────────────────────────────────
import crypto from 'crypto'
export function verifyPaystackWebhook(req: Request, _res: Response, next: NextFunction): void {
  if (!paystackConfigured) {
    throw AppError.badRequest('Payments are not configured on this deployment')
  }

  const signature = req.headers['x-paystack-signature'] as string
  if (!signature) throw AppError.unauthorized('Missing webhook signature')

  const hash = crypto
    .createHmac('sha512', env.PAYSTACK_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex')

  if (hash !== signature) throw AppError.unauthorized('Invalid webhook signature')
  next()
}

// ─── Request logger ───────────────────────────────────────────────────────────
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
    logger[level](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
      ip: req.ip, ua: req.headers['user-agent']?.slice(0, 80),
    })
  })
  next()
}
