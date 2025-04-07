const net = require('net');
const axios = require('axios');
const http = require('http');
const fs = require('fs').promises; // For local file storage
const path = require('path');


// Configuration
const DEVICE_PORT = 5027; // TCP port for TMT250 device connections
const BACKEND_API_URL = "http://localhost:3001/api/deviceData";
const DEBUG_LOG = true; // Set to false in production
const SOCKET_TIMEOUT = 300000; // 5 minute socket timeout
const FAILED_MESSAGES_FILE = 'failed-messages.json'; // File for failed backend requests
const RAW_PACKET_LOG = 'raw-packets.log'; // File to save raw packet data
const SAVE_RAW_PACKETS = true; // Whether to save raw packets to disk

// Tracking connected devices
const activeDevices = new Map(); // Maps IMEI to device info

// MongoDB Device ID mapping - Add your TMT250 IMEI here
const DEVICE_IMEI_MAP = {
    // Replace with your TMT250's IMEI and corresponding MongoDB ObjectID
    "353691841005134": "67c09e2317fe16417720d289", // Actual TMT250 IMEI
    "DEFAULT": "67c09e2317fe16417720d289" // Default placeholder
};

// Updated TMT250-specific IO Element ID mapping based on the official documentation
// Source: https://wiki.teltonika-gps.com/view/TMT250_AVL_ID_List
const TMT250_IO_ELEMENTS = {
    // Digital Inputs
    1: "din1",
    2: "din2",
    3: "din3", 
    4: "din4",
    
    // Permanent IO elements
    11: "ICCID",
    14: "ICCID2",
    17: "Axis X",
    18: "Axis Y", 
    19: "Axis Z",
    21: "GSM Signal",
    24: "Speed",
    25: "External Voltage",
    67: "Battery Voltage",
    69: "GNSS Status",
    80: { name: "Data Mode", description: "Current data mode", unit: "Enum (0-5)" },
    113: "Battery Level",
    116: "Charger Connected",
    181: "GNSS PDOP",
    182: "GNSS HDOP",
    200: "Sleep Mode",
    205: "GSM Cell ID",
    206: "GSM Area Code",
    240: "Movement",
    241: "Active GSM Operator",
    
    // Geofence zones
    155: "Geofence zone 01",
    156: "Geofence zone 02",
    157: "Geofence zone 03",
    158: "Geofence zone 04",
    159: "Geofence zone 05",
    61: "Geofence zone 06",
    62: "Geofence zone 07",
    63: "Geofence zone 08",
    64: "Geofence zone 09",
    65: "Geofence zone 10",
    70: "Geofence zone 11",
    88: "Geofence zone 12",
    91: "Geofence zone 13",
    92: "Geofence zone 14",
    93: "Geofence zone 15",
    94: "Geofence zone 16",
    95: "Geofence zone 17",
    96: "Geofence zone 18",
    97: "Geofence zone 19",
    98: "Geofence zone 20",
    99: "Geofence zone 21",
    153: "Geofence zone 22",
    154: "Geofence zone 23",
    190: "Geofence zone 24",
    191: "Geofence zone 25",
    192: "Geofence zone 26",
    193: "Geofence zone 27",
    194: "Geofence zone 28",
    195: "Geofence zone 29",
    196: "Geofence zone 30",
    197: "Geofence zone 31",
    198: "Geofence zone 32",
    208: "Geofence zone 33",
    209: "Geofence zone 34",
    216: "Geofence zone 35",
    217: "Geofence zone 36",
    218: "Geofence zone 37",
    219: "Geofence zone 38",
    220: "Geofence zone 39",
    221: "Geofence zone 40",
    222: "Geofence zone 41",
    223: "Geofence zone 42",
    224: "Geofence zone 43",
    225: "Geofence zone 44",
    226: "Geofence zone 45",
    227: "Geofence zone 46",
    228: "Geofence zone 47",
    229: "Geofence zone 48",
    230: "Geofence zone 49",
    231: "Geofence zone 50",
    
    // Special events
    175: "Auto Geofence",
    236: "Alarm",
    242: "ManDown",
    255: "Over Speeding"
};

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


