\c properties_db;

-- Habilitar la extensión unaccent
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Crear la base de datos si no existe (opcional, solo si quieres crearla desde cero)
-- CREATE DATABASE properties_db;

-- Crear la tabla properties si no existe
CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    data JSONB NOT NULL,
    visits INT DEFAULT 1,
    reservation_cost INT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    auth0_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enforce unique emails (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users ((LOWER(email)));
CREATE UNIQUE INDEX IF NOT EXISTS users_auth0_id_unique_idx ON users (auth0_user_id);


-- Tipos ENUM
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_status') THEN
    CREATE TYPE purchase_status AS ENUM ('OK','ACCEPTED','REJECTED','ERROR');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_type') THEN
    CREATE TYPE event_type AS ENUM (
      'PROPERTY_INFO',         -- llegó una propiedad nueva
      'REQUEST_SENT',          -- enviamos una solicitud
      'VALIDATION_ACCEPTED',   -- validación OK
      'VALIDATION_REJECTED',   -- validación rechazada
      'VALIDATION_ERROR',      -- error de formato
      'REQUEST_OTHER_GROUP'    -- otra compra ajena que afecta stock
    );
  END IF;
END$$;

-- Tabla purchase_requests
CREATE TABLE IF NOT EXISTS purchase_requests (
  id              SERIAL PRIMARY KEY,
  request_id      UUID NOT NULL UNIQUE,
  user_id         INTEGER NULL,
  property_url    TEXT   NOT NULL,
  amount_clp      INTEGER NULL,
  status          purchase_status NOT NULL DEFAULT 'OK',
  reason          TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_purchase_requests_url    ON purchase_requests (property_url);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests (status);

-- Tabla event_logs
CREATE TABLE IF NOT EXISTS event_logs (
  id                 SERIAL PRIMARY KEY,
  type               event_type NOT NULL,
  payload            JSONB      NOT NULL DEFAULT '{}'::jsonb,
  related_request_id UUID       NULL REFERENCES purchase_requests(request_id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_logs_type              ON event_logs (type);
CREATE INDEX IF NOT EXISTS idx_event_logs_related_request   ON event_logs (related_request_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_created_at_desc   ON event_logs (created_at DESC);

-- Campo reserved_count en properties
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='properties' AND column_name='reserved_count'
  ) THEN
    ALTER TABLE properties ADD COLUMN reserved_count INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_properties_reserved_count ON properties (reserved_count);
  END IF;
END$$;

-- Campo retry_used en purchase_requests (permitir solo un reintento por solicitud)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='purchase_requests' AND column_name='retry_used'
  ) THEN
    ALTER TABLE purchase_requests ADD COLUMN retry_used BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_retry_used ON purchase_requests (retry_used);
  END IF;
END$$;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_purchase_requests_updated_at'
  ) THEN
    CREATE TRIGGER trg_touch_purchase_requests_updated_at
    BEFORE UPDATE ON purchase_requests
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_event_logs_updated_at'
  ) THEN
    CREATE TRIGGER trg_touch_event_logs_updated_at
    BEFORE UPDATE ON event_logs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END$$;
