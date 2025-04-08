const net = require('net');
const { parseTeltonikaData } = require('./parsers');
const { saveRawPacket, hexDump, isImeiPacket, parseImeiPacket } = require('./utils');
const { DEVICE_PORT, SOCKET_TIMEOUT, DEBUG_LOG } = require('./config');
const { connectToDatabase, saveDeviceData, getDeviceInfoByDeviceId } = require('./database');

// Track connected devices
const activeDevices = new Map(); // Maps deviceId to device info

// Rate limiting configuration
const RATE_LIMIT = {
    maxConnections: 100, // Maximum number of concurrent connections
    maxRequestsPerMinute: 60, // Maximum requests per minute per device
    requestWindowMs: 60000 // 1 minute window
};

// Track request counts for rate limiting
const requestCounts = new Map();

// Function to check if a device is rate limited
function isRateLimited(deviceId) {
    const now = Date.now();
    const deviceRequests = requestCounts.get(deviceId) || [];
    
    // Remove old requests outside the time window
    const recentRequests = deviceRequests.filter(time => now - time < RATE_LIMIT.requestWindowMs);
    requestCounts.set(deviceId, recentRequests);
    
    // Check if device has exceeded rate limit
    if (recentRequests.length >= RATE_LIMIT.maxRequestsPerMinute) {
        return true;
    }
    
    // Add current request
    recentRequests.push(now);
    return false;
}