function isImeiPacket(buffer) {
    // Basic length check (at least 2 bytes for length + some digits)
    if (!buffer || buffer.length < 4) {
        return false;
    }
    
    // Read length as 2-byte integer
    const imeiLength = buffer.readUInt16BE(0);
    
    // TMT250 usually sends 000F (15) but let's be flexible
    if (imeiLength >= 15 && imeiLength <= 17 && buffer.length >= imeiLength + 2) {
        // Check if the next bytes are ASCII digits
        for (let i = 2; i < 2 + imeiLength; i++) {
            if (i >= buffer.length) return false;
            const char = buffer[i];
            if (char < 0x30 || char > 0x39) { // ASCII range for digits
                return false;
            }
        }
        return true;
    }
    
    return false;
}

/**
 * Parse an IMEI packet to extract the IMEI number
 * According to specification, format is:
 * - 2 bytes length (000F for 15 digits)
 * - IMEI as ASCII digits
 */
function parseImeiPacket(buffer) {
    if (!buffer || buffer.length < 4) {
        throw new Error("Invalid IMEI packet: buffer too small");
    }
    
    // Read IMEI length
    const imeiLength = buffer.readUInt16BE(0);
    
    if (imeiLength < 15 || buffer.length < imeiLength + 2) {
        throw new Error(`Invalid IMEI packet: length (${imeiLength}) too small or buffer too short`);
    }
    
    // Extract the IMEI as ASCII string
    const imei = buffer.toString('ascii', 2, 2 + imeiLength);
    
    // Validate that we have digits
    if (!/^\d+$/.test(imei)) {
        throw new Error("Invalid IMEI format: expected digits only");
    }
    
    return imei;
}

