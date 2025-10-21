const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const Request = sequelize.define('Request', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    request_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
    },
    buy_order: {
        type: DataTypes.STRING(26),
        allowNull: true,
        unique: true,
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    property_url: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    amount_clp: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    status: {
        type: DataTypes.ENUM('OK', 'ACCEPTED', 'REJECTED', 'ERROR', 'PENDING'),
        allowNull: false,
        defaultValue: 'OK',
    },
    reason: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    retry_used: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    deposit_token: {
        type: DataTypes.TEXT,
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
}, {
    tableName: 'purchase_requests',
    freezeTableName: true,
    timestamps: false,
});

module.exports = Request;
