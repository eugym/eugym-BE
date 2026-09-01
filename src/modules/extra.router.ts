import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { query, withTransaction } from '../db/pool'
import { AppError, mapUser, paginated, parsePagination, mapProduct, randomToken, hashToken } from '../utils'
import { authenticate, authorize, validate } from '../middleware'
import { ok, created } from '../utils'
import type { UserRow, ProductRow } from '../types'
import bcrypt from 'bcryptjs'
import { env, paystackConfigured } from '../config/env'
import { emailService } from '../lib/email'

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CORPORATE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const corporateRouter = Router()
corporateRouter.use(authenticate, authorize('corporate_admin'))

corporateRouter.get('/overview', async (req: Request, res: Response) => {
  const { rows: userRows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  const corporateId = userRows[0]?.corporate_id
  if (!corporateId) throw AppError.forbidden('No corporate account associated')

  const [account, staff, usage] = await Promise.all([
    query('SELECT * FROM corporate_accounts WHERE id = $1', [corporateId]),
    query(
      `SELECT COUNT(*) FILTER (WHERE is_active = true) as enrolled,
              COUNT(*) FILTER (WHERE role = 'premium') as premium_count,
              COUNT(*) FILTER (WHERE role = 'standard') as standard_count
       FROM users WHERE corporate_id = $1`,
      [corporateId],
    ),
    query(
      `SELECT COUNT(*) as total_sessions FROM bookings b
       JOIN users u ON u.id = b.user_id
       WHERE u.corporate_id = $1
         AND DATE_TRUNC('month', b.scheduled_at) = DATE_TRUNC('month', NOW())`,
      [corporateId],
    ),
  ])

  ok(res, {
    account:   account.rows[0],
    staff:     staff.rows[0],
    usage:     usage.rows[0],
  })
})

corporateRouter.get('/staff', async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const { rows: me } = await query<UserRow>('SELECT corporate_id FROM users WHERE id = $1', [req.user!.id])
  const { corporate_id } = me[0]

  const [{ rows }, { rows: cnt }] = await Promise.all([
    query<UserRow>(
      `SELECT u.*,
              (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id
               AND DATE_TRUNC('month', b.scheduled_at) = DATE_TRUNC('month', NOW())) AS sessions_this_month
       FROM users u
       WHERE u.corporate_id = $1 AND u.is_active = true
       ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [corporate_id, limit, offset],
    ),
    query('SELECT COUNT(*) FROM users WHERE corporate_id = $1 AND is_active = true', [corporate_id]),
  ])

  paginated(res, rows.map(r => ({
    ...mapUser(r as unknown as Record<string, unknown>),
    sessionsThisMonth: (r as Record<string, unknown>).sessions_this_month,
  })), parseInt(cnt[0].count), page, limit)
})

corporateRouter.post('/staff', async (req: Request, res: Response) => {
  const schema = z.object({
    firstName:  z.string().min(2),
    lastName:   z.string().min(2),
    email:      z.string().email(),
    phone:      z.string().min(10),
    tier:       z.enum(['standard', 'premium']),
  })
  const body = schema.parse(req.body)

  const { rows: me } = await query<UserRow>(
    'SELECT corporate_id FROM users WHERE id = $1', [req.user!.id],
  )
  const { corporate_id } = me[0]
  if (!corporate_id) throw AppError.forbidden('No corporate account')

  const { rows: acct } = await query('SELECT * FROM corporate_accounts WHERE id = $1', [corporate_id])
  const { allocation } = acct[0] as { allocation: number }

  const { rows: enrolled } = await query(
    'SELECT COUNT(*) FROM users WHERE corporate_id = $1 AND is_active = true', [corporate_id],
  )
  if (parseInt(enrolled[0].count) >= allocation) {
    throw AppError.conflict('Corporate seat allocation is full. Contact Eugym to expand your package.')
  }

  const { rows: exists } = await query('SELECT id FROM users WHERE email = $1', [body.email.toLowerCase()])
  if (exists.length) throw AppError.conflict('A user with this email already exists')

  // Staff are created with NO password and sent an activation link, the same
  // way POST /admin/members works.
  //
  // This previously generated a temporary password, hashed it, and sent a
  // welcome email that did not contain it — and never returned it to the
  // corporate admin either. The password existed only as a bcrypt hash, so
  // nobody could sign in to the account that had just been created for them.
  // The pattern was also Eugym@ plus four digits: a 9,000-value keyspace.
  const activationToken = randomToken(32)
  const activationHash  = hashToken(activationToken)
  const activationExp   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  const staff = await withTransaction(async (client) => {
    const r = await client.query<UserRow>(
      `INSERT INTO users (first_name,last_name,email,phone,password_hash,role,corporate_id,is_email_verified)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,false) RETURNING *`,
      [body.firstName, body.lastName, body.email.toLowerCase(), body.phone,
       body.tier, corporate_id],
    )
    const created = r.rows[0]

    await client.query(
      `INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,$3)`,
      [created.id, activationHash, activationExp],
    )
    return created
  })

  // Best-effort: a dead mailer must not fail a seat that was already created.
  // The admin can resend from the staff list if it does not arrive.
  emailService
    .sendAccountActivation(staff.email, staff.first_name, activationToken, body.tier)
    .catch(() => null)

  created(res, mapUser(staff as unknown as Record<string, unknown>), 'Invitation sent')
})

corporateRouter.patch('/staff/:userId', async (req: Request, res: Response) => {
  const { rows: me } = await query<UserRow>('SELECT corporate_id FROM users WHERE id = $1', [req.user!.id])
  const schema = z.object({ tier: z.enum(['standard','premium']).optional(), isActive: z.boolean().optional() })
  const body = schema.parse(req.body)

  const sets: string[] = [], vals: unknown[] = []
  if (body.tier)       { sets.push(`role = $${vals.push(body.tier)}`) }
  if (body.isActive !== undefined) { sets.push(`is_active = $${vals.push(body.isActive)}`) }
  if (!sets.length) throw AppError.badRequest('Nothing to update')

  vals.push(req.params.userId, me[0].corporate_id)
  const { rows } = await query<UserRow>(
    `UPDATE users SET ${sets.join(',')}
     WHERE id = $${vals.length - 1} AND corporate_id = $${vals.length} RETURNING *`,
    vals,
  )
  if (!rows.length) throw AppError.notFound('Staff member not found in your account')
  ok(res, mapUser(rows[0] as unknown as Record<string, unknown>))
})

corporateRouter.delete('/staff/:userId', async (req: Request, res: Response) => {
  const { rows: me } = await query<UserRow>('SELECT corporate_id FROM users WHERE id = $1', [req.user!.id])
  const { rows } = await query(
    `UPDATE users SET is_active = false, corporate_id = NULL
     WHERE id = $1 AND corporate_id = $2 RETURNING id`,
    [req.params.userId, me[0].corporate_id],
  )
  if (!rows.length) throw AppError.notFound('Staff member not found')
  ok(res, null, 'Staff member removed from corporate account')
})

corporateRouter.get('/reports', async (req: Request, res: Response) => {
  const { rows: me } = await query<UserRow>('SELECT corporate_id FROM users WHERE id = $1', [req.user!.id])
  const { month } = req.query as { month?: string }
  const target = month ?? `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`

  const { rows } = await query(
    `SELECT u.first_name, u.last_name, u.role,
            COUNT(b.id) as sessions,
            COUNT(b.id) FILTER (WHERE b.status = 'completed') as completed
     FROM users u
     LEFT JOIN bookings b ON b.user_id = u.id AND TO_CHAR(b.scheduled_at, 'YYYY-MM') = $1
     WHERE u.corporate_id = $2 AND u.is_active = true
     GROUP BY u.id, u.first_name, u.last_name, u.role
     ORDER BY sessions DESC`,
    [target, me[0].corporate_id],
  )
  ok(res, rows)
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AFFILIATE PARTNER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const affiliateRouter = Router()
affiliateRouter.use(authenticate, authorize('affiliate_partner'))

async function getAffiliateId(userId: string): Promise<string> {
  // affiliate_partner users are linked via the affiliates.contact_email matching users.email
  const { rows } = await query<UserRow & { affiliate_id?: string }>(
    `SELECT u.*, a.id as affiliate_id
     FROM users u
     JOIN affiliates a ON a.contact_email = u.email
     WHERE u.id = $1`,
    [userId],
  )
  if (!rows.length || !rows[0].affiliate_id) throw AppError.forbidden('No affiliate linked to this account')
  return rows[0].affiliate_id
}

affiliateRouter.get('/overview', async (req: Request, res: Response) => {
  const affiliateId = await getAffiliateId(req.user!.id)

  const [affiliate, monthVisits, totalEarned, pendingSettlement] = await Promise.all([
    query('SELECT * FROM affiliates WHERE id = $1', [affiliateId]),
    query(
      `SELECT COUNT(*) FROM affiliate_visits
       WHERE affiliate_id = $1 AND DATE_TRUNC('month', visited_at) = DATE_TRUNC('month', NOW())`,
      [affiliateId],
    ),
    query(
      `SELECT COALESCE(SUM(total_amount), 0) as total FROM settlements
       WHERE affiliate_id = $1 AND status = 'processed'`,
      [affiliateId],
    ),
    query(
      `SELECT COUNT(*) as visits FROM affiliate_visits WHERE affiliate_id = $1 AND settled = false`,
      [affiliateId],
    ),
  ])

  const rate = (affiliate.rows[0] as { rate_per_visit: number }).rate_per_visit
  const unsettledVisits = parseInt(pendingSettlement.rows[0].visits)

  ok(res, {
    affiliate:         affiliate.rows[0],
    monthVisits:       parseInt(monthVisits.rows[0].count),
    totalEarned:       parseInt(totalEarned.rows[0].total),
    pendingAmount:     unsettledVisits * rate,
    unsettledVisits,
  })
})

affiliateRouter.get('/visits', async (req: Request, res: Response) => {
  const affiliateId = await getAffiliateId(req.user!.id)
  const { page, limit, offset } = parsePagination(req.query)
  const { month } = req.query as { month?: string }

  let where = 'WHERE av.affiliate_id = $1'
  const params: unknown[] = [affiliateId]
  if (month) { params.push(month); where += ` AND TO_CHAR(av.visited_at, 'YYYY-MM') = $${params.length}` }

  params.push(limit, offset)
  const [{ rows }, { rows: cnt }] = await Promise.all([
    query(
      `SELECT av.id, av.visited_at, av.settled,
              CONCAT('EUG-P-', LPAD(SUBSTRING(av.user_id::text, 1, 5), 5, '0')) AS member_ref,
              c.name as centre_name
       FROM affiliate_visits av
       JOIN centres c ON c.id = av.centre_id
       ${where}
       ORDER BY av.visited_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query(`SELECT COUNT(*) FROM affiliate_visits av ${where}`, params.slice(0, -2)),
  ])

  paginated(res, rows, parseInt(cnt[0].count), page, limit)
})

