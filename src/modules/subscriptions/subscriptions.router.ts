import { Router, Request, Response } from 'express'
import axios from 'axios'
import { z } from 'zod'
import { query, withTransaction } from '../../db/pool'
import { env } from '../../config/env'
import { AppError, mapSubscription, SUBSCRIPTION_PRICES, DURATION_DAYS, calculateProRata } from '../../utils'
import { authenticate, authorize, validate, verifyPaystackWebhook } from '../../middleware'
import { ok } from '../../utils'
import { emailService } from '../../lib/email'
import type { SubscriptionRow, UserRow } from '../../types'
import { logger } from "../../config/logger"

export const subscriptionsRouter = Router()

// ─── Schemas ─────────────────────────────────────────────────────────────────
const createSchema = z.object({
  tier:     z.enum(['standard', 'premium']),
  duration: z.enum(['daily','weekly','monthly','quarterly','biannual','annual']),
  centreId: z.string().uuid().optional(),
})

const upgradeSchema = z.object({
  tier:     z.enum(['standard', 'premium']),
  duration: z.enum(['daily','weekly','monthly','quarterly','biannual','annual']),
})

// ─── Paystack helpers ─────────────────────────────────────────────────────────
async function initializePaystack(
  email: string,
  amountKobo: number,
  metadata: Record<string, unknown>,
): Promise<{ reference: string; authorizationUrl: string }> {
  const { data } = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email,
      amount: amountKobo,
      currency: 'NGN',
      callback_url: `${env.FRONTEND_URL}/payment/callback`,
      metadata,
    },
    { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
  )
  return { reference: data.data.reference, authorizationUrl: data.data.authorization_url }
}

// ─── GET /subscriptions/current ──────────────────────────────────────────────
subscriptionsRouter.get('/current', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [req.user!.id],
  )
  ok(res, rows[0] ? mapSubscription(rows[0] as unknown as Record<string, unknown>) : null)
})

// ─── GET /subscriptions/history ───────────────────────────────────────────────
subscriptionsRouter.get('/history', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user!.id],
  )
  ok(res, rows.map(r => mapSubscription(r as unknown as Record<string, unknown>)))
})

