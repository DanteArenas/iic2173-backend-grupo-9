const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
    process.env.POSTGRES_DB || 'properties_db',
    process.env.POSTGRES_USER || 'properties_user',
    process.env.POSTGRES_PASSWORD || '',
    {
        host: process.env.POSTGRES_HOST || 'postgres',
        port: Number(process.env.POSTGRES_PORT || 5432),
        dialect: 'postgres',
        logging: false,
    }
);

module.exports = sequelize;
