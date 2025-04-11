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
    movementStatus: { type: Boolean, default: null },
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

        // Get coordinates - handle both naming conventions
        const latitude = latestRecord.positionLatitude !== undefined ? 
                        latestRecord.positionLatitude : latestRecord.latitude;
        const longitude = latestRecord.positionLongitude !== undefined ? 
                        latestRecord.positionLongitude : latestRecord.longitude;

        // Validate coordinates - don't save if both are 0
        if (latitude === 0 && longitude === 0) {
            console.log(`Skipping record with zero coordinates for device ${deviceId}`);
            return;
        }

        // Calculate movement status
        const movementStatus = determineMovementStatus(latestRecord);
        console.log(`🔍 Movement check - Status: ${movementStatus}`);

        // Log record details with calculated movement status
        console.log('📊 Record details:', {
            timestamp: latestRecord.timestamp,
            latitude: latitude,
            longitude: longitude,
            movementStatus: movementStatus
        });

        // Format the record according to schema
        const formattedRecord = {
            device: deviceDoc._id,
            batteryLevel: latestRecord.batteryLevel || 0,
            deviceName: deviceDoc.name || deviceId,
            gnssStatus: latestRecord.gnssStatus,
            movementStatus: movementStatus,
            positionAltitude: latestRecord.positionAltitude || latestRecord.altitude,
            positionDirection: latestRecord.positionDirection || latestRecord.angle,
            positionSpeed: latestRecord.positionSpeed || latestRecord.speed,
            positionValid: latestRecord.positionValid || (latitude !== 0 && longitude !== 0),
            timestamp: timestamp,
            positionLatitude: latitude,
            positionLongitude: longitude
        };

        console.log(`Saving device data for ${deviceId}:`, formattedRecord);

        // Create new record
        const savedRecord = await DeviceData.create(formattedRecord);
        
        // Update device's lastData reference
        deviceDoc.lastData = savedRecord._id;
        await deviceDoc.save();

        console.log(`Saved latest record for device ${deviceId} with timestamp ${timestamp.toISOString()}`);
        return savedRecord;
    } catch (error) {
        console.error('Error saving device data:', error);
        return null;
    }
}
function determineMovementStatus(record) {
    // Explicit movement status takes highest priority
    if (record.movementStatus !== undefined) return record.movementStatus;
    
    // Legacy 'movement' field
    if (record.movement !== undefined) return record.movement;
    
    // Use speed to determine movement - consider moving if speed > 0.5 km/h
    if (record.positionSpeed !== undefined) {
        // Convert speed to km/h if needed (assuming speed is in m/s)
        const speedKmh = record.positionSpeed * 3.6;
        return speedKmh > 0.5;
    }
    
    // If no movement data at all, return false to indicate stationary
    return false;
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

        // Filter invalid points
        const validPoints = points.filter(point => 
            point.latitude !== undefined && point.latitude !== null && point.latitude !== 0 &&
            point.longitude !== undefined && point.longitude !== null && point.longitude !== 0
        );

        if (validPoints.length === 0) {
            console.error(`No valid points to save for device ${deviceId}`);
            return null;
        }

        // Calculate distance and duration
        let totalDistance = 0;
        let durationInSeconds = 0;
        
        if (validPoints.length > 1) {
            // Calculate total distance
            for (let i = 1; i < validPoints.length; i++) {
                const prevPoint = validPoints[i-1];
                const currPoint = validPoints[i];
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
            durationInSeconds = Math.floor((validPoints[validPoints.length - 1].timestamp - validPoints[0].timestamp) / 1000);
        }
        
        // Convert duration to minutes (rounded to 1 decimal place)
        const durationInMinutes = Math.round(durationInSeconds / 60 * 10) / 10;
        
        console.log(`Walk path for device ${deviceId}: ${validPoints.length} points, ${Math.round(totalDistance)}m distance, ${durationInMinutes} min duration`);
        
        const walkPath = new WalkPath({
            device: deviceInfo._id,
            isActive: isActive,
            startTime: startTime || validPoints[0].timestamp,
            endTime: endTime || validPoints[validPoints.length - 1].timestamp,
            coordinates: validPoints,
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
        console.log(`Attempting to update walk path for device ${deviceId} with ${Array.isArray(points) ? points.length : 1} points`);
        
        // Convert single point to array if needed
        const pointsArray = Array.isArray(points) ? points : [{
            latitude: points.latitude || points,
            longitude: points.longitude || arguments[2],
            timestamp: points.timestamp || arguments[3] || new Date()
        }];

        // Ensure points is an array and contains valid lat/long
        const validPoints = pointsArray.filter(point => 
            point && typeof point === 'object' && 
            point.latitude !== undefined && point.latitude !== null && point.latitude !== 0 &&
            point.longitude !== undefined && point.longitude !== null && point.longitude !== 0
        );

        if (validPoints.length === 0) {
            console.log(`❌ No valid points to update walk path for device ${deviceId}`);
            return null;
        }
        
        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) {
            console.error(`Cannot update walk path: Device ${deviceId} not found`);
            return null;
        }

        // Find the active walk path for this device
        let activeWalkPath = await WalkPath.findOne({ 
            device: deviceInfo._id, 
            isActive: true 
        });

        if (!activeWalkPath) {
            console.log(`No active walk path found for device ${deviceId}, creating new one`);
            // Create new walk path since none exists
            activeWalkPath = await saveWalkPath(
                deviceId,
                validPoints,
                true,
                validPoints[0].timestamp,
                null
            );
            
            if (!activeWalkPath) {
                console.error(`Failed to create new walk path for device ${deviceId}`);
                return null;
            }
            
            console.log(`✅ Created new walk path for device ${deviceId}`);
            return activeWalkPath;
        }

        // Update the existing walk path
        activeWalkPath.coordinates.push(...validPoints);
        activeWalkPath.isActive = isActive;
        if (endTime) {
            activeWalkPath.endTime = endTime;
        }

        // Calculate new total distance
        let totalDistance = activeWalkPath.distance || 0;
        if (validPoints.length > 1) {
            for (let i = 1; i < validPoints.length; i++) {
                const prevPoint = validPoints[i-1];
                const currPoint = validPoints[i];
                const distance = calculateDistance(
                    prevPoint.latitude, 
                    prevPoint.longitude, 
                    currPoint.latitude, 
                    currPoint.longitude
                );
                totalDistance += distance;
            }
        }

        // Update duration
        const startTime = activeWalkPath.startTime;
        const lastPointTime = validPoints[validPoints.length - 1].timestamp;
        const durationInSeconds = Math.floor((lastPointTime - startTime) / 1000);

        // Update the walk path
        activeWalkPath.distance = Math.round(totalDistance);
        activeWalkPath.duration = durationInSeconds;

        const updatedWalkPath = await activeWalkPath.save();
        console.log(`✅ Updated walk path for device ${deviceId} with ${validPoints.length} new points`);
        return updatedWalkPath;
    } catch (error) {
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            console.log(`⚠️ Connection error for device ${deviceId}, retrying...`);
            // Add retry logic here if needed
            return null;
        }
        console.error(`❌ Error updating walk path: ${error.message}`);
        return null;
    }
}

// Export all functions
module.exports = {
    connectToDatabase,
    getDeviceInfoByDeviceId,
    saveDeviceData,
    saveWalkPath,
    updateWalkPath,
    Device,
    DeviceData,
    WalkPath
};