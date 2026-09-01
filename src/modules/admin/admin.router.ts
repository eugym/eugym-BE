import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { query, withTransaction } from '../../db/pool'
import { AppError, mapUser, mapTrainer, paginated, parsePagination } from '../../utils'
import { authenticate, authorize, validate } from '../../middleware'
import { ok, created, randomToken, hashToken } from '../../utils'
import { emailService } from '../../lib/email'
import { logger } from '../../config/logger'
import type { UserRow } from '../../types'

export const adminRouter = Router()

// All admin routes require authentication + admin role
adminRouter.use(authenticate, authorize('admin', 'super_admin'))

// ─── GET /admin/stats ────────────────────────────────────────────────────────
adminRouter.get('/stats', async (_req: Request, res: Response) => {
  const [members, revenue, bookings, pendingPOS, lowStock, trainers] = await Promise.all([
    query(`SELECT COUNT(*) FROM users WHERE role IN ('standard','premium') AND is_active = true`),
    query(`SELECT COALESCE(SUM(amount),0) AS total FROM payments
           WHERE status = 'success' AND DATE_TRUNC('month', paid_at) = DATE_TRUNC('month', NOW())`),
    query(`SELECT COUNT(*) FROM bookings WHERE DATE(scheduled_at) = CURRENT_DATE`),
    query(`SELECT COUNT(*) FROM payments WHERE method = 'pos' AND status = 'pending'`),
    query(`SELECT COUNT(*) FROM products WHERE stock <= 5 AND status = 'active'`),
    query(`SELECT COUNT(*) FROM trainer_profiles WHERE is_active = true`),
  ])

  ok(res, {
    totalMembers:        parseInt(members.rows[0].count),
    monthlyRevenue:      parseInt(revenue.rows[0].total),
    todayBookings:       parseInt(bookings.rows[0].count),
    pendingPOS:          parseInt(pendingPOS.rows[0].count),
    lowStockItems:       parseInt(lowStock.rows[0].count),
    activeTrainers:      parseInt(trainers.rows[0].count),
  })
})

