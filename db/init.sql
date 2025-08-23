-- Habilitar la extensión unaccent
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Crear la base de datos si no existe (opcional, solo si quieres crearla desde cero)
-- CREATE DATABASE properties_db;

-- Crear la tabla properties si no existe
CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    data JSONB NOT NULL,
    visits INT DEFAULT 1
);