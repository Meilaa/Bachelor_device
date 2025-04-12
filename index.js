require('dotenv').config(); // Load environment variables

const express = require('express');
const { startServer, activeDevices } = require('./deviceServer');
const { connectToDatabase } = require('./database');
const { MONITORING_PORT } = require('./config');

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Start the servers
async function initializeServers() {
    try {
        // Connect to database
        await connectToDatabase();
        console.log('✅ Database connection established');

        // Start device server
        await startServer();
        console.log('✅ Device server started');

        // Handle server closing
        const shutdownHandler = () => {
            console.log('🛑 Shutting down servers...');

            // Close all device connections
            for (const [imei, info] of activeDevices.entries()) {
                try {
                    info.socket.end();
                    console.log(`✅ Closed connection to device ${imei}`);
                } catch (err) {
                    console.error(`❌ Error closing connection to device ${imei}: ${err.message}`);
                }
            }

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
    } catch (error) {
        console.error('❌ Server initialization error:', error);
        process.exit(1);
    }
}

// Initialize servers
initializeServers();

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Export the server instances for testing
module.exports = {
    deviceServer: require('./deviceServer').server,
    activeDevices
};
