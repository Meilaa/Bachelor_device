const express = require('express');
const { DEVICE_PORT, MONITOR_PORT } = require('./config');

// Create Express app for monitoring
const monitorServer = express();

// Add error handling middleware
monitorServer.use((err, req, res, next) => {
    console.error('❌ Monitoring server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint
monitorServer.get('/health', (req, res) => {
    try {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            devicePort: DEVICE_PORT,
            monitorPort: MONITOR_PORT
        });
    } catch (error) {
        console.error('❌ Health check error:', error);
        res.status(500).json({ error: 'Health check failed' });
    }
});

// Active devices endpoint
monitorServer.get('/devices', (req, res) => {
    try {
        const activeDevices = req.app.locals.activeDevices || new Map();
        const devices = Array.from(activeDevices.entries()).map(([deviceId, info]) => ({
            deviceId,
            connectedAt: info.connectedAt,
            lastActivity: info.lastActivity,
            bytesReceived: info.bytesReceived,
            packetsProcessed: info.packetsProcessed
        }));
        res.json({ devices });
    } catch (error) {
        console.error('❌ Devices endpoint error:', error);
        res.status(500).json({ error: 'Failed to get device list' });
    }
});

// Start the monitoring server
function startMonitorServer(activeDevices) {
    try {
        // Store active devices in app locals
        monitorServer.locals.activeDevices = activeDevices;

        monitorServer.listen(MONITOR_PORT, () => {
            console.log(`🖥️ Monitoring server listening on port ${MONITOR_PORT}`);
            console.log(`    Health endpoint: http://localhost:${MONITOR_PORT}/health`);
            console.log(`    Devices endpoint: http://localhost:${MONITOR_PORT}/devices`);
        });
    } catch (error) {
        console.error('❌ Failed to start monitoring server:', error);
        process.exit(1);
    }
}

module.exports = {
    monitorServer,
    startMonitorServer
}; 