// ─── GET /admin/members ──────────────────────────────────────────────────────
adminRouter.get('/members', async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const { search, role, status } = req.query as {
    search?: string
    role?: string
    status?: string
  }

  const conditions: string[] = []
  const params: unknown[] = []

  // Defaults to active, so every existing caller keeps its behaviour. Without
  // 'inactive' and 'all', deactivating a member removes them from the only
  // screen that could reactivate them — a one-way trip out of the admin UI.
  if (status === 'inactive')  conditions.push('u.is_active = false')
  else if (status !== 'all')  conditions.push('u.is_active = true')

  if (search) {
    params.push(`%${search}%`)
    conditions.push(
      `(u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`,
    )
  }
  if (role) {
    params.push(role)
    conditions.push(`u.role = $${params.length}`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countParams = [...params]
  params.push(limit, offset)

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query<UserRow>(
      `SELECT u.*, s.tier as sub_tier, s.status as sub_status, s.end_date as sub_end
       FROM users u
       LEFT JOIN LATERAL (
         SELECT tier, status, end_date FROM subscriptions
         WHERE user_id = u.id AND status = 'active'
         ORDER BY created_at DESC LIMIT 1
       ) s ON true
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query(`SELECT COUNT(*) FROM users u ${where}`, countParams),
  ])

  paginated(
    res,
    rows.map(r => ({
      ...mapUser(r as unknown as Record<string, unknown>),
      subscription: (r as Record<string, unknown>).sub_tier ? {
        tier:    (r as Record<string, unknown>).sub_tier,
        status:  (r as Record<string, unknown>).sub_status,
        endDate: (r as Record<string, unknown>).sub_end,
      } : null,
    })),
    parseInt(countRows[0].count),
    page,
    limit,
  )
})

// ─── POST /admin/members ─────────────────────────────────────────────────────
// UC-A8: an admin creates an account for someone who can't self-register. The
// account is created with NO password and an activation link is emailed; login
// compares against '' for a null hash, so it cannot be signed into until the
// user sets one. The admin never sees or chooses the password.
const ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

async function issueActivation(userId: string): Promise<string> {
  const token = randomToken(32)
  await query(
    `INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,$3)`,
    [userId, hashToken(token), new Date(Date.now() + ACTIVATION_TTL_MS)],
  )
  return token
}

adminRouter.post('/members', async (req: Request, res: Response) => {
  const schema = z.object({
    firstName: z.string().min(2).max(100),
    lastName:  z.string().min(2).max(100),
    email:     z.string().email(),
    phone:     z.string().min(10).max(20),
    role:      z.enum(['regular','standard','premium','trainer','corporate_admin','affiliate_partner','admin']),
    centreId:  z.string().uuid().nullable().optional(),
  })
  const body = schema.parse(req.body)
  const email = body.email.toLowerCase()

  // Creating a peer admin is privilege escalation, so it stays with super
  // admins — otherwise any admin could mint themselves an ally.
  const actor = (req as { user?: { role?: string } }).user
  if (body.role === 'admin' && actor?.role !== 'super_admin') {
    throw AppError.forbidden('Only a super admin can create admin accounts')
  }

  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.length) throw AppError.conflict('An account with that email already exists')

  const { rows } = await query<UserRow>(
    `INSERT INTO users (first_name, last_name, email, phone, role, centre_id, password_hash, is_email_verified)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,false) RETURNING *`,
    [body.firstName, body.lastName, email, body.phone, body.role, body.centreId ?? null],
  )
  const user = rows[0]

  const token = await issueActivation(user.id)
  emailService
    .sendAccountActivation(user.email, user.first_name, token, body.role.replace(/_/g, ' '))
    .catch((err) => logger.error('Failed to send activation email', { error: err.message }))

  created(res, mapUser(user as unknown as Record<string, unknown>))
})

// ─── POST /admin/members/:id/resend-activation ───────────────────────────────
// UC-A8: "If activation link expires → Admin can resend link".
adminRouter.post('/members/:id/resend-activation', async (req: Request, res: Response) => {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.params.id])
  if (!rows.length) throw AppError.notFound('Member not found')

  const user = rows[0]
  if (user.password_hash) {
    throw AppError.badRequest('That account is already activated')
  }

  // Retire outstanding links so a forwarded older email stops working.
  await query(
    `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  )

  const token = await issueActivation(user.id)
  emailService
    .sendAccountActivation(user.email, user.first_name, token, String(user.role).replace(/_/g, ' '))
    .catch((err) => logger.error('Failed to resend activation email', { error: err.message }))

  ok(res, null, 'Activation link sent')
})

// ─── POST /admin/members/:id/anonymise ───────────────────────────────────────
// Erasure that survives an audit. payments, subscriptions and affiliate_visits
// all cascade from users, so a real DELETE would take the member's payment
// history and the check-in records affiliate settlements are billed from with
// it. Scrubbing the personal data instead satisfies the erasure request while
// leaving the financial trail whole.
adminRouter.post('/members/:id/anonymise', authorize('super_admin'), async (req: Request, res: Response) => {
  const { id } = req.params
  const actor = (req as { user?: { id?: string } }).user

  if (actor?.id === id) throw AppError.badRequest('You cannot anonymise your own account')

  const { rows: found } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [id])
  if (!found.length) throw AppError.notFound('Member not found')
  if (found[0].role === 'super_admin') {
    throw AppError.forbidden('Super admin accounts cannot be anonymised')
  }

  const anonymised = await withTransaction(async (client) => {
    // Keeping the row (and its id) is the point — every payment and visit still
    // references it. Only the identifying columns are destroyed.
    const { rows } = await client.query<UserRow>(
      `UPDATE users SET
         first_name        = 'Deleted',
         last_name         = 'User',
         email             = $2,
         phone             = '',
         avatar            = NULL,
         password_hash     = NULL,
         google_id         = NULL,
         two_fa_secret     = NULL,
         is_2fa_enabled    = false,
         is_email_verified = false,
         is_active         = false,
         updated_at        = NOW()
       WHERE id = $1 RETURNING *`,
      [id, `deleted+${id}@eugym.invalid`],
    )

    // Anything that could let the erased account back in.
    await client.query('DELETE FROM refresh_tokens      WHERE user_id = $1', [id])
    await client.query('DELETE FROM password_resets     WHERE user_id = $1', [id])
    await client.query('DELETE FROM email_verifications WHERE user_id = $1', [id])

    return rows[0]
  })

  ok(res, mapUser(anonymised as unknown as Record<string, unknown>), 'Member anonymised')
})

