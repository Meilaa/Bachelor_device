const net = require('net');
const { getDeviceInfoByDeviceId, saveDeviceData } = require('./database');
const { parseTeltonikaData } = require('./parsers');
const WalkPath = require('./models/WalkPath');
const { calculateDistance } = require('./utils/geofenceUtils');

// Configuration
const DEVICE_PORT = 5005;
const SOCKET_TIMEOUT = 300000; // 5 minutes
const DEBUG_LOG = true;

// Track server start time
const SERVER_START_TIME = Date.now();

// List of IPs to block
const BLOCKED_IPS = ['::ffff:10.244.33.1', '10.244.33.1'];

// Track active devices and their movement
const activeDevices = new Map();
const movementTracker = {};
const pendingPoints = {};

// Function to clean IP addresses
function cleanIP(ip) {
    return ip.replace('::ffff:', '') // Remove IPv6 prefix
            .replace(/^10\.244\.\d+\.\d+$/, '[internal]'); // Mask Kubernetes internal IPs
}

// Create TCP server
const server = net.createServer((socket) => {
    const clientIP = socket.remoteAddress;
    const cleanIPAddress = cleanIP(clientIP);
    
    // Check if this IP is in the blocklist
    if (BLOCKED_IPS.includes(clientIP)) {
        console.log(`🚫 Blocking connection from banned IP: ${cleanIPAddress}`);
        socket.destroy();
        return;
    }

    let dataBuffer = Buffer.alloc(0);
    let deviceImei = null;
    let lastActivity = Date.now();

    // Timeout if the device doesn't send data within 1 minute
    let timeoutHandler = setTimeout(() => {
        console.log(`⏱️ No data received from ${deviceImei || 'unknown device'}`);
        socket.end();
    }, 60000);

    socket.setTimeout(SOCKET_TIMEOUT);

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${deviceImei || 'unknown device'}`);
        socket.end();
    });

    socket.on('data', async (data) => {
        lastActivity = Date.now();
        clearTimeout(timeoutHandler);

        if (DEBUG_LOG) {
            console.log(`📩 Received ${data.length} bytes from ${deviceImei || 'new connection'} at ${new Date().toISOString()}`);
        }

        dataBuffer = Buffer.concat([dataBuffer, data]);
        await processBuffer();

        timeoutHandler = setTimeout(() => {
            console.log(`⏱️ No data received from ${deviceImei || 'unknown device'}`);
            socket.end();
        }, 60000);
    });

    async function processBuffer() {
        if (dataBuffer.length < 2) return;

        // Check for IMEI packet
        if (isImeiPacket(dataBuffer)) {
            deviceImei = parseImeiPacket(dataBuffer);
            console.log(`📱 Device connected - IMEI: ${deviceImei} at ${new Date().toISOString()}`);

            const deviceInfo = await getDeviceInfoByDeviceId(deviceImei);
            if (!deviceInfo) {
                console.warn(`⚠️ Unknown device: ${deviceImei}. Closing connection.`);
                socket.end();
                return;
            }

            activeDevices.set(deviceImei, {
                socket,
                imei: deviceImei,
                ip: cleanIPAddress,
                connectedAt: new Date(),
                lastActivity: new Date()
            });

            // Initialize movement tracker for this device
            if (!movementTracker[deviceImei]) {
                movementTracker[deviceImei] = {
                    lastMovement: new Date(),
                    movementStartTime: null,
                    falseDuration: 0,
                    isSaving: false
                };
            }

            // Initialize pending points array
            if (!pendingPoints[deviceImei]) {
                pendingPoints[deviceImei] = [];
            }

            socket.write(Buffer.from([0x01]));
            const imeiLength = dataBuffer.readUInt16BE(0);
            dataBuffer = dataBuffer.slice(2 + imeiLength);

            if (dataBuffer.length > 0) processBuffer();
        }
        else if (dataBuffer.length >= 8) {
            const preamble = dataBuffer.readUInt32BE(0);
            if (preamble !== 0) {
                dataBuffer = dataBuffer.slice(1);
                if (dataBuffer.length > 0) processBuffer();
                return;
            }

            const dataLength = dataBuffer.readUInt32BE(4);
            const totalLength = 8 + dataLength + 4;

            if (dataBuffer.length >= totalLength) {
                const fullPacket = dataBuffer.slice(0, totalLength);
                const records = parseTeltonikaData(fullPacket, deviceImei);

                if (records.length > 0) {
                    // Filter records to only include those newer than server start
                    const newRecords = records.filter(record => {
                        const recordTime = new Date(record.timestamp).getTime();
                        return recordTime > SERVER_START_TIME;
                    });

                    if (newRecords.length > 0) {
                        console.log(`📊 Processing ${newRecords.length} new records from ${deviceImei} at ${new Date().toISOString()}`);
                        
                        // Process each record for walk tracking
                        for (const record of newRecords) {
                            await processWalkTracking(deviceImei, record);
                        }
                        
                        try {
                            await saveDeviceData(deviceImei, newRecords);
                            console.log(`✅ Saved latest record for ${deviceImei} with timestamp ${new Date(newRecords[newRecords.length - 1].timestamp).toISOString()}`);
                        } catch (error) {
                            console.error(`❌ Failed to save records for ${deviceImei}:`, error.message);
                        }
                    } else {
                        console.log(`⏭️ Skipping ${records.length} historical records from ${deviceImei}`);
                    }

                    const ackBuffer = Buffer.alloc(4);
                    ackBuffer.writeUInt32BE(records.length, 0);
                    socket.write(ackBuffer);
                }

                dataBuffer = dataBuffer.slice(totalLength);
                if (dataBuffer.length > 0) processBuffer();
            }
        }
    }

    socket.on('close', () => {
        console.log(`🔌 Device disconnected: ${deviceImei || 'unknown'}`);
        if (deviceImei && activeDevices.has(deviceImei)) {
            activeDevices.delete(deviceImei);
        }
        clearTimeout(timeoutHandler);
    });

    socket.on('error', (err) => {
        console.error(`❌ Connection error (${deviceImei || 'unknown'}): ${err.message}`);
    });
});

// Helper function to process walk tracking
async function processWalkTracking(deviceImei, record) {
    const deviceTracker = movementTracker[deviceImei];
    const timestamp = new Date(record.timestamp);
    const timeSinceLastPoint = deviceTracker.lastMovement ? 
        (timestamp - deviceTracker.lastMovement) : 0;
    
    // Skip walk tracking if latitude or longitude is missing
    const hasValidCoordinates = record.latitude !== undefined && 
                               record.latitude !== null && 
                               record.longitude !== undefined && 
                               record.longitude !== null;
    
    if (hasValidCoordinates) {
        if (record.movement === true) {
            // Reset false duration counter when movement is true
            deviceTracker.falseDuration = 0;
            
            // Store this point in the pending points
            pendingPoints[deviceImei].push({
                latitude: record.latitude,
                longitude: record.longitude,
                timestamp: timestamp
            });
            
            // Update or initialize movementStartTime
            if (!deviceTracker.movementStartTime) {
                deviceTracker.movementStartTime = timestamp;
                console.log(`Device ${deviceImei}: Movement detected, starting movement timer`);
            }
            
            // Check if we've been moving for 5+ minutes
            const movementDuration = timestamp - deviceTracker.movementStartTime;
            
            // If not already saving and we've been moving for 5+ minutes, start saving
            if (!deviceTracker.isSaving && movementDuration >= 5 * 60 * 1000) {
                deviceTracker.isSaving = true;
                console.log(`Device ${deviceImei}: Started tracking movement after ${Math.round(movementDuration/1000)} seconds of activity`);
                
                // Save all pending points
                if (pendingPoints[deviceImei] && pendingPoints[deviceImei].length > 0) {
                    const points = pendingPoints[deviceImei];
                    // Filter out any points with invalid coordinates
                    const validPoints = points.filter(point => 
                        point.latitude !== undefined && point.latitude !== null && 
                        point.longitude !== undefined && point.longitude !== null
                    );
                    
                    if (validPoints.length > 0) {
                        await createWalkPathWithInitialPoints(deviceImei, validPoints);
                    }
                    pendingPoints[deviceImei] = []; // Clear pending points after saving
                }
            } else if (deviceTracker.isSaving) {
                // Save path data if we're in saving mode
                await updateWalkPath(deviceImei, record.latitude, record.longitude, timestamp);
            }
        } else if (record.movement === false) {
            // Add to false duration counter
            deviceTracker.falseDuration += timeSinceLastPoint;
            
            // Log when movement stops
            if (deviceTracker.movementStartTime) {
                console.log(`Device ${deviceImei}: Movement stopped, starting idle timer`);
                deviceTracker.movementStartTime = null; // Reset movement start time since movement has stopped
            }
            
            // Check if we should stop saving (5+ minutes of false)
            if (deviceTracker.isSaving && deviceTracker.falseDuration >= 5 * 60 * 1000) {
                console.log(`Device ${deviceImei}: Stopping track after ${Math.round(deviceTracker.falseDuration/1000)} seconds of inactivity`);
                deviceTracker.isSaving = false;
                deviceTracker.falseDuration = 0; // Reset false duration after stopping
                
                // Finalize the walk path by marking it as inactive
                await WalkPath.findOneAndUpdate(
                    { device: deviceImei, isActive: true },
                    { isActive: false, endTime: timestamp },
                    { new: true }
                ).exec();
                
                // Clear any remaining pending points for this device
                pendingPoints[deviceImei] = [];
            }
        }
        
        // Always update lastMovement timestamp
        deviceTracker.lastMovement = timestamp;
    }
}

// Helper function to create a walk path with initial points
async function createWalkPathWithInitialPoints(deviceImei, points) {
    try {
        // Validate that we have at least one valid point
        if (!points || points.length === 0 || 
            !points[0].latitude || !points[0].longitude) {
            console.log(`Skipping walk creation for device ${deviceImei}: No valid coordinates`);
            return;
        }
        
        // Create a new walk path with all the pending points
        const activeWalk = new WalkPath({
            device: deviceImei,
            isActive: true,
            startTime: points[0].timestamp, // Use the first point's timestamp as start time
            coordinates: points
        });
        await activeWalk.save();
        console.log(`Started new walk for device ${deviceImei} with ${points.length} initial points`);
    } catch (error) {
        console.error(`Error creating walk path with initial points: ${error.message}`);
    }
}

// Helper function to update WalkPath when movement is detected
async function updateWalkPath(deviceImei, positionLatitude, positionLongitude, timestamp) {
    try {
        // Skip if latitude or longitude is missing
        if (positionLatitude === undefined || positionLatitude === null || 
            positionLongitude === undefined || positionLongitude === null) {
            console.log(`Skipping walk update for device ${deviceImei}: Missing coordinates`);
            return;
        }
        
        let activeWalk = await WalkPath.findOne(
            { device: deviceImei, isActive: true }
        ).exec();
        
        if (!activeWalk) {
            // Create a new walk path if none exists
            activeWalk = new WalkPath({
                device: deviceImei,
                isActive: true,
                startTime: timestamp,
                coordinates: [{ latitude: positionLatitude, longitude: positionLongitude, timestamp }]
            });
            await activeWalk.save();
            console.log(`Started new walk for device ${deviceImei}`);
        } else {
            // Add coordinates to existing walk path
            activeWalk.coordinates.push({ latitude: positionLatitude, longitude: positionLongitude, timestamp });
            await activeWalk.save();
        }
    } catch (error) {
        console.error(`Error updating walk path: ${error.message}`);
    }
}

// Helper functions
function isImeiPacket(buffer) {
    if (buffer.length < 4) return false;
    const imeiLength = buffer.readUInt16BE(0);
    if (imeiLength < 15 || imeiLength > 17 || buffer.length < imeiLength + 2) {
        return false;
    }
    for (let i = 2; i < 2 + imeiLength; i++) {
        if (i >= buffer.length) return false;
        const char = buffer[i];
        if (char < 0x30 || char > 0x39) return false;
    }
    return true;
}

function parseImeiPacket(buffer) {
    const imeiLength = buffer.readUInt16BE(0);
    return buffer.toString('ascii', 2, 2 + imeiLength);
}

// Start server
async function startServer() {
    try {
        server.listen(DEVICE_PORT, () => {
            console.log(`🚀 Server listening on port ${DEVICE_PORT}`);
            console.log(`🛡️ Blocking IPs: ${BLOCKED_IPS.map(ip => cleanIP(ip)).join(', ')}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

module.exports = {
    startServer,
    startDeviceServer: startServer,
    server,
    activeDevices
};