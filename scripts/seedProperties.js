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
const Property = require('../src/web_server/models/Property');

const SAMPLE_PROPERTIES = [
  {
    url: 'https://demo.propertiesmarket.tech/property/las-condes-smartloft',
    timestamp: '2025-08-10T14:32:00.000Z',
    location: 'Cerro El Plomo 5680, Las Condes, RM',
    price: 125_000_000,
    currency: 'CLP',
    title: 'Smart loft 2D/2B en Las Condes',
    description:
      'Departamento remodelado con cocina integrada, orientación oriente, incluye estacionamiento y bodega.',
    bedrooms: 2,
    bathrooms: 2,
    parking_spots: 1,
    surface_m2: 85,
    commune: 'Las Condes',
    region: 'Metropolitana',
    images: [
      'https://picsum.photos/id/1018/800/600',
      'https://picsum.photos/id/1015/800/600',
    ],
    tags: ['remodelado', 'cercano a metro', 'ideal inversionistas'],
  },
  {
    url: 'https://demo.propertiesmarket.tech/property/nunoa-family-house',
    timestamp: '2025-08-08T19:05:30.000Z',
    location: 'Simón Bolívar 2800, Ñuñoa, RM',
    price: 178_500_000,
    currency: 'CLP',
    title: 'Casa familiar 3D/3B con patio',
    description:
      'Casa aislada a pasos de Plaza Ñuñoa, con quincho, logia y estacionamiento para 2 autos.',
    bedrooms: 3,
    bathrooms: 3,
    parking_spots: 2,
    surface_m2: 140,
    commune: 'Ñuñoa',
    region: 'Metropolitana',
    images: [
      'https://picsum.photos/id/1020/800/600',
      'https://picsum.photos/id/1021/800/600',
    ],
    tags: ['patio grande', 'quincho', 'colegios cercanos'],
  },
  {
    url: 'https://demo.propertiesmarket.tech/property/vina-del-mar-bayview',
    timestamp: '2025-08-07T09:15:10.000Z',
    location: 'Calle Limache 3863, Viña del Mar, Valparaíso',
    price: 92_900_000,
    currency: 'CLP',
    title: 'Depto BayView 1D/1B con vista al mar',
    description:
      'Ideal para arriendo turístico, edificio con piscina temperada, gimnasio y cowork.',
    bedrooms: 1,
    bathrooms: 1,
    parking_spots: 0,
    surface_m2: 48,
    commune: 'Viña del Mar',
    region: 'Valparaíso',
    images: [
      'https://picsum.photos/id/1025/800/600',
      'https://picsum.photos/id/1024/800/600',
    ],
    tags: ['vista al mar', 'inversión', 'full amenities'],
  },
];

const inferReservationCost = (propertyData) => {
  if (
    typeof propertyData.price === 'number' &&
    Number.isFinite(propertyData.price) &&
    propertyData.price > 0
  ) {
    return Math.round(propertyData.price * 0.1);
  }
  return null;
};

async function seed() {
  await sequelize.authenticate();
  console.log('✅ Conectado a la base de datos');

  for (const propertyData of SAMPLE_PROPERTIES) {
    const reservationCost = inferReservationCost(propertyData);

    const existing = await Property.findOne({
      where: sequelize.where(
        sequelize.json('data.url'),
        propertyData.url
      ),
    });

    if (existing) {
      await existing.update({
        data: propertyData,
        reservation_cost: reservationCost,
        updated_at: propertyData.timestamp,
      });
      console.log(`♻️ Propiedad actualizada: ${propertyData.url}`);
    } else {
      await Property.create({
        data: propertyData,
        visits: 1,
        reservation_cost: reservationCost,
        updated_at: propertyData.timestamp,
      });
      console.log(`✨ Propiedad creada: ${propertyData.url}`);
    }
  }

  await sequelize.close();
  console.log('🏁 Seeding completado.');
}

seed().catch((err) => {
  console.error('❌ Error sembrando propiedades:', err);
  sequelize.close();
  process.exit(1);
});