affiliateRouter.get('/settlements', async (req: Request, res: Response) => {
  const affiliateId = await getAffiliateId(req.user!.id)
  const { rows } = await query(
    `SELECT * FROM settlements WHERE affiliate_id = $1 ORDER BY period_start DESC`,
    [affiliateId],
  )
  ok(res, rows)
})

// â”€â”€â”€ POST /affiliate/settlements/process (Super Admin only, via admin router) â”€
export async function processSettlement(affiliateId: string, month: string, adminUserId: string) {
  const { rows: visits } = await query(
    `SELECT COUNT(*) as count FROM affiliate_visits
     WHERE affiliate_id = $1 AND settled = false
       AND TO_CHAR(visited_at, 'YYYY-MM') = $2`,
    [affiliateId, month],
  )
  const visitCount = parseInt(visits[0].count)
  if (!visitCount) throw AppError.badRequest('No unsettled visits for this period')

  const { rows: aff } = await query('SELECT * FROM affiliates WHERE id = $1', [affiliateId])
  const rate        = (aff[0] as { rate_per_visit: number }).rate_per_visit
  const totalAmount = visitCount * rate

  const [y, m] = month.split('-').map(Number)
  const periodStart = new Date(y, m - 1, 1)
  const periodEnd   = new Date(y, m, 0)

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO settlements (affiliate_id, period_start, period_end, visit_count, rate, total_amount, status, processed_by, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'processed',$7,NOW()) RETURNING id`,
      [affiliateId, periodStart, periodEnd, visitCount, rate, totalAmount, adminUserId],
    )
    const settlementId = rows[0].id
    await client.query(
      `UPDATE affiliate_visits SET settled = true, settlement_id = $1
       WHERE affiliate_id = $2 AND settled = false AND TO_CHAR(visited_at, 'YYYY-MM') = $3`,
      [settlementId, affiliateId, month],
    )
  })

  // Notify affiliate
  emailService.sendSettlementNotice(
    aff[0].contact_email, aff[0].name, month, visitCount, totalAmount,
  ).catch(() => null)

  return { visitCount, totalAmount }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MERCHANDISE & ORDERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
export const merchandiseRouter = Router()

merchandiseRouter.get('/', async (req: Request, res: Response) => {
  const { category } = req.query as { category?: string }
  const { page, limit, offset } = parsePagination(req.query)

  let where = `WHERE p.status = 'active'`
  const params: unknown[] = []
  if (category) { params.push(category); where += ` AND p.category = $${params.length}` }
  params.push(limit, offset)

  const [{ rows }, { rows: cnt }] = await Promise.all([
    query(
      `SELECT p.*, json_agg(pv.*) FILTER (WHERE pv.id IS NOT NULL) AS variants
       FROM products p
       LEFT JOIN product_variants pv ON pv.product_id = p.id
       ${where}
       GROUP BY p.id ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query(`SELECT COUNT(*) FROM products p ${where}`, params.slice(0, -2)),
  ])

  paginated(
    res,
    rows.map(r => mapProduct(r as unknown as Record<string, unknown>)),
    parseInt(cnt[0].count),
    page,
    limit,
  )
})

