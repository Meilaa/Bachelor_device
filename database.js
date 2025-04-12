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
// deviceSchema.index({ deviceId: 1 }, { unique: true }); // Removing duplicate index
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

// Create a map to track device states within this module
const deviceTrackers = new Map();

// Helper function to close active walk paths
async function closeActiveWalkPaths(deviceId) {
    try {
        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) return;
        
        const walkPaths = await WalkPath.find({
            device: deviceInfo._id,
            isActive: true
        });
        
        for (const walkPath of walkPaths) {
            walkPath.isActive = false;
            walkPath.endTime = new Date();
            await walkPath.save();
            console.log(`✅ Closed walk path ${walkPath._id} for device ${deviceId}`);
        }
    } catch (error) {
        console.error(`❌ Error closing walk paths: ${error.message}`);
    }
}

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

function determineMovementStatus(record) {
    // Log the raw movement data for debugging
    console.log('🔍 Movement check - Raw data:', {
        movementStatus: record.movementStatus,
        movement: record.movement,
        speed: record.positionSpeed
    });

    // Explicit movement status takes highest priority
    if (record.movementStatus !== undefined) {
        console.log('🔍 Using movementStatus:', record.movementStatus);
        return record.movementStatus;
    }
    
    // Legacy 'movement' field
    if (record.movement !== undefined) {
        console.log('🔍 Using movement:', record.movement);
        return record.movement;
    }
    
    // Use speed to determine movement - consider moving if speed > 3 km/h
    if (record.positionSpeed !== undefined) {
        const isMoving = record.positionSpeed > 3;
        console.log('🔍 Using speed:', record.positionSpeed, 'km/h, Moving:', isMoving);
        return isMoving;
    }
    
    // If no movement data is available, return null instead of false
    console.log('⚠️ No movement data available');
    return null;
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

        // Improved coordinate validation - only reject if both are exactly 0 or if they're invalid
        if ((latitude === undefined || longitude === undefined) || 
            isNaN(latitude) || isNaN(longitude) ||
            (latitude === 0 && longitude === 0)) {
            console.log(`Skipping record with invalid coordinates for device ${deviceId}: lat=${latitude}, lon=${longitude}`);
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
            movementStatus: movementStatus,  // This can now be null
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

        // Improved coordinate validation - only reject undefined, NaN, or exact 0,0 point
        if (lat === undefined || lon === undefined || isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) {
            console.error(`❌ Invalid coordinates for device ${deviceImei}: lat=${lat}, lon=${lon}`);
            return;
        }

        // Get device tracker from our local map
        let deviceTracker = deviceTrackers.get(deviceImei);
        if (!deviceTracker) {
            deviceTracker = {
                isSaving: false,
                lastPoint: null,
                lastUpdate: Date.now(),
                movementStartTime: null,
                falseDuration: 0
            };
            deviceTrackers.set(deviceImei, deviceTracker);
        }

        // Update last point and timestamp
        deviceTracker.lastPoint = { lat, lon, timestamp };
        deviceTracker.lastUpdate = Date.now();

        // Check if device is moving - use our own logic here
        const speed = record.positionSpeed || 0;
        const isMoving = speed > 3; // Using 3 km/h as threshold
        
        console.log(`🔍 Device ${deviceImei}: Speed ${speed} km/h, Moving: ${isMoving}`);
        
        if (isMoving) {
            // Reset false duration counter
            deviceTracker.falseDuration = 0;
            
            // Set movement start time if not already set
            if (!deviceTracker.movementStartTime) {
                deviceTracker.movementStartTime = timestamp;
                console.log(`🚶‍♂️ Device ${deviceImei}: Movement started at ${timestamp.toLocaleTimeString()}`);
            }
            
            // Check if we should save or create a walk path
            if (!deviceTracker.isSaving) {
                // Start saving after the movement has continued for some time
                const movementDuration = timestamp - deviceTracker.movementStartTime;
                if (movementDuration >= 30000) { // 30 seconds threshold
                    console.log(`🛣️ Device ${deviceImei}: Starting walk path after ${Math.round(movementDuration/1000)}s of movement`);
                    deviceTracker.isSaving = true;
                    
                    // Create a new walk path
                    const result = await updateWalkPath(deviceImei, lat, lon, timestamp);
                    if (result) {
                        console.log(`✅ Device ${deviceImei}: Created new walk path`);
                    } else {
                        console.error(`❌ Device ${deviceImei}: Failed to create walk path`);
                    }
                }
            } else {
                // Update existing walk path
                const result = await updateWalkPath(deviceImei, lat, lon, timestamp);
                if (result) {
                    console.log(`✅ Device ${deviceImei}: Updated walk path`);
                } else {
                    console.error(`❌ Device ${deviceImei}: Failed to update walk path`);
                }
            }
        } else {
            // Not moving - update falseDuration
            if (deviceTracker.lastMovement) {
                deviceTracker.falseDuration += timestamp - deviceTracker.lastMovement;
            }
            
            // Stop tracking if inactive too long
            if (deviceTracker.falseDuration >= 60000 && deviceTracker.isSaving) { // 1 minute
                console.log(`🛑 Device ${deviceImei}: Stopped tracking after ${Math.round(deviceTracker.falseDuration/1000)}s idle`);
                deviceTracker.isSaving = false;
                deviceTracker.movementStartTime = null;
                deviceTracker.falseDuration = 0;
                
                // Close any active walk paths for this device
                await closeActiveWalkPaths(deviceImei);
            }
        }
        
        // Update last movement time
        deviceTracker.lastMovement = timestamp;
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

            // First try to find an active walk path
            let walkPath = await WalkPath.findOne({ 
                device: deviceInfo._id, 
                isActive: true 
            });

            if (!walkPath) {
                console.log(`Creating new walk path for device ${deviceId}`);
                // Create new walk path
                walkPath = new WalkPath({
                    device: deviceInfo._id,
                    isActive: true,
                    startTime: timestamp,
                    coordinates: [{
                        latitude,
                        longitude,
                        timestamp
                    }],
                    distance: 0,
                    duration: 0
                });

                await walkPath.save();
                console.log(`✅ Created new walk path for device ${deviceId}`);
                return walkPath;
            }

            // Update existing walk path
            walkPath.coordinates.push({
                latitude,
                longitude,
                timestamp
            });

            // Calculate new distance
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

            // Update duration
            const duration = Math.floor((timestamp - walkPath.startTime) / 1000);

            // Update the walk path
            walkPath.distance = Math.round(totalDistance);
            walkPath.duration = duration;
            walkPath.isActive = true;

            await walkPath.save();
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