// ─── POST /subscriptions ─────────────────────────────────────────────────────
subscriptionsRouter.post('/', authenticate, validate(createSchema), async (req: Request, res: Response) => {
  const { tier, duration, centreId } = req.body as z.infer<typeof createSchema>

  if (tier === 'standard' && !centreId) {
    throw AppError.badRequest('centreId is required for Standard plan')
  }

  // Check no existing active subscription
  const { rows: existing } = await query(
    `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
    [req.user!.id],
  )
  if (existing.length) {
    throw AppError.conflict('You already have an active subscription. Use upgrade instead.')
  }

  const priceKobo = SUBSCRIPTION_PRICES[tier]?.[duration]
  if (!priceKobo) throw AppError.badRequest('Invalid plan combination')

  const { rows: userRows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  const user = userRows[0]

  // Create pending subscription
  const { rows: subRows } = await query<SubscriptionRow>(
    `INSERT INTO subscriptions (user_id, tier, duration, status, amount_paid, centre_id)
     VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *`,
    [req.user!.id, tier, duration, priceKobo / 100, centreId ?? null],
  )
  const sub = subRows[0]

  // Initialize Paystack
  const { reference, authorizationUrl } = await initializePaystack(
    user.email,
    priceKobo,
    { subscriptionId: sub.id, type: 'subscription', tier, duration },
  )

  // Store reference
  await query('UPDATE subscriptions SET paystack_ref = $1 WHERE id = $2', [reference, sub.id])
  await query(
    `INSERT INTO payments (user_id, subscription_id, amount, method, paystack_ref)
     VALUES ($1, $2, $3, 'card', $4)`,
    [req.user!.id, sub.id, priceKobo / 100, reference],
  )

  ok(res, { paymentUrl: authorizationUrl, reference })
})

// ─── POST /subscriptions/upgrade ─────────────────────────────────────────────
subscriptionsRouter.post('/upgrade', authenticate, validate(upgradeSchema), async (req: Request, res: Response) => {
  const { tier, duration } = req.body as z.infer<typeof upgradeSchema>

  const { rows } = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [req.user!.id],
  )
  if (!rows.length) throw AppError.badRequest('No active subscription to upgrade')

  const current = rows[0]
  const proRataCredit  = calculateProRata(
    current.end_date!,
    current.amount_paid,
    current.duration,
  )
  const newPriceKobo   = SUBSCRIPTION_PRICES[tier]?.[duration]
  if (!newPriceKobo) throw AppError.badRequest('Invalid plan combination')

  const chargeKobo     = Math.max(0, newPriceKobo - proRataCredit * 100)
  const { rows: userRows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])
  const user = userRows[0]

  if (chargeKobo === 0) {
    // Free upgrade - activate immediately
    const days     = DURATION_DAYS[duration]
    const startDate = new Date()
    const endDate   = new Date(Date.now() + days * 86_400_000)

    await withTransaction(async (client) => {
      await client.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [current.id])
      await client.query(
        `INSERT INTO subscriptions (user_id, tier, duration, status, start_date, end_date, amount_paid)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
        [req.user!.id, tier, duration, startDate, endDate, 0],
      )
      await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [tier, req.user!.id])
    })
    ok(res, { proRataCredit, newTotal: 0, paymentUrl: null })
    return
  }

  const { rows: newSubRows } = await query<SubscriptionRow>(
    `INSERT INTO subscriptions (user_id, tier, duration, status, amount_paid)
     VALUES ($1, $2, $3, 'pending', $4) RETURNING *`,
    [req.user!.id, tier, duration, chargeKobo / 100],
  )
  const newSub = newSubRows[0]

  const { reference, authorizationUrl } = await initializePaystack(
    user.email,
    chargeKobo,
    { subscriptionId: newSub.id, previousSubId: current.id, type: 'upgrade', tier, duration },
  )
  await query('UPDATE subscriptions SET paystack_ref = $1 WHERE id = $2', [reference, newSub.id])
  await query(
    `INSERT INTO payments (user_id, subscription_id, amount, method, paystack_ref)
     VALUES ($1, $2, $3, 'card', $4)`,
    [req.user!.id, newSub.id, chargeKobo / 100, reference],
  )

  ok(res, { proRataCredit, newTotal: chargeKobo / 100, paymentUrl: authorizationUrl })
})

// ─── POST /subscriptions/cancel ──────────────────────────────────────────────
subscriptionsRouter.post('/cancel', authenticate, async (req: Request, res: Response) => {
  const { rows } = await query(
    `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW()
     WHERE user_id = $1 AND status = 'active' RETURNING id`,
    [req.user!.id],
  )
  if (!rows.length) throw AppError.notFound('No active subscription to cancel')
  await query(`UPDATE users SET role = 'regular' WHERE id = $1`, [req.user!.id])
  ok(res, null, 'Subscription cancelled. Access continues until the end of your billing period.')
})

// ─── PATCH /subscriptions/auto-renew ─────────────────────────────────────────
subscriptionsRouter.patch('/auto-renew', authenticate, async (req: Request, res: Response) => {
  const { autoRenew } = z.object({ autoRenew: z.boolean() }).parse(req.body)
  const { rows } = await query<SubscriptionRow>(
    `UPDATE subscriptions SET auto_renew = $1
     WHERE user_id = $2 AND status = 'active' RETURNING *`,
    [autoRenew, req.user!.id],
  )
  if (!rows.length) throw AppError.notFound('No active subscription')
  ok(res, mapSubscription(rows[0] as unknown as Record<string, unknown>))
})

