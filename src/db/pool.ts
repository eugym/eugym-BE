import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { env } from '../config/env'
import { logger } from '../config/logger'

// Managed Postgres (Supabase, Neon, Render) terminates TLS with a certificate
// chain Node does not ship a root for, so verification is disabled while the
// connection itself stays encrypted.
const ssl = env.DB_SSL ? { rejectUnauthorized: false } : false

// A single URI wins over the discrete DB_* fields when provided.
const connection = env.DATABASE_URL
  ? { connectionString: env.DATABASE_URL }
  : {
      host:     env.DB_HOST,
      port:     env.DB_PORT,
      database: env.DB_NAME,
      user:     env.DB_USER,
      password: env.DB_PASSWORD,
    }

export const pool = new Pool({
  ...connection,
  ssl,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  // Managed providers sit behind a pooler and a cold one can take a few
  // seconds to answer; 5s produced spurious boot failures on first deploy.
  connectionTimeoutMillis: 15_000,
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
/**
 * Where we are actually dialling, with the password removed.
 *
 * A bare "connection timeout" gives no way to tell a wrong host from an
 * unreachable one, and the credentials live in a provider dashboard rather than
 * in the repo — so the log has to say what it tried.
 */
function describeTarget(): { host: string; port: string; database: string; ssl: boolean } {
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL)
      return {
        host: u.hostname,
        port: u.port || '5432',
        database: u.pathname.replace(/^\//, '') || '(default)',
        ssl: Boolean(env.DB_SSL),
      }
    } catch {
      return { host: '(unparseable DATABASE_URL)', port: '?', database: '?', ssl: Boolean(env.DB_SSL) }
    }
  }
  return {
    host: env.DB_HOST,
    port: String(env.DB_PORT),
    database: env.DB_NAME ?? '(unset)',
    ssl: Boolean(env.DB_SSL),
  }
}

/** Turn the common managed-Postgres failures into the actual next action. */
function diagnose(message: string, host: string): string | null {
  const timedOut = /timeout|ETIMEDOUT/i.test(message)
  const unreachable = /ENETUNREACH|EHOSTUNREACH/i.test(message)

  if ((timedOut || unreachable) && /^db\..*\.supabase\.co$/.test(host)) {
    return "This is Supabase's Direct connection, which is IPv6-only. Render dials IPv4 and can never reach it. Use the Session pooler string instead — host aws-<region>.pooler.supabase.com, user postgres.<project-ref>."
  }
  // Supabase's pooler answers with this when the username lacks the project ref.
  if (/tenant.user .* not found|Tenant or user not found/i.test(message)) {
    return 'The pooler rejected the username. It must be postgres.<project-ref>, not postgres — copy the URI from Supabase rather than assembling it.'
  }
  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    return 'Hostname did not resolve. Check for a typo, and that the project still exists and is not paused.'
  }
  if (timedOut || unreachable) {
    return 'Host unreachable. Check the hostname, that the database is not paused, and that its network rules allow this service.'
  }
  if (/no pg_hba\.conf entry|does not support SSL/i.test(message)) {
    return 'TLS mismatch. Managed Postgres requires SSL — set DB_SSL=true.'
  }
  if (/password authentication failed/i.test(message)) {
    return 'Credentials rejected. On Supabase the pooler username is postgres.<project-ref>, not postgres, and a password containing reserved characters must be percent-encoded inside the URI.'
  }
  return null
}

export async function connectDB(): Promise<void> {
  const target = describeTarget()

  try {
    const client = await pool.connect()
    const { rows } = await client.query('SELECT NOW() as now, current_database() as db')
    client.release()
    logger.info(`✅ PostgreSQL connected — db: ${rows[0].db} at ${rows[0].now}`)
  } catch (err: unknown) {
    const message = (err as Error).message
    logger.error('❌ PostgreSQL connection failed', {
      error: message,
      target: `${target.host}:${target.port}/${target.database}`,
      ssl: target.ssl,
      via: env.DATABASE_URL ? 'DATABASE_URL' : 'DB_* variables',
    })

    const hint = diagnose(message, target.host)
    if (hint) logger.error(`   -> ${hint}`)

    throw err
  }
}
