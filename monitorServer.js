const http = require('http');
const { MONITOR_PORT } = require('./config');

// Create HTTP server for status monitoring
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

// Start the monitoring server
function startMonitorServer(activeDevices) {
    monitorServer.listen(MONITOR_PORT, () => {
        console.log(`🖥️ Monitoring server listening on port ${MONITOR_PORT}`);
        console.log(`   Health endpoint: http://localhost:${MONITOR_PORT}/health`);
        console.log(`   Devices endpoint: http://localhost:${MONITOR_PORT}/devices`);
    });
}

module.exports = {
    monitorServer,
    startMonitorServer
}; 