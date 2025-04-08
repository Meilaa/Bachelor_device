const net = require('net');
const { parseTeltonikaData, sendDataToBackend } = require('./parsers');
const { saveRawPacket } = require('./utils');
const { DEVICE_PORT, SOCKET_TIMEOUT, DEBUG_LOG } = require('./config');

// Tracking connected devices
const activeDevices = new Map(); // Maps IMEI to device info

// Create a TCP server to receive data from the device
const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`📡 New device connected: ${clientId}`);
    
    // Configure socket
    socket.setTimeout(SOCKET_TIMEOUT);
    
    let dataBuffer = Buffer.alloc(0); // Buffer to accumulate data
    let deviceImei = null;
    let lastActivity = Date.now();
    let bytesReceived = 0;
    let packetsProcessed = 0;
    let connectionStartTime = Date.now();

    socket.on('timeout', () => {
        console.log(`⏱️ Connection timed out: ${clientId} (IMEI: ${deviceImei || 'unknown'})`);
        socket.end();
    });

    socket.on('data', (data) => {
        lastActivity = Date.now();
        bytesReceived += data.length;
        
        console.log(`📩 Received ${data.length} bytes from ${clientId} (IMEI: ${deviceImei || 'unknown'})`);
        
        // Enhanced debugging with hex dump
        if (DEBUG_LOG) {
            console.log('📩 Raw Data received:', data.toString('hex'));
            console.log('📦 Packet structure:');
            console.log(hexDump(data));
        }
        
        // Save raw packet data
        saveRawPacket(data, 'socket-data', deviceImei);

        // Append new data to our buffer
        dataBuffer = Buffer.concat([dataBuffer, data]);
        
        // Process buffer until we've consumed all complete packets
        processBuffer();

        function processBuffer() {
            // Check if we have enough data for basic analysis
            if (dataBuffer.length < 2) return;
            
            // Log for debugging
            if (DEBUG_LOG) {
                console.log(`Processing buffer: ${dataBuffer.length} bytes, starting with 0x${dataBuffer.slice(0, Math.min(10, dataBuffer.length)).toString('hex')}`);
            }
            
            // Check if this is a login/IMEI packet (according to specification)
            if (isImeiPacket(dataBuffer)) {
                deviceImei = parseImeiPacket(dataBuffer);
                console.log(`📱 Device IMEI: ${deviceImei}`);
                
                // Register device in active devices map
                activeDevices.set(deviceImei, {
                    socket: socket,
                    imei: deviceImei,
                    clientId: clientId,
                    connectedAt: new Date(),
                    lastActivity: new Date(),
                    bytesReceived: bytesReceived,
                    packetsProcessed: 0
                });
                
                // Send proper acknowledgment to the device (1 byte: 0x01 = accept)
                const ackBuffer = Buffer.from([0x01]);
                socket.write(ackBuffer);
                console.log(`✅ Sent IMEI acknowledgment: ${ackBuffer.toString('hex')}`);
                
                // Calculate how many bytes to remove (2 bytes length + IMEI length)
                const imeiLength = dataBuffer.readUInt16BE(0);
                dataBuffer = dataBuffer.slice(2 + imeiLength);
                
                console.log(`Buffer after IMEI processing: ${dataBuffer.length} bytes`);
                
                // Process any remaining data in the buffer
                if (dataBuffer.length > 0) processBuffer();
            } 
            // Check if we have a standard AVL data packet (starts with 00000000 preamble)
            else if (dataBuffer.length >= 8) {
                // Check for standard preamble (4 bytes of zeros)
                const preamble = dataBuffer.readUInt32BE(0);
                
                if (preamble !== 0) {
                    console.warn(`⚠️ Invalid preamble: 0x${preamble.toString(16)}. Expected 0x00000000`);
                    dataBuffer = dataBuffer.slice(1); // Skip one byte and try again
                    if (dataBuffer.length > 0) processBuffer();
                    return;
                }
                
                // Read data field length
                const dataLength = dataBuffer.readUInt32BE(4);
                
                // Validate packet size constraints
                const totalLength = 8 + dataLength + 4; // preamble + data field length + CRC
                
                if (dataLength < 15 || dataLength > 783 * 255) { // Min record size to max possible size
                    console.warn(`⚠️ Invalid data length: ${dataLength}. Expected 15-${783*255}`);
                    dataBuffer = dataBuffer.slice(1); // Skip one byte and try again
                    if (dataBuffer.length > 0) processBuffer();
                    return;
                }
                
                // Check if we have a complete packet
                if (dataBuffer.length >= totalLength) {
                    console.log(`📦 Full data packet received, total length: ${totalLength}, data length: ${dataLength}`);
                    
                    // Extract the complete packet
                    const fullPacket = dataBuffer.slice(0, totalLength);
                    
                    // Parse the AVL data
                    const parsedMessages = parseTeltonikaData(fullPacket, deviceImei);
                    
                    if (parsedMessages.length > 0) {
                        // Send data to backend immediately
                        sendDataToBackend(parsedMessages, deviceImei);
                        
                        // Send acknowledgment with number of correctly received records
                        const numRecords = parsedMessages.length;
                        packetsProcessed += numRecords;

                        // Update device stats if registered
                        if (deviceImei && activeDevices.has(deviceImei)) {
                            const deviceInfo = activeDevices.get(deviceImei);
                            deviceInfo.lastActivity = new Date();
                            deviceInfo.bytesReceived = bytesReceived;
                            deviceInfo.packetsProcessed += numRecords;
                        }

                        // Acknowledgment is 4 bytes with number of records
                        const ackBuffer = Buffer.alloc(4);
                        ackBuffer.writeUInt32BE(numRecords, 0);
                        socket.write(ackBuffer);
                        console.log(`✅ Sent data acknowledgment: records=${numRecords}`);
                    } else {
                        // Send acknowledgment with 0 records if parsing failed
                        const ackBuffer = Buffer.alloc(4);
                        ackBuffer.writeUInt32BE(0, 0);
                        socket.write(ackBuffer);
                        console.log(`⚠️ Sent zero-record acknowledgment due to parsing failure`);
                    }
                    
                    // Remove the processed packet from buffer
                    dataBuffer = dataBuffer.slice(totalLength);
                    
                    // Process any remaining data in the buffer
                    if (dataBuffer.length > 0) processBuffer();
                } else {
                    console.log(`⏳ Partial packet received, waiting for more data (${dataBuffer.length}/${totalLength} bytes)`);
                }
            } else {
                // Not enough data to determine packet type
                console.log(`⏳ Waiting for more data, current buffer: ${dataBuffer.length} bytes`);
            }
        }
    });

    socket.on('close', (hadError) => {
        const duration = Math.round((Date.now() - connectionStartTime) / 1000);
        console.log(`🔌 Device ${deviceImei || 'unknown'} disconnected${hadError ? ' due to error' : ''}`);
        console.log(`📊 Connection stats: duration=${duration}s, bytes=${bytesReceived}, packets=${packetsProcessed}`);
        
        // Remove device from active devices map
        if (deviceImei && activeDevices.has(deviceImei)) {
            activeDevices.delete(deviceImei);
            console.log(`📝 Removed device ${deviceImei} from active devices. Current count: ${activeDevices.size}`);
        }
    });
    
    socket.on('error', (err) => {
        console.error(`❌ Socket error for device ${deviceImei || 'unknown'}: ${err.message}`);
    });
});

// Start the device server
function startDeviceServer() {
    server.listen(DEVICE_PORT, () => {
        console.log(`🚀 TMT250 device server listening on port ${DEVICE_PORT}`);
        console.log(`Ready to receive connections from Teltonika TMT250 devices`);
    });
}

module.exports = {
    server,
    startDeviceServer,
    activeDevices
}; 