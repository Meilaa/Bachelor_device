const net = require('net');
const { getDeviceInfoByDeviceId, saveDeviceData } = require('./database');
const { parseTeltonikaData } = require('./parsers');

// Configuration
const DEVICE_PORT = 8080;
const DEBUG_LOG = true;

// Track active devices
const activeDevices = new Map();

// Create TCP server
const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    let connectionStartTime = Date.now();
    let hasReceivedData = false;
    
    console.log(`🔍 New connection attempt from ${clientId} at ${new Date().toISOString()}`);
    
    // Configure TCP keep-alive (critical for cloud environments)
    socket.setKeepAlive(true, 60000); // Send keep-alive after 60s idle
    console.log(`⚙️ Configured keep-alive for ${clientId} (60s interval)`);
    
    // Reduce timeout to match cloud provider limits
    socket.setTimeout(15000); // 15s instead of 300s
    console.log(`⚙️ Set socket timeout to 15s for ${clientId}`);
    
    // Enable TCP_NODELAY to prevent buffering delays
    socket.setNoDelay(true);
    console.log(`⚙️ Enabled TCP_NODELAY for ${clientId}`);
    
    let dataBuffer = Buffer.alloc(0);
    let deviceImei = null;
    let lastActivity = Date.now();

    // Add heartbeat detection
    const heartbeatInterval = setInterval(() => {
        const timeSinceLastActivity = Date.now() - lastActivity;
        console.log(`💓 Heartbeat check for ${clientId}: ${timeSinceLastActivity}ms since last activity`);
        
        if (timeSinceLastActivity > 30000) {
            console.log(`❤️‍🩹 No activity for 30s, closing ${clientId}`);
            console.log(`📊 Connection stats for ${clientId}:`);
            console.log(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
            console.log(`   - Data received: ${hasReceivedData ? 'Yes' : 'No'}`);
            console.log(`   - IMEI: ${deviceImei || 'Not identified'}`);
            clearInterval(heartbeatInterval);
            socket.end();
        }
    }, 10000);

    socket.on('timeout', () => {
        console.log(`⏱️ Socket timeout for ${clientId}`);
        console.log(`📊 Connection stats at timeout:`);
        console.log(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
        console.log(`   - Data received: ${hasReceivedData ? 'Yes' : 'No'}`);
        console.log(`   - IMEI: ${deviceImei || 'Not identified'}`);
        
        if (!hasReceivedData) {
            console.log(`🔇 Silent close for ${clientId} (no data received)`);
            socket.destroy();
            return;
        }
        console.log(`⏱️ Connection timed out: ${clientId} (IMEI: ${deviceImei || 'unknown'})`);
        clearInterval(heartbeatInterval);
        socket.end();
    });

    socket.on('data', async (data) => {
        try {
            hasReceivedData = true;
            lastActivity = Date.now();
            
            if (DEBUG_LOG) {
                console.log(`📩 Received ${data.length} bytes from ${clientId}`);
                console.log(`📦 Buffer contents: ${data.toString('hex')}`);
            }
            
            // Handle partial IMEI packets
            if (!deviceImei && dataBuffer.length + data.length < 17) {
                console.log(`📦 Accumulating partial IMEI packet: ${dataBuffer.length + data.length} bytes`);
                dataBuffer = Buffer.concat([dataBuffer, data]);
                return;
            }
            
            dataBuffer = Buffer.concat([dataBuffer, data]);
            await processBuffer();
        } catch (error) {
            console.error(`❌ Error processing data from ${clientId}:`, error);
            console.error(`📦 Buffer state: ${dataBuffer.length} bytes`);
        }
    });

    async function processBuffer() {
        try {
            if (dataBuffer.length < 2) {
                console.log(`📦 Buffer too small (${dataBuffer.length} bytes)`);
                return;
            }
            
            // Check for IMEI packet
            if (isImeiPacket(dataBuffer)) {
                console.log(`🔍 Found IMEI packet in buffer (${dataBuffer.length} bytes)`);
                deviceImei = parseImeiPacket(dataBuffer);
                console.log(`📱 Device IMEI: ${deviceImei}`);
                
                // Check if device exists in database
                const deviceInfo = await getDeviceInfoByDeviceId(deviceImei);
                if (!deviceInfo) {
                    console.warn(`⚠️ Unknown device: ${deviceImei}`);
                    console.log(`🔒 Closing connection for unknown device ${deviceImei}`);
                    deviceImei = 'unknown';
                    socket.end();
                    return;
                } else {
                    // Update or add device to active devices
                    activeDevices.set(deviceImei, {
                        socket,
                        imei: deviceImei,
                        clientId,
                        connectedAt: new Date(),
                        lastActivity: new Date()
                    });
                    console.log(`✅ Device ${deviceImei} registered and active`);
                }
                
                // Send acknowledgment
                socket.write(Buffer.from([0x01]));
                console.log(`📤 Sent acknowledgment to ${deviceImei}`);
                
                // Remove processed IMEI data
                const imeiLength = dataBuffer.readUInt16BE(0);
                dataBuffer = dataBuffer.slice(2 + imeiLength);
                console.log(`📦 Remaining buffer: ${dataBuffer.length} bytes`);
                
                if (dataBuffer.length > 0) await processBuffer();
            }
            // Check for data packet
            else if (dataBuffer.length >= 8) {
                const preamble = dataBuffer.readUInt32BE(0);
                console.log(`🔍 Checking data packet preamble: 0x${preamble.toString(16)}`);
                
                if (preamble !== 0) {
                    console.log(`⚠️ Invalid preamble, skipping byte`);
                    dataBuffer = dataBuffer.slice(1);
                    if (dataBuffer.length > 0) await processBuffer();
                    return;
                }
                
                const dataLength = dataBuffer.readUInt32BE(4);
                const totalLength = 8 + dataLength + 4;
                console.log(`📦 Data packet length: ${dataLength} bytes, total: ${totalLength} bytes`);
                
                if (dataBuffer.length >= totalLength) {
                    const fullPacket = dataBuffer.slice(0, totalLength);
                    const records = parseTeltonikaData(fullPacket, deviceImei);
                    
                    if (records.length > 0) {
                        if (DEBUG_LOG) {
                            console.log(`📊 Processing ${records.length} records from device ${deviceImei}`);
                        }
                        
                        try {
                            await saveDeviceData(deviceImei, records);
                            if (DEBUG_LOG) {
                                console.log(`✅ Successfully saved ${records.length} records for device ${deviceImei}`);
                            }
                        } catch (error) {
                            console.error(`❌ Failed to save records for device ${deviceImei}:`, error);
                        }
                        
                        // Send acknowledgment
                        const ackBuffer = Buffer.alloc(4);
                        ackBuffer.writeUInt32BE(records.length, 0);
                        socket.write(ackBuffer);
                        console.log(`📤 Sent acknowledgment for ${records.length} records`);
                    }
                    
                    dataBuffer = dataBuffer.slice(totalLength);
                    console.log(`📦 Remaining buffer: ${dataBuffer.length} bytes`);
                    if (dataBuffer.length > 0) await processBuffer();
                }
            }
        } catch (error) {
            console.error(`❌ Error in processBuffer for ${clientId}:`, error);
            console.error(`📦 Buffer state: ${dataBuffer.length} bytes`);
            dataBuffer = Buffer.alloc(0); // Reset buffer on error
        }
    }

    socket.on('close', () => {
        clearInterval(heartbeatInterval);
        if (hasReceivedData) {
            console.log(`🔌 Device ${deviceImei || 'unknown'} disconnected`);
            console.log(`📊 Final connection stats:`);
            console.log(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
            console.log(`   - IMEI: ${deviceImei || 'Not identified'}`);
            if (deviceImei && activeDevices.has(deviceImei)) {
                activeDevices.delete(deviceImei);
            }
        }
    });
    
    socket.on('error', (err) => {
        console.error(`❌ Socket error for device ${deviceImei || 'unknown'}: ${err.message}`);
        console.error(`📊 Error stats:`);
        console.error(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
        console.error(`   - Data received: ${hasReceivedData ? 'Yes' : 'No'}`);
        console.error(`   - IMEI: ${deviceImei || 'Not identified'}`);
        clearInterval(heartbeatInterval);
    });
});

// Helper functions
function isImeiPacket(buffer) {
    try {
        if (buffer.length < 4) {
            console.log(`📦 Buffer too small for IMEI check: ${buffer.length} bytes`);
            return false;
        }
        
        const imeiLength = buffer.readUInt16BE(0);
        console.log(`🔍 IMEI length check: ${imeiLength} bytes`);
        
        if (imeiLength < 15 || imeiLength > 17 || buffer.length < imeiLength + 2) {
            console.log(`⚠️ Invalid IMEI length or buffer size`);
            return false;
        }
        
        for (let i = 2; i < 2 + imeiLength; i++) {
            if (i >= buffer.length) {
                console.log(`⚠️ Buffer index out of range: ${i}`);
                return false;
            }
            const char = buffer[i];
            if (char < 0x30 || char > 0x39) {
                console.log(`⚠️ Invalid IMEI character at index ${i}: 0x${char.toString(16)}`);
                return false;
            }
        }
        console.log(`✅ Valid IMEI packet found`);
        return true;
    } catch (error) {
        console.error('Error in isImeiPacket:', error);
        return false;
    }
}

function parseImeiPacket(buffer) {
    try {
        const imeiLength = buffer.readUInt16BE(0);
        const imei = buffer.toString('ascii', 2, 2 + imeiLength);
        console.log(`📱 Parsed IMEI: ${imei}`);
        return imei;
    } catch (error) {
        console.error('Error in parseImeiPacket:', error);
        return null;
    }
}

// Start server
async function startServer() {
    try {
        server.listen(DEVICE_PORT, () => {
            console.log(`🚀 Device server listening on port ${DEVICE_PORT}`);
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
