'use strict';

require('dotenv').config(); // Cargar las variables del archivo .env

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME_WEB_SERVER],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  distributed_tracing: {
    enabled: process.env.NEW_RELIC_DISTRIBUTED_TRACING_ENABLED === 'true',
  },
};