const net = require('net');
const { 
    getDeviceInfoByDeviceId, 
    saveDeviceData, 
    saveWalkPath, 
    updateWalkPath: dbUpdateWalkPath,
    WalkPath
} = require('./database');
const { parseTeltonikaData } = require('./parsers');
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
        } else {
            // Try to parse as JSON first
            try {
                const jsonData = JSON.parse(dataBuffer.toString());
                console.log(`📦 Received JSON data from ${deviceImei}:`, jsonData);
                
                // Process the JSON data
                const record = {
                    deviceImei: deviceImei,
                    deviceId: deviceImei,
                    timestamp: jsonData.timestamp,
                    latitude: jsonData.positionLatitude,
                    longitude: jsonData.positionLongitude,
                    movementStatus: jsonData.movementStatus,
                    ioElements: [{
                        id: 240,
                        value: jsonData.movementStatus ? 1 : 0
                    }]
                };

                // Process walk tracking
                await processWalkTracking(deviceImei, record);
                
                // Save device data
                try {
                    await saveDeviceData(deviceImei, [record]);
                    console.log(`✅ Saved device data for ${deviceImei}`);
                } catch (error) {
                    console.error(`❌ Failed to save device data for ${deviceImei}:`, error.message);
                }

                // Clear the buffer
                dataBuffer = Buffer.alloc(0);
            } catch (e) {
                // Not JSON data, try Teltonika parsing
                if (dataBuffer.length >= 8) {
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
                                console.log(`📊 Processing ${newRecords.length} new records from ${deviceImei}`);
                                
                                // Process each record for walk tracking
                                for (const record of newRecords) {
                                    await processWalkTracking(deviceImei, record);
                                }
                                
                                try {
                                    await saveDeviceData(deviceImei, newRecords);
                                    console.log(`✅ Saved latest record for ${deviceImei}`);
                                } catch (error) {
                                    console.error(`❌ Failed to save records for ${deviceImei}:`, error.message);
                                }
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
        // Check movement status from the record
        const isMoving = record.movementStatus === true || record.movement === true;
        console.log(`🔍 Movement check - Status: ${isMoving}, Value: ${record.movementStatus || record.movement}`);
        
        if (isMoving) {
            // Reset false duration counter when movement is true
            deviceTracker.falseDuration = 0;
            
            // If we were not moving before, reset movement start time
            if (!deviceTracker.movementStartTime) {
                deviceTracker.movementStartTime = timestamp;
                console.log(`🚶‍♂️ Device ${deviceImei}: Movement detected, starting movement timer at ${timestamp.toLocaleTimeString()}`);
            }
            
            // Store this point in the pending points regardless of tracking status
            pendingPoints[deviceImei].push({
                latitude: record.latitude,
                longitude: record.longitude,
                timestamp: timestamp
            });
            
            // Wait for 5 minutes of continuous movement before starting to save
            const MOVEMENT_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
            const movementDuration = timestamp - deviceTracker.movementStartTime;
            
            console.log(`⏱️ Device ${deviceImei}: Movement duration: ${Math.round(movementDuration/1000)} seconds`);
            
            // If not already saving and we've been moving for 5+ minutes, start saving
            if (!deviceTracker.isSaving && movementDuration >= MOVEMENT_THRESHOLD) {
                deviceTracker.isSaving = true;
                console.log(`📝 Device ${deviceImei}: Started tracking movement after ${Math.round(movementDuration/1000)} seconds of activity`);
                
                // Save all pending points that have been accumulated during the 5-minute period
                if (pendingPoints[deviceImei] && pendingPoints[deviceImei].length > 0) {
                    const points = pendingPoints[deviceImei];
                    // Filter out any points with invalid coordinates
                    const validPoints = points.filter(point => 
                        point.latitude !== undefined && point.latitude !== null && 
                        point.longitude !== undefined && point.longitude !== null
                    );
                    
                    if (validPoints.length > 0) {
                        console.log(`📊 Device ${deviceImei}: Creating walk path with ${validPoints.length} initial points`);
                        await createWalkPathWithInitialPoints(deviceImei, validPoints);
                        console.log(`✅ Device ${deviceImei}: Saved ${validPoints.length} buffered points after 5-minute threshold`);
                    }
                    pendingPoints[deviceImei] = []; // Clear pending points after saving
                }
            } else if (deviceTracker.isSaving) {
                // Save path data if we're in saving mode
                console.log(`📍 Device ${deviceImei}: Adding point to walk path at ${timestamp.toLocaleTimeString()}`);
                await updateWalkPath(deviceImei, record.latitude, record.longitude, timestamp);
                console.log(`✅ Device ${deviceImei}: Updated walk path with new point`);
            }
        } else {
            // Add to false duration counter
            deviceTracker.falseDuration += timeSinceLastPoint;
            
            // If we've been inactive for 5 minutes, stop tracking and reset everything
            const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
            if (deviceTracker.falseDuration >= IDLE_THRESHOLD) {
                if (deviceTracker.isSaving) {
                    console.log(`🛑 Device ${deviceImei}: Stopped tracking movement after ${Math.round(deviceTracker.falseDuration/1000)} seconds of inactivity`);
                    deviceTracker.isSaving = false;
                    deviceTracker.movementStartTime = null;  // Reset movement start time
                    deviceTracker.falseDuration = 0;
                    // Clear any pending points when stopping tracking
                    pendingPoints[deviceImei] = [];
                }
            }
            
            // If we're saving and get a non-moving status, don't add the point to the walk path
            if (deviceTracker.isSaving) {
                console.log(`⏸️ Device ${deviceImei}: Skipping point - device is not moving`);
            }
        }
        
        // Update last movement time
        deviceTracker.lastMovement = timestamp;
    }
}

// Helper function to create a walk path with initial points
async function createWalkPathWithInitialPoints(deviceImei, points) {
    try {
        // Validate that we have at least one valid point
        if (!points || points.length === 0 || 
            !points[0].latitude || !points[0].longitude) {
            console.log(`❌ Skipping walk creation for device ${deviceImei}: No valid coordinates`);
            return;
        }
        
        console.log(`📝 Creating walk path for device ${deviceImei} with ${points.length} points`);
        console.log(`📍 First point: ${points[0].latitude}, ${points[0].longitude}`);
        console.log(`⏰ Start time: ${new Date(points[0].timestamp).toLocaleTimeString()}`);
        
        // Create a new walk path with all the pending points
        const walkPath = await saveWalkPath(
            deviceImei,
            points,
            true,
            points[0].timestamp,
            null
        );
        
        if (walkPath) {
            console.log(`✅ Started new walk for device ${deviceImei} with ${points.length} initial points`);
            console.log(`🆔 Walk path ID: ${walkPath._id}`);
        } else {
            console.error(`❌ Failed to create walk path for device ${deviceImei}`);
        }
    } catch (error) {
        console.error(`❌ Error creating walk path with initial points: ${error.message}`);
    }
}

// Helper function to update WalkPath when movement is detected
async function updateWalkPath(deviceImei, positionLatitude, positionLongitude, timestamp) {
    try {
        // Skip if latitude or longitude is missing
        if (positionLatitude === undefined || positionLatitude === null || 
            positionLongitude === undefined || positionLongitude === null) {
            console.log(`❌ Skipping walk update for device ${deviceImei}: Missing coordinates`);
            return;
        }
        
        console.log(`📍 Updating walk path for device ${deviceImei} with point: ${positionLatitude}, ${positionLongitude}`);
        console.log(`⏰ Time: ${new Date(timestamp).toLocaleTimeString()}`);
        
        // Get the current walk path
        const deviceInfo = await getDeviceInfoByDeviceId(deviceImei);
        if (!deviceInfo) {
            console.error(`❌ Cannot update walk path: Device ${deviceImei} not found`);
            return;
        }
        
        // Create a new point
        const newPoint = {
            latitude: positionLatitude,
            longitude: positionLongitude,
            timestamp: timestamp
        };
        
        // Update the walk path
        const updatedWalkPath = await dbUpdateWalkPath(
            deviceImei,
            [newPoint],
            true,
            null
        );
        
        if (updatedWalkPath) {
            console.log(`✅ Updated walk path for device ${deviceImei} with new point`);
            console.log(`🆔 Walk path ID: ${updatedWalkPath._id}`);
        } else {
            console.error(`❌ Failed to update walk path for device ${deviceImei}`);
        }
    } catch (error) {
        console.error(`❌ Error updating walk path: ${error.message}`);
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