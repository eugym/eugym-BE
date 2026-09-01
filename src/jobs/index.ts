import cron from 'node-cron'
import { query, withTransaction } from '../db/pool'
import { logger } from '../config/logger'
import { emailService } from '../lib/email'
import { processSettlement } from '../modules/extra.router'
import type { UserRow, SubscriptionRow } from '../types'

// ─── Job 1: Expire subscriptions (runs daily at 00:05) ───────────────────────
export function scheduleSubscriptionExpiry() {
  cron.schedule('5 0 * * *', async () => {
    logger.info('[CRON] Running subscription expiry check…')
    try {
      // Mark expired
      const { rows: expired } = await query<SubscriptionRow & { email: string; first_name: string }>(
        `UPDATE subscriptions s
         SET status = 'expired'
         FROM users u
         WHERE s.user_id = u.id
           AND s.status = 'active'
           AND s.end_date < CURRENT_DATE
         RETURNING s.*, u.email, u.first_name, u.id as uid`,
      )

      for (const sub of expired) {
        // Downgrade user role
        await query(`UPDATE users SET role = 'regular' WHERE id = $1`, [sub.user_id])
        logger.info(`Expired subscription for user ${sub.user_id} (${sub.tier})`)
      }

      // Send 7-day renewal reminder
      const { rows: expiring7 } = await query<SubscriptionRow & UserRow>(
        `SELECT s.*, u.email, u.first_name
         FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE s.status = 'active'
           AND s.end_date = CURRENT_DATE + INTERVAL '7 days'
           AND s.auto_renew = false`,
      )
      for (const sub of expiring7) {
        emailService.sendSubscriptionExpiring(sub.email, sub.first_name, 7, sub.tier).catch(() => null)
      }

      // Send 3-day reminder
      const { rows: expiring3 } = await query<SubscriptionRow & UserRow>(
        `SELECT s.*, u.email, u.first_name
         FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE s.status = 'active'
           AND s.end_date = CURRENT_DATE + INTERVAL '3 days'
           AND s.auto_renew = false`,
      )
      for (const sub of expiring3) {
        emailService.sendSubscriptionExpiring(sub.email, sub.first_name, 3, sub.tier).catch(() => null)
      }

      // Send 1-day reminder
      const { rows: expiring1 } = await query<SubscriptionRow & UserRow>(
        `SELECT s.*, u.email, u.first_name
         FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE s.status = 'active'
           AND s.end_date = CURRENT_DATE + INTERVAL '1 day'`,
      )
      for (const sub of expiring1) {
        emailService.sendSubscriptionExpiring(sub.email, sub.first_name, 1, sub.tier).catch(() => null)
      }

      logger.info(`[CRON] Expiry check done — ${expired.length} expired, ${expiring7.length + expiring3.length + expiring1.length} reminders sent`)
    } catch (err: unknown) {
      logger.error('[CRON] Subscription expiry job failed', { error: (err as Error).message })
    }
  }, { timezone: 'Africa/Lagos' })

  logger.info('✅ Subscription expiry cron scheduled (daily 00:05 WAT)')
}

// ─── Job 2: Monthly affiliate settlement (runs on 1st of each month at 01:00) ─
export function scheduleMonthlySettlement() {
  cron.schedule('0 1 1 * *', async () => {
    logger.info('[CRON] Running monthly affiliate settlement…')
    try {
      const now   = new Date()
      const month = `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}` // previous month

      const { rows: affiliates } = await query(
        `SELECT DISTINCT affiliate_id FROM affiliate_visits
         WHERE settled = false AND TO_CHAR(visited_at, 'YYYY-MM') = $1`,
        [month],
      )

      // Use system admin ID for automated processing
      const { rows: sysAdmin } = await query(
        `SELECT id FROM users WHERE role = 'super_admin' AND is_active = true LIMIT 1`,
      )
      const adminId = sysAdmin[0]?.id

      for (const { affiliate_id } of affiliates) {
        try {
          const result = await processSettlement(affiliate_id, month, adminId)
          logger.info(`[CRON] Settled ${affiliate_id}: ${result.visitCount} visits, ₦${result.totalAmount.toLocaleString()}`)
        } catch (err: unknown) {
          logger.error(`[CRON] Settlement failed for ${affiliate_id}`, { error: (err as Error).message })
        }
      }

      logger.info(`[CRON] Monthly settlement done — ${affiliates.length} affiliates processed`)
    } catch (err: unknown) {
      logger.error('[CRON] Monthly settlement job failed', { error: (err as Error).message })
    }
  }, { timezone: 'Africa/Lagos' })

  logger.info('✅ Monthly settlement cron scheduled (1st of month 01:00 WAT)')
}

// ─── Job 3: Clean up expired tokens (weekly Sunday 02:00) ────────────────────
export function scheduleTokenCleanup() {
  cron.schedule('0 2 * * 0', async () => {
    logger.info('[CRON] Cleaning up expired tokens…')
    try {
      const [r1, r2, r3] = await Promise.all([
        query(`DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL RETURNING id`),
        query(`DELETE FROM email_verifications WHERE expires_at < NOW() RETURNING id`),
        query(`DELETE FROM password_resets WHERE expires_at < NOW() RETURNING id`),
      ])
      logger.info(`[CRON] Token cleanup: ${r1.rowCount} refresh, ${r2.rowCount} email, ${r3.rowCount} reset tokens purged`)
    } catch (err: unknown) {
      logger.error('[CRON] Token cleanup failed', { error: (err as Error).message })
    }
  }, { timezone: 'Africa/Lagos' })

  logger.info('✅ Token cleanup cron scheduled (weekly Sunday 02:00 WAT)')
}

// ─── Job 4: Update out-of-stock product statuses (daily 00:10) ───────────────
export function scheduleStockCheck() {
  cron.schedule('10 0 * * *', async () => {
    await query(`UPDATE products SET status = 'out_of_stock' WHERE stock = 0 AND status = 'active'`)
    await query(`UPDATE products SET status = 'active' WHERE stock > 0 AND status = 'out_of_stock'`)
    logger.info('[CRON] Stock status check complete')
  }, { timezone: 'Africa/Lagos' })
}

// ─── Start all jobs ───────────────────────────────────────────────────────────
export function startAllJobs() {
  scheduleSubscriptionExpiry()
  scheduleMonthlySettlement()
  scheduleTokenCleanup()
  scheduleStockCheck()
  logger.info('✅ All background jobs initialised')
}
