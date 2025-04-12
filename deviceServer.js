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
    
    // Initialize buffer and device tracking variables
    let dataBuffer = Buffer.alloc(0);
    let deviceImei = null;
    let lastActivity = Date.now();
    let timeoutHandler = null;

    // Timeout if the device doesn't send data within 1 minute
    timeoutHandler = setTimeout(() => {
        console.log(`⏱️ No data received from ${deviceImei || 'unknown device'}`);
        socket.end();
    }, 60000);

    socket.setTimeout(SOCKET_TIMEOUT);

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${deviceImei || 'unknown device'}`);
        socket.end();
    });

    socket.on('data', async (data) => {
        try {
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
        } catch (error) {
            console.error(`❌ Error processing data: ${error.message}`);
        }
    });

    // Add this near the top of your file or in a strategic location
    // Connection management improvements
    const connectionTimeouts = {};
    const reconnectAttempts = {};
    const MAX_RECONNECT_ATTEMPTS = 5;

    // Add this to your socket handling in deviceServer.js
    socket.on('error', (err) => {
        console.error(`❌ Connection error (${deviceImei || 'unknown'}): ${err.message}`);
        
        // Close socket if still open
        if (!socket.destroyed) {
            try {
                socket.end();
            } catch (closeErr) {
                console.error(`Error closing socket: ${closeErr.message}`);
            }
        }
        
        // Clean up the connection
        if (deviceImei) {
            // Remove from active devices
            if (activeDevices.has(deviceImei)) {
                activeDevices.delete(deviceImei);
            }
            
            // Track reconnection attempts
            if (!reconnectAttempts[deviceImei]) {
                reconnectAttempts[deviceImei] = 0;
            }
            
            // Only try to reconnect if under max attempts
            if (reconnectAttempts[deviceImei] < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts[deviceImei]++;
                console.log(`⏱️ Scheduling reconnection attempt ${reconnectAttempts[deviceImei]} for device ${deviceImei}`);
                
                // Clean up any existing timeout
                if (connectionTimeouts[deviceImei]) {
                    clearTimeout(connectionTimeouts[deviceImei]);
                }
                
                // Schedule reconnect attempt - device will actually reconnect on its own
                connectionTimeouts[deviceImei] = setTimeout(() => {
                    console.log(`🔄 Connection timeout cleared for device ${deviceImei}`);
                    delete connectionTimeouts[deviceImei];
                }, 60000); // 1 minute delay
            } else {
                console.log(`⚠️ Max reconnection attempts reached for device ${deviceImei}`);
            }
        }
    });

    socket.on('close', () => {
        console.log(`🔌 Device disconnected: ${deviceImei || 'unknown'}`);
        
        if (deviceImei && activeDevices.has(deviceImei)) {
            activeDevices.delete(deviceImei);
        }
        
        clearTimeout(timeoutHandler);
        
        // If this was a clean close, reset reconnect attempts
        if (deviceImei) {
            reconnectAttempts[deviceImei] = 0;
        }
    });

    async function processBuffer() {
        try {
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

                if (dataBuffer.length > 0) await processBuffer();
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
                            if (dataBuffer.length > 0) await processBuffer();
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
                                    // Process each record for walk tracking
                                    for (const record of newRecords) {
                                        // Calculate movement status directly based on speed for consistency
                                        const movementStatus = record.positionSpeed > 3; // Using 3 km/h as threshold
                                        
                                        // Update the record with the calculated movement status
                                        record.movementStatus = movementStatus;
                                        
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
                                safeSocketWrite(socket, ackBuffer, deviceImei);
                            }

                            dataBuffer = dataBuffer.slice(totalLength);
                            if (dataBuffer.length > 0) await processBuffer();
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Error in processBuffer: ${error.message}`);
            // Clear the buffer on error to prevent infinite loops
            dataBuffer = Buffer.alloc(0);
        }
    }
});

