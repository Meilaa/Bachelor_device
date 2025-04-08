const net = require('net');
const { getDeviceInfoByDeviceId, saveDeviceData } = require('./database');
const { parseTeltonikaData } = require('./parsers');

// Configuration
const DEVICE_PORT = 5005;
const SOCKET_TIMEOUT = 300000; // 5 minutes
const DEBUG_LOG = true;

// List of IPs to block
const BLOCKED_IPS = ['::ffff:10.244.33.1', '10.244.33.1'];

// Track active devices
const activeDevices = new Map();

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
            console.log(`📩 Received ${data.length} bytes from ${deviceImei || 'new connection'}`);
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
            console.log(`📱 Device connected - IMEI: ${deviceImei}`);

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

            socket.write(Buffer.from([0x01]));
            const imeiLength = dataBuffer.readUInt16BE(0);
            dataBuffer = dataBuffer.slice(2 + imeiLength);

            if (dataBuffer.length > 0) processBuffer();
        }
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
                    console.log(`📊 Processing ${records.length} records from ${deviceImei}`);
                    
                    try {
                        await saveDeviceData(deviceImei, records);
                        console.log(`✅ Saved ${records.length} records for ${deviceImei}`);
                    } catch (error) {
                        console.error(`❌ Failed to save records for ${deviceImei}:`, error.message);
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