// Create a TCP server to receive data from the device
const server = net.createServer({
    keepAlive: true,
    keepAliveInitialDelay: 60000,
    noDelay: true
}, (socket) => {
    // Check if we've reached maximum connections
    if (activeDevices.size >= RATE_LIMIT.maxConnections) {
        console.log('⚠️ Maximum connections reached, rejecting new connection');
        socket.end();
        return;
    }

    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    
    // Configure socket
    socket.setTimeout(SOCKET_TIMEOUT);
    socket.setKeepAlive(true, 60000);
    socket.setNoDelay(true);
    
    // Force socket settings to be applied
    socket.on('connect', () => {
        console.log('🔌 Socket connected, applying settings...');
        socket.setKeepAlive(true, 60000);
        socket.setNoDelay(true);
        socket.setTimeout(SOCKET_TIMEOUT);
    });
    
    let dataBuffer = Buffer.alloc(0);
    let deviceId = null;
    let lastActivity = Date.now();
    let bytesReceived = 0;
    let packetsProcessed = 0;
    let connectionStartTime = Date.now();
    let isProcessing = false;
    let isImeiProcessed = false;

    // Log initial connection details
    console.log(`📡 New device connected: ${clientId}`);
    console.log(`📡 Socket details:`, {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        timeout: socket.timeout,
        keepAlive: socket.keepAlive,
        noDelay: socket.noDelay
    });

    // Send initial acknowledgment to keep connection alive
    const initialAck = Buffer.from([0x01]);
    socket.write(initialAck, (err) => {
        if (err) {
            console.error('❌ Error sending initial acknowledgment:', err);
        } else {
            console.log('📤 Sent initial acknowledgment to device');
        }
    });

    // Set up periodic keepalive
    const keepAliveInterval = setInterval(() => {
        if (!socket.destroyed) {
            socket.write(initialAck, (err) => {
                if (err) {
                    console.error('❌ Error sending keepalive:', err);
                } else {
                    console.log('📤 Sent keepalive acknowledgment');
                }
            });
        }
    }, 30000); // Send keepalive every 30 seconds

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
        console.log('⚠️ Socket timeout detected, but keeping connection alive');
        socket.setTimeout(SOCKET_TIMEOUT);
    });

    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${clientId} (Device ID: ${deviceId || 'unknown'}):`, error);
        console.error('❌ Error details:', {
            message: error.message,
            stack: error.stack
        });
    });

    socket.on('close', () => {
        console.log(`🔌 Connection closed: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
        console.log('📊 Connection statistics:', {
            duration: Date.now() - connectionStartTime,
            bytesReceived,
            packetsProcessed,
            isImeiProcessed
        });
        
        // Clean up
        clearInterval(keepAliveInterval);
        if (deviceId) {
            activeDevices.delete(deviceId);
            requestCounts.delete(deviceId);
        }
    });

    socket.on('data', async (data) => {
        // Prevent concurrent processing of the same device's data
        if (isProcessing) {
            console.log(`⚠️ Skipping concurrent data processing for device ${deviceId || 'unknown'}`);
            return;
        }

        isProcessing = true;
        try {
            lastActivity = Date.now();
            bytesReceived += data.length;
            
            console.log(`📩 Received ${data.length} bytes from ${clientId} (Device ID: ${deviceId || 'unknown'})`);
            console.log('📦 Raw data (hex):', data.toString('hex'));
            console.log('📦 Raw data (ascii):', data.toString('ascii'));
            
            // Append new data to our buffer
            dataBuffer = Buffer.concat([dataBuffer, data]);
            
            // Process buffer until we've consumed all complete packets
            await processBuffer();

            async function processBuffer() {
                // Check if we have enough data for basic analysis
                if (dataBuffer.length < 2) {
                    console.log('⚠️ Not enough data for processing, waiting for more');
                    return;
                }
                
                // Log buffer state
                console.log(`📦 Current buffer length: ${dataBuffer.length} bytes`);
                console.log(`📦 Buffer content (hex): ${dataBuffer.toString('hex')}`);
                
                // Check if this is a login/device ID packet (according to specification)
                if (!isImeiProcessed && isImeiPacket(dataBuffer)) {
                    try {
                        console.log('🔍 Processing IMEI packet...');
                        deviceId = parseImeiPacket(dataBuffer);
                        console.log(`📱 Device ID: ${deviceId}`);
                        
                        // Check if device exists in database
                        const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
                        if (!deviceInfo) {
                            console.log(`⚠️ Device ${deviceId} not found in database`);
                            // Don't disconnect, just mark as unknown
                            deviceId = 'unknown';
                        } else {
                            console.log(`✅ Device ${deviceId} found in database`);
                            // Register device in active devices map
                            activeDevices.set(deviceId, {
                                socket: socket,
                                deviceId: deviceId,
                                clientId: clientId,
                                connectedAt: new Date(),
                                lastActivity: new Date(),
                                bytesReceived: bytesReceived,
                                packetsProcessed: 0
                            });
                        }
                        
                        // Send acknowledgment to device regardless of database status
                        const ackBuffer = Buffer.from([0x01]);
                        socket.write(ackBuffer);
                        console.log(`✅ Sent device ID acknowledgment: ${ackBuffer.toString('hex')}`);
                        
                        // Calculate how many bytes to remove (2 bytes length + device ID length)
                        const deviceIdLength = dataBuffer.readUInt16BE(0);
                        dataBuffer = dataBuffer.slice(2 + deviceIdLength);
                        
                        isImeiProcessed = true; // Mark IMEI as processed
                        
                        // Process any remaining data in the buffer
                        if (dataBuffer.length > 0) await processBuffer();
                    } catch (error) {
                        console.error('❌ Error processing IMEI packet:', error);
                        console.error('❌ Error details:', {
                            message: error.message,
                            stack: error.stack,
                            buffer: dataBuffer.toString('hex')
                        });
                        // Don't disconnect, try to process as AVL data
                    }
                }
                // Check if we have a standard AVL data packet (starts with 00000000 preamble)
                else if (dataBuffer.length >= 8) {
                    // Check for standard preamble (4 bytes of zeros)
                    const preamble = dataBuffer.readUInt32BE(0);
                    if (preamble === 0) {
                        // Check rate limiting
                        if (deviceId && isRateLimited(deviceId)) {
                            console.log(`⚠️ Rate limit exceeded for device ${deviceId}`);
                            // Remove the packet from buffer but don't process it
                            const dataFieldLength = dataBuffer.readUInt32BE(4);
                            const totalPacketSize = 8 + dataFieldLength + 4;
                            dataBuffer = dataBuffer.slice(totalPacketSize);
                            return;
                        }

                        // Parse the AVL data
                        const records = parseTeltonikaData(dataBuffer, deviceId);
                        
                        if (records && records.length > 0) {
                            // Save the records to database
                            await saveDeviceData(deviceId, records);
                            
                            // Send acknowledgment to device (number of records processed)
                            const ackBuffer = Buffer.from([records.length]);
                            socket.write(ackBuffer);
                            console.log(`✅ Sent AVL acknowledgment: ${ackBuffer.toString('hex')}`);
                            
                            // Update device stats
                            packetsProcessed += records.length;
                            if (activeDevices.has(deviceId)) {
                                const deviceInfo = activeDevices.get(deviceId);
                                deviceInfo.packetsProcessed = packetsProcessed;
                                deviceInfo.lastActivity = new Date();
                            }
                        }
                        
                        // Remove processed data from buffer
                        const dataFieldLength = dataBuffer.readUInt32BE(4);
                        const totalPacketSize = 8 + dataFieldLength + 4; // preamble + length + data + CRC
                        dataBuffer = dataBuffer.slice(totalPacketSize);
                        
                        // Process any remaining data
                        if (dataBuffer.length > 0) await processBuffer();
                    } else {
                        // Invalid preamble, remove first byte and try again
                        console.log('⚠️ Invalid preamble, trying next byte');
                        dataBuffer = dataBuffer.slice(1);
                        await processBuffer();
                    }
                } else {
                    console.log('⚠️ Not enough data for processing, waiting for more');
                }
            }
        } catch (error) {
            console.error(`❌ Error processing data for device ${deviceId || 'unknown'}:`, error);
            console.error('❌ Error details:', {
                message: error.message,
                stack: error.stack
            });
        }
        isProcessing = false;
    });
});

// Start the device server
function startDeviceServer() {
    // Connect to MongoDB first
    connectToDatabase().then(() => {
        server.listen(DEVICE_PORT, () => {
            console.log(`📡 Device server listening on port ${DEVICE_PORT}`);
        });
    }).catch(error => {
        console.error('❌ Failed to start device server:', error);
        process.exit(1);
    });
}

module.exports = {
    server,
    startDeviceServer,
    activeDevices
}; 