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
        type: DataTypes.ENUM('OK', 'ACCEPTED', 'REJECTED', 'ERROR'),
        allowNull: false,
        defaultValue: 'OK',
    },
    reason: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    retry_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    can_retry: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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
