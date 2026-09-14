# Publium — VPS deployment

Self-hosted stack: **Caddy** (edge + auto-HTTPS) → **API** (Express/Prisma/Playwright) → **Postgres**.
Uploaded files live on a local volume served at `/uploads` (replaces Vercel Blob).

```
Internet ──443──> Caddy ──/api/*──> api:8787 ──> db:5432
                    │   ──/uploads/*──> /srv/uploads (volume)
                    └── /            ──> SPA (static build)
```

## Prerequisites (already done on the server)

- Ubuntu 24.04, Docker + Compose, 2 GB swap, UFW (22/80/443 open).

## One-time setup

1. **Point DNS** — create an `A` record for your domain → the server's IPv4. Wait for it to resolve (`ping <domain>`), otherwise Caddy can't get a TLS cert.

2. **Get the code on the server**, e.g.:
   ```bash
   git clone https://github.com/HappyHolder/publium-miniapp.git /opt/publium
   cd /opt/publium/deploy
   ```

3. **Configure** — copy and fill the env file:
   ```bash
   cp .env.example .env
   nano .env        # set DOMAIN, a strong POSTGRES_PASSWORD, and all secrets
   ```
   Configure `OPENAI_API_KEY`, Telegram tokens/secrets, `MANAGED_BOT_ENCRYPTION_KEY` and TON wallet/API key. Replicate is optional for panoramas. Keep live secrets in `deploy/.env`; never print or commit them.

4. **Bring the stack up:**
   ```bash
   docker compose up -d --build
   ```
   On first boot the api container runs `prisma migrate deploy`, creating the schema.
   Caddy obtains a Let's Encrypt certificate automatically once DNS resolves.

5. **Point the Telegram webhook at the new domain:**
   ```bash
   docker compose exec api npm run set-webhook
   docker compose exec api npm run set-community-manager-webhook
   ```
   (or set it once via the Bot API with `WEBHOOK_URL=https://<domain>/api/bot/webhook`).
   Also set @Publiumbot's Mini App / menu-button URL to `https://<domain>`.

## Data migration (from the old cloud) — SKIPPED

> This deployment started **fresh** (empty database, no Vercel Blob import). The
> steps below are kept only for reference if a future migration from the old
> Render/Neon/Vercel stack is ever needed.

1. **Database** — dump Neon (use the **DIRECT_URL**, not the pooled one) and restore into the container:
   ```bash
   pg_dump "<NEON_DIRECT_URL>" -Fc -f neon.dump
   docker compose cp neon.dump db:/tmp/neon.dump
   docker compose exec db pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --no-owner /tmp/neon.dump
   ```

2. **Files** — the old covers/logos/templates are public Vercel Blob URLs stored in the DB
   (`PostVariant.bannerUrl`, `GeneratedPost.coverBaseUrl`, `BrandKit.visualKit`). Download each
   by its public URL into the `uploads` volume under the same path, then rewrite the URLs in the
   DB from `*.public.blob.vercel-storage.com/...` to `https://<domain>/uploads/...`.
   Do this **before** deleting the Vercel project. (A migration script can be added when we run it.)

## Operations

```bash
docker compose ps                 # status
docker compose logs -f api        # backend logs
docker compose logs -f web        # Caddy / TLS logs
docker compose up -d --build      # redeploy after a git pull
docker compose down               # stop (volumes are kept)
```

Backups: snapshot the `pgdata` and `uploads` volumes regularly.

## Release procedure (verified 2026-09-12)

Production: `root@45.146.165.97`, repository `/opt/publium`. Use the existing SSH key (`~/.ssh/id_ed25519`); do not copy the private key or put it in the repository.

1. Run types, unit/integration tests and the production frontend smoke test. CI repeats these checks.
2. Inspect remote git status and container health. Preserve server-local files and environment.
3. Before schema changes, create a PostgreSQL custom-format dump and verify it can be restored to an isolated database. Preserve the previous API/web images for rollback.
4. Push the reviewed release, then `git pull --ff-only origin main` in `/opt/publium`.
5. From `/opt/publium/deploy`, run `docker compose up -d --build`. API applies additive migrations on boot.
6. Check `docker compose ps`, `/api/health`, migration status, frontend assets and recent API logs. Do not publish real messages or make real purchases as smoke tests.

Only TON orders can create new purchases. Historical Stars tables remain for accounting; late paid notices are stored in `LegacyPaymentNotice` for manual reconciliation. Old Stars checkout is rejected.

`PublicationRecord.status = UNCERTAIN` (or a stale `SENDING`) requires checking the actual Telegram channel before an operator resets a post for retry. Never bulk-reset these records: the message may already be delivered.

Backups and rollback images contain production data/configuration references: store them on the server with restricted permissions. A database rollback requires an explicit recovery decision; additive migrations normally allow rolling the application back without deleting new tables.
