const net = require('net');
const { 
    getDeviceInfoByDeviceId, 
    saveDeviceData, 
    saveWalkPath, 
    updateWalkPath: dbUpdateWalkPath,
    WalkPath,
    ensureConnection
} = require('./database');
const { parseTeltonikaData } = require('./parsers');
const { calculateDistance } = require('./utils/geofenceUtils');

// Configuration
const DEVICE_PORT = 5005;
const SOCKET_TIMEOUT = 300000; // 5 minutes
const DEBUG_LOG = true;

// Retry configuration for database operations
const RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000, // 1 second
    timeout: 5000 // 5 seconds
};

// Track server start time
const SERVER_START_TIME = Date.now();

// Track active devices and their movement
const activeDevices = new Map();
const movementTracker = {};
const pendingPoints = {};

// Create TCP server
const server = net.createServer((socket) => {
    const clientIP = socket.remoteAddress;
    
    // Initialize socket properties
    socket.dataBuffer = Buffer.alloc(0);
    socket.deviceImei = null;
    socket.lastActivity = Date.now();
    socket.timeoutHandler = null;

    // Connection management improvements
    const connectionTimeouts = {};
    const reconnectAttempts = {};
    const MAX_RECONNECT_ATTEMPTS = 5;

    const processBuffer = async () => {
        try {
            // Ensure dataBuffer is always initialized
            if (!socket.dataBuffer) {
                socket.dataBuffer = Buffer.alloc(0);
                return;
            }
    
            // Don't process if the buffer is too small
            if (socket.dataBuffer.length < 2) return;
            // Check for IMEI packet
            if (isImeiPacket(socket.dataBuffer)) {
                socket.deviceImei = parseImeiPacket(socket.dataBuffer);
                console.log(`📱 Device connected - IMEI: ${socket.deviceImei} at ${new Date().toISOString()}`);

                const deviceInfo = await getDeviceInfoByDeviceId(socket.deviceImei);
                if (!deviceInfo) {
                    console.warn(`⚠️ Unknown device: ${socket.deviceImei}. Closing connection.`);
                    socket.end();
                    return;
                }

                activeDevices.set(socket.deviceImei, {
                    socket,
                    imei: socket.deviceImei,
                    ip: clientIP,
                    connectedAt: new Date(),
                    lastActivity: new Date()
                });

                // Initialize movement tracker for this device
                if (!movementTracker[socket.deviceImei]) {
                    movementTracker[socket.deviceImei] = {
                        lastMovement: new Date(),
                        movementStartTime: null,
                        falseDuration: 0,
                        isSaving: false,
                        pendingPoints: [] // Store points before DB saving starts
                    };
                }

                // Initialize pending points array
                if (!pendingPoints[socket.deviceImei]) {
                    pendingPoints[socket.deviceImei] = [];
                    console.log(`🆕 Initialized pending points array for ${socket.deviceImei}`);
                }

                safeSocketWrite(socket, Buffer.from([0x01]), socket.deviceImei);
                const imeiLength = socket.dataBuffer.readUInt16BE(0);
                socket.dataBuffer = socket.dataBuffer.slice(2 + imeiLength);

                if (socket.dataBuffer.length > 0) await processBuffer();
            } else {
                // Try to parse as JSON first
                try {
                    const jsonData = JSON.parse(socket.dataBuffer.toString());
                    console.log(`📦 Received JSON data from ${socket.deviceImei}:`, jsonData);
                    
                    // Process the JSON data
                    const record = {
                        deviceImei: socket.deviceImei,
                        deviceId: socket.deviceImei,
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
                    await processWalkTracking(socket.deviceImei, record);
                    
                    // Save device data
                    try {
                        await saveDeviceData(socket.deviceImei, [record]);
                        console.log(`✅ Saved device data for ${socket.deviceImei}`);
                    } catch (error) {
                        console.error(`❌ Failed to save device data for ${socket.deviceImei}:`, error.message);
                    }

                    // Clear the buffer
                    socket.dataBuffer = Buffer.alloc(0);
                } catch (e) {
                    // Not JSON data, try Teltonika parsing
                    if (socket.dataBuffer.length >= 8) {
                        const preamble = socket.dataBuffer.readUInt32BE(0);
                        if (preamble !== 0) {
                            socket.dataBuffer = socket.dataBuffer.slice(1);
                            if (socket.dataBuffer.length > 0) await processBuffer();
                            return;
                        }

                        const dataLength = socket.dataBuffer.readUInt32BE(4);
                        const totalLength = 8 + dataLength + 4;

                        if (socket.dataBuffer.length >= totalLength) {
                            const fullPacket = socket.dataBuffer.slice(0, totalLength);
                            const records = parseTeltonikaData(fullPacket, socket.deviceImei);

                            if (records.length > 0) {
                                // Filter records to only include those newer than server start
                                const newRecords = records.filter(record => {
                                    const recordTime = new Date(record.timestamp).getTime();
                                    return recordTime > SERVER_START_TIME;
                                });

                                if (newRecords.length > 0) {
                                    // Process each record for walk tracking
                                    for (const record of newRecords) {
                                        await processWalkTracking(socket.deviceImei, record);
                                    }
                                    
                                    try {
                                        await saveDeviceData(socket.deviceImei, newRecords);
                                        console.log(`✅ Saved latest record for ${socket.deviceImei}`);
                                    } catch (error) {
                                        console.error(`❌ Failed to save records for ${socket.deviceImei}:`, error.message);
                                    }
                                }

                                const ackBuffer = Buffer.alloc(4);
                                ackBuffer.writeUInt32BE(records.length, 0);
                                safeSocketWrite(socket, ackBuffer, socket.deviceImei);
                            }

                            socket.dataBuffer = socket.dataBuffer.slice(totalLength);
                            if (socket.dataBuffer.length > 0) await processBuffer();
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Error in processBuffer: ${error.message}`);
            socket.dataBuffer = Buffer.alloc(0);
        }
    };

    // Timeout if the device doesn't send data within 1 minute
    socket.timeoutHandler = setTimeout(() => {
        console.log(`⏱️ No data received from ${socket.deviceImei || 'unknown device'}`);
        socket.end();
    }, 60000);

    socket.setTimeout(SOCKET_TIMEOUT);

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${socket.deviceImei || 'unknown device'}`);
        socket.end();
    });

    socket.on('data', async (data) => {
        try {
            socket.lastActivity = Date.now();
            clearTimeout(socket.timeoutHandler);
    
            if (DEBUG_LOG) {
                console.log(`📩 Received ${data.length} bytes from ${socket.deviceImei || 'new connection'} at ${new Date().toISOString()}`);
            }
    
            // Ensure dataBuffer is always properly initialized
            if (!socket.dataBuffer) {
                socket.dataBuffer = Buffer.alloc(0);
            }
            
            // Create a new buffer with the existing data and new data
            const newBuffer = Buffer.concat([socket.dataBuffer, data]);
            socket.dataBuffer = newBuffer;
            
            await processBuffer();
    
            // Reset timeout
            socket.timeoutHandler = setTimeout(() => {
                console.log(`⏱️ No data received from ${socket.deviceImei || 'unknown device'}`);
                socket.end();
            }, 60000);
        } catch (error) {
            console.error(`❌ Error processing data: ${error.message}`);
            // Reset buffer to prevent further errors from corrupted data
            socket.dataBuffer = Buffer.alloc(0);
        }
    });

    socket.on('error', (err) => {
        console.error(`❌ Connection error (${socket.deviceImei || 'unknown'}): ${err.message}`);
        
        // Close socket if still open
        if (!socket.destroyed) {
            try {
                socket.end();
            } catch (closeErr) {
                console.error(`Error closing socket: ${closeErr.message}`);
            }
        }
        
        // Clean up the connection
        if (socket.deviceImei) {
            // Remove from active devices
            if (activeDevices.has(socket.deviceImei)) {
                activeDevices.delete(socket.deviceImei);
            }
            
            // Track reconnection attempts
            if (!reconnectAttempts[socket.deviceImei]) {
                reconnectAttempts[socket.deviceImei] = 0;
            }
            
            // Only try to reconnect if under max attempts
            if (reconnectAttempts[socket.deviceImei] < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts[socket.deviceImei]++;
                console.log(`⏱️ Scheduling reconnection attempt ${reconnectAttempts[socket.deviceImei]} for device ${socket.deviceImei}`);
                
                // Clean up any existing timeout
                if (connectionTimeouts[socket.deviceImei]) {
                    clearTimeout(connectionTimeouts[socket.deviceImei]);
                }
                
                // Schedule reconnect attempt - device will actually reconnect on its own
                connectionTimeouts[socket.deviceImei] = setTimeout(() => {
                    console.log(`🔄 Connection timeout cleared for device ${socket.deviceImei}`);
                    delete connectionTimeouts[socket.deviceImei];
                }, 60000); // 1 minute delay
            } else {
                console.log(`⚠️ Max reconnection attempts reached for device ${socket.deviceImei}`);
            }
        }
    });

    socket.on('close', () => {
        console.log(`🔌 Device disconnected: ${socket.deviceImei || 'unknown'}`);
        
        if (socket.deviceImei && activeDevices.has(socket.deviceImei)) {
            activeDevices.delete(socket.deviceImei);
        }
        
        clearTimeout(socket.timeoutHandler);
        
        // If this was a clean close, reset reconnect attempts
        if (socket.deviceImei) {
            reconnectAttempts[socket.deviceImei] = 0;
        }
    });
});

// Improved walk tracking process with better error handling
async function processWalkTracking(deviceImei, record) {
    try {
        const timestamp = new Date(record.timestamp);
        const lat = record.positionLatitude || record.latitude;
        const lon = record.positionLongitude || record.longitude;

        // Validate coordinates
        if (!lat || !lon || isNaN(lat) || isNaN(lon) || lat === 0 || lon === 0) {
            console.error(`❌ Invalid coordinates for device ${deviceImei}: lat=${lat}, lon=${lon}`);
            return;
        }

        // Get device tracker from our local map
        let deviceTracker = movementTracker[deviceImei];
        if (!deviceTracker) {
            deviceTracker = {
                isSaving: false,
                lastPoint: null,
                lastUpdate: Date.now(),
                movementStartTime: null,
                falseDuration: 0,
                pendingPoints: [] // Store points before DB saving starts
            };
            movementTracker[deviceImei] = deviceTracker;
        }

        // Update last point and timestamp
        deviceTracker.lastPoint = { lat, lon, timestamp };
        deviceTracker.lastUpdate = Date.now();

        // Get movement status from the record
        // Check both movementStatus and movement fields
        const isMoving = record.movementStatus === true || record.movement === true;
        
        console.log(`🔍 Device ${deviceImei}: Movement Status: ${isMoving}, Raw Status: ${record.movementStatus}, Raw Movement: ${record.movement}`);
        
        if (isMoving) {
            // Reset false duration counter
            deviceTracker.falseDuration = 0;
            
            // Set movement start time if not already set
            if (!deviceTracker.movementStartTime) {
                deviceTracker.movementStartTime = timestamp;
                console.log(`🚶‍♂️ Device ${deviceImei}: Movement started at ${timestamp.toLocaleTimeString()}`);
            }
            
            // Add point to pending points array
            deviceTracker.pendingPoints.push({
                latitude: lat,
                longitude: lon,
                timestamp: timestamp
            });
            
            // Check if we should start saving to DB (after 5 minutes of movement)
            const movementDuration = timestamp - deviceTracker.movementStartTime;
            if (movementDuration >= 300000 && !deviceTracker.isSaving) { // 5 minutes = 300000 ms
                console.log(`🛣️ Device ${deviceImei}: Starting DB saving after ${Math.round(movementDuration/1000)}s of movement`);
                deviceTracker.isSaving = true;
                
                // Save all pending points to DB
                if (deviceTracker.pendingPoints.length > 0) {
                    const result = await saveWalkPath(
                        deviceImei,
                        deviceTracker.pendingPoints,
                        true,
                        deviceTracker.pendingPoints[0].timestamp,
                        null
                    );
                    
                    if (result) {
                        console.log(`✅ Device ${deviceImei}: Created walk path with ${deviceTracker.pendingPoints.length} initial points`);
                        // Clear pending points after successful save
                        deviceTracker.pendingPoints = [];
                    } else {
                        console.error(`❌ Device ${deviceImei}: Failed to create initial walk path`);
                    }
                }
            } else if (deviceTracker.isSaving) {
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
            
            // Stop tracking if inactive for 5 minutes
            if (deviceTracker.falseDuration >= 300000 && deviceTracker.isSaving) { // 5 minutes = 300000 ms
                console.log(`🛑 Device ${deviceImei}: Stopped tracking after ${Math.round(deviceTracker.falseDuration/1000)}s idle`);
                
                // Save any remaining pending points
                if (deviceTracker.pendingPoints.length > 0) {
                    const result = await saveWalkPath(
                        deviceImei,
                        deviceTracker.pendingPoints,
                        false,
                        deviceTracker.pendingPoints[0].timestamp,
                        timestamp
                    );
                    
                    if (result) {
                        console.log(`✅ Device ${deviceImei}: Saved final walk path with ${deviceTracker.pendingPoints.length} points`);
                    } else {
                        console.error(`❌ Device ${deviceImei}: Failed to save final walk path`);
                    }
                }
                
                // Reset tracker state
                deviceTracker.isSaving = false;
                deviceTracker.movementStartTime = null;
                deviceTracker.falseDuration = 0;
                deviceTracker.pendingPoints = [];
                
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

// Helper function to create a walk path with initial points
async function createWalkPathWithInitialPoints(deviceImei, points) {
    try {
        // Improved validation to avoid rejecting valid coordinates
        if (!points || points.length === 0 || 
            points[0].latitude === undefined || points[0].longitude === undefined || 
            isNaN(points[0].latitude) || isNaN(points[0].longitude) || 
            (points[0].latitude === 0 && points[0].longitude === 0)) {
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
async function updateWalkPath(deviceId, latitude, longitude, timestamp) {
    let retries = 0;
    
    while (retries < RETRY_CONFIG.maxRetries) {
        try {
            // Validate inputs before proceeding
            if (latitude === undefined || longitude === undefined || 
                isNaN(latitude) || isNaN(longitude) ||
                (latitude === 0 && longitude === 0)) {
                console.error(`❌ Cannot update walk path: Invalid coordinates for device ${deviceId}: lat=${latitude}, lon=${longitude}`);
                return null;
            }
            
            // Get device info first
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

// Add the closeActiveWalkPaths function
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

// Add the deg2rad function
function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

module.exports = {
    startServer,
    server,
    activeDevices,
    safeSocketWrite,
    handleSocketError,
    handleSocketClose,
    handleDeviceData,
    processWalkTracking,
    updateWalkPath,
    closeActiveWalkPaths
};