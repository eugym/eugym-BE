import { Router, Request, Response } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { query, withTransaction } from '../db/pool'
import { env } from '../config/env'
import { AppError, mapClass, mapBooking, mapTrainer, mapCentre, mapUser, paginated, parsePagination } from '../utils'
import { authenticate, authorize, validate, optionalAuth } from '../middleware'
import { ok, created } from '../utils'
import type { FitnessClassRow, BookingRow, UserRow } from '../types'

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CLASSES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const classesRouter = Router()

// GET /classes
classesRouter.get('/', optionalAuth, async (req: Request, res: Response) => {
  const { centreId, week } = req.query as { centreId?: string; week?: string }
  let sql = `
    SELECT fc.*, u.first_name, u.last_name, u.avatar
    FROM fitness_classes fc
    JOIN trainer_profiles tp ON tp.id = fc.trainer_id
    JOIN users u ON u.id = tp.user_id
    WHERE fc.is_cancelled = false
  `
  const params: unknown[] = []
  if (centreId) { params.push(centreId); sql += ` AND fc.centre_id = $${params.length}` }
  if (week) {
    params.push(week); sql += ` AND DATE_TRUNC('week', fc.start_time) = DATE_TRUNC('week', $${params.length}::timestamptz)`
  } else {
    sql += ` AND fc.start_time >= NOW()`
  }
  sql += ` ORDER BY fc.start_time ASC LIMIT 100`
  const { rows } = await query<FitnessClassRow>(sql, params)
  ok(res, rows.map(r => mapClass(r as unknown as Record<string, unknown>)))
})

// GET /classes/:id
classesRouter.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await query<FitnessClassRow>(
    `SELECT fc.*, u.first_name, u.last_name, u.avatar,
            c.name as centre_name, c.address as centre_address
     FROM fitness_classes fc
     JOIN trainer_profiles tp ON tp.id = fc.trainer_id
     JOIN users u ON u.id = tp.user_id
     JOIN centres c ON c.id = fc.centre_id
     WHERE fc.id = $1`,
    [req.params.id],
  )
  if (!rows.length) throw AppError.notFound('Class not found')
  ok(res, mapClass(rows[0] as unknown as Record<string, unknown>))
})

