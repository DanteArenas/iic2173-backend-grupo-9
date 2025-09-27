const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const Property = sequelize.define('Property', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    data: {
        type: DataTypes.JSONB,
        allowNull: false
    },
    visits: {
        type: DataTypes.INTEGER,
        defaultValue: 1
    },
    reservation_cost: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    updated_at: {
        type: DataTypes.TEXT
    }
}, {
    tableName: 'properties',
    timestamps: false
});

module.exports = Property;
