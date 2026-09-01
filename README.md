# 🏋️ Eugym Fitness — Backend API

> Production-grade REST API built with Node.js, Express, TypeScript, and PostgreSQL.

---

## 📋 Table of Contents
1. [Architecture Overview](#architecture)
2. [Prerequisites](#prerequisites)
3. [Local Development Setup](#local-setup)
4. [Environment Variables](#env-vars)
5. [Database Setup](#database)
6. [Running the API](#running)
7. [API Reference](#api-reference)
8. [Docker Deployment](#docker)
9. [Production Deployment](#production)
10. [Testing Credentials](#credentials)

---

## 🏗️ Architecture Overview <a name="architecture"></a>

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTS                              │
│         Next.js Frontend  ·  Mobile App (Phase 3)           │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS
┌──────────────────────────▼──────────────────────────────────┐
│                    NGINX (Reverse Proxy)                     │
│          Rate limiting  ·  SSL termination  ·  Gzip         │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│               EXPRESS API  (Node.js / TypeScript)            │
│                                                             │
│  /auth   /users   /subscriptions   /classes   /bookings     │
│  /trainers   /centres   /admin   /corporate   /affiliate    │
│  /products   /orders   /visits                              │
│                                                             │
│  Middleware: JWT Auth · RBAC · Zod Validation · Rate Limit  │
│  Jobs:  Subscription expiry · Settlement · Token cleanup    │
└───────────┬──────────────────────────────┬──────────────────┘
            │                              │
┌───────────▼──────────┐      ┌───────────▼──────────────────┐
│   PostgreSQL 16       │      │   External Services           │
│                       │      │                               │
│  22 migrations        │      │  Paystack  (payments)         │
│  16 tables            │      │  SendGrid  (email)            │
│  Full FK constraints  │      │  Cloudinary (uploads)         │
│  Auto updated_at      │      │  Google Maps (locations)      │
└───────────────────────┘      └───────────────────────────────┘
```

---

## ✅ Prerequisites <a name="prerequisites"></a>

| Tool          | Version  | Install                              |
|---------------|----------|--------------------------------------|
| Node.js       | ≥ 20.x   | https://nodejs.org                   |
| npm           | ≥ 10.x   | Bundled with Node                    |
| PostgreSQL    | ≥ 15.x   | https://postgresql.org               |
| Git           | any      | https://git-scm.com                  |
| Docker        | ≥ 24.x   | https://docs.docker.com (optional)   |

---

## 🖥️ Local Development Setup <a name="local-setup"></a>

### Step 1 — Clone and install

```bash
git clone https://github.com/your-org/eugym-api.git
cd eugym-api
npm install
```

### Step 2 — Create PostgreSQL database

```bash
# Log into PostgreSQL
psql -U postgres

# Inside psql:
CREATE USER eugym_user WITH PASSWORD 'your_strong_password';
CREATE DATABASE eugym_db OWNER eugym_user;
GRANT ALL PRIVILEGES ON DATABASE eugym_db TO eugym_user;
\q
```

### Step 3 — Set up environment

```bash
cp .env.example .env
```

Open `.env` and fill in **at minimum**:
```env
DB_NAME=eugym_db
DB_USER=eugym_user
DB_PASSWORD=your_strong_password

JWT_ACCESS_SECRET=<run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_REFRESH_SECRET=<run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">

PAYSTACK_SECRET_KEY=sk_test_xxxx      # from dashboard.paystack.com
PAYSTACK_PUBLIC_KEY=pk_test_xxxx
PAYSTACK_WEBHOOK_SECRET=xxxx

SMTP_USER=apikey
SMTP_PASS=SG.xxxx                     # from sendgrid.com
EMAIL_FROM=noreply@eugym.ng
```

### Step 4 — Run migrations

```bash
npm run db:migrate
```

You should see:
```
  ✅ 001_extensions
  ✅ 002_enums
  ✅ 003_affiliates
  ... (22 migrations total)
✅ All migrations complete
```

### Step 5 — Seed test data

```bash
npm run db:seed
```

This creates all test users, centres, trainers, classes, products, and sample data.

### Step 6 — Start development server

```bash
npm run dev
```

```
╔══════════════════════════════════════════════╗
║        🏋️  EUGYM FITNESS API                 ║
╠══════════════════════════════════════════════╣
║  Port    : 4000                              ║
║  Env     : development                       ║
║  Prefix  : /api/v1                           ║
║  Health  : http://localhost:4000/health      ║
╚══════════════════════════════════════════════╝

✅ PostgreSQL connected
✅ All background jobs initialised
```

---

## 🔑 Environment Variables <a name="env-vars"></a>

| Variable                  | Required | Description                                    |
|---------------------------|----------|------------------------------------------------|
| `PORT`                    | No       | Server port (default: 4000)                    |
| `DB_HOST`                 | Yes      | PostgreSQL host                                |
| `DB_NAME`                 | Yes      | Database name                                  |
| `DB_USER`                 | Yes      | Database user                                  |
| `DB_PASSWORD`             | Yes      | Database password                              |
| `JWT_ACCESS_SECRET`       | Yes      | 64-char hex secret for access tokens           |
| `JWT_REFRESH_SECRET`      | Yes      | 64-char hex secret for refresh tokens          |
| `PAYSTACK_SECRET_KEY`     | Yes      | Paystack secret key (sk_test_... or sk_live_..)|
| `PAYSTACK_WEBHOOK_SECRET` | Yes      | From Paystack webhook settings                 |
| `SMTP_USER`               | Yes      | SMTP username (apikey for SendGrid)            |
| `SMTP_PASS`               | Yes      | SMTP password / API key                        |
| `FRONTEND_URL`            | Yes      | Frontend URL for email links                   |

---

## 🗄️ Database Setup <a name="database"></a>

### Reset and re-migrate from scratch

```bash
# Drop and recreate
psql -U postgres -c "DROP DATABASE IF EXISTS eugym_db;"
psql -U postgres -c "CREATE DATABASE eugym_db OWNER eugym_user;"

npm run db:migrate
npm run db:seed
```

### Database schema overview

```
users               ← All roles, auth, profile
subscriptions       ← Tier, duration, status, dates
payments            ← Paystack refs, POS records
refresh_tokens      ← JWT refresh with rotation
email_verifications ← Email OTP tokens
password_resets     ← Password reset tokens
centres             ← Gym locations (owned + affiliate)
affiliates          ← Partner hotels/gyms
affiliate_visits    ← Premium check-ins
settlements         ← Monthly affiliate payouts
trainer_profiles    ← Trainer bios, ratings, certs
trainer_availability← Weekly availability slots
fitness_classes     ← Group class schedules
bookings            ← Class + PT session bookings
corporate_accounts  ← Company bulk subscriptions
workout_plans       ← Trainer → client plans
diet_plans          ← Trainer → client nutrition
products            ← Merchandise catalogue
product_variants    ← Size/flavour variants
orders              ← Customer orders (guest + member)
order_items         ← Line items per order
notifications       ← In-app notifications
schema_migrations   ← Migration tracking
```

---

## 🚀 Running the API <a name="running"></a>

```bash
# Development (hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Run migrations only
npm run db:migrate

# Seed test data
npm run db:seed
```

---

## 📡 API Reference <a name="api-reference"></a>

Base URL: `http://localhost:4000/api/v1`

### Authentication

All protected routes require:
```
Authorization: Bearer <accessToken>
```

Access tokens expire in **15 minutes**. Use `/auth/refresh` with your refresh token to get a new one.

---

### Auth Endpoints

| Method | Path                    | Auth | Description                          |
|--------|-------------------------|------|--------------------------------------|
| POST   | `/auth/register`        | ✗    | Register new account                 |
| POST   | `/auth/login`           | ✗    | Login, returns tokens + user         |
| POST   | `/auth/refresh`         | ✗    | Rotate refresh token                 |
| GET    | `/auth/me`              | ✓    | Get current user + subscription      |
| POST   | `/auth/logout`          | ✓    | Revoke all refresh tokens            |
| POST   | `/auth/verify-email`    | ✗    | Verify email with OTP token          |
| POST   | `/auth/forgot-password` | ✗    | Request reset email                  |
| POST   | `/auth/reset-password`  | ✗    | Reset with token                     |
| POST   | `/auth/2fa/enable`      | ✓    | Generate 2FA QR code                 |
| POST   | `/auth/2fa/verify`      | ✗    | Complete 2FA login                   |
| POST   | `/auth/2fa/disable`     | ✓    | Disable 2FA                          |

**Login response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "firstName": "Kemi",
      "lastName": "Adeyemi",
      "email": "kemi@example.com",
      "role": "premium",
      "subscription": {
        "tier": "premium",
        "status": "active",
        "endDate": "2026-11-01"
      }
    },
    "tokens": {
      "accessToken": "eyJ...",
      "refreshToken": "abc123...",
      "expiresIn": 900
    }
  }
}
```

---

### Subscription Endpoints

| Method | Path                               | Auth | Roles             | Description               |
|--------|------------------------------------|------|-------------------|---------------------------|
| GET    | `/subscriptions/current`           | ✓    | any               | Current active sub        |
| GET    | `/subscriptions/history`           | ✓    | any               | Subscription history      |
| POST   | `/subscriptions`                   | ✓    | any               | Create + initiate payment |
| POST   | `/subscriptions/upgrade`           | ✓    | standard/premium  | Pro-rata upgrade          |
| POST   | `/subscriptions/cancel`            | ✓    | standard/premium  | Cancel (end of period)    |
| PATCH  | `/subscriptions/auto-renew`        | ✓    | standard/premium  | Toggle auto-renew         |
| POST   | `/subscriptions/webhook`           | ✗*   | —                 | Paystack webhook           |
| POST   | `/subscriptions/confirm-pos/:id`   | ✓    | admin             | Confirm POS payment       |

*Webhook verified by HMAC signature, not JWT

**Create subscription body:**
```json
{
  "tier": "standard",
  "duration": "monthly",
  "centreId": "uuid-of-centre"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "paymentUrl": "https://checkout.paystack.com/...",
    "reference": "PST_xxxxx"
  }
}
```

---

### Booking Endpoints

| Method | Path                  | Auth | Description                         |
|--------|-----------------------|------|-------------------------------------|
| GET    | `/bookings/me`        | ✓    | My bookings (class + PT)            |
| POST   | `/bookings`           | ✓    | Book class or PT session            |
| POST   | `/bookings/:id/cancel`| ✓    | Cancel (strike system applies)      |

**Book group class:**
```json
{ "type": "group_class", "classId": "uuid", "notes": "optional" }
```

**Book PT session:**
```json
{
  "type": "pt_session",
  "trainerId": "uuid",
  "proposedAt": "2026-11-05T09:00:00Z",
  "durationMins": 60
}
```

---

### Other Key Endpoints

| Method | Path                           | Description                         |
|--------|--------------------------------|-------------------------------------|
| GET    | `/classes`                     | List upcoming classes               |
| GET    | `/trainers`                    | List trainers (filter by centre)    |
| GET    | `/centres`                     | List centres (supports lat/lng)     |
| POST   | `/visits/check-in`             | Premium affiliate check-in          |
| GET    | `/products`                    | Product catalogue (paginated)       |
| POST   | `/orders`                      | Create order + get payment URL      |
| GET    | `/admin/stats`                 | Platform stats (admin)              |
| GET    | `/admin/members`               | Paginated member list               |
| GET    | `/admin/payments/pending-pos`  | Pending POS confirmations           |
| GET    | `/admin/super/revenue`         | Monthly revenue breakdown           |
| GET    | `/corporate/staff`             | Corporate staff list                |
| POST   | `/corporate/staff`             | Add staff member                    |
| GET    | `/affiliate/overview`          | Affiliate stats                     |
| GET    | `/affiliate/visits`            | Visit log (paginated)               |
| GET    | `/affiliate/settlements`       | Settlement history                  |

---

## 🐳 Docker Deployment <a name="docker"></a>

### Start full stack locally

```bash
# Copy and fill env
cp .env.example .env

# Start all services (API + Postgres + Redis + Nginx)
docker compose up -d

# View logs
docker compose logs -f api

# Run migrations inside container
docker compose exec api node dist/db/migrate.js

# Seed data
docker compose exec api node dist/db/seed.js

# Stop everything
docker compose down
```

### Container health check

```bash
curl http://localhost:4000/health
# {"status":"ok","service":"eugym-api","version":"1.0.0"}
```

---

## 🌐 Production Deployment <a name="production"></a>

### Option A — Docker on a VPS (DigitalOcean / AWS EC2)

```bash
# 1. SSH into your server
ssh root@your-server-ip

# 2. Install Docker
curl -fsSL https://get.docker.com | sh

# 3. Clone repo
git clone https://github.com/your-org/eugym-api.git /opt/eugym-api
cd /opt/eugym-api

# 4. Set up environment
cp .env.example .env
nano .env  # fill in production values

# 5. Get SSL cert (replace domain)
docker run --rm -v certbot_data:/etc/letsencrypt \
  -v certbot_www:/var/www/certbot certbot/certbot \
  certonly --webroot -w /var/www/certbot \
  -d api.eugym.ng --email admin@eugym.ng --agree-tos

# 6. Start stack
docker compose up -d

# 7. Run migrations + seed (first deploy only)
docker compose exec api node dist/db/migrate.js
docker compose exec api node dist/db/seed.js
```

### Option B — PM2 on bare metal

```bash
# Install PM2
npm install -g pm2

# Build
npm run build

# Run migrations
npm run db:migrate

# Start with PM2
pm2 start dist/server.js --name eugym-api -i max
pm2 save
pm2 startup

# Monitor
pm2 status
pm2 logs eugym-api
```

### CI/CD with GitHub Actions

Create `.github/workflows/deploy.yml`:
```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: root
          key: ${{ secrets.SSH_KEY }}
          script: |
            cd /opt/eugym-api
            git pull origin main
            docker compose build api
            docker compose up -d api
            docker compose exec -T api node dist/db/migrate.js
```

---

## 🧪 Testing Credentials <a name="credentials"></a>

After running `npm run db:seed`:

| Role              | Email                      | Password        |
|-------------------|----------------------------|-----------------|
| Super Admin       | superadmin@eugym.ng        | Admin@1234      |
| Admin             | admin@eugym.ng             | Admin@1234      |
| Premium Member    | kemi@example.com           | User@1234       |
| Standard Member   | tunde@example.com          | User@1234       |
| Regular Member    | ngozi@example.com          | User@1234       |
| Trainer           | trainer@eugym.ng           | Trainer@1234    |
| Corporate Admin   | hr@acmeng.com              | Corp@1234       |
| Affiliate Partner | partner.eko@eugym.ng       | Partner@1234    |

### Quick test with curl

```bash
# Login
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"kemi@example.com","password":"User@1234"}'

# Use the returned accessToken
TOKEN="eyJ..."

# Get profile
curl http://localhost:4000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"

# List classes
curl http://localhost:4000/api/v1/classes

# Admin stats
curl http://localhost:4000/api/v1/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 🔒 Security Notes

- **Never commit `.env`** — it's in `.gitignore`
- Rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` if compromised (all sessions will be invalidated)
- Paystack webhook uses HMAC-SHA512 signature verification — never disable this
- `super_admin` accounts enforce 2FA in production
- All PII is stored with column-level considerations; full AES-256 encryption at rest is configured at the PostgreSQL / cloud storage level

---

## 📁 Project Structure

```
src/
├── config/
│   ├── env.ts          ← Zod-validated environment (crashes if misconfigured)
│   └── logger.ts       ← Winston (dev: coloured, prod: JSON)
├── db/
│   ├── pool.ts         ← pg Pool, query(), withTransaction()
│   ├── migrate.ts      ← 22 sequential migrations
│   └── seed.ts         ← Realistic Nigerian test data
├── middleware/
│   └── index.ts        ← authenticate, authorize, validate, errorHandler, limiters
├── modules/
│   ├── auth/           ← Register, login, 2FA, refresh, email verify, password reset
│   ├── subscriptions/  ← Full Paystack lifecycle, pro-rata, POS confirmation
│   ├── core.router.ts  ← Classes, Bookings, Trainers, Centres, Visits, Users
│   ├── extra.router.ts ← Corporate, Affiliate, Merchandise, Orders
│   └── admin/          ← Members, trainers, stats, reports, super admin
├── lib/
│   └── email.ts        ← All 9 transactional email templates (HTML)
├── jobs/
│   └── index.ts        ← 4 cron jobs: expiry, settlement, cleanup, stock
├── types/
│   └── index.ts        ← DB row types + JWT payload (mirrors frontend)
├── utils/
│   └── index.ts        ← ok(), AppError, mappers, pro-rata calc, crypto
└── server.ts           ← Express assembly, graceful shutdown, bootstrap
```

---

*Built for Eugym Fitness Ltd — Lagos, Nigeria 🇳🇬*
