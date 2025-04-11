const mongoose = require('mongoose');
require('dotenv').config();
const { calculateDistance } = require('./utils/geofenceUtils');

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

const walkPathSchema = new mongoose.Schema({
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    isActive: { type: Boolean, default: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date },
    coordinates: [{
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        timestamp: { type: Date, required: true }
    }],
    distance: { type: Number },
    duration: { type: Number }
}, { timestamps: true });

// Create models
const Device = mongoose.model('Device', deviceSchema);
const DeviceData = mongoose.model('DeviceData', deviceDataSchema);
const WalkPath = mongoose.model('WalkPath', walkPathSchema);

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
            animalId: device.animalId,
            _id: device._id // Add this to get the MongoDB _id
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

// Function to save walk path
async function saveWalkPath(deviceId, points, isActive, startTime, endTime) {
    try {
        console.log(`Attempting to save walk path for device ${deviceId} with ${points.length} points`);
        
        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) {
            console.error(`Cannot save walk path: Device ${deviceId} not found`);
            return null;
        }

        // Calculate distance and duration
        let totalDistance = 0;
        let durationInSeconds = 0;
        
        if (points.length > 1) {
            // Calculate total distance
            for (let i = 1; i < points.length; i++) {
                const prevPoint = points[i-1];
                const currPoint = points[i];
                const distance = calculateDistance(
                    prevPoint.latitude, 
                    prevPoint.longitude, 
                    currPoint.latitude, 
                    currPoint.longitude
                );
                totalDistance += distance;
                console.log(`📏 Distance between points ${i-1} and ${i}: ${Math.round(distance)}m`);
            }
            
            // Calculate duration in seconds
            durationInSeconds = Math.floor((points[points.length - 1].timestamp - points[0].timestamp) / 1000);
        }
        
        // Convert duration to minutes (rounded to 1 decimal place)
        const durationInMinutes = Math.round(durationInSeconds / 60 * 10) / 10;
        
        console.log(`Walk path for device ${deviceId}: ${points.length} points, ${Math.round(totalDistance)}m distance, ${durationInMinutes} min duration`);
        
        const walkPath = new WalkPath({
            device: deviceInfo._id,
            isActive: isActive,
            startTime: startTime || points[0].timestamp,
            endTime: endTime || points[points.length - 1].timestamp,
            coordinates: points,
            distance: Math.round(totalDistance),
            duration: durationInSeconds
        });

        const savedWalkPath = await walkPath.save();
        console.log(`✅ Saved walk path for device ${deviceId} with ID: ${savedWalkPath._id}`);
        return savedWalkPath;
    } catch (error) {
        console.error(`❌ Error saving walk path: ${error.message}`);
        return null;
    }
}

// Function to update walk path
async function updateWalkPath(deviceId, points, isActive, endTime) {
    try {
        console.log(`Attempting to update walk path for device ${deviceId} with ${points.length} points`);
        
        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) {
            console.error(`Cannot update walk path: Device ${deviceId} not found`);
            return null;
        }

        // Find the active walk path for this device
        const activeWalkPath = await WalkPath.findOne({ 
            device: deviceInfo._id, 
            isActive: true 
        });

        if (!activeWalkPath) {
            console.error(`No active walk path found for device ${deviceId}`);
            return null;
        }

        // Update the walk path
        activeWalkPath.coordinates = [...activeWalkPath.coordinates, ...points];
        
        // Recalculate distance and duration
        let totalDistance = 0;
        let durationInSeconds = 0;
        
        if (activeWalkPath.coordinates.length > 1) {
            // Calculate total distance
            for (let i = 1; i < activeWalkPath.coordinates.length; i++) {
                const prevPoint = activeWalkPath.coordinates[i-1];
                const currPoint = activeWalkPath.coordinates[i];
                totalDistance += calculateDistance(
                    prevPoint.latitude, 
                    prevPoint.longitude, 
                    currPoint.latitude, 
                    currPoint.longitude
                );
            }
            
            // Calculate duration in seconds
            durationInSeconds = Math.floor((activeWalkPath.coordinates[activeWalkPath.coordinates.length - 1].timestamp - activeWalkPath.coordinates[0].timestamp) / 1000);
        }

        // Update walk path properties
        activeWalkPath.distance = Math.round(totalDistance);
        activeWalkPath.duration = durationInSeconds;
        activeWalkPath.isActive = isActive;
        if (endTime) {
            activeWalkPath.endTime = endTime;
        }

        const updatedWalkPath = await activeWalkPath.save();
        console.log(`✅ Updated walk path ${updatedWalkPath._id} for device ${deviceId}`);
        return updatedWalkPath;
    } catch (error) {
        console.error(`❌ Error updating walk path: ${error.message}`);
        return null;
    }
}

module.exports = {
    connectToDatabase,
    saveDeviceData,
    getDeviceInfoByDeviceId,
    saveWalkPath,
    updateWalkPath,
    Device,
    DeviceData,
    WalkPath
}; 