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

-- Tabla de usuarios para el registro en la plataforma (RF01)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enforce unique emails (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users ((LOWER(email)));