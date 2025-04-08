const net = require('net');
const { parseTeltonikaData } = require('./parsers');
const { isImeiPacket, parseImeiPacket } = require('./utils');
const { DEVICE_PORT, SOCKET_TIMEOUT } = require('./config');
const { connectToDatabase, saveDeviceData, getDeviceInfoByDeviceId } = require('./database');

// Track connected devices
const activeDevices = new Map();

// Create a TCP server to receive data from the device
const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`📡 New device connected: ${clientId}`);
    
    // Configure socket with longer timeout and keep-alive
    socket.setTimeout(300000); // 5 minutes timeout
    socket.setKeepAlive(true, 60000); // Enable keep-alive every 60 seconds
    
    let dataBuffer = Buffer.alloc(0);
    let deviceId = null;
    let isProcessing = false;
    let isImeiProcessed = false;
    let lastDataTime = Date.now();

    socket.on('timeout', () => {
        const timeSinceLastData = Date.now() - lastDataTime;
        if (timeSinceLastData > 300000) { // 5 minutes without data
            console.log(`⏱️ Connection timed out: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
            socket.end();
        } else {
            // Reset timeout if we've received data recently
            socket.setTimeout(300000);
        }
    });

    // Function to process the data buffer
    async function processBuffer() {
        if (isProcessing) return;
        isProcessing = true;

        try {
            if (dataBuffer.length < 2) return;
            
            if (!isImeiProcessed && isImeiPacket(dataBuffer)) {
                try {
                    deviceId = parseImeiPacket(dataBuffer);
                    console.log(`📱 Device ID: ${deviceId}`);
                    
                    const deviceInfo = await getDeviceInfoByDeviceId(deviceId);
                    if (!deviceInfo) {
                        console.log(`⚠️ Device ${deviceId} not found in database`);
                        deviceId = 'unknown';
                    } else {
                        console.log(`✅ Device ${deviceId} found in database`);
                        activeDevices.set(deviceId, {
                            socket: socket,
                            deviceId: deviceId,
                            clientId: clientId,
                            connectedAt: new Date()
                        });
                    }
                    
                    const ackBuffer = Buffer.from([0x01]);
                    socket.write(ackBuffer);
                    
                    const deviceIdLength = dataBuffer.readUInt16BE(0);
                    dataBuffer = dataBuffer.slice(2 + deviceIdLength);
                    isImeiProcessed = true;
                    
                    if (dataBuffer.length > 0) await processBuffer();
                } catch (error) {
                    console.error('❌ Error processing IMEI packet:', error);
                }
            } else if (isImeiProcessed && deviceId !== 'unknown') {
                try {
                    const records = parseTeltonikaData(dataBuffer, deviceId);
                    if (records && records.length > 0) {
                        await saveDeviceData(deviceId, records);
                        console.log(`📊 Received ${records.length} records from device ${deviceId}`);
                        
                        const bytesPerRecord = 45;
                        const bytesProcessed = records.length * bytesPerRecord;
                        dataBuffer = dataBuffer.slice(bytesProcessed);
                        lastDataTime = Date.now();
                    }
                } catch (error) {
                    console.error(`❌ Error processing data for device ${deviceId}:`, error);
                }
            }
        } catch (error) {
            console.error('❌ Error processing data:', error);
        } finally {
            isProcessing = false;
        }
    }

    socket.on('data', async (data) => {
        dataBuffer = Buffer.concat([dataBuffer, data]);
        await processBuffer();
    });

    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${clientId}:`, error);
    });

    socket.on('close', () => {
        console.log(`🔌 Connection closed: ${clientId} (Device ID: ${deviceId || 'unknown'})`);
        if (deviceId) {
            activeDevices.delete(deviceId);
        }
    });
});

// Function to start the device server
async function startDeviceServer() {
    try {
        await connectToDatabase();
        console.log('✅ Database connection established');

        return new Promise((resolve, reject) => {
            server.listen(DEVICE_PORT, () => {
                console.log(`📡 Device server listening on port ${DEVICE_PORT}`);
                resolve(server);
            }).on('error', (err) => {
                console.error('❌ Server initialization error:', err);
                reject(err);
            });
        });
    } catch (error) {
        console.error('❌ Failed to start device server:', error);
        throw error;
    }
}

module.exports = {
    server,
    startDeviceServer,
    activeDevices
};
