# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache optimisation)
COPY package*.json ./
RUN npm ci --only=production && \
    npm ci  # install devDeps for build

COPY . .
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache wget dumb-init

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S eugym -u 1001 -G nodejs

# Copy built output and production deps
COPY --from=builder --chown=eugym:nodejs /app/dist       ./dist
COPY --from=builder --chown=eugym:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=eugym:nodejs /app/package.json ./

# Create logs directory
RUN mkdir -p logs && chown eugym:nodejs logs

USER eugym

EXPOSE 4000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
