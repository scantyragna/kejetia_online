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

-- ── USER LOCATIONS (live map dots, one row per user) ─────────
CREATE TABLE IF NOT EXISTS public.user_locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
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

-- ── Extensions ------------------------------------------------
-- gen_random_uuid() is core since Postgres 13 (Render uses >= 15).