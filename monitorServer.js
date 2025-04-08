const express = require('express');
const { DEVICE_PORT, MONITOR_PORT } = require('./config');

// Create Express app for monitoring
const monitorServer = express();

// Add error handling middleware
monitorServer.use((err, req, res, next) => {
    console.error('❌ Monitoring server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint for Kubernetes
monitorServer.get('/healthz', (req, res) => {
    try {
        res.status(200).json({
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

// Original health check endpoint (kept for backward compatibility)
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

// Connections endpoint
monitorServer.get('/connections', (req, res) => {
    try {
        const server = req.app.locals.deviceServer;
        if (!server) {
            return res.status(503).json({ error: 'Device server not available' });
        }

        server.getConnections((err, count) => {
            if (err) {
                console.error('❌ Error getting connections:', err);
                return res.status(500).json({ error: 'Failed to get connection count' });
            }

            const activeDevices = req.app.locals.activeDevices || new Map();
            const connectionIssues = Array.from(activeDevices.values())
                .filter(d => Date.now() - d.lastActivity > 30000);

            res.json({
                activeConnections: count,
                timestamp: new Date().toISOString(),
                connectionIssues
            });
        });
    } catch (error) {
        console.error('❌ Connections endpoint error:', error);
        res.status(500).json({ error: 'Failed to get connection information' });
    }
});

// Start the monitoring server
function startMonitorServer(deviceServer, activeDevices) {
    try {
        // Store device server and active devices in app locals
        monitorServer.locals.deviceServer = deviceServer;
        monitorServer.locals.activeDevices = activeDevices;

        if (!MONITOR_PORT) {
            throw new Error('MONITOR_PORT is not defined');
        }

        monitorServer.listen(MONITOR_PORT, () => {
            console.log(`\n📊 Monitoring server listening on port ${MONITOR_PORT}`);
            console.log(`   - Health endpoint: http://localhost:${MONITOR_PORT}/health`);
            console.log(`   - Devices endpoint: http://localhost:${MONITOR_PORT}/devices`);
            console.log(`   - Connections endpoint: http://localhost:${MONITOR_PORT}/connections`);
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