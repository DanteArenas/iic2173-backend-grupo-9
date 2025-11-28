const Auction = require('./Auction');
const ExchangeProposal = require('./ExchangeProposal');
const Schedule = require('./Schedule');

// Associations
Auction.belongsTo(Schedule, { foreignKey: 'schedule_id', as: 'schedule' });
Auction.hasMany(ExchangeProposal, { foreignKey: 'auction_id', as: 'proposals' });
ExchangeProposal.belongsTo(Auction, { foreignKey: 'auction_id', as: 'auction' });
ExchangeProposal.belongsTo(Schedule, { foreignKey: 'offering_schedule_id', as: 'offering_schedule' });

module.exports = {
  Auction,
  ExchangeProposal,
  Schedule,
};