// POST /classes (Admin/Trainer)
classesRouter.post('/', authenticate, authorize('admin', 'super_admin', 'trainer'), async (req: Request, res: Response) => {
  const schema = z.object({
    centreId:    z.string().uuid(),
    trainerId:   z.string().uuid(),
    name:        z.string().min(3),
    description: z.string().optional(),
    category:    z.string().min(2),
    level:       z.enum(['beginner','intermediate','advanced']),
    startTime:   z.string().datetime(),
    durationMins: z.number().int().min(15).max(180),
    capacity:    z.number().int().min(1).max(200),
  })
  const body = schema.parse(req.body)
  const { rows } = await query<FitnessClassRow>(
    `INSERT INTO fitness_classes
       (centre_id, trainer_id, name, description, category, level, start_time, duration_mins, capacity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [body.centreId, body.trainerId, body.name, body.description ?? null,
     body.category, body.level, body.startTime, body.durationMins, body.capacity],
  )
  created(res, mapClass(rows[0] as unknown as Record<string, unknown>))
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BOOKINGS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const bookingsRouter = Router()

// GET /bookings/me
bookingsRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query<BookingRow>(
    `SELECT b.*, fc.name as class_name, fc.start_time,
            u.first_name as trainer_first, u.last_name as trainer_last
     FROM bookings b
     LEFT JOIN fitness_classes fc ON fc.id = b.class_id
     LEFT JOIN trainer_profiles tp ON tp.id = b.trainer_id
     LEFT JOIN users u ON u.id = tp.user_id
     WHERE b.user_id = $1
     ORDER BY b.scheduled_at DESC`,
    [req.user!.id],
  )
  ok(res, rows.map(r => ({
    ...mapBooking(r as unknown as Record<string, unknown>),
    className:     (r as Record<string, unknown>).class_name,
    trainerName:   (r as Record<string, unknown>).trainer_first
                   ? `${(r as Record<string, unknown>).trainer_first} ${(r as Record<string, unknown>).trainer_last}`
                   : null,
  })))
})

// POST /bookings
bookingsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const schema = z.object({
    classId:   z.string().uuid().optional(),
    trainerId: z.string().uuid().optional(),
    type:      z.enum(['group_class','pt_session']),
    proposedAt: z.string().datetime().optional(),
    durationMins: z.number().int().min(30).max(120).optional(),
    notes:     z.string().max(500).optional(),
  })
  const body = schema.parse(req.body)

  // Check booking suspension
  const { rows: userRows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  const user = userRows[0]
  if (user.booking_suspended_until && user.booking_suspended_until > new Date()) {
    throw AppError.forbidden(`Booking suspended until ${user.booking_suspended_until.toDateString()} due to repeated no-shows`)
  }

  if (body.type === 'group_class') {
    if (!body.classId) throw AppError.badRequest('classId required for group class')

    const { rows: cls } = await query<FitnessClassRow>(
      'SELECT * FROM fitness_classes WHERE id = $1 AND is_cancelled = false',
      [body.classId],
    )
    if (!cls.length) throw AppError.notFound('Class not found or cancelled')
    if (cls[0].enrolled >= cls[0].capacity) throw AppError.conflict('Class is full')

    // Check not already booked
    const { rows: dup } = await query(
      `SELECT id FROM bookings WHERE user_id = $1 AND class_id = $2 AND status = 'confirmed'`,
      [req.user!.id, body.classId],
    )
    if (dup.length) throw AppError.conflict('You already have a booking for this class')

    const bookRow = await withTransaction(async (client) => {
      const r = await client.query<BookingRow>(
        `INSERT INTO bookings (user_id, class_id, type, status, scheduled_at, duration_mins, notes)
         VALUES ($1,$2,'group_class','confirmed',$3,$4,$5) RETURNING *`,
        [req.user!.id, body.classId, cls[0].start_time, cls[0].duration_mins, body.notes ?? null],
      )
      await client.query(
        'UPDATE fitness_classes SET enrolled = enrolled + 1 WHERE id = $1',
        [body.classId],
      )
      return r.rows
    })
    created(res, mapBooking(bookRow[0] as unknown as Record<string, unknown>))
  } else {
    // PT session
    if (!body.trainerId || !body.proposedAt) {
      throw AppError.badRequest('trainerId and proposedAt required for PT session')
    }
    const { rows: bookRow } = await query<BookingRow>(
      `INSERT INTO bookings (user_id, trainer_id, type, status, scheduled_at, duration_mins, notes)
       VALUES ($1,$2,'pt_session','confirmed',$3,$4,$5) RETURNING *`,
      [req.user!.id, body.trainerId, body.proposedAt, body.durationMins ?? 60, body.notes ?? null],
    )
    created(res, mapBooking(bookRow[0] as unknown as Record<string, unknown>))
  }
})

// POST /bookings/:id/cancel
bookingsRouter.post('/:id/cancel', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query<BookingRow>(
    `SELECT * FROM bookings WHERE id = $1 AND user_id = $2 AND status = 'confirmed'`,
    [req.params.id, req.user!.id],
  )
  if (!rows.length) throw AppError.notFound('Booking not found or already cancelled')

  const booking = rows[0]
  const twoHoursFromNow = new Date(Date.now() + 2 * 3_600_000)

  if (booking.scheduled_at < twoHoursFromNow) {
    // Late cancellation: apply strike
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
        [booking.id],
      )
      if (booking.class_id) {
        await client.query(
          'UPDATE fitness_classes SET enrolled = enrolled - 1 WHERE id = $1',
          [booking.class_id],
        )
      }
      const { rows: u } = await client.query<UserRow>(
        'UPDATE users SET strike_count = strike_count + 1 WHERE id = $1 RETURNING *',
        [req.user!.id],
      )
      if (u[0].strike_count >= 3) {
        const suspendUntil = new Date(Date.now() + 7 * 86_400_000)
        await client.query(
          'UPDATE users SET booking_suspended_until = $1, strike_count = 0 WHERE id = $2',
          [suspendUntil, req.user!.id],
        )
      }
    })
    ok(res, null, 'Booking cancelled (late). Strike recorded.')
    return
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [booking.id],
    )
    if (booking.class_id) {
      await client.query(
        'UPDATE fitness_classes SET enrolled = enrolled - 1 WHERE id = $1', [booking.class_id],
      )
    }
  })
  ok(res, null, 'Booking cancelled successfully')
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TRAINERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const trainersRouter = Router()

trainersRouter.get('/', async (req: Request, res: Response) => {
  const { centreId } = req.query as { centreId?: string }
  let sql = `
    SELECT tp.*, u.first_name, u.last_name, u.avatar, u.email
    FROM trainer_profiles tp
    JOIN users u ON u.id = tp.user_id
    WHERE tp.is_active = true
  `
  const params: unknown[] = []
  if (centreId) { params.push(centreId); sql += ` AND tp.centre_id = $${params.length}` }
  sql += ' ORDER BY tp.rating DESC'
  const { rows } = await query(sql, params)
  ok(res, rows.map(r => mapTrainer(r as unknown as Record<string, unknown>)))
})

trainersRouter.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT tp.*, u.first_name, u.last_name, u.avatar, u.email,
            c.name as centre_name
     FROM trainer_profiles tp
     JOIN users u ON u.id = tp.user_id
     JOIN centres c ON c.id = tp.centre_id
     WHERE tp.id = $1 AND tp.is_active = true`,
    [req.params.id],
  )
  if (!rows.length) throw AppError.notFound('Trainer not found')
  ok(res, mapTrainer(rows[0] as unknown as Record<string, unknown>))
})

