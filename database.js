const mongoose = require('mongoose');
const { MONGODB_URI } = require('./config');

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
    timestamp: { type: Date, required: true },
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
    batteryVoltage: { type: Number },
    gnssPDOP: { type: Number },
    gnssHDOP: { type: Number }
}, { timestamps: true });

// Create models
const Device = mongoose.model('Device', deviceSchema);
const DeviceData = mongoose.model('DeviceData', deviceDataSchema);

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
        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) {
            console.warn(`Skipping data save - Device with ID ${deviceId} not found in database`);
            return;
        }

        const latestRecord = records[records.length - 1];
        if (!latestRecord) {
            console.warn('No valid records to save');
            return;
        }

        if (!latestRecord.latitude || !latestRecord.longitude) {
            console.warn('Latest record missing required fields');
            return;
        }

        // Convert device timestamp to Lithuanian time
        const deviceDate = new Date(latestRecord.timestamp);
        const lithuanianDate = new Date(deviceDate.getTime() + (3 * 60 * 60 * 1000)); // Add 3 hours for UTC+3

        // Create document without saving
        const deviceData = new DeviceData({
            deviceId: deviceInfo.deviceId,
            user: deviceInfo.userId,
            animal: deviceInfo.animalId,
            timestamp: lithuanianDate,
            latitude: latestRecord.latitude,
            longitude: latestRecord.longitude,
            altitude: latestRecord.altitude,
            angle: latestRecord.angle,
            satellites: latestRecord.satellites,
            speed: latestRecord.speed,
            priority: latestRecord.priority,
            eventIOID: latestRecord.eventIOID,
            elements: latestRecord.elements,
            batteryLevel: latestRecord.batteryLevel,
            gnssStatus: latestRecord.gnssStatus,
            movement: latestRecord.movement,
            charging: latestRecord.charging,
            gsmSignal: latestRecord.gsmSignal,
            batteryVoltage: latestRecord.batteryVoltage,
            gnssPDOP: latestRecord.gnssPDOP,
            gnssHDOP: latestRecord.gnssHDOP
        });

        await deviceData.save();
        console.log(`✅ Saved latest position for device ${deviceId} at ${lithuanianDate.toLocaleString('lt-LT')}`);

    } catch (error) {
        console.error('Error saving device data:', error);
    }
}

module.exports = {
    connectToDatabase,
    saveDeviceData,
    getDeviceInfoByDeviceId,
    DeviceData
}; 