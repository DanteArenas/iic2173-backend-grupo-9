     -- sql/create_recommendations.sql

-- (Opcional) extensiones útiles
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Cola de trabajos de recomendaciones
CREATE TABLE IF NOT EXISTS recommendations_queue (
  id              BIGSERIAL PRIMARY KEY,
  request_id      UUID NOT NULL UNIQUE,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  payload         JSONB NOT NULL, -- parámetros de la recomendación (ej. filtros)
  status          TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','DONE','ERROR')) DEFAULT 'PENDING',
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rec_queue_status_created
  ON recommendations_queue (status, created_at);

CREATE INDEX IF NOT EXISTS idx_rec_queue_user
  ON recommendations_queue (user_id);

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION trg_rec_queue_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_rec_queue_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_rec_queue_set_updated_at
    BEFORE UPDATE ON recommendations_queue
    FOR EACH ROW
    EXECUTE FUNCTION trg_rec_queue_touch_updated_at();
  END IF;
END$$;

-- Resultados de recomendaciones
CREATE TABLE IF NOT EXISTS recommendations_results (
  id           BIGSERIAL PRIMARY KEY,
  request_id   UUID NOT NULL REFERENCES recommendations_queue(request_id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL,
  items        JSONB NOT NULL,    -- arreglo de propiedades recomendadas
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rec_results_user_created
  ON recommendations_results (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rec_results_req
  ON recommendations_results (request_id);