// Function to parse Teltonika AVL data with TMT250-specific IO decoding
function parseTeltonikaData(buffer, deviceImei) {
    try {
        // Check for minimum packet size
        if (buffer.length < 45) { // Minimum valid packet size per specification
            console.warn('Buffer too small to parse Teltonika data (minimum 45 bytes)');
            return [];
        }

        // Parse the data according to TMT250 protocol specification
        let index = 0;
        let records = [];
        
        // Verify preamble (4 bytes of zeroes)
        const preamble = buffer.readUInt32BE(index);
        if (preamble !== 0) {
            console.warn(`Invalid preamble: 0x${preamble.toString(16)}. Expected 0x00000000`);
            return [];
        }
        index += 4;
        
        // Data field length
        const dataFieldLength = buffer.readUInt32BE(index);
        if (dataFieldLength > 783 * 255) { // Max size per specification (max bytes per record * max records)
            console.warn(`Data length too large: ${dataFieldLength}`);
            return [];
        }
        index += 4;
        
        // Validate total packet size
        const totalPacketSize = 8 + dataFieldLength + 4; // preamble + length + data + CRC
        if (buffer.length < totalPacketSize) {
            console.warn(`Incomplete packet: received ${buffer.length} bytes, expected ${totalPacketSize}`);
            return [];
        }
        
        // Codec ID - Should be 0x08 for TMT250
        const codecID = buffer[index];
        if (codecID !== 0x08 && codecID !== 0x8E) { // Allow extended codec 0x8E as well
            console.warn(`Unexpected codec ID: ${codecID.toString(16)}. Expected 0x08`);
            return [];
        }
        index += 1;
        
        // Number of records
        const numberOfRecords1 = buffer[index];
        if (numberOfRecords1 === 0 || numberOfRecords1 > 255) {
            console.warn(`Invalid number of records: ${numberOfRecords1}`);
            return [];
        }
        index += 1;
        
        // Process each AVL data record
        for (let i = 0; i < numberOfRecords1; i++) {
            try {
                // Create a record object
                const record = {
                    deviceImei: deviceImei,
                    timestamp: 0,
                    latitude: 0,
                    longitude: 0,
                    altitude: 0,
                    angle: 0,
                    satellites: 0,
                    speed: 0,
                    priority: 0,
                    eventIOID: 0,
                    elements: {}
                };
                
                // Timestamp
                // Extract timestamp
                if (index + 8 <= buffer.length) {
                    const timestampMs = Number(buffer.readBigUInt64BE(index));
                    record.timestamp = timestampMs;
                    index += 8;
                } else {
                    throw new Error(`Buffer too small for timestamp at index ${index}`);
                }
                
                // Priority
                if (index < buffer.length) {
                    record.priority = buffer[index];
                    index += 1;
                } else {
                    throw new Error(`Buffer too small for priority at index ${index}`);
                }
                
                // GPS Element (15 bytes)
                if (index + 15 <= buffer.length) {
                    // Longitude (4 bytes) - Convert from integer to floating point
                    const longitudeRaw = buffer.readInt32BE(index);
                    // Handle sign bit according to specification
                    const longitudeSign = (longitudeRaw & 0x80000000) ? -1 : 1;
                    record.longitude = (Math.abs(longitudeRaw) / 10000000) * longitudeSign;
                    index += 4;
                    
                    // Latitude (4 bytes) - Convert from integer to floating point
                    const latitudeRaw = buffer.readInt32BE(index);
                    // Handle sign bit according to specification
                    const latitudeSign = (latitudeRaw & 0x80000000) ? -1 : 1;
                    record.latitude = (Math.abs(latitudeRaw) / 10000000) * latitudeSign;
                    index += 4;
                    
                    // Altitude (2 bytes)
                    record.altitude = buffer.readInt16BE(index);
                    index += 2;
                    
                    // Angle (2 bytes) - 0 = North, increases clockwise
                    record.angle = buffer.readUInt16BE(index);
                    index += 2;
                    
                    // Satellites (1 byte)
                    record.satellites = buffer[index];
                    // Position validity based on satellite count (≥3 required for valid fix)
                    record.positionValid = record.satellites >= 3;
                    index += 1;
                    
                    // Speed (2 bytes)
                    record.speed = buffer.readUInt16BE(index);
                    index += 2;
                } else {
                    throw new Error(`Buffer too small for GPS element at index ${index}`);
                }
                
                // IO Element
                if (index + 2 <= buffer.length) {
                    // Event IO ID
                    record.eventIOID = buffer[index];
                    index += 1;
                    
                    // Total IO Elements count
                    const totalIOElements = buffer[index];
                    index += 1;
                    
                    // Process 1-byte elements
                    if (index + 1 <= buffer.length) {
                        const count1 = buffer[index];
                        index += 1;
                        
                        for (let j = 0; j < count1 && index + 2 <= buffer.length; j++) {
                            const id = buffer[index];
                            index += 1;
                            const value = buffer[index];
                            index += 1;
                            
                            // Map to TMT250 elements with a descriptive name
                            const elementName = TMT250_IO_ELEMENTS[id] || `unknown_${id}`;
                            record.elements[id] = value;
                            
                            // Special handling for important fields
                            switch (id) {
                                case 113: // Battery Level
                                    record.batteryLevel = value;
                                    break;
                                case 69: // GNSS Status
                                    record.gnssStatus = value === 1;
                                    break;
                                case 240: // Movement
                                    record.movement = value === 1;
                                    break;
                                case 116: // Charger Connected
                                    record.charging = value === 1;
                                    break;
                                case 21: // GSM Signal
                                    record.gsmSignal = value;
                                    break;
                                case 242: // ManDown
                                    record.manDown = value === 1;
                                    break;
                            }
                        }
                    }
                    
                    // Process 2-byte elements
                    if (index + 1 <= buffer.length) {
                        const count2 = buffer[index];
                        index += 1;
                        
                        for (let j = 0; j < count2 && index + 3 <= buffer.length; j++) {
                            const id = buffer[index];
                            index += 1;
                            const value = buffer.readUInt16BE(index);
                            index += 2;
                            
                            // Store all 2-byte elements
                            record.elements[id] = value;
                            
                            // Special handling for important fields
                            switch (id) {
                                case 67: // Battery Voltage
                                    record.batteryVoltage = value;
                                    break;
                                case 181: // GNSS PDOP
                                    record.gnssPDOP = value / 10; // Divide by 10 for actual value
                                    break;
                                case 182: // GNSS HDOP
                                    record.gnssHDOP = value / 10; // Divide by 10 for actual value
                                    break;
                            }
                        }
                    }
                    
                    // Process 4-byte elements
                    if (index + 1 <= buffer.length) {
                        const count4 = buffer[index];
                        index += 1;
                        
                        for (let j = 0; j < count4 && index + 5 <= buffer.length; j++) {
                            const id = buffer[index];
                            index += 1;
                            const value = buffer.readUInt32BE(index);
                            index += 4;
                            
                            // Store all 4-byte elements
                            record.elements[id] = value;
                        }
                    }
                    
                    // Process 8-byte elements
                    if (index + 1 <= buffer.length) {
                        const count8 = buffer[index];
                        index += 1;
                        
                        for (let j = 0; j < count8 && index + 9 <= buffer.length; j++) {
                            const id = buffer[index];
                            index += 1;
                            // Read as BigInt but convert to string for easier handling
                            const value = buffer.readBigUInt64BE(index).toString();
                            index += 8;
                            
                            // Store all 8-byte elements
                            record.elements[id] = value;
                        }
                    }
                }
                
                // Add the parsed record
                records.push(record);
                
            } catch (recordError) {
                console.error(`Error parsing record ${i}: ${recordError.message}`);
                // Continue to next record
            }
        }
        
        // Verify Number of Data 2 matches Number of Data 1
        if (index < buffer.length) {
            const numberOfRecords2 = buffer[index];
            index += 1;
            
            if (numberOfRecords1 !== numberOfRecords2) {
                console.warn(`Record count mismatch: Data1=${numberOfRecords1}, Data2=${numberOfRecords2}`);
                // We'll still return the records we parsed
            }
        }
        
        // Validate CRC-16
        if (index + 4 <= buffer.length) {
            // Skip first 2 bytes of CRC field (should be zeroes)
            const crcFirstTwoBytes = buffer.readUInt16BE(index);
            if (crcFirstTwoBytes !== 0) {
                console.warn(`First two CRC bytes not zero: 0x${crcFirstTwoBytes.toString(16)}`);
            }
            index += 2;
            
            // Read actual CRC-16 value (last 2 bytes)
            const receivedCRC = buffer.readUInt16BE(index);
            
            // Calculate CRC-16 on data field (from Codec ID to Number of Data 2)
            // Note: This would require a proper CRC-16 implementation
            // const calculatedCRC = calculateCRC16(buffer.slice(8, index - 2));
            
            // For now, we'll skip CRC validation but log it
            console.log(`CRC-16 from packet: 0x${receivedCRC.toString(16)}`);
        }
        
        return records;
        
    } catch (error) {
        console.error(`Error parsing Teltonika data: ${error.message}`);
        return [];
    }
}