// ─── PATCH /admin/members/:id ────────────────────────────────────────────────
adminRouter.patch('/members/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    role:       z.enum(['regular','standard','premium','trainer','corporate_admin','affiliate_partner','admin']).optional(),
    isActive:   z.boolean().optional(),
    centreId:   z.string().uuid().nullable().optional(),
    trainerId:  z.string().uuid().nullable().optional(),
  })
  const body = schema.parse(req.body)
  const sets: string[] = [], vals: unknown[] = []
  if (body.role !== undefined)      { sets.push(`role = $${vals.push(body.role)}`) }
  if (body.isActive !== undefined)  { sets.push(`is_active = $${vals.push(body.isActive)}`) }
  if (body.centreId !== undefined)  { sets.push(`centre_id = $${vals.push(body.centreId)}`) }
  if (body.trainerId !== undefined) { sets.push(`trainer_id = $${vals.push(body.trainerId)}`) }
  if (!sets.length) throw AppError.badRequest('No fields to update')
  vals.push(req.params.id)
  const { rows } = await query<UserRow>(
    `UPDATE users SET ${sets.join(',')} WHERE id = $${vals.length} RETURNING *`, vals,
  )
  if (!rows.length) throw AppError.notFound('Member not found')
  ok(res, mapUser(rows[0] as unknown as Record<string, unknown>))
})

// ─── DELETE /admin/members/:id ───────────────────────────────────────────────
adminRouter.delete('/members/:id', authorize('super_admin'), async (req: Request, res: Response) => {
  const { rows } = await query(
    `UPDATE users SET is_active = false WHERE id = $1 RETURNING id`, [req.params.id],
  )
  if (!rows.length) throw AppError.notFound('Member not found')
  ok(res, null, 'Member deactivated')
})

// ─── GET /admin/trainers ─────────────────────────────────────────────────────
adminRouter.get('/trainers', async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT tp.*, u.first_name, u.last_name, u.email, u.avatar, c.name as centre_name
     FROM trainer_profiles tp
     JOIN users u ON u.id = tp.user_id
     JOIN centres c ON c.id = tp.centre_id
     ORDER BY tp.rating DESC`,
  )
  ok(res, rows.map(r => mapTrainer(r as unknown as Record<string, unknown>)))
})

// ─── POST /admin/trainers ────────────────────────────────────────────────────
adminRouter.post('/trainers', async (req: Request, res: Response) => {
  const schema = z.object({
    userId:          z.string().uuid(),
    centreId:        z.string().uuid(),
    bio:             z.string().max(1000).optional(),
    specialisations: z.array(z.string()).default([]),
    certifications:  z.array(z.string()).default([]),
  })
  const body = schema.parse(req.body)

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO trainer_profiles (user_id, centre_id, bio, specialisations, certifications)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [body.userId, body.centreId, body.bio ?? null, body.specialisations, body.certifications],
    )
    await client.query(`UPDATE users SET role = 'trainer' WHERE id = $1`, [body.userId])
    created(res, mapTrainer(rows[0] as unknown as Record<string, unknown>))
  })
})

// ─── GET /admin/payments/pending-pos ────────────────────────────────────────
adminRouter.get('/payments/pending-pos', async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT p.*, u.first_name, u.last_name, u.email,
            s.tier, s.duration
     FROM payments p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN subscriptions s ON s.id = p.subscription_id
     WHERE p.method = 'pos' AND p.status = 'pending'
     ORDER BY p.created_at DESC`,
  )
  ok(res, rows)
})

// ─── GET /admin/classes ──────────────────────────────────────────────────────
adminRouter.get('/classes', async (req: Request, res: Response) => {
  const { centreId } = req.query as { centreId?: string }
  let sql = `
    SELECT fc.*, u.first_name, u.last_name, c.name as centre_name
    FROM fitness_classes fc
    JOIN trainer_profiles tp ON tp.id = fc.trainer_id
    JOIN users u ON u.id = tp.user_id
    JOIN centres c ON c.id = fc.centre_id
    WHERE fc.start_time >= NOW()
  `
  const params: unknown[] = []
  if (centreId) { params.push(centreId); sql += ` AND fc.centre_id = $${params.length}` }
  sql += ' ORDER BY fc.start_time ASC'
  const { rows } = await query(sql, params)
  ok(res, rows)
})