trainersRouter.get('/:id/availability', authenticate, async (req: Request, res: Response) => {
  const { week } = req.query as { week?: string }
  const { rows } = await query(
    `SELECT * FROM trainer_availability WHERE trainer_id = $1 AND is_active = true ORDER BY day_of_week`,
    [req.params.id],
  )
  ok(res, { slots: rows })
})

trainersRouter.get('/me/clients', authenticate, authorize('trainer'), async (req: Request, res: Response) => {
  const { rows: tp } = await query('SELECT id FROM trainer_profiles WHERE user_id = $1', [req.user!.id])
  if (!tp.length) throw AppError.notFound('Trainer profile not found')
  const { rows } = await query<UserRow>(
    'SELECT * FROM users WHERE trainer_id = $1 AND is_active = true', [tp[0].id],
  )
  ok(res, rows.map(r => mapUser(r as unknown as Record<string, unknown>)))
})

trainersRouter.get('/me/schedule', authenticate, authorize('trainer'), async (req: Request, res: Response) => {
  const { rows: tp } = await query('SELECT id FROM trainer_profiles WHERE user_id = $1', [req.user!.id])
  if (!tp.length) throw AppError.notFound('Trainer profile not found')
  const { rows } = await query<BookingRow>(
    `SELECT b.*, u.first_name, u.last_name
     FROM bookings b JOIN users u ON u.id = b.user_id
     WHERE b.trainer_id = $1 AND b.status = 'confirmed' AND b.scheduled_at >= NOW()
     ORDER BY b.scheduled_at ASC`,
    [tp[0].id],
  )
  ok(res, rows)
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CENTRES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const centresRouter = Router()

centresRouter.get('/', async (req: Request, res: Response) => {
  const { lat, lng } = req.query as { lat?: string; lng?: string }
  let sql = `SELECT * FROM centres WHERE is_active = true`
  if (lat && lng) {
    sql = `
      SELECT *, (
        6371 * acos(
          cos(radians($1)) * cos(radians(lat)) *
          cos(radians(lng) - radians($2)) +
          sin(radians($1)) * sin(radians(lat))
        )
      ) AS distance_km
      FROM centres WHERE is_active = true
      ORDER BY distance_km ASC
    `
    const { rows } = await query(sql, [parseFloat(lat), parseFloat(lng)])
    ok(res, rows.map(r => mapCentre(r as unknown as Record<string, unknown>)))
    return
  }
  const { rows } = await query(sql)
  ok(res, rows.map(r => mapCentre(r as unknown as Record<string, unknown>)))
})

centresRouter.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await query('SELECT * FROM centres WHERE id = $1 AND is_active = true', [req.params.id])
  if (!rows.length) throw AppError.notFound('Centre not found')
  ok(res, mapCentre(rows[0] as unknown as Record<string, unknown>))
})