// Helper function to return codec description
function getCodecDescription(codecID) {
    switch(codecID) {
        case 0x08: return 'TMT250 Data';
        case 0x0C: return 'TMT250 Config';
        default: return 'Unknown';
    }
}

/**
 * Debug utility for analyzing TMT250 packets
 * Prints detail information about the packet structure
 */
function debugTMT250Packet(buffer, label = "TMT250 Packet") {
    console.log(`===== ${label} DEBUG =====`);
    console.log(`Packet Length: ${buffer.length} bytes`);
    
    // Print the hex dump of the first 64 bytes (or full packet if smaller)
    const dumpLength = Math.min(buffer.length, 64);
    const hexDumpPreview = Array.from(buffer.slice(0, dumpLength))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
    
    console.log(`Hex Preview: ${hexDumpPreview}${buffer.length > dumpLength ? ' ...' : ''}`);
    
    try {
        // Try to detect packet type
        if (isImeiPacket(buffer)) {
            const imei = parseImeiPacket(buffer);
            console.log(`📱 IMEI Packet: ${imei}`);
            
            // Special format detection (000f prefix)
            if (buffer.length >= 2 && buffer[0] === 0x00 && buffer[1] === 0x0F) {
                console.log(`Format: Special IMEI with 000f prefix`);
            } else {
                console.log(`Format: Standard IMEI (length: ${buffer[0]} bytes)`);
            }
            return;
        }
        
        // Data packet format analysis
        console.log(`📦 Data Packet Analysis:`);
        
        // Check for standard header
        if (buffer.length >= 8) {
            const preamble = buffer.readUInt32BE(0);
            const dataLength = buffer.readUInt32BE(4);
            
            console.log(`Preamble: 0x${preamble.toString(16).padStart(8, '0')}`);
            console.log(`Data Length: ${dataLength} bytes`);
            
            // Validate data length
            if (dataLength > buffer.length - 8) {
                console.log(`⚠️ WARNING: Declared data length (${dataLength}) exceeds packet size (${buffer.length - 8} bytes available)`);
            }
            
            // Try to read codec and record count
            if (buffer.length >= 10) {
                const codecID = buffer[8];
                const recordCount = buffer[9];
                
                console.log(`Codec ID: 0x${codecID.toString(16).padStart(2, '0')}`);
                console.log(`Record Count: ${recordCount}`);
            }
        } else {
            console.log(`⚠️ Packet too small for TMT250 format (${buffer.length} bytes)`);
        }
    } catch (error) {
        console.log(`❌ Analysis Error: ${error.message}`);
    }
    
    console.log(`===== DEBUG END =====\n`);
}

