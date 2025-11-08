// src/web_server/services/publishValidation.js
const mqtt = require('mqtt');

let client;
function ensureClient() {
  if (client) return client;
  const host = process.env.HOST;          // broker.iic2173.org
  const port = process.env.PORT || 9000;  // 9000
  const user = process.env.USER_mqtt;
  const pass = process.env.PASSWORD;
  client = mqtt.connect(`mqtt://${host}:${port}`, { username: user, password: pass, reconnectPeriod: 2000 });
  client.on('error', (e) => console.error('MQTT pub error:', e.message));
  return client;
}

async function publishValidation(payload) {
  const c = ensureClient();
  const topic = 'properties/validation';
  return new Promise((resolve, reject) => {
    c.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => err ? reject(err) : resolve());
  });
}

module.exports = { publishValidation };