// Helper function to process walk tracking
// Improved walk tracking process with better error handling
async function processWalkTracking(deviceImei, record) {
    try {
        if (!movementTracker[deviceImei]) {
            movementTracker[deviceImei] = {
                lastMovement: new Date(),
                movementStartTime: null,
                falseDuration: 0,
                isSaving: false
            };
            console.log(`🆕 Initialized movement tracker for ${deviceImei}`);
        }
        
        const deviceTracker = movementTracker[deviceImei];
        const timestamp = new Date(record.timestamp);
        const lat = record.positionLatitude || record.latitude;
        const lon = record.positionLongitude || record.longitude;
        
        // Verify we have valid coordinates
        if (!lat || !lon || lat === 0 || lon === 0) {
            console.log(`❌ Invalid coordinates for device ${deviceImei}: [${lat}, ${lon}]`);
            return;
        }
        
        console.log(`📍 Using coordinates: ${lat}, ${lon}`);
        
        // Check movement status based on speed
        const speed = record.positionSpeed || 0;
        const isMoving = speed > 0.5; // Consider moving if speed > 0.5 km/h
        console.log(`🔍 Movement check - Speed: ${speed} km/h, Status: ${isMoving}`);
        
        if (isMoving) {
            // Reset false duration counter
            deviceTracker.falseDuration = 0;
            
            // Set movement start time if not already set
            if (!deviceTracker.movementStartTime) {
                deviceTracker.movementStartTime = timestamp;
                console.log(`🚶‍♂️ Device ${deviceImei}: Movement detected, starting timer at ${timestamp.toLocaleTimeString()}`);
            }
            
            // Store this point in pending points
            if (!pendingPoints[deviceImei]) {
                pendingPoints[deviceImei] = [];
            }
            
            pendingPoints[deviceImei].push({
                latitude: lat,
                longitude: lon,
                timestamp: timestamp
            });
            
            // Check if we should start saving
            const MOVEMENT_THRESHOLD = 1 * 60 * 1000; // 1 minute
            const movementDuration = timestamp - deviceTracker.movementStartTime;
            
            console.log(`⏱️ Device ${deviceImei}: Movement duration: ${Math.round(movementDuration/1000)} seconds`);
            
            // Start saving if threshold reached
            if (!deviceTracker.isSaving && movementDuration >= MOVEMENT_THRESHOLD) {
                deviceTracker.isSaving = true;
                console.log(`📝 Device ${deviceImei}: Started tracking after ${Math.round(movementDuration/1000)} seconds`);
                
                // Save all pending points
                if (pendingPoints[deviceImei] && pendingPoints[deviceImei].length > 0) {
                    try {
                        const walkPath = await saveWalkPath(
                            deviceImei,
                            pendingPoints[deviceImei],
                            true,
                            pendingPoints[deviceImei][0].timestamp,
                            null
                        );
                        
                        if (walkPath) {
                            console.log(`✅ Created walk path with ${pendingPoints[deviceImei].length} points`);
                            // Clear pending points after successful save
                            pendingPoints[deviceImei] = [];
                        } else {
                            console.error(`❌ Failed to create walk path with initial points`);
                        }
                    } catch (error) {
                        console.error(`❌ Error creating walk path: ${error.message}`);
                    }
                }
            } else if (deviceTracker.isSaving) {
                // Add point to existing walk path
                try {
                    const result = await updateWalkPath(deviceImei, lat, lon, timestamp);
                    if (result) {
                        console.log(`✅ Updated walk path for device ${deviceImei}`);
                    } else {
                        console.error(`❌ Failed to update walk path - null result`);
                    }
                } catch (error) {
                    console.error(`❌ Error adding point to walk path: ${error.message}`);
                }
            }
        } else {
            // Not moving - update falseDuration
            deviceTracker.falseDuration += timestamp - deviceTracker.lastMovement;
            
            // Stop tracking if inactive too long
            const IDLE_THRESHOLD = 2 * 60 * 1000; // 2 minutes
            if (deviceTracker.falseDuration >= IDLE_THRESHOLD && deviceTracker.isSaving) {
                console.log(`🛑 Device ${deviceImei}: Stopped tracking after ${Math.round(deviceTracker.falseDuration/1000)}s idle`);
                deviceTracker.isSaving = false;
                deviceTracker.movementStartTime = null;
                deviceTracker.falseDuration = 0;
                pendingPoints[deviceImei] = [];
            }
        }
        
        // Update last movement time
        deviceTracker.lastMovement = timestamp;
    } catch (error) {
        console.error(`❌ Error in processWalkTracking for ${deviceImei}: ${error.message}`);
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
async function updateWalkPath(deviceId, points, isActive, endTime) {
    try {
        console.log(`Attempting to update walk path for device ${deviceId}`);
        
        // Handle single point vs array of points
        const pointsArray = Array.isArray(points) ? points : [{
            latitude: points,
            longitude: isActive, // In single point mode, isActive is actually longitude
            timestamp: endTime || new Date() // In single point mode, endTime is the timestamp
        }];

        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
        if (!deviceInfo) {
            console.error(`Cannot update walk path: Device ${deviceId} not found`);
            return null;
        }

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

        // Find the active walk path for this device
        let activeWalkPath = await WalkPath.findOne({ 
            device: deviceInfo._id, 
            isActive: true 
        });

        // If no active walk path, create a new one with explicit error handling
        if (!activeWalkPath) {
            console.log(`No active walk path found for device ${deviceId}, creating new one`);
            
            try {
                // Create new walk path
                const newWalkPath = new WalkPath({
                    device: deviceInfo._id,
                    isActive: true,
                    startTime: validPoints[0].timestamp,
                    coordinates: validPoints,
                    distance: 0,
                    duration: 0
                });
                
                activeWalkPath = await newWalkPath.save();
                console.log(`✅ Created new walk path for device ${deviceId} with ID: ${activeWalkPath._id}`);
                return activeWalkPath;
            } catch (createError) {
                console.error(`❌ Failed to create new walk path: ${createError.message}`);
                // Try one more time with minimal data
                try {
                    const simpleWalkPath = new WalkPath({
                        device: deviceInfo._id,
                        isActive: true,
                        startTime: new Date(),
                        coordinates: [{
                            latitude: validPoints[0].latitude,
                            longitude: validPoints[0].longitude,
                            timestamp: validPoints[0].timestamp || new Date()
                        }]
                    });
                    activeWalkPath = await simpleWalkPath.save();
                    console.log(`✅ Created simplified walk path as fallback for device ${deviceId}`);
                    return activeWalkPath;
                } catch (retryError) {
                    console.error(`❌ Final attempt to create walk path failed: ${retryError.message}`);
                    return null;
                }
            }
        }

        // Update the existing walk path with new points
        try {
            // Add the new points
            activeWalkPath.coordinates.push(...validPoints);
            
            // Update the isActive flag if provided
            if (typeof isActive === 'boolean') {
                activeWalkPath.isActive = isActive;
            }
            
            // Update endTime if provided
            if (endTime instanceof Date) {
                activeWalkPath.endTime = endTime;
            }

            // Calculate new distance
            let totalDistance = activeWalkPath.distance || 0;
            const coordsLength = activeWalkPath.coordinates.length;
            
            if (coordsLength > 1) {
                for (let i = coordsLength - validPoints.length; i < coordsLength; i++) {
                    if (i > 0) {
                        const prevPoint = activeWalkPath.coordinates[i-1];
                        const currPoint = activeWalkPath.coordinates[i];
                        
                        const distance = calculateDistance(
                            prevPoint.latitude, 
                            prevPoint.longitude, 
                            currPoint.latitude, 
                            currPoint.longitude
                        );
                        totalDistance += distance;
                    }
                }
            }

            // Update duration
            const startTime = activeWalkPath.startTime;
            const lastPointTime = validPoints[validPoints.length - 1].timestamp;
            const durationInSeconds = Math.floor((lastPointTime - startTime) / 1000);

            // Update walk path properties
            activeWalkPath.distance = Math.round(totalDistance);
            activeWalkPath.duration = durationInSeconds;

            // Save the updated walk path
            const updatedWalkPath = await activeWalkPath.save();
            console.log(`✅ Updated walk path for device ${deviceId} with ${validPoints.length} new points`);
            return updatedWalkPath;
        } catch (updateError) {
            console.error(`❌ Error updating existing walk path: ${updateError.message}`);
            return null;
        }
    } catch (error) {
        console.error(`❌ Error in updateWalkPath: ${error.message}`);
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

// Improved safe socket write function
function safeSocketWrite(socket, data, deviceImei) {
    try {
        if (socket && !socket.destroyed && socket.writable) {
            socket.write(data);
            return true;
        } else {
            console.log(`⚠️ Cannot write to socket for device ${deviceImei}: Socket not writable`);
            return false;
        }
    } catch (error) {
        console.error(`❌ Error writing to socket for ${deviceImei}: ${error.message}`);
        return false;
    }
}

// Socket error handler
function handleSocketError(socket, deviceImei) {
    socket.on('error', (err) => {
        console.error(`❌ Connection error (${deviceImei || 'unknown'}): ${err.message}`);
        if (deviceImei && activeDevices.has(deviceImei)) {
            activeDevices.delete(deviceImei);
        }
    });
}

// Socket close handler
function handleSocketClose(socket, deviceImei) {
    socket.on('close', () => {
        console.log(`🔌 Device disconnected: ${deviceImei}`);
        if (deviceImei && activeDevices.has(deviceImei)) {
            activeDevices.delete(deviceImei);
        }
    });
}

// Function to handle device data
async function handleDeviceData(socket, data, deviceImei) {
    try {
        // ... existing code ...
        
        // Use safeSocketWrite for any socket communications
        if (responseData) {
            safeSocketWrite(socket, responseData, deviceImei);
        }
        
        // ... rest of existing code ...
    } catch (error) {
        console.error(`❌ Error handling device data for ${deviceImei}: ${error.message}`);
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
    activeDevices,
    safeSocketWrite,
    handleSocketError,
    handleSocketClose,
    handleDeviceData
};