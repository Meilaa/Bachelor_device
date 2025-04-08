const { DEBUG_LOG, TMT250_IO_ELEMENTS } = require('./config');

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
        
        return records;
        
    } catch (error) {
        console.error(`Error parsing Teltonika data: ${error.message}`);
        return [];
    }
}

module.exports = {
    parseTeltonikaData
}; 