// ─── PATCH /admin/classes/:id/cancel ────────────────────────────────────────
adminRouter.patch('/classes/:id/cancel', async (req: Request, res: Response) => {
  const { rows } = await query(
    `UPDATE fitness_classes SET is_cancelled = true WHERE id = $1 RETURNING id`,
    [req.params.id],
  )
  if (!rows.length) throw AppError.notFound('Class not found')
  // Cancel all bookings for this class
  await query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW()
     WHERE class_id = $1 AND status = 'confirmed'`,
    [req.params.id],
  )
  ok(res, null, 'Class cancelled and all bookings refunded')
})

// ─── Merchandise management ──────────────────────────────────────────────────
adminRouter.get('/merchandise', async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const [{ rows }, { rows: cnt }] = await Promise.all([
    query(`SELECT p.*, json_agg(pv.*) FILTER (WHERE pv.id IS NOT NULL) AS variants
           FROM products p
           LEFT JOIN product_variants pv ON pv.product_id = p.id
           GROUP BY p.id ORDER BY p.created_at DESC
           LIMIT $1 OFFSET $2`, [limit, offset]),
    query('SELECT COUNT(*) FROM products'),
  ])
  paginated(res, rows, parseInt(cnt[0].count), page, limit)
})

adminRouter.post('/merchandise', async (req: Request, res: Response) => {
  const schema = z.object({
    name:        z.string().min(3),
    description: z.string().optional(),
    category:    z.enum(['fitness_wear','accessories','supplements','wellness','branded']),
    price:       z.number().int().positive(),
    sku:         z.string().min(3),
    stock:       z.number().int().min(0),
    images:      z.array(z.string().url()).default([]),
  })
  const body = schema.parse(req.body)
  const { rows } = await query(
    `INSERT INTO products (name,description,category,price,sku,stock,images)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [body.name, body.description ?? null, body.category, body.price, body.sku, body.stock, body.images],
  )
  created(res, rows[0])
})

adminRouter.patch('/merchandise/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    name:   z.string().optional(),
    price:  z.number().int().positive().optional(),
    stock:  z.number().int().min(0).optional(),
    status: z.enum(['active','inactive','out_of_stock']).optional(),
  })
  const body = schema.parse(req.body)
  const sets: string[] = [], vals: unknown[] = []
  Object.entries(body).forEach(([k, v]) => {
    if (v !== undefined) {
      const col = k.replace(/([A-Z])/g, '_$1').toLowerCase()
      sets.push(`${col} = $${vals.push(v)}`)
    }
  })
  if (!sets.length) throw AppError.badRequest('Nothing to update')
  vals.push(req.params.id)
  const { rows } = await query(`UPDATE products SET ${sets.join(',')} WHERE id = $${vals.length} RETURNING *`, vals)
  if (!rows.length) throw AppError.notFound('Product not found')
  ok(res, rows[0])
})

// ─── GET /admin/reports ──────────────────────────────────────────────────────
adminRouter.get('/reports', async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string }
  const start = from ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const end   = to   ?? new Date().toISOString()

  const [revenue, signups, bookingStats, topClasses] = await Promise.all([
    query(
      `SELECT DATE_TRUNC('day', paid_at) as day, SUM(amount) as total, COUNT(*) as count
       FROM payments WHERE status = 'success' AND paid_at BETWEEN $1 AND $2
       GROUP BY day ORDER BY day`,
      [start, end],
    ),
    query(
      `SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as count
       FROM users WHERE created_at BETWEEN $1 AND $2
       GROUP BY day ORDER BY day`,
      [start, end],
    ),
    query(
      `SELECT status, COUNT(*) as count FROM bookings
       WHERE created_at BETWEEN $1 AND $2 GROUP BY status`,
      [start, end],
    ),
    query(
      `SELECT fc.name, COUNT(b.id) as bookings
       FROM bookings b JOIN fitness_classes fc ON fc.id = b.class_id
       WHERE b.created_at BETWEEN $1 AND $2
       GROUP BY fc.name ORDER BY bookings DESC LIMIT 5`,
      [start, end],
    ),
  ])

  ok(res, {
    revenue:      revenue.rows,
    signups:      signups.rows,
    bookingStats: bookingStats.rows,
    topClasses:   topClasses.rows,
  })
})

