// src/web_server/models/EventLog.js
const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const EventLog = sequelize.define('EventLog', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    type: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    payload: {
        type: DataTypes.JSONB,
        allowNull: false,
    },
    related_request_id: {
        type: DataTypes.UUID,
        allowNull: true,
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    }, {
    tableName: 'event_logs',
    freezeTableName: true,
    timestamps: false,
});

module.exports = EventLog;