merchandiseRouter.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT p.*, json_agg(pv.*) FILTER (WHERE pv.id IS NOT NULL) AS variants
     FROM products p
     LEFT JOIN product_variants pv ON pv.product_id = p.id
     WHERE p.id = $1 GROUP BY p.id`,
    [req.params.id],
  )
  if (!rows.length) throw AppError.notFound('Product not found')
  ok(res, mapProduct(rows[0] as unknown as Record<string, unknown>))
})

// â”€â”€â”€ Orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const ordersRouter = Router()

ordersRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT o.*, json_agg(json_build_object(
       'id', oi.id, 'productId', oi.product_id, 'variantId', oi.variant_id,
       'quantity', oi.quantity, 'unitPrice', oi.unit_price, 'total', oi.total,
       'productName', p.name
     )) AS items
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     WHERE o.user_id = $1
     GROUP BY o.id ORDER BY o.created_at DESC`,
    [req.user!.id],
  )
  ok(res, rows)
})

ordersRouter.get('/:id', async (req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT o.*, json_agg(json_build_object(
       'id', oi.id, 'productId', oi.product_id,
       'quantity', oi.quantity, 'unitPrice', oi.unit_price, 'total', oi.total,
       'productName', p.name, 'productImages', p.images
     )) AS items
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     WHERE o.id = $1 GROUP BY o.id`,
    [req.params.id],
  )
  if (!rows.length) throw AppError.notFound('Order not found')
  ok(res, rows[0])
})

const orderItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity:  z.number().int().min(1).max(100),
})

ordersRouter.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    firstName: z.string().min(2),
    lastName:  z.string().min(2),
    email:     z.string().email(),
    phone:     z.string().min(10),
    address:   z.string().min(5),
    city:      z.string().min(2),
    state:     z.string().min(2),
    items:     z.array(orderItemSchema).min(1),
  })
  const body = schema.parse(req.body)

  // Validate products and calculate totals
  let subtotal = 0
  const lineItems: { product: ProductRow; variantId?: string; qty: number; unitPrice: number }[] = []

  for (const item of body.items) {
    const { rows } = await query<ProductRow>(
      `SELECT * FROM products WHERE id = $1 AND status = 'active'`, [item.productId],
    )
    if (!rows.length) throw AppError.notFound(`Product ${item.productId} not found`)
    const product = rows[0]

    let unitPrice = product.price
    if (item.variantId) {
      const { rows: vRows } = await query(
        'SELECT * FROM product_variants WHERE id = $1 AND product_id = $2',
        [item.variantId, item.productId],
      )
      if (!vRows.length) throw AppError.notFound('Variant not found')
      unitPrice += (vRows[0] as { price_modifier: number }).price_modifier
    }

    const availableStock = item.variantId
      ? (await query('SELECT stock FROM product_variants WHERE id = $1', [item.variantId])).rows[0]?.stock ?? 0
      : product.stock

    if (availableStock < item.quantity) {
      throw AppError.conflict(`Insufficient stock for "${product.name}"`)
    }

    subtotal += unitPrice * item.quantity
    lineItems.push({ product, variantId: item.variantId, qty: item.quantity, unitPrice })
  }

  const deliveryFee = 2000 // â‚¦2,000 flat rate
  const total       = subtotal + deliveryFee

  const userId = (req as { user?: { id: string } }).user?.id ?? null

  const order = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO orders (user_id,guest_email,guest_phone,first_name,last_name,address,city,state,subtotal,delivery_fee,total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [userId, userId ? null : body.email, userId ? null : body.phone,
       body.firstName, body.lastName, body.address, body.city, body.state,
       subtotal, deliveryFee, total],
    )
    const order = rows[0]

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO order_items (order_id,product_id,variant_id,quantity,unit_price,total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, li.product.id, li.variantId ?? null, li.qty, li.unitPrice, li.unitPrice * li.qty],
      )
      // Stock is NOT taken here. It is decremented when Paystack confirms the
      // charge, in the webhook's order branch. Taking it at checkout meant every
      // abandoned cart permanently destroyed inventory that was never sold.
    }

    // Paystack init
    if (!paystackConfigured) {
      throw AppError.badRequest(
        'Payments are not available yet. Please contact support to complete this order.',
      )
    }

    const axios = (await import('axios')).default
    const { data } = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email:    body.email,
        amount:   total * 100,
        currency: 'NGN',
        callback_url: `${env.FRONTEND_URL}/store/order-success`,
        metadata: { orderId: order.id, type: 'order' },
      },
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
    )

    await client.query(
      `INSERT INTO payments (user_id, order_id, amount, method, paystack_ref)
       VALUES ($1,$2,$3,'card',$4)`,
      [userId, order.id, total, data.data.reference],
    )
    await client.query(
      `UPDATE orders SET paystack_ref = $1 WHERE id = $2`,
      [data.data.reference, order.id],
    )

    return { order, paymentUrl: data.data.authorization_url }
  })

  // Send order confirmation (async)
  emailService.sendOrderConfirmation(
    body.email, body.firstName, order.order.id,
    lineItems.map(li => ({ name: li.product.name, qty: li.qty, price: li.unitPrice })),
    total,
  ).catch(() => null)

  created(res, { orderId: order.order.id, paymentUrl: order.paymentUrl })
})
