const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const Schedule = sequelize.define(
  'Schedule',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    property_url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    price_clp: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    discount_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: 'AVAILABLE',
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    owner_group_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    tableName: 'property_schedules',
    timestamps: false,
  }
);

module.exports = Schedule;
