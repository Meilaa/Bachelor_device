require('dotenv').config();

// Configuration
const DEVICE_PORT = parseInt(process.env.DEVICE_PORT) || 5005; // TCP port for TMT250 device connections
const DEBUG_LOG = process.env.DEBUG_LOG === 'true'; // Set to false in production
const SOCKET_TIMEOUT = parseInt(process.env.SOCKET_TIMEOUT) || 15000; // Reduced from 300000
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL) || 45000; // Add this
const RAW_PACKET_LOG = process.env.RAW_PACKET_LOG || 'raw-packets.log'; // File to save raw packet data
const SAVE_RAW_PACKETS = process.env.SAVE_RAW_PACKETS === 'true'; // Whether to save raw packets to disk

// MongoDB Configuration
const MONGODB_URI = process.env.MONGODB_URI;

// Rate Limiting Configuration
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 100;
const RATE_LIMIT_REQUESTS = parseInt(process.env.RATE_LIMIT_REQUESTS) || 60;
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 60000;

// TMT250-specific IO Element ID mapping
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

module.exports = {
    DEVICE_PORT,
    DEBUG_LOG,
    SOCKET_TIMEOUT,
    RAW_PACKET_LOG,
    SAVE_RAW_PACKETS,
    MONGODB_URI,
    TMT250_IO_ELEMENTS,
    MAX_CONNECTIONS,
    RATE_LIMIT_REQUESTS,
    RATE_LIMIT_WINDOW
}; 