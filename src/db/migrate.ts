import { pool } from './pool'
import { logger } from '../config/logger'

const migrations: { name: string; sql: string }[] = [
  // ── 001: Extensions ─────────────────────────────────────────────────────────
  {
    name: '001_extensions',
    sql: `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `,
  },

  // ── 002: Enums ──────────────────────────────────────────────────────────────
  {
    name: '002_enums',
    sql: `
      DO $$ BEGIN
        CREATE TYPE user_role AS ENUM (
          'visitor','regular','standard','premium',
          'trainer','corporate_admin','affiliate_partner','admin','super_admin'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE subscription_tier AS ENUM ('free','standard','premium','corporate');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE subscription_duration AS ENUM (
          'daily','weekly','monthly','quarterly','biannual','annual'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE subscription_status AS ENUM ('active','expired','cancelled','pending');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE booking_status AS ENUM ('confirmed','cancelled','completed','no_show');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE booking_type AS ENUM ('group_class','pt_session');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE product_category AS ENUM (
          'fitness_wear','accessories','supplements','wellness','branded'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE product_status AS ENUM ('active','inactive','out_of_stock');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE order_status AS ENUM (
          'pending_payment','processing','shipped','delivered','cancelled','refunded'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE payment_method AS ENUM ('card','bank_transfer','pos','ussd');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE class_level AS ENUM ('beginner','intermediate','advanced');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE settlement_status AS ENUM ('pending','processed','disputed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },

  // ── 003: Affiliates ──────────────────────────────────────────────────────────
  {
    name: '003_affiliates',
    sql: `
      CREATE TABLE IF NOT EXISTS affiliates (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name            VARCHAR(200) NOT NULL,
        contact_name    VARCHAR(200) NOT NULL,
        contact_email   VARCHAR(200) NOT NULL UNIQUE,
        contact_phone   VARCHAR(20)  NOT NULL,
        rate_per_visit  INTEGER      NOT NULL DEFAULT 10000,
        bank_name       VARCHAR(100),
        bank_account    VARCHAR(20),
        bank_code       VARCHAR(10),
        is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
        agreement_start DATE,
        agreement_end   DATE,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `,
  },

  // ── 004: Centres ─────────────────────────────────────────────────────────────
  {
    name: '004_centres',
    sql: `
      CREATE TABLE IF NOT EXISTS centres (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name         VARCHAR(200) NOT NULL,
        address      TEXT         NOT NULL,
        city         VARCHAR(100) NOT NULL,
        state        VARCHAR(100) NOT NULL,
        lat          DECIMAL(10,7),
        lng          DECIMAL(10,7),
        capacity     INTEGER      NOT NULL DEFAULT 100,
        is_affiliate BOOLEAN      NOT NULL DEFAULT FALSE,
        affiliate_id UUID REFERENCES affiliates(id) ON DELETE SET NULL,
        images       TEXT[]       NOT NULL DEFAULT '{}',
        amenities    TEXT[]       NOT NULL DEFAULT '{}',
        is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_centres_affiliate ON centres(affiliate_id);
    `,
  },

  // ── 005: Corporate Accounts ──────────────────────────────────────────────────
  {
    name: '005_corporate_accounts',
    sql: `
      CREATE TABLE IF NOT EXISTS corporate_accounts (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        company_name   VARCHAR(200) NOT NULL,
        email          VARCHAR(200) NOT NULL UNIQUE,
        phone          VARCHAR(20)  NOT NULL,
        address        TEXT,
        allocation     INTEGER      NOT NULL DEFAULT 10,
        discount_rate  DECIMAL(5,2) NOT NULL DEFAULT 20.00,
        is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `,
  },

  // ── 006: Users ───────────────────────────────────────────────────────────────
  {
    name: '006_users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        first_name        VARCHAR(100)  NOT NULL,
        last_name         VARCHAR(100)  NOT NULL,
        email             VARCHAR(255)  NOT NULL UNIQUE,
        phone             VARCHAR(20)   NOT NULL,
        password_hash     VARCHAR(255),
        role              user_role     NOT NULL DEFAULT 'regular',
        avatar            TEXT,
        centre_id         UUID REFERENCES centres(id) ON DELETE SET NULL,
        trainer_id        UUID,
        corporate_id      UUID REFERENCES corporate_accounts(id) ON DELETE SET NULL,
        is_email_verified BOOLEAN       NOT NULL DEFAULT FALSE,
        is_2fa_enabled    BOOLEAN       NOT NULL DEFAULT FALSE,
        two_fa_secret     VARCHAR(255),
        google_id         VARCHAR(255),
        strike_count      INTEGER       NOT NULL DEFAULT 0,
        booking_suspended_until TIMESTAMPTZ,
        last_login_at     TIMESTAMPTZ,
        is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_corporate   ON users(corporate_id);
      CREATE INDEX IF NOT EXISTS idx_users_centre      ON users(centre_id);
    `,
  },

  // ── 007: Refresh Tokens ──────────────────────────────────────────────────────
  {
    name: '007_refresh_tokens',
    sql: `
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    `,
  },

  // ── 008: Email Verification & Password Reset ─────────────────────────────────
  {
    name: '008_tokens',
    sql: `
      CREATE TABLE IF NOT EXISTS email_verifications (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },

  // ── 009: Subscriptions ───────────────────────────────────────────────────────
  {
    name: '009_subscriptions',
    sql: `
      CREATE TABLE IF NOT EXISTS subscriptions (
        id           UUID                  PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      UUID                  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tier         subscription_tier     NOT NULL,
        duration     subscription_duration NOT NULL,
        status       subscription_status   NOT NULL DEFAULT 'pending',
        start_date   DATE,
        end_date     DATE,
        amount_paid  INTEGER               NOT NULL DEFAULT 0,
        auto_renew   BOOLEAN               NOT NULL DEFAULT TRUE,
        centre_id    UUID REFERENCES centres(id) ON DELETE SET NULL,
        paystack_ref VARCHAR(100),
        cancelled_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ           NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_subs_user      ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_subs_status    ON subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_subs_end_date  ON subscriptions(end_date);
    `,
  },

  // ── 010: Payments ────────────────────────────────────────────────────────────
  {
    name: '010_payments',
    sql: `
      CREATE TABLE IF NOT EXISTS payments (
        id              UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
        order_id        UUID,
        amount          INTEGER        NOT NULL,
        method          payment_method NOT NULL DEFAULT 'card',
        status          payment_status NOT NULL DEFAULT 'pending',
        paystack_ref    VARCHAR(100)   UNIQUE,
        paystack_data   JSONB,
        pos_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        pos_proof_url   TEXT,
        paid_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_payments_user        ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_sub         ON payments(subscription_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status      ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_payments_paystack_ref ON payments(paystack_ref);
    `,
  },

  // ── 011: Trainers ────────────────────────────────────────────────────────────
  {
    name: '011_trainers',
    sql: `
      CREATE TABLE IF NOT EXISTS trainer_profiles (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        centre_id        UUID NOT NULL REFERENCES centres(id) ON DELETE RESTRICT,
        bio              TEXT,
        specialisations  TEXT[]      NOT NULL DEFAULT '{}',
        certifications   TEXT[]      NOT NULL DEFAULT '{}',
        rating           DECIMAL(3,2) NOT NULL DEFAULT 0,
        review_count     INTEGER      NOT NULL DEFAULT 0,
        client_count     INTEGER      NOT NULL DEFAULT 0,
        is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_trainer_profiles_user   ON trainer_profiles(user_id);
      CREATE INDEX IF NOT EXISTS idx_trainer_profiles_centre ON trainer_profiles(centre_id);

      -- Enforce trainer_id FK on users
      ALTER TABLE users ADD CONSTRAINT fk_users_trainer
        FOREIGN KEY (trainer_id) REFERENCES trainer_profiles(id) ON DELETE SET NULL;
    `,
  },

  // ── 012: Fitness Classes ─────────────────────────────────────────────────────
  {
    name: '012_classes',
    sql: `
      CREATE TABLE IF NOT EXISTS fitness_classes (
        id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        centre_id     UUID        NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
        trainer_id    UUID        NOT NULL REFERENCES trainer_profiles(id) ON DELETE CASCADE,
        name          VARCHAR(200) NOT NULL,
        description   TEXT,
        category      VARCHAR(100) NOT NULL,
        level         class_level  NOT NULL DEFAULT 'beginner',
        start_time    TIMESTAMPTZ  NOT NULL,
        duration_mins INTEGER      NOT NULL DEFAULT 60,
        capacity      INTEGER      NOT NULL DEFAULT 20,
        enrolled      INTEGER      NOT NULL DEFAULT 0,
        is_cancelled  BOOLEAN      NOT NULL DEFAULT FALSE,
        recurrence    VARCHAR(50),
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_classes_centre    ON fitness_classes(centre_id);
      CREATE INDEX IF NOT EXISTS idx_classes_trainer   ON fitness_classes(trainer_id);
      CREATE INDEX IF NOT EXISTS idx_classes_start     ON fitness_classes(start_time);
    `,
  },

  // ── 013: Bookings ────────────────────────────────────────────────────────────
  {
    name: '013_bookings',
    sql: `
      CREATE TABLE IF NOT EXISTS bookings (
        id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        class_id      UUID REFERENCES fitness_classes(id) ON DELETE SET NULL,
        trainer_id    UUID REFERENCES trainer_profiles(id) ON DELETE SET NULL,
        type          booking_type NOT NULL,
        status        booking_status NOT NULL DEFAULT 'confirmed',
        scheduled_at  TIMESTAMPTZ  NOT NULL,
        duration_mins INTEGER      NOT NULL DEFAULT 60,
        notes         TEXT,
        cancelled_at  TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT check_booking_target CHECK (
          (type = 'group_class' AND class_id IS NOT NULL) OR
          (type = 'pt_session'  AND trainer_id IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_user      ON bookings(user_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_class     ON bookings(class_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_trainer   ON bookings(trainer_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_scheduled ON bookings(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_bookings_status    ON bookings(status);
    `,
  },

  // ── 014: Affiliate Visits ────────────────────────────────────────────────────
  {
    name: '014_affiliate_visits',
    sql: `
      CREATE TABLE IF NOT EXISTS affiliate_visits (
        id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        centre_id    UUID        NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
        affiliate_id UUID        NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
        visited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled      BOOLEAN     NOT NULL DEFAULT FALSE,
        settlement_id UUID
      );
      CREATE INDEX IF NOT EXISTS idx_visits_user      ON affiliate_visits(user_id);
      CREATE INDEX IF NOT EXISTS idx_visits_affiliate ON affiliate_visits(affiliate_id);
      CREATE INDEX IF NOT EXISTS idx_visits_settled   ON affiliate_visits(settled);
      -- date_trunc(text, timestamptz) is STABLE (depends on TimeZone), so it cannot be
      -- indexed. Pinning the zone makes the expression IMMUTABLE.
      CREATE INDEX IF NOT EXISTS idx_visits_month     ON affiliate_visits(DATE_TRUNC('month', visited_at AT TIME ZONE 'UTC'));
    `,
  },

  // ── 015: Settlements ─────────────────────────────────────────────────────────
  {
    name: '015_settlements',
    sql: `
      CREATE TABLE IF NOT EXISTS settlements (
        id           UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
        affiliate_id UUID              NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
        period_start DATE              NOT NULL,
        period_end   DATE              NOT NULL,
        visit_count  INTEGER           NOT NULL DEFAULT 0,
        rate         INTEGER           NOT NULL,
        total_amount INTEGER           NOT NULL,
        status       settlement_status NOT NULL DEFAULT 'pending',
        processed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        processed_at TIMESTAMPTZ,
        notes        TEXT,
        created_at   TIMESTAMPTZ       NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_settlements_affiliate ON settlements(affiliate_id);
      CREATE INDEX IF NOT EXISTS idx_settlements_status    ON settlements(status);
    `,
  },

  // ── 016: Products ────────────────────────────────────────────────────────────
  {
    name: '016_products',
    sql: `
      CREATE TABLE IF NOT EXISTS products (
        id          UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
        name        VARCHAR(300)     NOT NULL,
        description TEXT,
        category    product_category NOT NULL,
        price       INTEGER          NOT NULL,
        images      TEXT[]           NOT NULL DEFAULT '{}',
        sku         VARCHAR(100)     NOT NULL UNIQUE,
        stock       INTEGER          NOT NULL DEFAULT 0,
        status      product_status   NOT NULL DEFAULT 'active',
        created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_products_status   ON products(status);

      CREATE TABLE IF NOT EXISTS product_variants (
        id             UUID    PRIMARY KEY DEFAULT uuid_generate_v4(),
        product_id     UUID    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        label          VARCHAR(100) NOT NULL,
        stock          INTEGER NOT NULL DEFAULT 0,
        price_modifier INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
    `,
  },

  // ── 017: Orders ─────────────────────────────────────────────────────────────
  {
    name: '017_orders',
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
        guest_email     VARCHAR(255),
        guest_phone     VARCHAR(20),
        first_name      VARCHAR(100) NOT NULL,
        last_name       VARCHAR(100) NOT NULL,
        address         TEXT         NOT NULL,
        city            VARCHAR(100) NOT NULL,
        state           VARCHAR(100) NOT NULL,
        subtotal        INTEGER      NOT NULL,
        delivery_fee    INTEGER      NOT NULL DEFAULT 0,
        total           INTEGER      NOT NULL,
        status          order_status NOT NULL DEFAULT 'pending_payment',
        paystack_ref    VARCHAR(100),
        shipped_at      TIMESTAMPTZ,
        delivered_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id          UUID    PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id    UUID    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id  UUID    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        variant_id  UUID REFERENCES product_variants(id) ON DELETE SET NULL,
        quantity    INTEGER NOT NULL,
        unit_price  INTEGER NOT NULL,
        total       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_order_items   ON order_items(order_id);
    `,
  },

  // ── 018: Workout & Diet Plans ────────────────────────────────────────────────
  {
    name: '018_plans',
    sql: `
      CREATE TABLE IF NOT EXISTS workout_plans (
        id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        trainer_id  UUID        NOT NULL REFERENCES trainer_profiles(id) ON DELETE CASCADE,
        client_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       VARCHAR(200) NOT NULL,
        goal        TEXT,
        weeks       INTEGER      NOT NULL DEFAULT 4,
        plan_data   JSONB        NOT NULL DEFAULT '[]',
        is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS diet_plans (
        id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        trainer_id  UUID        NOT NULL REFERENCES trainer_profiles(id) ON DELETE CASCADE,
        client_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       VARCHAR(200) NOT NULL,
        goal        TEXT,
        plan_data   JSONB        NOT NULL DEFAULT '[]',
        is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_workout_client  ON workout_plans(client_id);
      CREATE INDEX IF NOT EXISTS idx_diet_client     ON diet_plans(client_id);
    `,
  },

  // ── 019: Notifications ──────────────────────────────────────────────────────
  {
    name: '019_notifications',
    sql: `
      CREATE TABLE IF NOT EXISTS notifications (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      VARCHAR(200) NOT NULL,
        body       TEXT        NOT NULL,
        type       VARCHAR(50) NOT NULL,
        read_at    TIMESTAMPTZ,
        metadata   JSONB       NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notifs_user   ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifs_read   ON notifications(user_id, read_at);
    `,
  },

  // ── 020: Trainer Availability ────────────────────────────────────────────────
  {
    name: '020_availability',
    sql: `
      CREATE TABLE IF NOT EXISTS trainer_availability (
        id         UUID    PRIMARY KEY DEFAULT uuid_generate_v4(),
        trainer_id UUID    NOT NULL REFERENCES trainer_profiles(id) ON DELETE CASCADE,
        day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_time  TIME    NOT NULL,
        end_time    TIME    NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        UNIQUE(trainer_id, day_of_week, start_time)
      );

      CREATE TABLE IF NOT EXISTS trainer_blocks (
        id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        trainer_id UUID        NOT NULL REFERENCES trainer_profiles(id) ON DELETE CASCADE,
        start_at   TIMESTAMPTZ NOT NULL,
        end_at     TIMESTAMPTZ NOT NULL,
        reason     VARCHAR(200)
      );
    `,
  },

  // ── 021: Updated_at trigger ──────────────────────────────────────────────────
  {
    name: '021_updated_at_trigger',
    sql: `
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DO $$ DECLARE t TEXT;
      BEGIN
        FOREACH t IN ARRAY ARRAY[
          'users','subscriptions','fitness_classes','bookings',
          'products','product_variants','orders','trainer_profiles',
          'centres','affiliates','corporate_accounts','workout_plans','diet_plans'
        ] LOOP
          EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %s;
             CREATE TRIGGER trg_%s_updated_at
             BEFORE UPDATE ON %s
             FOR EACH ROW EXECUTE FUNCTION update_updated_at();',
            t, t, t, t
          );
        END LOOP;
      END $$;
    `,
  },

  // ── 022: Migration tracking ──────────────────────────────────────────────────
  {
    name: '000_migrations_table',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(200) NOT NULL UNIQUE,
        run_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `,
  },
]

async function runMigrations() {
  const client = await pool.connect()
  try {
    // Ensure migration table exists first
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id     SERIAL PRIMARY KEY,
        name   VARCHAR(200) NOT NULL UNIQUE,
        run_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `)

    const { rows: ran } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    )
    const ranSet = new Set(ran.map((r) => r.name))

    for (const migration of migrations) {
      if (ranSet.has(migration.name)) {
        logger.debug(`  ⏭  ${migration.name} (already run)`)
        continue
      }
      logger.info(`  ▶  Running ${migration.name}…`)
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [migration.name],
        )
        await client.query('COMMIT')
        logger.info(`  ✅ ${migration.name}`)
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error(`  ❌ ${migration.name}:`, (err as Error).message)
        throw err
      }
    }
    logger.info('✅ All migrations complete')
  } finally {
    client.release()
  }
}

runMigrations()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('❌ Migration failed:', err)
    process.exit(1)
  })