/**
 * Helper function to get codec description
 */
function getCodecDescription(codecID) {
    switch(codecID) {
        case 0x08: return "TMT250 Standard";
        case 0x8E: return "TMT250 Extended";
        default: return "Unknown";
    }
}


function quickParseTMT250(buffer, deviceImei = null) {
    const result = {
        success: false,
        type: null,
        imei: deviceImei,
        recordCount: 0,
        records: [],
        error: null
    };
    
    try {
        // Check if this is an IMEI packet
        if (isImeiPacket(buffer)) {
            result.type = 'IMEI';
            result.imei = parseImeiPacket(buffer);
            result.success = true;
            return result;
        }
        
        // It's a data packet
        result.type = 'DATA';
        
        // Try to extract essential data without full parsing
        if (buffer.length < 10) {
            result.error = 'Packet too small';
            return result;
        }
        
        // Check header format
        let index = 0;
        let codecID, recordCount;
        
        // Check for different packet formats before proceeding
        const preamble = buffer.readUInt32BE(index);
        
        // Standard format with 0x000000FF preamble
        if (preamble === 0x000000FF) {
            index += 4; // Skip preamble
            
            // Data field length
            const dataFieldLength = buffer.readUInt32BE(index);
            index += 4;
            
            // Codec ID
            codecID = buffer[index];
            index += 1;
            
            // Number of records
            recordCount = buffer[index];
            index += 1;
        }
        // Alternative format with 0x00000000 preamble (seen in some TMT250 logs)
        else if (preamble === 0x00000000) {
            index += 4; // Skip preamble
            
            // Check if we have a data length field or direct codec
            if (index + 4 <= buffer.length && buffer[index] === 0x00 && buffer[index+1] === 0x00) {
                // This appears to have a data length field
                const dataFieldLength = buffer.readUInt32BE(index);
                index += 4;
            }
            
            // Now read codec ID and number of records
            if (index + 2 <= buffer.length) {
                codecID = buffer[index];
                index += 1;
                recordCount = buffer[index];
                index += 1;
            } else {
                result.error = 'Unable to read codec ID and record count after preamble';
                return result;
            }
        }
        // Direct codec format (no preamble, starts with codec ID 8 for TMT250)
        else if (buffer.length >= 2 && (buffer[0] === 0x08 || buffer[0] === 0x8E)) {
            codecID = buffer[0];
            index += 1;
            recordCount = buffer[index];
            index += 1;
        }
        // Unknown format
        else {
            result.error = `Unknown packet format with preamble: 0x${preamble.toString(16)}`;
            return result;
        }
        
        result.codecID = codecID;
        result.recordCount = recordCount || 0;
        
        // Basic sanity check
        if (codecID !== 0x08 && codecID !== 0x8E) {
            result.error = `Unexpected codec ID: ${codecID}`;
            return result;
        }
        
        // Extract timestamps and minimal data from each record
        for (let i = 0; i < result.recordCount && index + 25 < buffer.length; i++) {
            try {
                const record = {
                    timestamp: null,
                    latitude: null,
                    longitude: null,
                    speed: null,
                    satellites: null,
                    elements: {}
                };
                
                // Extract timestamp
                if (index + 8 <= buffer.length) {
                    const timestampMs = Number(buffer.readBigUInt64BE(index));
                    record.timestamp = timestampMs;
                    index += 8;
                } else {
                    break;
                }
                
                // Skip priority
                index += 1;
                
                // Extract position
                if (index + 10 <= buffer.length) {
                    // Longitude and latitude
                    const longitudeRaw = buffer.readInt32BE(index);
                    record.longitude = longitudeRaw / 10000000;
                    index += 4;
                    
                    const latitudeRaw = buffer.readInt32BE(index);
                    record.latitude = latitudeRaw / 10000000;
                    index += 4;
                    
                    // Skip altitude and direction
                    index += 4;
                    
                    // Get satellites and speed
                    record.satellites = buffer[index++];
                    record.speed = buffer.readUInt16BE(index);
                    index += 2;
                } else {
                    break;
                }
                
                // Try to extract some basic IO elements
                if (index + 2 < buffer.length) {
                    // Event IO ID
                    const eventIOID = buffer[index++];
                    record.eventIOID = eventIOID;
                    
                    // For simplicity, we'll just note we have IO elements
                    record.hasIOElements = true;
                }
                
                result.records.push(record);
            } catch (recordError) {
                // If we can't parse a record, just continue to the next
                continue;
            }
        }
        
        result.success = result.records.length > 0;
        
    } catch (error) {
        result.error = error.message;
    }
    
    return result;
}

