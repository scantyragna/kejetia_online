-- ============================================================
-- Kejetia Online — consolidated Postgres schema (self-hosted)
-- ------------------------------------------------------------
-- Replaces the old Supabase migrations (RLS, auth.users triggers
-- and supabase_realtime are gone — auth is app-managed via the
-- sessions cookie, authorization happens in the API
-- routes, and realtime is HTTP polling).
--
-- Run with:  psql "$DATABASE_URL" -f db/schema.sql
-- (skipped automatically at container boot when the tables
--  already exist — see scripts/migrate.mjs)
--
-- Safe to run more than once (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- ── Shared updated_at trigger ────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ── USERS (app-managed auth, replaces Supabase Auth) ─────────
CREATE TABLE IF NOT EXISTS public.users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON public.users (LOWER(email));

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── SESSIONS (opaque bearer tokens in an httpOnly cookie) ────
CREATE TABLE IF NOT EXISTS public.sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON public.sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON public.sessions (user_id);

-- ── PROFILES (canonical public user data) ────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'seller')),
  city        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create the profile row whenever a user account is created
-- (the API also does this explicitly; the trigger is a safety net).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, phone, role)
  VALUES (NEW.id, '', '', 'buyer')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_user_created ON public.users;
CREATE TRIGGER on_user_created
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── STORES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  phone            TEXT,
  whatsapp         TEXT,
  address          TEXT,
  image_url        TEXT,
  category         TEXT,
  icon             TEXT,
  operating_hours  TEXT,
  latitude         DOUBLE PRECISION,
  longitude        DOUBLE PRECISION,
  rating           NUMERIC(3, 1),
  review_count     INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS stores_set_updated_at ON public.stores;
CREATE TRIGGER stores_set_updated_at
  BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS stores_owner_idx ON public.stores (owner_id);
CREATE INDEX IF NOT EXISTS stores_category_idx ON public.stores (category);

-- ── PRODUCTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  price         NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  old_price     NUMERIC(12, 2),
  stock         INTEGER CHECK (stock IS NULL OR stock >= 0),
  category      TEXT,
  icon          TEXT,
  images        JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_available  BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS products_set_updated_at ON public.products;
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS products_store_idx ON public.products (store_id);
CREATE INDEX IF NOT EXISTS products_category_idx ON public.products (category);