// POST /visits/check-in (Premium affiliate check-in)
export const visitsRouter = Router()
visitsRouter.post('/check-in', authenticate, authorize('premium'), async (req: Request, res: Response) => {
  const { centreId } = z.object({ centreId: z.string().uuid() }).parse(req.body)

  const { rows: centre } = await query(
    'SELECT * FROM centres WHERE id = $1 AND is_affiliate = true AND is_active = true', [centreId],
  )
  if (!centre.length) throw AppError.notFound('Affiliate centre not found or not accessible')

  const c = centre[0] as { id: string; affiliate_id: string }
  const { rows } = await query(
    `INSERT INTO affiliate_visits (user_id, centre_id, affiliate_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [req.user!.id, c.id, c.affiliate_id],
  )
  ok(res, { visitId: rows[0].id }, 'Check-in successful. Enjoy your workout!')
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// USERS (profile)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const usersRouter = Router()

usersRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  if (!rows.length) throw AppError.notFound()
  ok(res, mapUser(rows[0] as unknown as Record<string, unknown>))
})

usersRouter.patch('/me', authenticate, async (req: Request, res: Response) => {
  const schema = z.object({
    firstName: z.string().min(2).optional(),
    lastName:  z.string().min(2).optional(),
    phone:     z.string().min(10).optional(),
  })
  const body = schema.parse(req.body)
  const sets: string[] = [], vals: unknown[] = []
  if (body.firstName) { sets.push(`first_name = $${vals.push(body.firstName)}`)}
  if (body.lastName)  { sets.push(`last_name = $${vals.push(body.lastName)}`)}
  if (body.phone)     { sets.push(`phone = $${vals.push(body.phone)}`)}
  if (!sets.length) throw AppError.badRequest('No fields to update')
  vals.push(req.user!.id)
  const { rows } = await query<UserRow>(
    `UPDATE users SET ${sets.join(',')} WHERE id = $${vals.length} RETURNING *`, vals,
  )
  ok(res, mapUser(rows[0] as unknown as Record<string, unknown>))
})

// Schema lives outside the handler so `validate` can run it as middleware.
// Inline `.parse()` threw a raw ZodError straight past the AppError branch of
// the error handler, so a password missing a capital came back as HTTP 500 with
// a JSON dump of the zod issues as its message. Every rule carries wording the
// frontend renders verbatim.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password needs at least one capital letter')
    .regex(/[0-9]/, 'Password needs at least one number'),
})

usersRouter.post('/me/password', authenticate, validate(changePasswordSchema), async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>

  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  const user = rows[0]
  if (!user) throw AppError.unauthorized()

  // An admin-created account has no password until its owner activates it;
  // comparing against '' would report "incorrect" and hide the real reason.
  if (!user.password_hash) {
    throw AppError.badRequest(
      'This account has no password yet. Use the activation link sent to your email.',
    )
  }

  // bcryptjs is CommonJS: `(await import('bcryptjs')).compare` is undefined
  // because the functions hang off `.default`. That made this endpoint throw
  // "compare is not a function" on every single call.
  const valid = await bcrypt.compare(currentPassword, user.password_hash)
  if (!valid) throw AppError.unauthorized('Current password is incorrect')

  // Enforced here as well as in the UI: a "change" that changes nothing gives
  // false reassurance after a suspected compromise.
  if (currentPassword === newPassword) {
    throw AppError.badRequest('New password must be different from your current one', {
      newPassword: ['New password must be different from your current one'],
    })
  }

  const hash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS)

  // Revoke outstanding refresh tokens. Changing a password is how someone locks
  // an intruder out; leaving live sessions alone defeats the point.
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id])
    await client.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    )
  })

  ok(res, null, 'Password updated successfully')
})

usersRouter.delete('/me', authenticate, async (req: Request, res: Response) => {
  // Soft delete
  await query('UPDATE users SET is_active = false WHERE id = $1', [req.user!.id])
  await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [req.user!.id])
  ok(res, null, 'Account deleted')
})