/**
 * Quick demonstration of real-time TMT250 data processing
 */
function processRealTMT250Data() {
    console.log("=== TMT250 Real-Time Processor ===");
    
    // Example raw data - replace with real packet from your logs
    const exampleImeiPacket = Buffer.from("000f333533363931383431303035313334", "hex");
    const exampleDataPacket = Buffer.from(
        "00000000000004da081500000195f320bd6000000000000000000000000000000000000b06f001" +
        "1505c80045027164740104b50000b6000018000043105101f1000060190000000195f32048300000", "hex");
    
    // Process the IMEI packet
    console.log("\n--- IMEI Packet Test ---");
    debugTMT250Packet(exampleImeiPacket, "IMEI Packet");
    const imeiResult = quickParseTMT250(exampleImeiPacket);
    console.log("IMEI Result:", JSON.stringify(imeiResult, null, 2));
    
    // Process the data packet
    console.log("\n--- Data Packet Test ---");
    debugTMT250Packet(exampleDataPacket, "Data Packet");
    const dataResult = quickParseTMT250(exampleDataPacket, "353691841005134");
    console.log("Parser Result:", JSON.stringify(dataResult, null, 2));
    
    console.log("\nTest the function with your real data by calling:");
    console.log("  debugTMT250Packet(yourBuffer, 'Custom Label');");
    console.log("  quickParseTMT250(yourBuffer, deviceImei);");
}

// Export the log analyzer
module.exports.debugTMT250 = {
    debugTMT250Packet,
    quickParseTMT250,
    processRealTMT250Data,
    getCodecDescription
};

// Export IMEI functions directly
module.exports.isImeiPacket = isImeiPacket;
module.exports.parseImeiPacket = parseImeiPacket;

// Export MongoDB transformation function
module.exports.transformToMongoFormat = transformToMongoFormat;

/**
 * Transform TMT250 parsed data into MongoDB document format
 * @param {Object} record - Parsed TMT250 record
 * @param {String} deviceImei - Device IMEI
 * @returns {Object} - MongoDB formatted document
 */
