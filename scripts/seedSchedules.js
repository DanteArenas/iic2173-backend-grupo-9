const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of envLines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

if (!fs.existsSync('/.dockerenv') && process.env.POSTGRES_HOST === 'postgres') {
  process.env.POSTGRES_HOST = 'localhost';
}

const sequelize = require('../src/web_server/database');
const Schedule = require('../src/web_server/models/Schedule');

const schedulePayloads = [
  // Las Condes
  {
    property_url: 'https://demo.propertiesmarket.tech/property/las-condes-smartloft',
    starts_at: '2025-09-01T15:00:00.000Z',
    ends_at: '2025-09-01T16:00:00.000Z',
    price_clp: 12500000,
    discount_pct: 0,
    status: 'AVAILABLE',
  },
  {
    property_url: 'https://demo.propertiesmarket.tech/property/las-condes-smartloft',
    starts_at: '2025-09-03T18:30:00.000Z',
    ends_at: '2025-09-03T19:30:00.000Z',
    price_clp: 12500000,
    discount_pct: 5,
    status: 'AVAILABLE',
  },
  // Ñuñoa
  {
    property_url: 'https://demo.propertiesmarket.tech/property/nunoa-family-house',
    starts_at: '2025-09-02T17:00:00.000Z',
    ends_at: '2025-09-02T18:00:00.000Z',
    price_clp: 17850000,
    discount_pct: 0,
    status: 'AVAILABLE',
  },
  {
    property_url: 'https://demo.propertiesmarket.tech/property/nunoa-family-house',
    starts_at: '2025-09-04T13:00:00.000Z',
    ends_at: '2025-09-04T14:30:00.000Z',
    price_clp: 17850000,
    discount_pct: 10,
    status: 'AVAILABLE',
  },
  // Viña del Mar
  {
    property_url: 'https://demo.propertiesmarket.tech/property/vina-del-mar-bayview',
    starts_at: '2025-09-01T20:00:00.000Z',
    ends_at: '2025-09-01T21:00:00.000Z',
    price_clp: 9290000,
    discount_pct: 0,
    status: 'AVAILABLE',
  },
  {
    property_url: 'https://demo.propertiesmarket.tech/property/vina-del-mar-bayview',
    starts_at: '2025-09-03T12:00:00.000Z',
    ends_at: '2025-09-03T13:00:00.000Z',
    price_clp: 9290000,
    discount_pct: 0,
    status: 'AVAILABLE',
  },
];

async function seed() {
  await sequelize.authenticate();
  console.log('✅ Conectado a la base de datos (schedules)');

  for (const payload of schedulePayloads) {
    const existing = await Schedule.findOne({
      where: {
        property_url: payload.property_url,
        starts_at: new Date(payload.starts_at),
      },
    });

    if (existing) {
      await existing.update({
        ends_at: new Date(payload.ends_at),
        price_clp: payload.price_clp,
        discount_pct: payload.discount_pct,
        status: payload.status,
        updated_at: new Date(),
      });
      console.log(`♻️ Schedule actualizado para ${payload.property_url} (${payload.starts_at})`);
    } else {
      await Schedule.create({
        ...payload,
        starts_at: new Date(payload.starts_at),
        ends_at: new Date(payload.ends_at),
        created_at: new Date(),
        updated_at: new Date(),
      });
      console.log(`✨ Schedule creado para ${payload.property_url} (${payload.starts_at})`);
    }
  }

  await sequelize.close();
  console.log('🏁 Seeding de schedules completado.');
}

seed().catch((err) => {
  console.error('❌ Error sembrando schedules:', err);
  sequelize.close();
  process.exit(1);
});
