import crypto from 'crypto'
import { Response } from 'express'
import type { ApiResponse, PaginatedResult } from '../types'

// ─── Response helpers ─────────────────────────────────────────────────────────
export function ok<T>(res: Response, data: T, message?: string, status = 200): void {
  const body: ApiResponse<T> = { success: true, data, ...(message && { message }) }
  res.status(status).json(body)
}

export function created<T>(res: Response, data: T, message?: string): void {
  ok(res, data, message, 201)
}

export function noContent(res: Response): void {
  res.status(204).end()
}

export function paginated<T>(
  res: Response,
  items: T[],
  total: number,
  page: number,
  limit: number,
): void {
  const result: PaginatedResult<T> = {
    data: items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
  ok(res, result)
}

// ─── Pagination parser ────────────────────────────────────────────────────────
export function parsePagination(query: Record<string, unknown>): {
  page: number
  limit: number
  offset: number
} {
  const page  = Math.max(1, parseInt(String(query.page  ?? '1'),  10))
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10)))
  return { page, limit, offset: (page - 1) * limit }
}

// ─── AppError class ───────────────────────────────────────────────────────────
export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly status: number = 400,
    public readonly code?: string,
    public readonly errors?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'AppError'
    Object.setPrototypeOf(this, AppError.prototype)
  }

  static notFound(msg = 'Resource not found')    { return new AppError(msg, 404, 'NOT_FOUND') }
  static unauthorized(msg = 'Unauthorised')       { return new AppError(msg, 401, 'UNAUTHORIZED') }
  static forbidden(msg = 'Forbidden')             { return new AppError(msg, 403, 'FORBIDDEN') }
  static conflict(msg: string)                    { return new AppError(msg, 409, 'CONFLICT') }
  static badRequest(msg: string, errs?: Record<string, string[]>) {
    return new AppError(msg, 400, 'BAD_REQUEST', errs)
  }
  static internal(msg = 'Internal server error')  { return new AppError(msg, 500, 'INTERNAL') }
}

// ─── Crypto helpers ────────────────────────────────────────────────────────────
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function generateOTP(digits = 6): string {
  return String(Math.floor(Math.random() * 10 ** digits)).padStart(digits, '0')
}

// ─── Subscription duration → days ─────────────────────────────────────────────
export const DURATION_DAYS: Record<string, number> = {
  daily:    1,
  weekly:   7,
  monthly:  30,
  quarterly: 91,
  biannual: 182,
  annual:   365,
}

// Subscription prices in kobo (smallest unit for Paystack) NGN × 100
//
// Daily, monthly and quarterly are the ORIGINAL (non-promo) prices from the
// SRS pricing table dated 30 Dec 2025. The launch-promo column is deliberately
// not encoded here — a promo needs a start and end date, and the table's stated
// window ("Feb 1–30") is not a real date range.
//
// Weekly, biannual and annual are NOT in the SRS. They are derived from the
// monthly rate so the ladder stays monotonic, and they need sign-off:
//   weekly   ≈ monthly ÷ 3   (a week costs more per-day than a month)
//   biannual = monthly × 6 × 0.85
//   annual   = monthly × 12 × 0.80
// Before this, standard weekly was ₦2,500 against a daily of ₦3,499 — a week
// cost less than a single day, which anyone could arbitrage.
export const SUBSCRIPTION_PRICES: Record<string, Record<string, number>> = {
  standard: {
    daily:      349_900,    // ₦3,499    SRS
    weekly:   1_199_900,    // ₦11,999   derived
    monthly:  3_499_900,    // ₦34,999   SRS
    quarterly: 10_499_900,  // ₦104,999  SRS
    biannual: 17_849_900,   // ₦178,499  derived
    annual:   33_599_900,   // ₦335,999  derived
  },
  premium: {
    daily:      549_900,    // ₦5,499    SRS
    weekly:   1_699_900,    // ₦16,999   derived
    monthly:  5_049_900,    // ₦50,499   SRS
    quarterly: 14_999_900,  // ₦149,999  SRS
    biannual: 25_754_900,   // ₦257,549  derived
    annual:   48_479_900,   // ₦484,799  derived
  },
}

