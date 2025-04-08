const net = require('net');
const { getDeviceInfoByDeviceId, saveDeviceData } = require('./database');
const { parseTeltonikaData } = require('./parsers');

// Configuration
const DEVICE_PORT = 5005;
const SOCKET_TIMEOUT = 300000;
const DEBUG_LOG = true;

// Track active devices
const activeDevices = new Map();

// Create TCP server
const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`📡 New device connected: ${clientId}`);
    
    socket.setTimeout(SOCKET_TIMEOUT);
    
    let dataBuffer = Buffer.alloc(0);
    let deviceImei = null;
    let lastActivity = Date.now();

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${clientId} (IMEI: ${deviceImei || 'unknown'})`);
        socket.end();
    });

    socket.on('data', async (data) => {
        lastActivity = Date.now();
        
        if (DEBUG_LOG) {
            console.log(`📩 Received ${data.length} bytes from ${clientId}`);
        }
        
        dataBuffer = Buffer.concat([dataBuffer, data]);
        await processBuffer();
    });

    async function processBuffer() {
        if (dataBuffer.length < 2) return;
        
        // Check for IMEI packet
        if (isImeiPacket(dataBuffer)) {
            deviceImei = parseImeiPacket(dataBuffer);
            console.log(`📱 Device IMEI: ${deviceImei}`);
            

            // Check if device exists in database
            const deviceInfo = await getDeviceInfoByDeviceId(deviceImei);
            if (!deviceInfo) {
                console.warn(`⚠️ Unknown device: ${deviceImei}. Closing connection.`);
                socket.end(); // <--- End connection if not known
                return;
            }

            // Register device in activeDevices
            activeDevices.set(deviceImei, {
                socket,
                imei: deviceImei,
                clientId,
                connectedAt: new Date(),
                lastActivity: new Date()
            });

            // Only ACK if valid device
            socket.write(Buffer.from([0x01]));

            
            // Remove processed IMEI data
            const imeiLength = dataBuffer.readUInt16BE(0);
            dataBuffer = dataBuffer.slice(2 + imeiLength);
            
            if (dataBuffer.length > 0) processBuffer();
        } 
        // Check for data packet
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
                    console.log(`📊 Processing ${records.length} records from device ${deviceImei}`);
                    console.log('Sample record:', JSON.stringify(records[0], null, 2));
                    
                    try {
                        // Save data to database
                        console.log('Attempting to save records to database...');
                        await saveDeviceData(deviceImei, records);
                        console.log(`✅ Successfully saved ${records.length} records for device ${deviceImei}`);
                    } catch (error) {
                        console.error(`❌ Failed to save records for device ${deviceImei}:`, error);
                        console.error('Error details:', error.stack);
                    }
                    
                    // Send acknowledgment
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
        console.log(`🔌 Device ${deviceImei || 'unknown'} disconnected`);
        if (deviceImei && activeDevices.has(deviceImei)) {
            activeDevices.delete(deviceImei);
        }
    });
    
    socket.on('error', (err) => {
        console.error(`❌ Socket error for device ${deviceImei || 'unknown'}: ${err.message}`);
    });
});

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