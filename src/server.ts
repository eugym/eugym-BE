import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import morgan from 'morgan'

import { env, isDev } from './config/env'
import { logger } from './config/logger'
import { connectDB } from './db/pool'
import { errorHandler, globalLimiter, requestLogger } from './middleware'

// Routers
import { authRouter }          from './modules/auth/auth.router'
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.router'
import {
  classesRouter, bookingsRouter, trainersRouter,
  centresRouter, visitsRouter, usersRouter,
} from './modules/core.router'
import {
  corporateRouter, affiliateRouter,
  merchandiseRouter, ordersRouter,
} from './modules/extra.router'
import { adminRouter } from './modules/admin/admin.router'

// Background jobs
import { startAllJobs } from './jobs'

const app = express()

// ─── Trust proxy (for accurate IPs behind Nginx/load balancer) ───────────────
app.set('trust proxy', 1)

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Handled by frontend
}))

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error(`CORS: ${origin} not allowed`))
  },
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-paystack-signature'],
}))

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression())

// ─── Body parsing ─────────────────────────────────────────────────────────────
// Raw body needed for Paystack webhook signature verification
app.use('/api/v1/subscriptions/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ─── Request logging ──────────────────────────────────────────────────────────
if (isDev) {
  app.use(morgan('dev'))
} else {
  app.use(requestLogger)
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
app.use(globalLimiter)

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'eugym-api',
    version:   '1.0.0',
    env:       env.NODE_ENV,
    timestamp: new Date().toISOString(),
  })
})

// ─── API Routes ───────────────────────────────────────────────────────────────
const API = env.API_PREFIX

app.use(`${API}/auth`,          authRouter)
app.use(`${API}/users`,         usersRouter)
app.use(`${API}/subscriptions`, subscriptionsRouter)
app.use(`${API}/classes`,       classesRouter)
app.use(`${API}/bookings`,      bookingsRouter)
app.use(`${API}/trainers`,      trainersRouter)
app.use(`${API}/centres`,       centresRouter)
app.use(`${API}/visits`,        visitsRouter)
app.use(`${API}/corporate`,     corporateRouter)
app.use(`${API}/affiliate`,     affiliateRouter)
app.use(`${API}/products`,      merchandiseRouter)
app.use(`${API}/orders`,        ordersRouter)
app.use(`${API}/admin`,         adminRouter)

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, data: null, message: 'Route not found' })
})

// ─── Global error handler (must be last) ─────────────────────────────────────
app.use(errorHandler)

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await connectDB()
    startAllJobs()

    const server = app.listen(env.PORT, () => {
      logger.info('')
      logger.info('╔══════════════════════════════════════════════╗')
      logger.info('║        🏋️  EUGYM FITNESS API                 ║')
      logger.info('╠══════════════════════════════════════════════╣')
      logger.info(`║  Port    : ${env.PORT}                              ║`)
      logger.info(`║  Env     : ${env.NODE_ENV.padEnd(10)}                    ║`)
      logger.info(`║  Prefix  : ${env.API_PREFIX.padEnd(16)}               ║`)
      logger.info(`║  Health  : http://localhost:${env.PORT}/health       ║`)
      logger.info('╚══════════════════════════════════════════════╝')
      logger.info('')
    })

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received — shutting down gracefully…`)
      server.close(async () => {
        const { pool } = await import('./db/pool')
        await pool.end()
        logger.info('Database pool closed. Goodbye.')
        process.exit(0)
      })
      setTimeout(() => process.exit(1), 10_000)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT',  () => shutdown('SIGINT'))

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: String(reason) })
    })
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { error: err.message, stack: err.stack })
      process.exit(1)
    })

  } catch (err: unknown) {
    logger.error('Fatal startup error', { error: (err as Error).message })
    process.exit(1)
  }
}

bootstrap()

export default app