// ─── POST /subscriptions/webhook (Paystack) ───────────────────────────────────
subscriptionsRouter.post('/webhook', verifyPaystackWebhook, async (req: Request, res: Response) => {
  const { event, data } = req.body as {
    event: string
    data: {
      reference: string
      amount: number
      metadata: {
        type: string
        subscriptionId?: string
        previousSubId?: string
        orderId?: string
        tier?: string
        duration?: string
      }
    }
  }

  res.status(200).json({ received: true }) // acknowledge immediately

  if (event !== 'charge.success') return

  const { reference, amount, metadata } = data
  const { subscriptionId, previousSubId, tier, duration, orderId } = metadata

  /*
   * Merchandise charges used to fall through to the subscription path with
   * subscriptionId undefined, so the UPDATE matched no row: the customer paid,
   * the order stayed pending_payment forever, and nothing marked it fulfilled.
   * Stock, meanwhile, had already been taken at checkout.
   */
  if (metadata.type === 'order') {
    if (!orderId) {
      logger.error('Order charge carried no orderId', { reference })
      return
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments SET status = 'success', paid_at = NOW(), paystack_data = $1
         WHERE paystack_ref = $2`,
        [JSON.stringify(data), reference],
      )

      const { rows: orderRows } = await client.query(
        `UPDATE orders SET status = 'processing'
         WHERE id = $1 AND status = 'pending_payment' RETURNING *`,
        [orderId],
      )

      // Guarded by the status check above, so a replayed webhook cannot
      // decrement the same order's stock twice.
      if (!orderRows.length) return

      const { rows: items } = await client.query(
        'SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = $1',
        [orderId],
      )

      for (const item of items) {
        if (item.variant_id) {
          await client.query(
            'UPDATE product_variants SET stock = GREATEST(stock - $1, 0) WHERE id = $2',
            [item.quantity, item.variant_id],
          )
        } else {
          await client.query(
            'UPDATE products SET stock = GREATEST(stock - $1, 0) WHERE id = $2',
            [item.quantity, item.product_id],
          )
        }
      }
    })
    return
  }

  if (!subscriptionId) {
    logger.error('Subscription charge carried no subscriptionId', { reference })
    return
  }

  await withTransaction(async (client) => {
    // Update payment record
    await client.query(
      `UPDATE payments SET status = 'success', paid_at = NOW(), paystack_data = $1
       WHERE paystack_ref = $2`,
      [JSON.stringify(data), reference],
    )

    // Activate subscription
    const days      = DURATION_DAYS[duration ?? 'monthly']
    const startDate = new Date()
    const endDate   = new Date(Date.now() + days * 86_400_000)

    await client.query(
      `UPDATE subscriptions
       SET status = 'active', start_date = $1, end_date = $2, amount_paid = $3
       WHERE id = $4`,
      [startDate, endDate, amount / 100, subscriptionId],
    )

    // Cancel previous if upgrade
    if (previousSubId) {
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
        [previousSubId],
      )
    }

    // Update user role
    const { rows: subRows } = await client.query<SubscriptionRow>(
      'SELECT user_id FROM subscriptions WHERE id = $1', [subscriptionId],
    )
    if (subRows.length) {
      await client.query(
        `UPDATE users SET role = $1 WHERE id = $2`,
        [tier ?? 'standard', subRows[0].user_id],
      )

      // Get user for email
      const { rows: userRows } = await client.query<UserRow>(
        'SELECT * FROM users WHERE id = $1', [subRows[0].user_id],
      )
      if (userRows.length) {
        const user = userRows[0]
        emailService.sendSubscriptionConfirmation(
          user.email, `${user.first_name}`, tier ?? "standard", duration ?? "monthly", endDate,
        ).catch(() => null)
      }
    }
  })
})

// ─── POST /subscriptions/confirm-pos (Admin) ──────────────────────────────────
subscriptionsRouter.post(
  '/confirm-pos/:paymentId',
  authenticate,
  authorize('admin', 'super_admin'),
  async (req: Request, res: Response) => {
    const { paymentId } = req.params
    const { rows: payRows } = await query(
      'SELECT * FROM payments WHERE id = $1 AND method = $2 AND status = $3',
      [paymentId, 'pos', 'pending'],
    )
    if (!payRows.length) throw AppError.notFound('POS payment not found or already processed')

    const payment = payRows[0] as { subscription_id: string; user_id: string; amount: number }
    const { rows: subRows } = await query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = $1', [payment.subscription_id],
    )
    if (!subRows.length) throw AppError.notFound('Subscription not found')
    const sub = subRows[0]

    const days    = DURATION_DAYS[sub.duration]
    const endDate = new Date(Date.now() + days * 86_400_000)

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments SET status = 'success', paid_at = NOW(), pos_confirmed_by = $1 WHERE id = $2`,
        [req.user!.id, paymentId],
      )
      await client.query(
        `UPDATE subscriptions SET status = 'active', start_date = NOW(), end_date = $1 WHERE id = $2`,
        [endDate, sub.id],
      )
      await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [sub.tier, sub.user_id])
    })
    ok(res, null, 'POS payment confirmed and subscription activated')
  },
)
