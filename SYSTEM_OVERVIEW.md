# Kejetia Online — System Overview

A plain-language guide to how the platform works: the pieces that run it, how
user data flows through it, how security works, what the limits are, and how
it grows. Written for founders, engineers, and future teammates.

---

## 1. The big picture: one machine + one database

Deployed, the platform runs on **two machines** (plus GitHub as the code
locker). There is no separate backend server — the Next.js app *is* the
backend.

| Piece | What it runs | Analogy |
|---|---|---|
| **Render (web service)** | The whole Next.js app — pages a visitor's browser downloads, *and* the backend API routes in `frontend/app/api/*` which run in the same container. | The **shop front + cashier desk + back office**. |
| **Render Postgres** | One managed PostgreSQL database — user accounts, stores, products, reviews, chats, live locations, and photo bytes. | The **ledger, stockroom, and messenger**. |
| **GitHub** | Just stores the code. Render pulls from GitHub and deploys it. | The **blueprint filing cabinet**. |

All the "backend" work — signup/login, every data read and write, realtime
updates, image storage — happens in **Next.js API routes** (`app/api/*`):

1. **`/api/auth/*`** — signup/signin/signout/session. Passwords are bcrypt-
   hashed; signing in sets an httpOnly session cookie (30 days).
2. **`/api/query`** — the generic data gateway. The browser sends a small way
   of describing "fetch stores where active" / "insert this product" etc., and
   the route builds parameterized SQL, **enforces authorization**, runs it
   against Postgres, and returns the rows.
3. **`/api/events`** — realtime. The browser polls this endpoint every ~2 s;
   it returns rows that changed since the last poll. This is what makes chat
   messages, new stores, and map dots appear on other users' screens without a
   page refresh.
4. **`/api/media/*`** — photo upload + serving. Photos live inside Postgres
   (BYTEA) and are served through an API path, so no separate object storage
   is needed.

The old `backend/` folder (Express, one `/api/health` endpoint) is a stub —
nothing flows through it. It is retired from the architecture and exists only
in the repo for historical reference.

---

## 2. How user data flows (the journey)

Every table below is real Postgres. In **mock mode** (no `NEXT_PUBLIC_DB_MODE`
set), the exact same code runs against `localStorage` in the visitor's own
browser — perfect for development, useless for a real product. Set the two env
vars (`NEXT_PUBLIC_DB_MODE=postgres` + `DATABASE_URL`) and the same code talks
to the cloud database instead.

**A buyer signs up.** `/api/auth/signup` creates a row in `users` (email +
bcrypt password hash) and a matching row in `profiles` (name, phone, role =
`buyer`). Two tables on purpose: credentials are private, the profile is safe
to show. A hashed token is stored in `sessions` and set as the `kj_session`
httpOnly cookie.

**A seller creates a store.** One row in `stores`: name, description, phone,
WhatsApp number, and **latitude/longitude** — this is what powers every map
pin in the app. The `owner_id` column links it to the seller's profile.
Anyone can view a store, only the owner can edit it (enforced by the API
route, not by the database).

**The seller lists products.** One row in `products` per item: name, price,
`stock` (blank = plenty, 0 = out, 1–5 = low), `old_price` (a higher "was"
price turns the item into a −% deal everywhere). Product **photos** are
compressed in the browser (<500 KB), uploaded via `/api/media/upload`, stored
as bytes in the `media` table, and referenced by URL
(`/api/media/product-images/…`).

**A buyer reviews a store.** One row in `reviews` → a **Postgres trigger**
fires → recomputes `stores.rating` and `stores.review_count`. The rating you
see on the homepage, search, and map is *derived from actual reviews*, not
hand-typed.

**Chat.** One `conversations` row links a buyer to a store, and `messages`
rows carry the conversation. The browser polls `/api/events` every ~2 s for
new messages, and the server only ever returns conversations/messages that
belong to the signed-in user.

**The map.** Stores carry coordinates. The app renders them on free CARTO/OSM
tiles, with a geo-referenced Kejetia image overlay at high zoom, an in-market
walking graph (`lib/kejetia-graph.js`), and Google-Maps deep links for turn-by-
turn. Signed-in users who grant geolocation write their position to
`user_locations` on a ~60 s heartbeat (or as soon as they walk ~25 m); every
browser polls for those rows, so live "user dots" appear and retire after
~10 min of silence. Sharing starts from an explicit gesture — the map's "Find
my location" control — and only fixes within 100 m are published, always
together with their `accuracy`. Rougher fixes are held back rather than
painted in the wrong place, and the read path filters on the same threshold,
so a dot always means "at least this accurate" (rendered with an uncertainty
halo).

