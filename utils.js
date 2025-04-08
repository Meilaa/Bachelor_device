const fs = require('fs').promises;
const path = require('path');
const { RAW_PACKET_LOG, SAVE_RAW_PACKETS, FAILED_MESSAGES_FILE } = require('./config');

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

function isImeiPacket(buffer) {
    // Basic length check (at least 2 bytes for length + some digits)
    if (!buffer || buffer.length < 4) {
        return false;
    }
    
    try {
        // Read length as 2-byte integer
        const imeiLength = buffer.readUInt16BE(0);
        
        // TMT250 usually sends 000F (15) but let's be flexible
        if (imeiLength >= 10 && imeiLength <= 20 && buffer.length >= imeiLength + 2) {
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
        
        // Try to detect IMEI without length prefix
        if (buffer.length >= 15) {
            let allDigits = true;
            for (let i = 0; i < 15; i++) {
                if (buffer[i] < 0x30 || buffer[i] > 0x39) {
                    allDigits = false;
                    break;
                }
            }
            if (allDigits) {
                console.log('⚠️ Detected IMEI without length prefix');
                return true;
            }
        }
    } catch (error) {
        console.error('Error checking IMEI packet:', error);
    }
    
    return false;
}

function parseImeiPacket(buffer) {
    if (!buffer || buffer.length < 4) {
        throw new Error("Invalid IMEI packet: buffer too small");
    }
    
    try {
        // Try to read IMEI length first
        const imeiLength = buffer.readUInt16BE(0);
        
        if (imeiLength >= 10 && imeiLength <= 20 && buffer.length >= imeiLength + 2) {
            // Extract the IMEI as ASCII string
            const imei = buffer.toString('ascii', 2, 2 + imeiLength);
            
            // Validate that we have digits
            if (!/^\d+$/.test(imei)) {
                throw new Error("Invalid IMEI format: expected digits only");
            }
            
            return imei;
        }
        
        // Try to parse IMEI without length prefix
        if (buffer.length >= 15) {
            const imei = buffer.toString('ascii', 0, 15);
            if (/^\d+$/.test(imei)) {
                console.log('⚠️ Parsed IMEI without length prefix:', imei);
                return imei;
            }
        }
        
        throw new Error(`Invalid IMEI packet: length (${imeiLength}) out of range or buffer too short`);
    } catch (error) {
        console.error('Error parsing IMEI packet:', error);
        throw error;
    }
}

module.exports = {
    hexDump,
    isImeiPacket,
    parseImeiPacket
}; 