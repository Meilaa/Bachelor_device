require('dotenv').config(); // Load environment variables

const { startDeviceServer, activeDevices } = require('./deviceServer');
const { startMonitorServer } = require('./monitorServer');
const { connectToDatabase } = require('./database.js');

// Connect to MongoDB and start the servers
connectToDatabase()
    .then(() => {
        try {
            if (!global.DISABLE_SERVER_AUTOSTART) {
                // Start monitoring HTTP server
                startMonitorServer(activeDevices);

                // Start device TCP server
                startDeviceServer();

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
            }
        } catch (error) {
            console.error('❌ Server initialization error:', error);
            process.exit(1);
        }
    })
    .catch(err => {
        console.error('❌ Failed to connect to the database:', err);
        process.exit(1);
    });

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
    process.exit(1);
});

// Export the server instances for testing
module.exports = {
    deviceServer: require('./deviceServer').server,
    monitorServer: require('./monitorServer').monitorServer,
    activeDevices
};
