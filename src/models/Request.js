// Compatibility shim: allow requiring the Request model via '../models/Request'
// while the actual model lives under web_server/models.
module.exports = require('../web_server/models/Request');
