import { z } from 'zod'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

// z.coerce.boolean() treats any non-empty string as true — "false" included.
// Parse the literal strings instead.
const boolFromString = z.preprocess(
  (v) => (typeof v === 'string' ? ['true', '1', 'yes', 'on'].includes(v.toLowerCase()) : v),
  z.boolean(),
)

const envSchema = z.object({
  NODE_ENV:   z.enum(['development', 'production', 'test']).default('development'),
  PORT:       z.coerce.number().default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  // Database
  //
  // Managed providers (Supabase, Render, Neon, Railway) hand out a single
  // connection URI, not five discrete values. When DATABASE_URL is set it wins
  // and the DB_* fields below are ignored — decomposing a URI by hand is where
  // these deployments usually break, because the pooler username contains a dot
  // (postgres.<project-ref>) and passwords often need percent-encoding.
  DATABASE_URL: z.string().url().optional(),

  // Optional because DATABASE_URL can supply all of them. The refinement
  // below enforces that one form or the other is complete.
  DB_HOST:     z.string().default('localhost'),
  DB_PORT:     z.coerce.number().default(5432),
  DB_NAME:     z.string().optional(),
  DB_USER:     z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_SSL:      boolFromString.default(false),
  DB_POOL_MIN: z.coerce.number().default(2),
  DB_POOL_MAX: z.coerce.number().default(10),

  // JWT
  JWT_ACCESS_SECRET:  z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES:  z.string().default('15m'),
  JWT_REFRESH_EXPIRES: z.string().default('7d'),

  // Security
  BCRYPT_ROUNDS: z.coerce.number().default(12),

  // When true, users must click the emailed verification link before they can
  // sign in. Requires working SMTP — keep false until SMTP_* are real.
  REQUIRE_EMAIL_VERIFICATION: boolFromString.default(false),

  // Failed sign-in/sign-up attempts allowed per IP per minute. Successful ones
  // are not counted. Raise it in development where you retry constantly.
  AUTH_RATE_LIMIT: z.coerce.number().default(10),

  // Paystack
  PAYSTACK_SECRET_KEY:    z.string(),
  PAYSTACK_PUBLIC_KEY:    z.string(),
  PAYSTACK_WEBHOOK_SECRET: z.string(),

  // Email
  SMTP_HOST:      z.string().default('smtp.sendgrid.net'),
  SMTP_PORT:      z.coerce.number().default(587),
  SMTP_USER:      z.string(),
  SMTP_PASS:      z.string(),
  EMAIL_FROM:     z.string().email().default('noreply@eugym.ng'),
  EMAIL_FROM_NAME: z.string().default('Eugym Fitness'),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY:    z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Frontend
  FRONTEND_URL:    z.string().url().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // Business
  AFFILIATE_RATE_PER_VISIT: z.coerce.number().default(10000),
  TWO_FA_APP_NAME: z.string().default('Eugym Fitness'),

  // Logs
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),
})
  // Either a full connection URI, or all three discrete credentials. Failing
  // here at boot with a clear message beats a running server that cannot reach
  // its database.
  .refine(
    (e) => Boolean(e.DATABASE_URL) || Boolean(e.DB_NAME && e.DB_USER && e.DB_PASSWORD),
    {
      path: ['DATABASE_URL'],
      message:
        'Set DATABASE_URL, or all of DB_NAME, DB_USER and DB_PASSWORD',
    },
  )

function parseEnv() {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('❌  Invalid environment variables:')
    result.error.errors.forEach((e) => {
      console.error(`   ${e.path.join('.')}: ${e.message}`)
    })
    process.exit(1)
  }
  return result.data
}

export const env = parseEnv()
export const isDev  = env.NODE_ENV === 'development'
export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
