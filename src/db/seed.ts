import bcrypt from 'bcryptjs'
import type { PoolClient } from 'pg'
import { pool } from './pool'
import { logger } from '../config/logger'
import { env } from '../config/env'

/**
 * Fetch a row's id by natural key, inserting it only when absent.
 *
 * `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns *nothing* on a re-run,
 * which previously left centreId/corporateId null on every seed after the first.
 * Worse, `centres` has no unique constraint at all, so ON CONFLICT never fired
 * and each run appended five more duplicate centres.
 */
async function getOrCreate(
  client: PoolClient,
  findSql: string,
  findParams: unknown[],
  insertSql: string,
  insertParams: unknown[],
): Promise<string> {
  const found = await client.query(findSql, findParams)
  if (found.rows.length) return found.rows[0].id as string

  const created = await client.query(insertSql, insertParams)
  return created.rows[0].id as string
}

async function seed() {
  const client = await pool.connect()
  logger.info('🌱 Starting database seed…')

  try {
    await client.query('BEGIN')

    // ── Affiliates ────────────────────────────────────────────────────────────
    const affiliateData = [
      ['Eko Hotel & Suites',     'Mr. Adebayo', 'partner.eko@eugym.ng',       '+2341-800-0001', '2025-01-01'],
      ['Transcorp Hilton Abuja', 'Mrs. Okafor', 'partner.transcorp@eugym.ng', '+2341-800-0002', '2025-03-01'],
      ['Radisson Blu Lagos',     'Mr. Chukwu',  'partner.radisson@eugym.ng',  '+2341-800-0003', '2025-06-01'],
    ]

    const affiliateIds: string[] = []
    for (const [name, contact, email, phone, start] of affiliateData) {
      affiliateIds.push(await getOrCreate(
        client,
        'SELECT id FROM affiliates WHERE contact_email = $1',
        [email],
        `INSERT INTO affiliates (name, contact_name, contact_email, contact_phone, rate_per_visit, agreement_start, agreement_end)
         VALUES ($1,$2,$3,$4,10000,$5,'2026-12-31') RETURNING id`,
        [name, contact, email, phone, start],
      ))
    }
    logger.info(`  ✅ ${affiliateIds.length} affiliates`)

    // ── Centres ───────────────────────────────────────────────────────────────
    const centreData: Array<[string, string, string, string, number, number, number, boolean, string[]]> = [
      ['Eugym Victoria Island', '12 Adeola Odeku St',      'Lagos', 'Lagos', 6.4281, 3.4219, 120, false, ['Pool', 'Sauna', 'Parking', 'Locker']],
      ['Eugym Lekki Phase 1',   '45 Admiralty Way',        'Lekki', 'Lagos', 6.4479, 3.4813, 80,  false, ['Parking', 'Locker', 'Cafe']],
      ['Eugym Abuja Central',   '7 Central Business Dist', 'Abuja', 'FCT',   9.0579, 7.4951, 100, false, ['Pool', 'Sauna', 'Parking']],
      ['Eugym Ikeja',           '23 Awolowo Way',          'Ikeja', 'Lagos', 6.5954, 3.3419, 90,  false, ['Parking', 'Locker']],
      ['Eko Hotel Gym',         '1415 Adetokunbo Ademola', 'Lagos', 'Lagos', 6.4303, 3.4226, 60,  true,  ['Pool', 'Spa', 'Premium']],
    ]

    const centreIds: string[] = []
    for (const [name, address, city, state, lat, lng, capacity, isAffiliate, amenities] of centreData) {
      centreIds.push(await getOrCreate(
        client,
        'SELECT id FROM centres WHERE name = $1',
        [name],
        `INSERT INTO centres (name, address, city, state, lat, lng, capacity, is_affiliate, amenities)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [name, address, city, state, lat, lng, capacity, isAffiliate, amenities],
      ))
    }
    logger.info(`  ✅ ${centreIds.length} centres`)

    // Eko Hotel Gym is the affiliate-operated centre
    await client.query(
      'UPDATE centres SET affiliate_id = $1 WHERE id = $2',
      [affiliateIds[0], centreIds[4]],
    )

    // ── Corporate Account ─────────────────────────────────────────────────────
    const corporateId = await getOrCreate(
      client,
      'SELECT id FROM corporate_accounts WHERE email = $1',
      ['hr@acmeng.com'],
      `INSERT INTO corporate_accounts (company_name, email, phone, allocation, discount_rate)
       VALUES ('Acme Nigeria Ltd', 'hr@acmeng.com', '+2348012345678', 50, 20.00) RETURNING id`,
      [],
    )
    logger.info('  ✅ 1 corporate account')

    // ── Test Users — one per role in the user_role enum ───────────────────────
    // Passwords are re-hashed on every run, so a forgotten test password is
    // always one `npm run db:seed` away from being reset.
    const hash = (p: string) => bcrypt.hash(p, env.BCRYPT_ROUNDS)

    const usersData = [
      { fn: 'Chidi',  ln: 'Nwosu',    email: 'superadmin@eugym.ng',   phone: '+2348000000001', role: 'super_admin',       pwd: 'Admin@1234',   centreId: null },
      { fn: 'Amaka',  ln: 'Obi',      email: 'admin@eugym.ng',        phone: '+2348000000002', role: 'admin',             pwd: 'Admin@1234',   centreId: null },
      { fn: 'Kemi',   ln: 'Adeyemi',  email: 'kemi@example.com',      phone: '+2348012345679', role: 'premium',           pwd: 'User@1234',    centreId: centreIds[0] },
      { fn: 'Tunde',  ln: 'Bakare',   email: 'tunde@example.com',     phone: '+2348023456789', role: 'standard',          pwd: 'User@1234',    centreId: centreIds[0] },
      { fn: 'Ngozi',  ln: 'Okonkwo',  email: 'ngozi@example.com',     phone: '+2348034567890', role: 'regular',           pwd: 'User@1234',    centreId: null },
      { fn: 'Adaeze', ln: 'Okonkwo',  email: 'trainer@eugym.ng',      phone: '+2348045678901', role: 'trainer',           pwd: 'Trainer@1234', centreId: centreIds[0] },
      { fn: 'Emeka',  ln: 'Chukwu',   email: 'hr@acmeng.com',         phone: '+2348056789012', role: 'corporate_admin',   pwd: 'Corp@1234',    centreId: null },
      // Email must match affiliates.contact_email — the affiliate dashboard
      // resolves the partner by email string, not by foreign key.
      { fn: 'Bola',   ln: 'Fashola',  email: 'partner.eko@eugym.ng',  phone: '+2348067890123', role: 'affiliate_partner', pwd: 'Partner@1234', centreId: null },
      { fn: 'Sade',   ln: 'Williams', email: 'visitor@example.com',   phone: '+2348078901234', role: 'visitor',           pwd: 'Visitor@1234', centreId: null },
    ]

    const userIds: Record<string, string> = {}
    for (const u of usersData) {
      const { rows } = await client.query(
        `INSERT INTO users (first_name, last_name, email, phone, password_hash, role, centre_id, corporate_id, is_email_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
         ON CONFLICT (email) DO UPDATE SET
           first_name        = EXCLUDED.first_name,
           last_name         = EXCLUDED.last_name,
           phone             = EXCLUDED.phone,
           password_hash     = EXCLUDED.password_hash,
           role              = EXCLUDED.role,
           centre_id         = EXCLUDED.centre_id,
           corporate_id      = EXCLUDED.corporate_id,
           is_email_verified = true,
           is_active         = true,
           updated_at        = NOW()
         RETURNING id`,
        [u.fn, u.ln, u.email, u.phone, await hash(u.pwd), u.role, u.centreId,
         u.role === 'corporate_admin' ? corporateId : null],
      )
      userIds[u.email] = rows[0].id
    }
    logger.info(`  ✅ ${usersData.length} users (one per role)`)

    // ── Trainer Profile ───────────────────────────────────────────────────────
    const trainerUserId = userIds['trainer@eugym.ng']
    const { rows: tp } = await client.query(
      `INSERT INTO trainer_profiles (user_id, centre_id, bio, specialisations, certifications, rating, review_count, client_count)
       VALUES ($1,$2,$3,$4,$5,4.9,47,18)
       ON CONFLICT (user_id) DO UPDATE SET centre_id = EXCLUDED.centre_id RETURNING id`,
      [
        trainerUserId,
        centreIds[0],
        'Certified fitness coach with 7+ years experience specialising in weight training and HIIT.',
        ['Weight Training', 'HIIT', 'Functional Fitness'],
        ['ACE Certified Personal Trainer', 'Precision Nutrition L1'],
      ],
    )
    const trainerProfileId = tp[0].id

    // Assign the trainer to the premium test user
    await client.query(
      'UPDATE users SET trainer_id = $1 WHERE id = $2',
      [trainerProfileId, userIds['kemi@example.com']],
    )
    logger.info('  ✅ Trainer profile + premium assignment')

    // ── Active Subscriptions ──────────────────────────────────────────────────
    const subData = [
      { userId: userIds['kemi@example.com'],  tier: 'premium',  duration: 'monthly', amount: 30999 },
      { userId: userIds['tunde@example.com'], tier: 'standard', duration: 'monthly', amount: 29999 },
    ]
    for (const s of subData) {
      const existing = await client.query(
        `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
        [s.userId],
      )
      if (existing.rows.length) continue

      await client.query(
        `INSERT INTO subscriptions (user_id, tier, duration, status, start_date, end_date, amount_paid)
         VALUES ($1,$2,$3,'active',CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',$4)`,
        [s.userId, s.tier, s.duration, s.amount],
      )
    }
    logger.info('  ✅ Subscriptions')

    // ── Fitness Classes ───────────────────────────────────────────────────────
    // fitness_classes has no natural unique key, so guard on "already seeded"
    // rather than ON CONFLICT — otherwise every run appends five more classes.
    const { rows: existingClasses } = await client.query(
      'SELECT 1 FROM fitness_classes WHERE centre_id = $1 LIMIT 1',
      [centreIds[0]],
    )

    if (!existingClasses.length) {
      const tomorrow = new Date(Date.now() + 86_400_000)

      const classes = [
        { name: 'HIIT Inferno',       category: 'HIIT',       level: 'advanced',     hour: 7,  cap: 20 },
        { name: 'Morning Yoga Flow',  category: 'Yoga',       level: 'beginner',     hour: 9,  cap: 15 },
        { name: 'Strength & Tone',    category: 'Strength',   level: 'intermediate', hour: 11, cap: 18 },
        { name: 'Cardio Blast',       category: 'Cardio',     level: 'intermediate', hour: 14, cap: 25 },
        { name: 'Functional Fitness', category: 'Functional', level: 'intermediate', hour: 17, cap: 20 },
      ]

      for (const cls of classes) {
        const st = new Date(tomorrow)
        st.setHours(cls.hour, 0, 0, 0)
        await client.query(
          `INSERT INTO fitness_classes (centre_id,trainer_id,name,category,level,start_time,duration_mins,capacity)
           VALUES ($1,$2,$3,$4,$5,$6,60,$7)`,
          [centreIds[0], trainerProfileId, cls.name, cls.category, cls.level, st, cls.cap],
        )
      }
      logger.info('  ✅ Fitness classes')
    } else {
      logger.info('  ⏭  Fitness classes already present — skipped')
    }

    // ── Products ─────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO products (name, description, category, price, sku, stock, images)
      VALUES
        ('Eugym Training Shorts', 'Premium moisture-wicking shorts', 'fitness_wear', 8500,  'EG-SH-001', 50, ARRAY['https://images.unsplash.com/photo-1556906781-9a412961a28c?w=400']),
        ('Eugym Training T-Shirt','100% cotton training tee',        'fitness_wear', 6500,  'EG-TS-001', 80, ARRAY['https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=400']),
        ('Resistance Band Set',   '5-band progressive resistance',   'accessories',  4500,  'EG-AC-001', 40, ARRAY['https://images.unsplash.com/photo-1598575285714-ddc6b6a34e8a?w=400']),
        ('Whey Protein 1kg',      'Premium whey — Chocolate/Vanilla','supplements',  18000, 'EG-SP-001', 25, ARRAY['https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400']),
        ('Eugym Water Bottle',    'BPA-free 1L shaker bottle',       'branded',      3500,  'EG-BT-001', 60, ARRAY['https://images.unsplash.com/photo-1570197788417-0e82375c9371?w=400']),
        ('Foam Roller',           'Deep tissue massage roller',      'accessories',  6000,  'EG-FR-001', 30, ARRAY['https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400'])
      ON CONFLICT (sku) DO NOTHING
    `)
    logger.info('  ✅ Products')

    // ── Sample Affiliate Visits ───────────────────────────────────────────────
    const { rows: existingVisits } = await client.query(
      'SELECT 1 FROM affiliate_visits WHERE affiliate_id = $1 LIMIT 1',
      [affiliateIds[0]],
    )

    if (!existingVisits.length) {
      for (let i = 0; i < 5; i++) {
        const d = new Date(Date.now() - i * 3 * 86_400_000)
        await client.query(
          `INSERT INTO affiliate_visits (user_id, centre_id, affiliate_id, visited_at)
           VALUES ($1,$2,$3,$4)`,
          [userIds['kemi@example.com'], centreIds[4], affiliateIds[0], d],
        )
      }
      logger.info('  ✅ Sample affiliate visits')
    } else {
      logger.info('  ⏭  Affiliate visits already present — skipped')
    }

    await client.query('COMMIT')
    logger.info('✅ Database seeded successfully!')
    logger.info('')
    logger.info('──────────────── Test Accounts ─────────────────────')
    logger.info('Super Admin : superadmin@eugym.ng    / Admin@1234')
    logger.info('Admin       : admin@eugym.ng         / Admin@1234')
    logger.info('Trainer     : trainer@eugym.ng       / Trainer@1234')
    logger.info('Corporate   : hr@acmeng.com          / Corp@1234')
    logger.info('Affiliate   : partner.eko@eugym.ng   / Partner@1234')
    logger.info('Premium     : kemi@example.com       / User@1234')
    logger.info('Standard    : tunde@example.com      / User@1234')
    logger.info('Regular     : ngozi@example.com      / User@1234')
    logger.info('Visitor     : visitor@example.com    / Visitor@1234')
    logger.info('────────────────────────────────────────────────────')
    logger.info('Re-run `npm run db:seed` at any time to reset these passwords.')

  } catch (err: unknown) {
    await client.query('ROLLBACK')
    logger.error('❌ Seed failed', { error: (err as Error).message })
    throw err
  } finally {
    client.release()
  }
}

seed()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
