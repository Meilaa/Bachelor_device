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
    let connectionAttempts = 0;
    
    // Immediately set a very short timeout for initial connection
    socket.setTimeout(5000); // 5 seconds to receive IMEI
    
    console.log(`\n🔍 New connection attempt from ${clientId} at ${new Date().toISOString()}`);
    console.log(`📊 Connection details:`);
    console.log(`   - Remote Address: ${socket.remoteAddress}`);
    console.log(`   - Remote Port: ${socket.remotePort}`);
    console.log(`   - Local Address: ${socket.localAddress}`);
    console.log(`   - Local Port: ${socket.localPort}`);
    console.log(`   - Timeout: 5s`);
    
    let dataBuffer = Buffer.alloc(0);
    let deviceImei = null;
    let lastActivity = Date.now();

    socket.on('timeout', () => {
        console.log(`\n⏱️ Initial connection timeout for ${clientId} - no IMEI received`);
        console.log(`📊 Connection stats at timeout:`);
        console.log(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
        console.log(`   - Data received: ${hasReceivedData ? 'Yes' : 'No'}`);
        console.log(`   - Buffer size: ${dataBuffer.length} bytes`);
        console.log(`   - IMEI: ${deviceImei || 'Not identified'}`);
        socket.destroy();
    });

    socket.on('data', async (data) => {
        try {
            hasReceivedData = true;
            lastActivity = Date.now();
            
            console.log(`\n📩 Received data from ${clientId}:`);
            console.log(`   - Data length: ${data.length} bytes`);
            console.log(`   - Raw hex: ${data.toString('hex')}`);
            console.log(`   - Raw ascii: ${data.toString('ascii')}`);
            console.log(`   - Current buffer size: ${dataBuffer.length} bytes`);
            
            // Check if this looks like a Teltonika IMEI packet
            if (data.length >= 2) {
                const potentialImeiLength = data.readUInt16BE(0);
                console.log(`🔍 IMEI length check:`);
                console.log(`   - Potential length: ${potentialImeiLength}`);
                console.log(`   - Valid range: 15-17`);
                
                if (potentialImeiLength < 15 || potentialImeiLength > 17) {
                    console.log(`⚠️ Invalid IMEI length (${potentialImeiLength}) from ${clientId} - closing connection`);
                    socket.destroy();
                    return;
                }
            }
            
            dataBuffer = Buffer.concat([dataBuffer, data]);
            console.log(`📦 Updated buffer size: ${dataBuffer.length} bytes`);
            
            // If we have enough data for an IMEI packet, try to process it
            if (dataBuffer.length >= 4) {
                const imeiLength = dataBuffer.readUInt16BE(0);
                console.log(`🔍 Processing IMEI packet:`);
                console.log(`   - Required length: ${2 + imeiLength} bytes`);
                console.log(`   - Current buffer: ${dataBuffer.length} bytes`);
                
                if (dataBuffer.length >= 2 + imeiLength) {
                    if (isImeiPacket(dataBuffer)) {
                        deviceImei = parseImeiPacket(dataBuffer);
                        console.log(`📱 Device IMEI: ${deviceImei}`);
                        
                        // Check if device exists in database
                        const deviceInfo = await getDeviceInfoByDeviceId(deviceImei);
                        if (!deviceInfo) {
                            console.log(`⚠️ Unknown device: ${deviceImei}`);
                            console.log(`   - Not found in database`);
                            socket.destroy();
                            return;
                        }
                        
                        console.log(`✅ Device found in database:`);
                        console.log(`   - IMEI: ${deviceInfo.deviceId}`);
                        console.log(`   - Name: ${deviceInfo.name || 'Unnamed'}`);
                        
                        // Valid device found - configure connection
                        socket.setTimeout(30000); // 30s timeout for valid devices
                        socket.setKeepAlive(true, 60000);
                        socket.setNoDelay(true);
                        
                        console.log(`⚙️ Configured connection for ${deviceImei}:`);
                        console.log(`   - Timeout: 30s`);
                        console.log(`   - Keep-alive: 60s`);
                        console.log(`   - TCP_NODELAY: enabled`);
                        
                        // Update or add device to active devices
                        activeDevices.set(deviceImei, {
                            socket,
                            imei: deviceImei,
                            clientId,
                            connectedAt: new Date(),
                            lastActivity: new Date()
                        });
                        console.log(`✅ Device ${deviceImei} registered and active`);
                        
                        // Send acknowledgment
                        socket.write(Buffer.from([0x01]));
                        console.log(`📤 Sent acknowledgment to ${deviceImei}`);
                        
                        // Remove processed IMEI data
                        dataBuffer = dataBuffer.slice(2 + imeiLength);
                        console.log(`📦 Remaining buffer: ${dataBuffer.length} bytes`);
                        if (dataBuffer.length > 0) await processBuffer();
                    } else {
                        console.log(`⚠️ Invalid IMEI packet format from ${clientId}`);
                        console.log(`   - Buffer contents: ${dataBuffer.toString('hex')}`);
                        socket.destroy();
                    }
                }
            }
        } catch (error) {
            console.error(`\n❌ Error processing data from ${clientId}:`, error);
            console.error(`📊 Error details:`);
            console.error(`   - Buffer size: ${dataBuffer.length} bytes`);
            console.error(`   - IMEI: ${deviceImei || 'Not identified'}`);
            socket.destroy();
        }
    });

    async function processBuffer() {
        try {
            if (dataBuffer.length < 8) {
                console.log(`📦 Buffer too small for data packet: ${dataBuffer.length} bytes`);
                return;
            }
            
            const preamble = dataBuffer.readUInt32BE(0);
            console.log(`🔍 Checking data packet:`);
            console.log(`   - Preamble: 0x${preamble.toString(16)}`);
            
            if (preamble !== 0) {
                console.log(`⚠️ Invalid preamble from ${clientId}`);
                console.log(`   - Expected: 0x00000000`);
                console.log(`   - Received: 0x${preamble.toString(16)}`);
                socket.destroy();
                return;
            }
            
            const dataLength = dataBuffer.readUInt32BE(4);
            const totalLength = 8 + dataLength + 4;
            console.log(`   - Data length: ${dataLength} bytes`);
            console.log(`   - Total packet length: ${totalLength} bytes`);
            
            if (dataBuffer.length >= totalLength) {
                const fullPacket = dataBuffer.slice(0, totalLength);
                const records = parseTeltonikaData(fullPacket, deviceImei);
                
                if (records.length > 0) {
                    console.log(`📊 Processing ${records.length} records from device ${deviceImei}`);
                    console.log(`   - First record timestamp: ${records[0].timestamp}`);
                    console.log(`   - Last record timestamp: ${records[records.length - 1].timestamp}`);
                    
                    try {
                        await saveDeviceData(deviceImei, records);
                        console.log(`✅ Successfully saved ${records.length} records for device ${deviceImei}`);
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
        } catch (error) {
            console.error(`\n❌ Error in processBuffer for ${clientId}:`, error);
            console.error(`📊 Error details:`);
            console.error(`   - Buffer size: ${dataBuffer.length} bytes`);
            console.error(`   - IMEI: ${deviceImei || 'Not identified'}`);
            socket.destroy();
        }
    }

    socket.on('close', () => {
        if (deviceImei) {
            console.log(`\n🔌 Device ${deviceImei} disconnected`);
            console.log(`📊 Final connection stats:`);
            console.log(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
            console.log(`   - Data received: ${hasReceivedData ? 'Yes' : 'No'}`);
            if (activeDevices.has(deviceImei)) {
                activeDevices.delete(deviceImei);
            }
        }
    });
    
    socket.on('error', (err) => {
        console.error(`\n❌ Socket error for ${clientId}: ${err.message}`);
        console.error(`📊 Error details:`);
        console.error(`   - Duration: ${(Date.now() - connectionStartTime) / 1000}s`);
        console.error(`   - Data received: ${hasReceivedData ? 'Yes' : 'No'}`);
        console.error(`   - IMEI: ${deviceImei || 'Not identified'}`);
        socket.destroy();
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
            console.log(`\n🚀 Device server listening on port ${DEVICE_PORT}`);
            console.log(`📊 Server details:`);
            console.log(`   - Port: ${DEVICE_PORT}`);
            console.log(`   - Debug logging: ${DEBUG_LOG ? 'enabled' : 'disabled'}`);
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