function transformToMongoFormat(record, deviceImei) {
    // Get device ObjectId from IMEI mapping
    const deviceId = DEVICE_IMEI_MAP[deviceImei] || DEVICE_IMEI_MAP.DEFAULT;
    
    // Extract IO elements
    const elements = record.elements || {};
    
    // Ensure timestamp is a Date object
    let timestamp = record.timestamp;
    
    if (typeof timestamp === 'string') {
        // If timestamp is a string (e.g., ISO 8601 format), convert it to Date
        timestamp = new Date(timestamp);
    } else if (typeof timestamp === 'number') {
        // If timestamp is a number (e.g., Unix timestamp), convert it to Date
        timestamp = new Date(timestamp);
    }

    // Get current date
    const currentDate = new Date();

    // Get the last Sunday of March and the last Sunday of October (DST start and end)
    const lastSundayOfMarch = new Date(currentDate.getFullYear(), 2, 31);
    while (lastSundayOfMarch.getDay() !== 0) {
        lastSundayOfMarch.setDate(lastSundayOfMarch.getDate() - 1);
    }

    const lastSundayOfOctober = new Date(currentDate.getFullYear(), 9, 31);
    while (lastSundayOfOctober.getDay() !== 0) {
        lastSundayOfOctober.setDate(lastSundayOfOctober.getDate() - 1);
    }

    // Check if current date is within the DST period (last Sunday of March to last Sunday of October)
    const isDST = currentDate >= lastSundayOfMarch && currentDate <= lastSundayOfOctober;

    // Lithuania Timezone Offset (UTC+3 for DST, UTC+2 for standard time)
    const timezoneOffsetMs = isDST ? 3 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;

    // Adjust the timestamp based on the timezone offset
    const adjustedTimestamp = new Date(timestamp.getTime() + timezoneOffsetMs);
    
    // Default document structure - Note: _id will be generated by MongoDB
    const mongoDoc = {
        ident: deviceImei, // Use the device IMEI as the identifier
        'device.name': record.deviceName,
        'timestamp': adjustedTimestamp, // Use the adjusted Lithuanian timestamp
        'position.latitude': record.latitude,
        'position.longitude': record.longitude,
        'position.speed': record.speed || 0,
        'position.direction': record.angle || 0,
        'position.altitude': record.altitude || 0,
        'position.valid': true,
        'battery.level': (elements[113] !== undefined) ? Number(elements[113]) : 0,
        'gnss.status': (elements[69] !== undefined) ? String(elements[69] === 1) : "false",
        'movement.status': (elements[240] !== undefined) ? String(elements[240] === 1) : "false",
    };
    
    return mongoDoc;
}



/**
 * Send parsed data to backend API for storage
 */
