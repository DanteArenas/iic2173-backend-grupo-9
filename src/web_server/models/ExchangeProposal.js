const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const ExchangeProposal = sequelize.define(
  'ExchangeProposal',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    proposal_uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      allowNull: false,
      unique: true,
    },

    // Debe matchear auction_uuid del auction original
    auction_uuid: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    auction_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    from_group_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    to_group_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    offering_schedule_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: 'PENDING',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'exchange_proposals',
    timestamps: false,
  }
);

module.exports = ExchangeProposal;
