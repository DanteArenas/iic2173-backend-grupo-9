---------------------------------------------------------
-- PATCH E3: UUIDs para Subastas/Propuestas entre grupos
-- Este script actualiza la BD para cumplir RNF04 y RNF05
-- Ejecutar una sola vez en PostgreSQL
---------------------------------------------------------
--QUIZA TAMBIEN FALTA BORRAR starts_at y end_at de SCHEDULE

-- 1) Activar extensión para generar UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE property_schedules
DROP COLUMN ends_at;

ALTER TABLE property_schedules
DROP COLUMN starts_at;
---------------------------------------------------------
-- 2) Agregar auction_uuid a property_auctions
---------------------------------------------------------
ALTER TABLE property_auctions
ADD COLUMN IF NOT EXISTS auction_uuid UUID;

-- Poblar UUIDs para filas existentes
UPDATE property_auctions
SET auction_uuid = gen_random_uuid()
WHERE auction_uuid IS NULL;

-- Hacerlo obligatorio
ALTER TABLE property_auctions
ALTER COLUMN auction_uuid SET NOT NULL;

-- Índice único
ALTER TABLE property_auctions
ADD CONSTRAINT uq_property_auctions_uuid UNIQUE (auction_uuid);

---------------------------------------------------------
-- 3) Agregar proposal_uuid a exchange_proposals
---------------------------------------------------------
ALTER TABLE exchange_proposals
ADD COLUMN IF NOT EXISTS proposal_uuid UUID;

-- Poblar UUIDs para filas existentes
UPDATE exchange_proposals
SET proposal_uuid = gen_random_uuid()
WHERE proposal_uuid IS NULL;

-- Hacerlo obligatorio
ALTER TABLE exchange_proposals
ALTER COLUMN proposal_uuid SET NOT NULL;

-- Índice único
ALTER TABLE exchange_proposals
ADD CONSTRAINT uq_exchange_proposals_uuid UNIQUE (proposal_uuid);

---------------------------------------------------------
-- 4) Agregar auction_uuid a exchange_proposals
---------------------------------------------------------
ALTER TABLE exchange_proposals
ADD COLUMN IF NOT EXISTS auction_uuid UUID;

-- Poblar auction_uuid basándose en la FK actual
UPDATE exchange_proposals ep
SET auction_uuid = pa.auction_uuid
FROM property_auctions pa
WHERE ep.auction_id = pa.id
  AND ep.auction_uuid IS NULL;

-- Hacerlo obligatorio
ALTER TABLE exchange_proposals
ALTER COLUMN auction_uuid SET NOT NULL;


---------------------------------------------------------
-- FIN DEL SCRIPT
---------------------------------------------------------

