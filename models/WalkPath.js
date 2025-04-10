const mongoose = require('mongoose');

const walkPathSchema = new mongoose.Schema({
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    isActive: { type: Boolean, default: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date },
    coordinates: [{
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        timestamp: { type: Date, required: true }
    }]
}, { timestamps: true });

module.exports = mongoose.model('WalkPath', walkPathSchema); 