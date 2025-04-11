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

// Track active devices and their movement
const activeDevices = new Map();
const movementTracker = {};
const pendingPoints = {};

// Create TCP server
const server = net.createServer((socket) => {
    const clientIP = socket.remoteAddress;
    
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
                ip: clientIP,
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
                console.log(`🆕 Initialized pending points array for ${deviceImei}`);
            }

            safeSocketWrite(socket, Buffer.from([0x01]), deviceImei);
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
                    positionLatitude: jsonData.positionLatitude || jsonData.latitude,
                    positionLongitude: jsonData.positionLongitude || jsonData.longitude,
                    movementStatus: jsonData.movementStatus,
                    positionSpeed: jsonData.positionSpeed,
                    positionValid: jsonData.positionValid,
                    positionAltitude: jsonData.positionAltitude,
                    positionDirection: jsonData.positionDirection,
                    batteryLevel: jsonData.batteryLevel,
                    gnssStatus: jsonData.gnssStatus
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
                                    // Ensure we have all necessary fields for walk tracking
                                    const walkRecord = {
                                        ...record,
                                        positionLatitude: record.positionLatitude || record.latitude,
                                        positionLongitude: record.positionLongitude || record.longitude,
                                        movementStatus: record.movementStatus,
                                        positionSpeed: record.positionSpeed,
                                        positionValid: record.positionValid,
                                        positionAltitude: record.positionAltitude,
                                        positionDirection: record.positionDirection,
                                        batteryLevel: record.batteryLevel,
                                        gnssStatus: record.gnssStatus
                                    };
                                    await processWalkTracking(deviceImei, walkRecord);
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
                            safeSocketWrite(socket, ackBuffer, deviceImei);
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
    
    // Debug the record to see what data we're getting
    console.log(`🔍 Processing record for ${deviceImei}:`, {
        timestamp: new Date(record.timestamp).toLocaleTimeString(),
        positionLatitude: record.positionLatitude,
        positionLongitude: record.positionLongitude,
        latitude: record.latitude,
        longitude: record.longitude,
        movementStatus: record.movementStatus
    });
    
    // Skip walk tracking if latitude or longitude is missing or zero
    const hasValidCoordinates = 
        ((record.positionLatitude !== undefined && record.positionLatitude !== null && record.positionLatitude !== 0) || 
         (record.latitude !== undefined && record.latitude !== null && record.latitude !== 0)) && 
        ((record.positionLongitude !== undefined && record.positionLongitude !== null && record.positionLongitude !== 0) ||
         (record.longitude !== undefined && record.longitude !== null && record.longitude !== 0));
    
    if (hasValidCoordinates) {
        // Use the appropriate coordinate fields (handle both naming conventions)
        const lat = record.positionLatitude || record.latitude;
        const lon = record.positionLongitude || record.longitude;
        
        console.log(`📍 Using coordinates: ${lat}, ${lon}`);
        
        // Check movement status directly from the record
        const isMoving = record.movementStatus === true;
        
        console.log(`🔍 Movement check - Status: ${isMoving}`);
        console.log(`📊 Record details:`, {
            timestamp: new Date(record.timestamp).toLocaleTimeString(),
            latitude: lat,
            longitude: lon,
            movementStatus: record.movementStatus
        });
        
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
                latitude: lat,
                longitude: lon,
                timestamp: timestamp
            });
            
            // Wait for 5 minutes of continuous movement before starting to save
            const MOVEMENT_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
            const movementDuration = timestamp - deviceTracker.movementStartTime;
            
            console.log(`⏱️ Device ${deviceImei}: Movement duration: ${Math.round(movementDuration/1000)} seconds`);
            console.log(`📈 Pending points: ${pendingPoints[deviceImei].length}`);
            console.log(`🚶‍♂️ Movement tracker state: ${JSON.stringify(deviceTracker)}`);
            
            // If not already saving and we've been moving for 5+ minutes, start saving
            if (!deviceTracker.isSaving && movementDuration >= MOVEMENT_THRESHOLD) {
                deviceTracker.isSaving = true;
                console.log(`📝 Device ${deviceImei}: Started tracking movement after ${Math.round(movementDuration/1000)} seconds of activity`);
                
                // Save all pending points that have been accumulated during the 5-minute period
                if (pendingPoints[deviceImei] && pendingPoints[deviceImei].length > 0) {
                    const points = pendingPoints[deviceImei];
                    // Filter out any points with invalid coordinates
                    const validPoints = points.filter(point => 
                        point.latitude !== undefined && point.latitude !== null && point.latitude !== 0 &&
                        point.longitude !== undefined && point.longitude !== null && point.longitude !== 0
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
                await updateWalkPath(deviceImei, lat, lon, timestamp);
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
    } else {
        console.log(`❌ Skipping walk tracking for device ${deviceImei}: Invalid coordinates: 
            positionLatitude=${record.positionLatitude}, 
            positionLongitude=${record.positionLongitude},
            latitude=${record.latitude}, 
            longitude=${record.longitude}`);
    }
}

// Helper function to create a walk path with initial points
async function createWalkPathWithInitialPoints(deviceImei, points) {
    try {
        // Validate that we have at least one valid point
        if (!points || points.length === 0 || 
            !points[0].latitude || !points[0].longitude || 
            points[0].latitude === 0 || points[0].longitude === 0) {
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
// Modified updateWalkPath function with better error handling and retry logic
async function updateWalkPath(deviceImei, positionLatitude, positionLongitude, timestamp) {
    try {
        // Skip if latitude or longitude is missing or zero
        if (positionLatitude === undefined || positionLatitude === null || positionLatitude === 0 || 
            positionLongitude === undefined || positionLongitude === null || positionLongitude === 0) {
            console.log(`❌ Skipping walk update for device ${deviceImei}: Missing or invalid coordinates`);
            return null;
        }
        
        console.log(`📍 Attempting to update walk path for device ${deviceImei} with point: ${positionLatitude}, ${positionLongitude}`);
        
        // Get the current walk path
        const deviceInfo = await getDeviceInfoByDeviceId(deviceImei);
        if (!deviceInfo) {
            console.error(`❌ Cannot update walk path: Device ${deviceImei} not found`);
            return null;
        }
        
        // Create a new point
        const newPoint = {
            latitude: positionLatitude,
            longitude: positionLongitude,
            timestamp: timestamp
        };
        
        // Try to find active walk path
        const activeWalkPath = await WalkPath.findOne({ 
            device: deviceInfo._id, 
            isActive: true 
        });
        
        // If no active walk path exists, create one
        if (!activeWalkPath) {
            console.log(`📝 No active walk path found for device ${deviceImei}, creating a new one...`);
            return await saveWalkPath(
                deviceImei,
                [newPoint],
                true,
                timestamp,
                null
            );
        }
        
        // Add point to existing walk path
        activeWalkPath.coordinates.push(newPoint);
        
        // Calculate new distance if this isn't the first point
        if (activeWalkPath.coordinates.length > 1) {
            const prevPoint = activeWalkPath.coordinates[activeWalkPath.coordinates.length - 2];
            const distance = calculateDistance(
                prevPoint.latitude, 
                prevPoint.longitude, 
                newPoint.latitude, 
                newPoint.longitude
            );
            activeWalkPath.distance = (activeWalkPath.distance || 0) + distance;
        }
        
        // Update duration
        const durationInSeconds = Math.floor((timestamp - activeWalkPath.startTime) / 1000);
        activeWalkPath.duration = durationInSeconds;
        
        // Save the updated walk path
        const updatedWalkPath = await activeWalkPath.save();
        console.log(`✅ Successfully updated walk path for device ${deviceImei}`);
        return updatedWalkPath;
    } catch (error) {
        console.error(`❌ Error updating walk path for device ${deviceImei}: ${error.message}`);
        return null;
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

// Add this helper function to check if socket is writable
function isSocketWritable(socket) {
    return socket && !socket.destroyed && socket.writable;
}

// Helper function to safely write to socket
function safeSocketWrite(socket, data, deviceImei) {
    if (isSocketWritable(socket)) {
        socket.write(data);
    } else {
        console.log(`⚠️ Cannot write to socket for device ${deviceImei}: Socket not writable`);
    }
}

// Start server
async function startServer() {
    try {
        server.listen(DEVICE_PORT, () => {
            console.log(`🚀 Server listening on port ${DEVICE_PORT}`);
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