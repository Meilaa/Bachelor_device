const mongoose = require('mongoose');
const { MONGODB_URI, DEBUG_LOG } = require('./config');

// Define Mongoose schemas
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    animal: { type: mongoose.Schema.Types.ObjectId, ref: 'Animal', required: true }
}, { timestamps: true });

const deviceDataSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    animal: { type: mongoose.Schema.Types.ObjectId, ref: 'Animal', required: true },
    timestamp: { type: Number, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    altitude: { type: Number, required: true },
    angle: { type: Number, required: true },
    satellites: { type: Number, required: true },
    speed: { type: Number, required: true },
    priority: { type: Number, required: true },
    eventIOID: { type: Number, required: true },
    elements: { type: Map, of: mongoose.Schema.Types.Mixed, required: true },
    batteryLevel: { type: Number },
    gnssStatus: { type: Boolean },
    movement: { type: Boolean },
    charging: { type: Boolean },
    gsmSignal: { type: Number },
    manDown: { type: Boolean },
    batteryVoltage: { type: Number },
    gnssPDOP: { type: Number },
    gnssHDOP: { type: Number }
}, { timestamps: true });

const walkPathSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    animal: { type: mongoose.Schema.Types.ObjectId, ref: 'Animal', required: true },
    startTime: { type: Number, required: true },
    endTime: { type: Number },
    points: [{
        timestamp: { type: Number, required: true },
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        speed: { type: Number, required: true }
    }]
}, { timestamps: true });

// Create models
const Device = mongoose.model('Device', deviceSchema);
const DeviceData = mongoose.model('DeviceData', deviceDataSchema);
const WalkPath = mongoose.model('WalkPath', walkPathSchema);

// Function to get device info from database using deviceId
async function getDeviceInfoByDeviceId(deviceId) {
    try {
        const device = await Device.findOne({ deviceId: deviceId });
        if (!device) {
            console.warn(`Device with ID ${deviceId} not found in database`);
            return null;
        }
        return {
            deviceId: device.deviceId,
            userId: device.user,
            animalId: device.animal
        };
    } catch (error) {
        console.error(`Error fetching device info for device ID ${deviceId}:`, error);
        return null;
    }
}

// Function to connect to MongoDB
async function connectToDatabase() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Function to save device data
async function saveDeviceData(deviceId, records) {
    try {
        // Get device info from database
        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) {
            console.warn(`Skipping data save - Device with ID ${deviceId} not found in database`);
            return;
        }

        let totalRecords = 0;
        // Process each record
        for (const record of records) {
            try {
                // Validate required fields
                if (!record.timestamp || !record.latitude || !record.longitude) {
                    continue;
                }

                // Create device data document
                const deviceData = new DeviceData({
                    deviceId: deviceInfo.deviceId,
                    user: deviceInfo.userId,
                    animal: deviceInfo.animalId,
                    timestamp: record.timestamp,
                    latitude: record.latitude,
                    longitude: record.longitude,
                    altitude: record.altitude,
                    angle: record.angle,
                    satellites: record.satellites,
                    speed: record.speed,
                    priority: record.priority,
                    eventIOID: record.eventIOID,
                    elements: record.elements,
                    batteryLevel: record.batteryLevel,
                    gnssStatus: record.gnssStatus,
                    movement: record.movement,
                    charging: record.charging,
                    gsmSignal: record.gsmSignal,
                    manDown: record.manDown,
                    batteryVoltage: record.batteryVoltage,
                    gnssPDOP: record.gnssPDOP,
                    gnssHDOP: record.gnssHDOP
                });

                // Save device data
                await deviceData.save();
                totalRecords++;

                // Handle movement tracking
                if (record.movement !== undefined) {
                    await handleMovementTracking(deviceInfo, record);
                }

            } catch (recordError) {
                if (DEBUG_LOG) {
                    console.error('Error processing record:', recordError);
                }
            }
        }

        if (totalRecords > 0) {
            console.log(`✅ Saved ${totalRecords} records to database for device ${deviceId}`);
        }

    } catch (error) {
        console.error('Error saving device data:', error);
    }
}

// Helper function to create a new walk path with initial points
async function createWalkPathWithInitialPoints(deviceInfo, record) {
    const walkPath = new WalkPath({
        deviceId: deviceInfo.deviceId,
        user: deviceInfo.userId,
        animal: deviceInfo.animalId,
        startTime: record.timestamp,
        points: [{
            timestamp: record.timestamp,
            latitude: record.latitude,
            longitude: record.longitude,
            speed: record.speed
        }]
    });
    await walkPath.save();
    return walkPath;
}

// Helper function to update an existing walk path
async function updateWalkPath(walkPath, record) {
    walkPath.points.push({
        timestamp: record.timestamp,
        latitude: record.latitude,
        longitude: record.longitude,
        speed: record.speed
    });
    await walkPath.save();
}

// Function to handle movement tracking
async function handleMovementTracking(deviceInfo, record) {
    try {
        // Find the most recent walk path for this device
        const latestWalkPath = await WalkPath.findOne({
            deviceId: deviceInfo.deviceId,
            endTime: null
        }).sort({ startTime: -1 });

        if (record.movement) {
            // Device is moving
            if (latestWalkPath) {
                // Update existing walk path
                await updateWalkPath(latestWalkPath, record);
            } else {
                // Create new walk path
                await createWalkPathWithInitialPoints(deviceInfo, record);
            }
        } else {
            // Device has stopped
            if (latestWalkPath) {
                // End the walk path
                latestWalkPath.endTime = record.timestamp;
                await latestWalkPath.save();
            }
        }
    } catch (error) {
        console.error('Error handling movement tracking:', error);
    }
}

module.exports = {
    connectToDatabase,
    saveDeviceData,
    DeviceData,
    WalkPath
}; 