// ─── Affiliates (admin view) ──────────────────────────────────────────────────
adminRouter.get('/affiliates', async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT a.*, COUNT(av.id) as total_visits,
            SUM(CASE WHEN av.settled = false THEN 1 ELSE 0 END) as unsettled_visits
     FROM affiliates a
     LEFT JOIN affiliate_visits av ON av.affiliate_id = a.id
     GROUP BY a.id ORDER BY a.name`,
  )
  ok(res, rows)
})

adminRouter.post('/affiliates', authorize('super_admin'), async (req: Request, res: Response) => {
  const schema = z.object({
    name:          z.string().min(3),
    contactName:   z.string().min(2),
    contactEmail:  z.string().email(),
    contactPhone:  z.string().min(10),
    ratePerVisit:  z.number().int().positive().default(10000),
    bankName:      z.string().optional(),
    bankAccount:   z.string().optional(),
    bankCode:      z.string().optional(),
    agreementStart: z.string().optional(),
    agreementEnd:  z.string().optional(),
  })
  const body = schema.parse(req.body)
  const { rows } = await query(
    `INSERT INTO affiliates
       (name,contact_name,contact_email,contact_phone,rate_per_visit,bank_name,bank_account,bank_code,agreement_start,agreement_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [body.name, body.contactName, body.contactEmail, body.contactPhone, body.ratePerVisit,
     body.bankName ?? null, body.bankAccount ?? null, body.bankCode ?? null,
     body.agreementStart ?? null, body.agreementEnd ?? null],
  )
  created(res, rows[0])
})

// ─── Super Admin: manage admins ───────────────────────────────────────────────
adminRouter.get('/super/admins', authorize('super_admin'), async (_req: Request, res: Response) => {
  const { rows } = await query<UserRow>(
    `SELECT * FROM users WHERE role IN ('admin','super_admin') ORDER BY created_at DESC`,
  )
  ok(res, rows.map(r => mapUser(r as unknown as Record<string, unknown>)))
})

adminRouter.post('/super/admins', authorize('super_admin'), async (req: Request, res: Response) => {
  const schema = z.object({
    userId: z.string().uuid(),
    role:   z.enum(['admin', 'super_admin']),
  })
  const { userId, role } = schema.parse(req.body)
  const { rows } = await query<UserRow>(
    `UPDATE users SET role = $1 WHERE id = $2 AND role NOT IN ('super_admin') RETURNING *`,
    [role, userId],
  )
  if (!rows.length) throw AppError.notFound('User not found or cannot promote')
  ok(res, mapUser(rows[0] as unknown as Record<string, unknown>), 'Admin role assigned')
})

// ─── Super Admin: revenue overview ───────────────────────────────────────────
adminRouter.get('/super/revenue', authorize('super_admin'), async (req: Request, res: Response) => {
  const { month } = req.query as { month?: string }
  const target = month ?? `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`

  const [subscriptionRev, merchandiseRev, affiliateStats, membersByTier] = await Promise.all([
    query(
      `SELECT s.tier, SUM(p.amount) as revenue, COUNT(p.id) as count
       FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
       WHERE p.status = 'success' AND TO_CHAR(p.paid_at, 'YYYY-MM') = $1
       GROUP BY s.tier`,
      [target],
    ),
    query(
      `SELECT SUM(p.amount) as revenue, COUNT(p.id) as count
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.status = 'success' AND TO_CHAR(p.paid_at, 'YYYY-MM') = $1`,
      [target],
    ),
    query(
      `SELECT a.name, COUNT(av.id) as visits
       FROM affiliate_visits av JOIN affiliates a ON a.id = av.affiliate_id
       WHERE TO_CHAR(av.visited_at, 'YYYY-MM') = $1
       GROUP BY a.name ORDER BY visits DESC`,
      [target],
    ),
    query(
      `SELECT role, COUNT(*) as count FROM users
       WHERE is_active = true GROUP BY role`,
    ),
  ])

  ok(res, {
    period:          target,
    subscriptionRev: subscriptionRev.rows,
    merchandiseRev:  merchandiseRev.rows[0] ?? { revenue: 0, count: 0 },
    affiliateStats:  affiliateStats.rows,
    membersByTier:   membersByTier.rows,
  })
})