function sendDataToBackend(parsedData, deviceImei) {
    if (!parsedData || parsedData.length === 0) {
        console.warn('No data to send to backend');
        return;
    }
    
    // Transform data to MongoDB format
    const mongoData = parsedData.map(record => transformToMongoFormat(record, record.deviceImei || deviceImei));
    
    console.log(`Sending ${mongoData.length} records to backend API...`);
    if (DEBUG_LOG && mongoData.length > 0) {
        console.log(`Sample record: ${JSON.stringify(mongoData[0], null, 2)}`);
    }
    
    // Wrap the data in the format the backend expects
    const requestBody = {
        messages: mongoData
    };
    
    // Send to backend
    axios.post(BACKEND_API_URL, requestBody)  // Changed mongoData to requestBody
        .then(response => {
            console.log(`✅ Successfully sent ${mongoData.length} records to backend API`);
            console.log(`Response: ${response.status} ${response.statusText}`);
            if (DEBUG_LOG && response.data) {
                console.log(`Response data: ${JSON.stringify(response.data, null, 2)}`);
            }
        })
        .catch(error => {
            console.error(`❌ Failed to send data to backend: ${error.message}`);
            if (error.response) {
                console.error(`Status: ${error.response.status}`);
                console.error(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
            }
            // Store failed messages for retry later
            storeFailedMessages(mongoData);
        });
}

// Helper function to save raw packet data
async function saveRawPacket(data, type, imei) {
    if (!SAVE_RAW_PACKETS) return;
    
    try {
        // Create a log entry
        const timestamp = new Date().toISOString();
        const hexData = data.toString('hex');
        const logEntry = `[${timestamp}] [${type}] [IMEI:${imei || 'unknown'}] ${hexData}\n`;
        
        // Append to the log file
        await fs.appendFile(RAW_PACKET_LOG, logEntry);
    } catch (error) {
        console.error(`Failed to save raw packet: ${error.message}`);
    }
}

// Helper function to store failed backend requests
async function storeFailedMessages(messages) {
    try {
        // Read existing failed messages
        let failedMessages = [];
        try {
            const data = await fs.readFile(FAILED_MESSAGES_FILE, 'utf8');
            failedMessages = JSON.parse(data);
        } catch (readError) {
            // File doesn't exist or invalid JSON - start with empty array
        }
        
        // Add new messages with timestamp
        const timestamped = messages.map(msg => ({
            message: msg,
            timestamp: new Date().toISOString(),
            retryCount: 0
        }));
        
        failedMessages = [...failedMessages, ...timestamped];
        
        // Write back to file
        await fs.writeFile(FAILED_MESSAGES_FILE, JSON.stringify(failedMessages, null, 2));
        console.log(`📝 Saved ${messages.length} failed messages for later retry`);
    } catch (error) {
        console.error(`❌ Failed to store messages: ${error.message}`);
    }
}

// Hexdump function for debugging (buffer visualization)
function hexDump(buffer, bytesPerLine = 16) {
    let result = '';
    const bufferLength = buffer.length;
    
    for (let i = 0; i < bufferLength; i += bytesPerLine) {
        // Address
        result += i.toString(16).padStart(8, '0') + '  ';
        
        // Hex values
        for (let j = 0; j < bytesPerLine; j++) {
            if (i + j < bufferLength) {
                result += buffer[i + j].toString(16).padStart(2, '0') + ' ';
            } else {
                result += '   ';
            }
        }
        
        result += ' ';
        
        // ASCII representation
        for (let j = 0; j < bytesPerLine; j++) {
            if (i + j < bufferLength) {
                const byte = buffer[i + j];
                if (byte >= 32 && byte <= 126) { // Printable ASCII
                    result += String.fromCharCode(byte);
                } else {
                    result += '.';
                }
            }
        }
        
        result += '\n';
    }
    
    return result;
}

// Create HTTP server for status monitoring
const MONITOR_PORT = 5030;
const monitorServer = http.createServer((req, res) => {
    // Basic CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle OPTIONS request for CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Route handling
    if (req.url === '/health') {
        // Basic health endpoint
        const uptime = process.uptime();
        const healthInfo = {
            status: 'ok',
            uptime: uptime,
            timestamp: new Date().toISOString(),
            connections: activeDevices.size
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthInfo));
    } 
    else if (req.url === '/devices') {
        // Return list of connected devices
        const deviceList = Array.from(activeDevices.entries()).map(([imei, info]) => {
            return {
                imei: imei,
                connectionTime: info.connectedAt,
                lastActivity: info.lastActivity,
                bytesReceived: info.bytesReceived,
                packetsProcessed: info.packetsProcessed,
                clientId: info.clientId
            };
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(deviceList));
    } 
    else {
        // Not found
        res.writeHead(404);
        res.end('Not Found');
    }
});

// Start the servers if not in a test environment
if (!global.DISABLE_SERVER_AUTOSTART) {
    // Start monitoring HTTP server
    monitorServer.listen(MONITOR_PORT, () => {
        console.log(`🖥️ Monitoring server listening on port ${MONITOR_PORT}`);
        console.log(`   Health endpoint: http://localhost:${MONITOR_PORT}/health`);
        console.log(`   Devices endpoint: http://localhost:${MONITOR_PORT}/devices`);
    });
    
    // Start device TCP server
    server.listen(DEVICE_PORT, () => {
        console.log(`🚀 TMT250 device server listening on port ${DEVICE_PORT}`);
        console.log(`Ready to receive connections from Teltonika TMT250 devices`);
    });
    
    // Handle server closing
    const shutdownHandler = () => {
        console.log('🛑 Shutting down servers...');
        
        // Close the monitor server
        monitorServer.close(() => {
            console.log('✅ Monitoring server closed');
        });
        
        // Close all device connections
        for (const [imei, info] of activeDevices.entries()) {
            try {
                info.socket.end();
                console.log(`✅ Closed connection to device ${imei}`);
            } catch (err) {
                console.error(`❌ Error closing connection to device ${imei}: ${err.message}`);
            }
        }
        
        // Close the device server
        server.close(() => {
            console.log('✅ Device server closed');
            process.exit(0);
        });
        
        // Force exit after 3 seconds if servers haven't closed
        setTimeout(() => {
            console.error('⚠️ Forced exit after timeout');
            process.exit(1);
        }, 3000);
    };
    
    // Register shutdown handlers
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
    
    console.log('🔄 Server initialization complete');
}

// Export the server instances for testing
module.exports.servers = {
    deviceServer: server,
    monitorServer: monitorServer
};