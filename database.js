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

// Add indexes to schemas
deviceSchema.index({ deviceId: 1 });
walkPathSchema.index({ device: 1, isActive: 1 });

// Create models
const Device = mongoose.model('Device', deviceSchema);
const DeviceData = mongoose.model('DeviceData', deviceDataSchema);
const WalkPath = mongoose.model('WalkPath', walkPathSchema);

// Add retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000, // 1 second
    timeout: 5000 // 5 seconds
};

// Add connection state tracking
let isConnected = false;
let connectionRetries = 0;

// Function to connect to MongoDB with retry logic
async function connectToDatabase() {
    try {
        await mongoose.connect(MONGODB_URI, {
            maxPoolSize: 50,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            bufferCommands: false,
            autoIndex: false,
            retryWrites: true,
            retryReads: true
        });
        
        isConnected = true;
        connectionRetries = 0;
        console.log('✅ Connected to MongoDB');
        
        // Set up connection event handlers
        mongoose.connection.on('error', (err) => {
            console.error('❌ MongoDB connection error:', err);
            isConnected = false;
            handleConnectionError(err);
        });

        mongoose.connection.on('disconnected', () => {
            console.log('⚠️ MongoDB disconnected');
            isConnected = false;
            handleConnectionError(new Error('MongoDB disconnected'));
        });

        mongoose.connection.on('reconnected', () => {
            console.log('✅ MongoDB reconnected');
            isConnected = true;
            connectionRetries = 0;
        });
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        handleConnectionError(error);
    }
}

// Function to handle connection errors with retry logic
async function handleConnectionError(error) {
    if (connectionRetries < RETRY_CONFIG.maxRetries) {
        connectionRetries++;
        console.log(`⚠️ Attempting to reconnect to MongoDB (attempt ${connectionRetries}/${RETRY_CONFIG.maxRetries})...`);
        setTimeout(connectToDatabase, RETRY_CONFIG.retryDelay);
    } else {
        console.error('❌ Max retry attempts reached. Please check your MongoDB connection.');
        process.exit(1);
    }
}

// Function to ensure database connection
async function ensureConnection() {
    if (!isConnected) {
        console.log('⚠️ Database not connected, attempting to reconnect...');
        await connectToDatabase();
    }
    return isConnected;
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
            timestamp: new Date(timestamp).toLocaleString(),
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
            timestamp: new Date(timestamp),
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

// Function to process walk tracking
async function processWalkTracking(deviceImei, record) {
    try {
        const timestamp = new Date(record.timestamp);
        const lat = record.positionLatitude || record.latitude;
        const lon = record.positionLongitude || record.longitude;

        if (!lat || !lon) {
            console.error(`❌ Invalid coordinates for device ${deviceImei}`);
            return;
        }

        // Get device tracker
        let deviceTracker = activeDevices.get(deviceImei);
        if (!deviceTracker) {
            deviceTracker = {
                isSaving: false,
                lastPoint: null,
                lastUpdate: Date.now()
            };
            activeDevices.set(deviceImei, deviceTracker);
        }

        // Update last point and timestamp
        deviceTracker.lastPoint = { lat, lon, timestamp };
        deviceTracker.lastUpdate = Date.now();

        // Check if device is moving
        const movementStatus = determineMovementStatus(record);
        if (movementStatus) {
            if (!deviceTracker.isSaving) {
                console.log(`🚶 Device ${deviceImei}: Started moving at ${timestamp.toLocaleTimeString()}`);
                deviceTracker.isSaving = true;
            }

            // Save path data
            console.log(`📍 Device ${deviceImei}: Adding point to walk path at ${timestamp.toLocaleTimeString()}`);
            const result = await updateWalkPath(deviceImei, lat, lon, timestamp);
            if (result) {
                console.log(`✅ Device ${deviceImei}: Updated walk path with new point`);
            } else {
                console.error(`❌ Device ${deviceImei}: Failed to update walk path - null result returned`);
            }
        } else if (deviceTracker.isSaving) {
            console.log(`🛑 Device ${deviceImei}: Stopped moving at ${timestamp.toLocaleTimeString()}`);
            deviceTracker.isSaving = false;
        }
    } catch (error) {
        console.error(`❌ Error in processWalkTracking for ${deviceImei}: ${error.message}`);
    }
}

// Function to update walk path with retry logic
async function updateWalkPath(deviceId, latitude, longitude, timestamp) {
    let retries = 0;
    
    while (retries < RETRY_CONFIG.maxRetries) {
        try {
            await ensureConnection();
            
            const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
            if (!deviceInfo) {
                console.error(`Cannot update walk path: Device ${deviceId} not found`);
                return null;
            }

            // Use findOneAndUpdate with upsert to atomically find or create walkpath
            const walkPath = await WalkPath.findOneAndUpdate(
                { device: deviceInfo._id, isActive: true },
                { 
                    $push: { 
                        coordinates: {
                            latitude,
                            longitude,
                            timestamp
                        }
                    },
                    $setOnInsert: { 
                        startTime: timestamp,
                        distance: 0,
                        duration: 0,
                        isActive: true
                    }
                },
                { 
                    new: true, 
                    upsert: true,
                    session: await mongoose.startSession()
                }
            );

            if (!walkPath) {
                console.error(`Failed to find or create walk path for device ${deviceId}`);
                return null;
            }

            // Calculate new distance and duration
            let totalDistance = 0;
            if (walkPath.coordinates.length > 1) {
                for (let i = 1; i < walkPath.coordinates.length; i++) {
                    const prev = walkPath.coordinates[i-1];
                    const curr = walkPath.coordinates[i];
                    totalDistance += calculateDistance(
                        prev.latitude,
                        prev.longitude,
                        curr.latitude,
                        curr.longitude
                    );
                }
            }

            const duration = Math.floor((timestamp - walkPath.startTime) / 1000);

            // Update distance and duration
            await WalkPath.updateOne(
                { _id: walkPath._id },
                { 
                    $set: {
                        distance: Math.round(totalDistance),
                        duration: duration
                    }
                }
            );

            console.log(`✅ Updated walk path for device ${deviceId} with new point`);
            return walkPath;
        } catch (error) {
            retries++;
            if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
                console.log(`⚠️ Connection error for device ${deviceId} (attempt ${retries}/${RETRY_CONFIG.maxRetries})`);
                if (retries < RETRY_CONFIG.maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay));
                    continue;
                }
            }
            console.error(`❌ Error updating walk path: ${error.message}`);
            return null;
        }
    }
    return null;
}

// Export all functions
module.exports = {
    connectToDatabase,
    getDeviceInfoByDeviceId,
    saveDeviceData,
    saveWalkPath,
    updateWalkPath,
    processWalkTracking,
    ensureConnection,
    Device,
    DeviceData,
    WalkPath
};