-- ── REVIEWS (rating aggregates stay in sync via trigger) ─────
CREATE TABLE IF NOT EXISTS public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  author_name TEXT NOT NULL,
  author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reviews_store_idx ON public.reviews (store_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.refresh_store_rating(target_store UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  avg_rating NUMERIC;
  total_reviews INTEGER;
BEGIN
  SELECT ROUND(AVG(rating)::NUMERIC, 1), COUNT(*)::INTEGER
    INTO avg_rating, total_reviews
    FROM reviews
   WHERE store_id = target_store;

  UPDATE stores
     SET rating = avg_rating,
         review_count = total_reviews
   WHERE id = target_store;
END;
$$;

CREATE OR REPLACE FUNCTION public.reviews_rating_trigger_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_store_rating(OLD.store_id);
    RETURN OLD;
  END IF;
  PERFORM public.refresh_store_rating(NEW.store_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reviews_rating_trigger ON public.reviews;
CREATE TRIGGER reviews_rating_trigger
  AFTER INSERT OR DELETE ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.reviews_rating_trigger_fn();

-- ── LANDMARKS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.landmarks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  notes       TEXT,
  category    TEXT,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  photo_url   TEXT,
  store_id    UUID REFERENCES public.stores(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS landmarks_store_idx ON public.landmarks (store_id);

-- ── CONVERSATIONS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  buyer_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS conversations_set_updated_at ON public.conversations;
CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS conversations_store_idx ON public.conversations (store_id);
CREATE INDEX IF NOT EXISTS conversations_buyer_idx ON public.conversations (buyer_id);

-- ── MESSAGES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON public.messages (conversation_id, created_at);

-- One thread per (store, buyer). The chat UI's find-or-create can race, so
-- uniqueness is enforced here: the API turns a duplicate insert into a
-- refetch instead of silently forking the message history into two rows.
-- Existing duplicates are merged first (messages move to the OLDEST thread),
-- so this is safe to run on a database that already has them.
DO $$
DECLARE
  dup RECORD;
  keeper UUID;
BEGIN
  FOR dup IN
    SELECT store_id, buyer_id, array_agg(id ORDER BY created_at) AS ids
      FROM public.conversations
     GROUP BY store_id, buyer_id
    HAVING COUNT(*) > 1
  LOOP
    keeper := dup.ids[1];
    UPDATE public.messages SET conversation_id = keeper
     WHERE conversation_id = ANY(dup.ids[2:]);
    DELETE FROM public.conversations WHERE id = ANY(dup.ids[2:]);
    RAISE NOTICE 'Merged % duplicate conversation(s) for store % / buyer % into %',
      array_length(dup.ids, 1) - 1, dup.store_id, dup.buyer_id, keeper;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_store_buyer_key
  ON public.conversations (store_id, buyer_id);

-- ── USER LOCATIONS (live map dots, one row per user) ─────────
CREATE TABLE IF NOT EXISTS public.user_locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  -- Metres (Postgres `coords.accuracy`). Kept on the row so every reader can
  -- tell a 5 m GPS fix from a 1 km IP guess: a dot published without this is
  -- indistinguishable from an exact one, which is how the map ended up
  -- showing people in the wrong neighbourhood. NULL = legacy row, unknown.
  accuracy    DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS user_locations_set_updated_at ON public.user_locations;
CREATE TRIGGER user_locations_set_updated_at
  BEFORE UPDATE ON public.user_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS user_locations_user_id_key
  ON public.user_locations (user_id);

-- ── LOCATION TRAILS (breadcrumbs — users draw the map by walking) ──
-- One row per movement fix. The live map draws the last 24h per user as a
-- fading polyline, so foot traffic literally sketches walkways. user_locations
-- stays as the "current dot"; this table is the history behind it.
CREATE TABLE IF NOT EXISTS public.location_trails (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  accuracy    DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS location_trails_user_time_idx
  ON public.location_trails (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS location_trails_time_idx
  ON public.location_trails (created_at DESC);

-- ── MEDIA (product / landmark photos, 256 KB real cap) ───────
CREATE TABLE IF NOT EXISTS public.media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket        TEXT NOT NULL,
  key           TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'image/jpeg',
  data          BYTEA NOT NULL,
  owner_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS media_bucket_key_key ON public.media (bucket, key);

-- ── Profile + store photos (safe reruns for existing DBs) ─────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION;

-- ── MAP STUDIO (crowdsourced mapping, review-queue model) ─────────────
-- Contributors walk the market with the Studio tab: they record trails,
-- drop photo landmarks and label walkway segments. Everything lands as a
-- DRAFT attached to a trail_sessions row; only an admin confirmation
-- (is_admin on profiles) publishes it to the public map. Authorization
-- lives in app/api/query/route.js — the DB carries the lifecycle columns.

-- Admin flag. Separate from role (buyer/seller) so the existing role CHECK
-- constraint stays untouched; no signup path can ever set it (the API
-- never accepts it from a client). Grant via scripts/make-admin.mjs.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- One mapping outing: start → walk → submit for review.
CREATE TABLE IF NOT EXISTS public.trail_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'submitted', 'approved', 'rejected')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trail_sessions_set_updated_at ON public.trail_sessions;
CREATE TRIGGER trail_sessions_set_updated_at
  BEFORE UPDATE ON public.trail_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS trail_sessions_user_idx ON public.trail_sessions (user_id);
CREATE INDEX IF NOT EXISTS trail_sessions_status_idx ON public.trail_sessions (status, created_at DESC);

-- Landmarks grow the review lifecycle + multi-photo support.
-- Default 'published' keeps pre-Studio rows visible on the public map;
-- the API forces 'draft' for every new non-admin insert.
ALTER TABLE public.landmarks
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.trail_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS landmarks_status_idx ON public.landmarks (status);
CREATE INDEX IF NOT EXISTS landmarks_session_idx ON public.landmarks (session_id);

-- Line features: the walkways/roads/stairs contributors trace on foot.
-- geometry is a JSONB polyline: [[lat,lng], [lat,lng], …]
CREATE TABLE IF NOT EXISTS public.walkways (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID REFERENCES public.trail_sessions(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  name        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'walkway'
              CHECK (kind IN ('walkway', 'road', 'stairs', 'entrance', 'crossing', 'other')),
  geometry    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS walkways_set_updated_at ON public.walkways;
CREATE TRIGGER walkways_set_updated_at
  BEFORE UPDATE ON public.walkways
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS walkways_status_idx ON public.walkways (status);
CREATE INDEX IF NOT EXISTS walkways_session_idx ON public.walkways (session_id);
CREATE INDEX IF NOT EXISTS walkways_creator_idx ON public.walkways (created_by);

-- Community reports on published features (wrong pin, duplicate, moved…).
CREATE TABLE IF NOT EXISTS public.map_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_table TEXT NOT NULL CHECK (feature_table IN ('landmarks', 'walkways', 'stores')),
  feature_id    UUID NOT NULL,
  reason        TEXT NOT NULL DEFAULT 'other',
  detail        TEXT NOT NULL DEFAULT '',
  reporter_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS map_reports_status_idx ON public.map_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS map_reports_feature_idx ON public.map_reports (feature_table, feature_id);

-- ── Extensions ------------------------------------------------
-- gen_random_uuid() is core since Postgres 13 (Render uses >= 15).