// ─── Pro-rata calculation ─────────────────────────────────────────────────────
export function calculateProRata(
  currentEndDate: Date,
  currentAmountPaid: number,
  currentDuration: string,
): number {
  const now        = new Date()
  const totalDays  = DURATION_DAYS[currentDuration] ?? 30
  const daysLeft   = Math.max(0, Math.ceil((currentEndDate.getTime() - now.getTime()) / 86_400_000))
  const dailyRate  = currentAmountPaid / totalDays
  return Math.floor(dailyRate * daysLeft)
}

// ─── Row mapper: snake_case → camelCase user ──────────────────────────────────
export function mapUser(row: Record<string, unknown>) {
  return {
    id:              row.id,
    firstName:       row.first_name,
    lastName:        row.last_name,
    email:           row.email,
    phone:           row.phone,
    role:            row.role,
    avatar:          row.avatar ?? null,
    centreId:        row.centre_id ?? null,
    trainerId:       row.trainer_id ?? null,
    corporateId:     row.corporate_id ?? null,
    isEmailVerified: row.is_email_verified,
    is2FAEnabled:    row.is_2fa_enabled,
    // Omitting this made every account render as "Inactive" in User Management,
    // because the client can only fall back to false for a field it never gets.
    isActive:        row.is_active ?? true,
    // An admin-created account (UC-A8) exists with no password until the user
    // follows their activation link. Compared against null explicitly: an
    // absent column means "not selected", not "no password set".
    isPending:       row.password_hash === null,
    lastLoginAt:     row.last_login_at ?? null,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  }
}

export function mapSubscription(row: Record<string, unknown>) {
  return {
    id:          row.id,
    tier:        row.tier,
    duration:    row.duration,
    status:      row.status,
    startDate:   row.start_date,
    endDate:     row.end_date,
    autoRenew:   row.auto_renew,
    amountPaid:  row.amount_paid,
    centreId:    row.centre_id ?? null,
  }
}

export function mapClass(row: Record<string, unknown>) {
  return {
    id:           row.id,
    name:         row.name,
    description:  row.description ?? '',
    trainerId:    row.trainer_id,
    centreId:     row.centre_id,
    startTime:    row.start_time,
    durationMins: row.duration_mins,
    capacity:     row.capacity,
    enrolled:     row.enrolled,
    category:     row.category,
    level:        row.level,
  }
}

export function mapBooking(row: Record<string, unknown>) {
  return {
    id:          row.id,
    userId:      row.user_id,
    classId:     row.class_id ?? null,
    sessionId:   row.trainer_id ?? null,
    type:        row.type,
    status:      row.status,
    scheduledAt: row.scheduled_at,
    bookedAt:    row.created_at,
  }
}

export function mapTrainer(row: Record<string, unknown>) {
  return {
    id:              row.id,
    userId:          row.user_id,
    firstName:       row.first_name,
    lastName:        row.last_name,
    avatar:          row.avatar ?? null,
    bio:             row.bio ?? '',
    specialisations: row.specialisations ?? [],
    certifications:  row.certifications ?? [],
    rating:          Number(row.rating),
    reviewCount:     row.review_count,
    clientCount:     row.client_count,
    centreId:        row.centre_id,
  }
}

export function mapCentre(row: Record<string, unknown>) {
  return {
    id:          row.id,
    name:        row.name,
    address:     row.address,
    city:        row.city,
    state:       row.state,
    lat:         Number(row.lat),
    lng:         Number(row.lng),
    capacity:    row.capacity,
    isAffiliate: row.is_affiliate,
    affiliateId: row.affiliate_id ?? null,
    images:      row.images ?? [],
    amenities:   row.amenities ?? [],
  }
}

export function mapProduct(row: Record<string, unknown>) {
  return {
    id:          row.id,
    name:        row.name,
    description: row.description ?? '',
    category:    row.category,
    price:       row.price,
    images:      row.images ?? [],
    sku:         row.sku,
    stock:       row.stock,
    status:      row.status,
    variants:    row.variants ?? [],
  }
}
