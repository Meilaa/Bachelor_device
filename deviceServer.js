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
const server = net.createServer((socket) => {
    // Check if we've reached maximum connections
    if (activeDevices.size >= RATE_LIMIT.maxConnections) {
        console.log('⚠️ Maximum connections reached, rejecting new connection');
        socket.end();
        return;
    }

    // Apply socket settings immediately (IMPORTANT: do this before any logging)
    socket.setTimeout(SOCKET_TIMEOUT);
    socket.setKeepAlive(true, 60000);
    socket.setNoDelay(true);

    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    
    // Log initial connection details with confirmed settings
    console.log(`📡 New device connected: ${clientId}`);
    console.log(`📡 Socket details:`, {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        timeout: socket.timeout,
        keepAlive: true, // We've set this, so we know it's true
        noDelay: true    // We've set this, so we know it's true
    });
    
    let dataBuffer = Buffer.alloc(0);
    let deviceId = null;
    let lastActivity = Date.now();
    let bytesReceived = 0;
    let packetsProcessed = 0;
    let connectionStartTime = Date.now();
    let isProcessing = false;
    let isImeiProcessed = false;

    // Set up periodic health check, but don't send data
    const healthCheckInterval = setInterval(() => {
        // Check if the socket is idle for too long
        const idleTime = Date.now() - lastActivity;
        if (idleTime > 120000) { // 2 minutes idle
            console.log(`⚠️ Connection idle for too long: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
            console.log(`⏱️ Idle time: ${idleTime}ms, closing connection`);
            socket.end();
            return;
        }
        
        // Log connection health but don't send keepalive packets
        console.log(`🔄 Connection health check: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
        console.log(`⏱️ Idle time: ${idleTime}ms`);
    }, 60000); // Check every minute

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
        // When timeout occurs, end the connection instead of keeping it alive
        socket.end();
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
        clearInterval(healthCheckInterval);
        if (deviceId) {
            activeDevices.delete(deviceId);
            requestCounts.delete(deviceId);
        }
    });

    // RAW data logging - capture everything immediately for debugging
    socket.on('data', (data) => {
        // Log raw data immediately before any processing
        console.log(`📩 RAW DATA RECEIVED [${data.length} bytes]: ${data.toString('hex')}`);
        processData(data);
    });

    async function processData(data) {
        // Prevent concurrent processing of the same device's data
        if (isProcessing) {
            console.log(`⚠️ Skipping concurrent data processing for device ${deviceId || 'unknown'}`);
            return;
        }

        isProcessing = true;
        try {
            lastActivity = Date.now();
            bytesReceived += data.length;
            
            console.log(`📩 Processing ${data.length} bytes from ${clientId} (Device ID: ${deviceId || 'unknown'})`);
            
            // Append new data to our buffer
            dataBuffer = Buffer.concat([dataBuffer, data]);
            
            // Process buffer until we've consumed all complete packets
            await processBuffer();
        } catch (error) {
            console.error(`❌ Error processing data for device ${deviceId || 'unknown'}:`, error);
            console.error('❌ Error details:', {
                message: error.message,
                stack: error.stack
            });
        }
        isProcessing = false;
    }

    async function processBuffer() {
        // Check if we have enough data for basic analysis
        if (dataBuffer.length < 2) {
            console.log('⚠️ Not enough data for processing, waiting for more');
            return;
        }
        
        // Log buffer state
        console.log(`📦 Current buffer length: ${dataBuffer.length} bytes`);
        console.log(`📦 Buffer content (hex): ${dataBuffer.toString('hex')}`);
        
        // Check if this is an HTTP request
        const isHttpRequest = dataBuffer.toString().startsWith('GET') || 
                            dataBuffer.toString().startsWith('POST') ||
                            dataBuffer.toString().startsWith('PUT') ||
                            dataBuffer.toString().startsWith('DELETE');
        
        if (isHttpRequest) {
            console.log('⚠️ Received HTTP request instead of device data');
            console.log('📦 HTTP request:', dataBuffer.toString());
            
            // Send HTTP 400 Bad Request response
            const httpResponse = 'HTTP/1.1 400 Bad Request\r\n' +
                               'Content-Type: text/plain\r\n' +
                               'Connection: close\r\n' +
                               '\r\n' +
                               'This server expects Teltonika protocol data, not HTTP requests.';
            
            socket.write(httpResponse, (err) => {
                if (err) {
                    console.error('❌ Error sending HTTP response:', err);
                } else {
                    console.log('📤 Sent HTTP 400 response');
                }
                socket.end();
            });
            return;
        }
        
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
                    // Don't disconnect, just mark as unknown but keep IMEI
                } else {
                    console.log(`✅ Device ${deviceId} found in database`);
                }
                
                // Register device in active devices map regardless of database status
                activeDevices.set(deviceId, {
                    socket: socket,
                    deviceId: deviceId,
                    clientId: clientId,
                    connectedAt: new Date(),
                    lastActivity: new Date(),
                    bytesReceived: bytesReceived,
                    packetsProcessed: 0
                });
                
                // Send acknowledgment to device - ONLY after IMEI is received
                const ackBuffer = Buffer.from([0x01]);
                socket.write(ackBuffer, (err) => {
                    if (err) {
                        console.error('❌ Error sending IMEI acknowledgment:', err);
                    } else {
                        console.log(`✅ Sent device ID acknowledgment: ${ackBuffer.toString('hex')}`);
                    }
                });
                
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
                    
                    // Ensure we have the complete packet before slicing
                    if (dataBuffer.length >= totalPacketSize) {
                        dataBuffer = dataBuffer.slice(totalPacketSize);
                    } else {
                        // Not enough data yet, wait for more
                        return;
                    }
                    
                    // Continue processing remaining data
                    if (dataBuffer.length > 0) await processBuffer();
                    return;
                }

                // Ensure we have the complete packet before parsing
                const dataFieldLength = dataBuffer.readUInt32BE(4);
                const totalPacketSize = 8 + dataFieldLength + 4; // preamble + length + data + CRC
                
                if (dataBuffer.length < totalPacketSize) {
                    console.log(`⚠️ Incomplete AVL packet: have ${dataBuffer.length} bytes, need ${totalPacketSize} bytes`);
                    return; // Wait for more data
                }

                try {
                    // Parse the AVL data
                    const records = parseTeltonikaData(dataBuffer, deviceId);
                    
                    if (records && records.length > 0) {
                        // Save the records to database
                        await saveDeviceData(deviceId, records);
                        
                        // Send acknowledgment to device (number of records processed)
                        const recordCount = Buffer.alloc(4);
                        recordCount.writeUInt32BE(records.length, 0);
                        socket.write(recordCount, (err) => {
                            if (err) {
                                console.error('❌ Error sending AVL acknowledgment:', err);
                            } else {
                                console.log(`✅ Sent AVL acknowledgment: ${records.length} records (${recordCount.toString('hex')})`);
                            }
                        });
                        
                        // Update device stats
                        packetsProcessed += records.length;
                        if (activeDevices.has(deviceId)) {
                            const deviceInfo = activeDevices.get(deviceId);
                            deviceInfo.packetsProcessed = packetsProcessed;
                            deviceInfo.lastActivity = new Date();
                        }
                    }
                    
                    // Remove processed data from buffer
                    dataBuffer = dataBuffer.slice(totalPacketSize);
                    
                    // Process any remaining data
                    if (dataBuffer.length > 0) await processBuffer();
                } catch (error) {
                    console.error('❌ Error parsing AVL data:', error);
                    // Skip this packet and try to recover by advancing 1 byte
                    dataBuffer = dataBuffer.slice(1);
                    await processBuffer();
                }
            } else {
                // Invalid preamble, remove first byte and try again
                console.log('⚠️ Invalid preamble, trying next byte');
                console.log(`⚠️ Expected 0, got: ${preamble.toString(16)}`);
                dataBuffer = dataBuffer.slice(1);
                await processBuffer();
            }
        } else {
            console.log('⚠️ Not enough data for AVL packet, waiting for more');
        }
    }
});

// Start the device server
function startDeviceServer() {
    // Connect to MongoDB first
    connectToDatabase().then(() => {
        server.listen(DEVICE_PORT, '0.0.0.0', () => {
            console.log(`📡 Device server listening on all interfaces (0.0.0.0:${DEVICE_PORT})`);
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