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