---

## 3. Security: the wall is in the API layer

Supabase used Row Level Security *inside the database*. This app has no RLS —
instead, **every API route checks "who is asking?" before it runs any SQL,**
using the signed-in user from the httpOnly session cookie. Concretely:

- A signed-out visitor can read stores/products/landmarks but gets denied any
  write (and any chat/message read).
- Store editing requires `owner_id = <your id>`; product editing requires the
  product to belong to *your* store.
- Conversations and messages are only ever returned to their participants.
- Writes go through a strict column allowlist (`INSERT_COLUMNS` /
  `UPDATE_COLUMNS` in `app/api/query/route.js`) — a client cannot set
  `owner_id`, `rating`, `review_count`, or another user's fields.

Passwords never leave the server as plaintext (bcrypt hash at rest), session
tokens are stored hashed (SHA-256) in `sessions`, and the cookie is `httpOnly`
(JavaScript can't read it, so XSS can't steal it).

The schema and all authorization live in one readable file:
`frontend/db/schema.sql` + the API routes that read it.

---

## 4. Capacity: how many users fit, and where the ceilings are

Verified numbers (2026, Render free tiers).

### The onboarding constraint: the database

**Render's free Postgres expires after 30 days.** For persistent "deploy
always" hosting, upgrade the database to a paid plan before that window
closes. After expiry the DB is deleted — all users, stores and photos are
gone and the database must be recreated.

### Storage & database

| Resource | Free limit | What it means |
|---|---|---|
| Database | 1 GB (free) | Tens of thousands of user/store/product/review rows — plenty. Photos are bytes here too, which is why client-side compression to <500 KB matters. |
| Web service | free instance sleeps after ~15 min idle | Wakes on the next request (first load after idle ~30 s). Not an issue while live. |
| Realtime | HTTP polling, ~2 s | Good enough for chat + live map at this scale. A WebSocket layer is the upgrade path for sub-second delivery. |
| Auth | app-managed, no external limits | No email-confirmation sender caps (signup logs straight in). If you add email verification later, pick any SMTP provider. |

### The honest flags

- **No African Render region.** Closest is Frankfurt (eu-central-1),
  ~100 ms from Ghana. Pick the region when creating the database — it can
  never be changed afterward.
- **Maps run on free community services** (OSRM routing, CARTO/OSM tiles).
  Free but rate-limited and with no SLA. Fine at launch; budget for a paid
  tiles/routing provider when the map becomes the flagship (it will).
- **WhatsApp links are manual deep links** (`wa.me`). No delivery tracking,
  read receipts, or templates. The WhatsApp Business API (paid, Meta-approved)
  is the upgrade path.
- **"Free forever" is a myth.** The honest upgrade path, in order:
  1. Upgrade Render Postgres past the free 30-day plan (persistence) —
     first and non-negotiable for real hosting.
  2. Paid web service instance (always-hot, more CPU/RAM) — when the free
     sleep/limits start to pinch.
  3. Media/CDN split — if photos-in-Postgres ever grow large, move images to
     an object store (S3/Cloudflare R2) and store URLs instead of bytes.
  By then the platform should have revenue to carry them.

---

## 5. Running the stack

### Modes

- **Mock mode (dev):** `NEXT_PUBLIC_DB_MODE` unset → everything persisted to
  `localStorage` under `kejetia_v2_*`. Tables start empty (demo data was
  removed at launch). Great for pure UI work — no database needed.
- **Postgres mode (production):** set `NEXT_PUBLIC_DB_MODE=postgres` (client-
  side) and `DATABASE_URL` (server-side) → the same code talks to our own API
  routes, which talk to Postgres.

### Schema & migrations (`frontend/db/schema.sql`)

One file, applied automatically at container boot by
`frontend/scripts/migrate.mjs`. It is idempotent (safe to re-run) and
creates: `users`, `sessions`, `profiles`, `stores`, `products`, `reviews`
(+ rating trigger), `landmarks`, `conversations`, `messages`,
`user_locations`, and `media`. The old `supabase-migrations/` folder is
historical and superseded — do not use it.

### Deploy

Render Blueprint (`render.yaml`): import the GitHub repo, one click provisions
the web service + Postgres, wires `DATABASE_URL`
(`fromDatabase`) and `NEXT_PUBLIC_DB_MODE=postgres`, runs the migration at
boot, and the site is live. See `DEPLOYMENT.md` for the exact runbook.