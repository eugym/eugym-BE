import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { env } from '../config/env'
import { logger } from '../config/logger'

export const pool = new Pool({
  host:     env.DB_HOST,
  port:     env.DB_PORT,
  database: env.DB_NAME,
  user:     env.DB_USER,
  password: env.DB_PASSWORD,
  ssl:      env.DB_SSL ? { rejectUnauthorized: false } : false,
  min:      env.DB_POOL_MIN,
  max:      env.DB_POOL_MAX,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  logger.error('Unexpected PG pool error', { error: err.message })
})

// ─── Typed query wrapper ───────────────────────────────────────────────────────
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now()
  try {
    const result = await pool.query<T>(text, params)
    const duration = Date.now() - start
    if (duration > 1000) {
      logger.warn('Slow query detected', { text: text.slice(0, 120), duration, rows: result.rowCount })
    }
    return result
  } catch (err: unknown) {
    logger.error('DB query error', { text: text.slice(0, 120), error: (err as Error).message })
    throw err
  }
}

// ─── Transaction helper ────────────────────────────────────────────────────────
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── Connection check ─────────────────────────────────────────────────────────
export async function connectDB(): Promise<void> {
  try {
    const client = await pool.connect()
    const { rows } = await client.query('SELECT NOW() as now, current_database() as db')
    client.release()
    logger.info(`✅ PostgreSQL connected — db: ${rows[0].db} at ${rows[0].now}`)
  } catch (err: unknown) {
    logger.error('❌ PostgreSQL connection failed', { error: (err as Error).message })
    throw err
  }
}
