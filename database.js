const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/device_tracking';

// Define schemas
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    animalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Animal' },
    lastData: { type: mongoose.Schema.Types.ObjectId, ref: 'DeviceData' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const deviceDataSchema = new mongoose.Schema({
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    deviceName: { type: String },
    batteryLevel: { type: Number, default: 0 },
    gnssStatus: { type: Boolean, default: false },
    movementStatus: { type: Boolean, default: false },
    positionAltitude: { type: Number },
    positionDirection: { type: Number },
    positionSpeed: { type: Number },
    positionValid: { type: Boolean, default: false },
    timestamp: { type: Date, required: true },
    positionLatitude: { type: Number, required: true },
    positionLongitude: { type: Number, required: true }
}, { timestamps: true });

// Create models
const Device = mongoose.model('Device', deviceSchema);
const DeviceData = mongoose.model('DeviceData', deviceDataSchema);

// Function to connect to MongoDB
async function connectToDatabase() {
    try {
        await mongoose.connect(MONGODB_URI, {
            maxPoolSize: 50,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            bufferCommands: false,
            autoIndex: false
        });
        console.log('✅ Connected to MongoDB');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Function to get device info
async function getDeviceInfoByDeviceId(deviceId) {
    try {
        const device = await Device.findOne({ deviceId }).lean();
        if (!device) {
            console.warn(`Device with ID ${deviceId} not found in database`);
            return null;
        }
        return {
            deviceId: device.deviceId,
            userId: device.userId,
            animalId: device.animalId
        };
    } catch (error) {
        console.error(`Error fetching device info for device ID ${deviceId}:`, error);
        return null;
    }
}

// Function to save device data
async function saveDeviceData(deviceId, records) {
    try {
        if (!records || records.length === 0) {
            console.log('No records to save');
            return;
        }

        // Only take the latest record
        const latestRecord = records[records.length - 1];
        const deviceDoc = await Device.findOne({ deviceId: deviceId });
        
        if (!deviceDoc) {
            console.log(`Device ${deviceId} not found in database`);
            return;
        }

        // Handle timestamp
        let timestamp;
        if (!latestRecord.timestamp) {
            console.log(`Missing timestamp for device ${deviceId}`);
            return;
        }

        // Check if timestamp is in seconds (if so, multiply by 1000)
        if (typeof latestRecord.timestamp === 'number' && latestRecord.timestamp < 10000000000) {
            timestamp = new Date(latestRecord.timestamp * 1000);
        } else {
            timestamp = new Date(latestRecord.timestamp);
        }

        // Validate the timestamp
        if (isNaN(timestamp.getTime())) {
            console.log(`Invalid timestamp for device ${deviceId}`);
            return;
        }

        // Format the record according to schema
        const formattedRecord = {
            device: deviceDoc._id,
            batteryLevel: latestRecord.batteryLevel || 0,
            deviceName: deviceDoc.name || deviceId,
            gnssStatus: latestRecord.gnssStatus,
            movementStatus: latestRecord.movement,
            positionAltitude: latestRecord.altitude,
            positionDirection: latestRecord.angle,
            positionSpeed: latestRecord.speed,
            positionValid: latestRecord.positionValid,
            timestamp: timestamp,
            positionLatitude: latestRecord.latitude,
            positionLongitude: latestRecord.longitude
        };

        // Create new record
        const savedRecord = await DeviceData.create(formattedRecord);
        
        // Update device's lastData reference
        deviceDoc.lastData = savedRecord._id;
        await deviceDoc.save();

        console.log(`Saved latest record for device ${deviceId} with timestamp ${timestamp.toISOString()}`);
    } catch (error) {
        console.error('Error saving device data:', error);
    }
}

module.exports = {
    connectToDatabase,
    saveDeviceData,
    getDeviceInfoByDeviceId,
    Device,
    DeviceData
}; 