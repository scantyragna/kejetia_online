# Deploying Kejetia Online

Status as of the last commit (`af58336`):

- ✅ All code pushed to GitHub → `github.com/scantyragna/kejetia_online` (branch `main`)
- ✅ `render.yaml` configured for an **external Neon** database (no Render DB — Render's
  free Postgres expires after 30 days; Neon's free tier does not)
- ✅ `Dockerfile` runs the schema migration automatically on every boot
- ⬜ **Left to do:** create the Neon + Render accounts, wire them, grant yourself admin,
  then test on a real phone

Everything below happens in a browser except the two `node` commands, which you run
locally.

---

## 0. What you need

| Thing | Where | Notes |
|-------|-------|-------|
| A Neon account (free) | https://neon.tech | The Postgres database |
| A Render account (free) | https://render.com | The web hosting |
| The GitHub repo connected to Render | `scantyragna/kejetia_online` | Already pushed; just connect it |

---

## 1. Create the database (Neon)

1. Sign up at https://neon.tech and create a project.
2. On the **Dashboard**, find the connection string.
3. Copy the **POOLED** string — it has `-pooler` in the host, e.g.
   `ep-xxx-pooler.aws.neon.tech`. **Do not use the direct string**: it has a tiny
   connection limit and will start refusing connections under real traffic.

   ⚠️ This string is a master key to your database. Don't commit it, don't put it in
   client-side code, and treat it like a password.

---

## 2. Create the hosting (Render)

1. Sign up at https://render.com.
2. **New → Blueprint** → connect GitHub → pick `scantyragna/kejetia_online`.
3. Render reads `render.yaml` and builds the web service. There is deliberately **no
   database** in the Blueprint — the database is Neon.
4. Once the service exists, go to **Environment** → add a new env var:
   - Key: `DATABASE_URL`
   - Value: your Neon **pooled** connection string

   (`render.yaml` marks it `sync: false` on purpose, so you must paste it by hand.)

5. Wait for it to build and deploy. The first deploy takes a few minutes.

> **What happens on boot:** the container runs
> `node ./scripts/migrate.mjs && npm start`. The migration applies `db/schema.sql`
> (including all the Map Studio tables) automatically and idempotently, so there is no
> manual database setup. If the migration fails, the container refuses to start — check
> the logs.

---

## 3. Grant yourself admin

The admin flag (`profiles.is_admin`) can't be set from any signup form or API call — it
must be granted by script. Run this **once** against the live database.

`migrate.mjs` and `make-admin.mjs` read `process.env.DATABASE_URL` directly and do
**not** load `.env.local` themselves, so export the variable in your shell first:

```bash
cd frontend
export DATABASE_URL="your-neon-pooled-connection-string"   # PowerShell: $env:DATABASE_URL="..."
node scripts/make-admin.mjs your-email@example.com
```

You should see: `✓ your-email@example.com is now an admin`. After a refresh you'll see
**Map Admin** in the site header.

---

## 4. Test on real phones

Open the deployed HTTPS URL on your phone. **GPS only works over HTTPS** (browsers
refuse geolocation on plain `http://` and on `localhost`), so this is the only way to
test the live-mapping feature for real.

- Sign in → **Map Studio** → **Start Trail** → accept the location prompt.
- Add a photo landmark, label a walkway, submit.
- On a second phone (or desktop), sign in as the admin account → **Map Admin** →
  watch the contributor's dot move live and approve the submitted session.

---

## Optional: test against the real database locally first

If you'd rather prove the schema works before Render picks it up:

```bash
cd frontend
# Put the Neon pooled string in frontend/.env.local:
#   DATABASE_URL=postgres://...-pooler...
#   NEXT_PUBLIC_DB_MODE=postgres

# Apply the schema. The app reads .env.local, but this script does not —
# so export the var explicitly:
export DATABASE_URL="your-neon-pooled-connection-string"   # PowerShell: $env:DATABASE_URL="..."
node scripts/migrate.mjs

# Then run the app in postgres mode:
npm run dev
```

If the migration prints `Schema is up to date.` and the app signs people in normally,
the database side is proven good.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Deploy fails / container won't start | Migration error | Render → service → **Logs**; the migrate step prints the SQL error |
| `password authentication failed` | Wrong DB string or using the **direct** Neon endpoint | Use the `-pooler` pooled string |
| Connection refused under load | Using the direct Neon endpoint | Switch `DATABASE_URL` to the pooled string |
| Site loads but nobody can sign up / data missing | `NEXT_PUBLIC_DB_MODE` not `postgres` | It's pinned in `render.yaml`; if unset the app silently runs in mock (localStorage) mode |
| No **Map Admin** link | You haven't been granted admin | Run step 3, then refresh |
| Phone can't get GPS | Not HTTPS | Use the deployed `https://` URL, not `localhost` |

---

## Note on the git credentials

The last push initially failed because the local Git Credential Manager was logged in as
a different GitHub account (`cycy4016-star`) than the repo owner (`scantyragna`). If you
hit `Permission ... denied` when pushing, clear the stored credential and re-login as the
repo-owning account:

```bash
echo -e "protocol=https\nhost=github.com" | git credential reject
git push origin main   # a GitHub login window should appear
```
