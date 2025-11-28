const ensureDbSchemaUpgrades = async (sequelize) => {
  try {
    await sequelize.query(
      `ALTER TABLE purchase_requests
       ADD COLUMN IF NOT EXISTS retry_used BOOLEAN NOT NULL DEFAULT FALSE`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_requests_retry_used
       ON purchase_requests (retry_used)`
    );
    await sequelize.query(
      `ALTER TABLE purchase_requests
       ADD COLUMN IF NOT EXISTS invoice_url TEXT`
    );
    await sequelize.query(
      `ALTER TABLE purchase_requests
       ADD COLUMN IF NOT EXISTS schedule_id INTEGER`
    );

    await sequelize.query(
      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`
    );
    await sequelize.query(
      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS group_id INTEGER`
    );

    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS property_schedules (
         id SERIAL PRIMARY KEY,
         property_url TEXT NOT NULL,
         price_clp INTEGER NOT NULL,
         discount_pct INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'AVAILABLE',
         created_by INTEGER,
         owner_group_id INTEGER,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_property_schedules_property_status
       ON property_schedules (property_url, status)`
    );

    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS property_auctions (
         id SERIAL PRIMARY KEY,
         schedule_id INTEGER NOT NULL REFERENCES property_schedules(id) ON DELETE CASCADE,
         owner_group_id INTEGER,
         min_price INTEGER,
         status TEXT NOT NULL DEFAULT 'OPEN',
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );

    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS exchange_proposals (
         id SERIAL PRIMARY KEY,
         auction_id INTEGER NOT NULL REFERENCES property_auctions(id) ON DELETE CASCADE,
         from_group_id INTEGER,
         to_group_id INTEGER,
         offering_schedule_id INTEGER REFERENCES property_schedules(id) ON DELETE SET NULL,
         message TEXT,
         status TEXT NOT NULL DEFAULT 'PENDING',
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_exchange_proposals_status
       ON exchange_proposals (status)`
    );

    console.log('✅ Esquema verificado: columnas e índices críticos listos.');
  } catch (err) {
    console.warn('⚠️ No se pudo asegurar el esquema:', err.message || err);
  }
};

module.exports = { ensureDbSchemaUpgrades };
