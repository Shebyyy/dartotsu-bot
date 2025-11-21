// Dartotsu Discord Bot - Ultimate Edition (Multi-Server by Name)

// Polyfill ReadableStream
if (typeof ReadableStream === 'undefined') {
  try {
    const streamWeb = require('stream/web');
    ReadableStream = streamWeb.ReadableStream;
  } catch (e) {
    const { Readable } = require('stream');
    global.ReadableStream = class extends Readable {
      constructor(options = {}) {
        super(options);
        this._controller = {
          enqueue: (chunk) => this.push(chunk),
          close: () => this.push(null),
          error: (e) => this.destroy(e)
        };
        if (options.start) options.start(this._controller);
      }
    };
  }
}

require('dotenv').config();
const { 
  Client, GatewayIntentBits, REST, Routes, EmbedBuilder, PermissionFlagsBits, 
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
  TextInputStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder 
} = require('discord.js');
const { Octokit } = require('@octokit/rest');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ================================
// SECURITY (ENCRYPTION)
// ================================
// MUST BE 32 CHARACTERS
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; 
const IV_LENGTH = 16;

const encrypt = (text) => {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) { console.error('Encryption error:', e.message); return text; }
};

const decrypt = (text) => {
  if (!text) return null;
  try {
    const textParts = text.split(':');
    if (textParts.length < 2) return text;
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) { return null; }
};

// ================================
// POSTGRESQL DATABASE SYSTEM
// ================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// In-Memory Storage: Map<ServerName, ConfigObject>
const serverConfigs = new Map();

const DEFAULT_CONFIG = {
  githubToken: null,
  repo: { owner: null, name: null, workflowFile: null, branch: 'main' },
  discord: { allowedRoleIds: [], logChannelId: null },
  features: { requirePermissions: false, enableLogging: false, autoRefreshStatus: false, refreshInterval: 30000 }
};

// Helpers
const getServerConfig = (serverName) => {
  if (!serverConfigs.has(serverName)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  return serverConfigs.get(serverName);
};

const getOctokit = (serverName) => {
  const config = getServerConfig(serverName);
  if (!config.githubToken) return null;
  return new Octokit({ 
    auth: config.githubToken,
    request: { fetch: require('node-fetch') }
  });
};

const log = (msg, level = 'INFO') => {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
};

// Database functions
const initDatabase = async () => {
  try {
    // Modified table to support Multi-Server (server_name)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS server_configs (
        server_name VARCHAR(255),
        key VARCHAR(50),
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_name, key)
      )
    `);
    
    // Preserve your trigger logic
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$       BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);
    
    await pool.query(`DROP TRIGGER IF EXISTS update_server_configs_updated_at ON server_configs`);
    
    await pool.query(`
      CREATE TRIGGER update_server_configs_updated_at
        BEFORE UPDATE ON server_configs
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);
    
    log('PostgreSQL database initialized (Multi-Server Mode)', 'INFO');
  } catch (error) {
    log(`Database init error: ${error.message}`, 'ERROR');
  }
};

const loadConfigsFromDB = async () => {
  try {
    const { rows } = await pool.query("SELECT server_name, key, value FROM server_configs");
    
    rows.forEach(row => {
      const { server_name, key, value } = row;
      
      if (!serverConfigs.has(server_name)) {
        serverConfigs.set(server_name, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
      }
      const config = serverConfigs.get(server_name);

      switch(key) {
        case 'githubToken': config.githubToken = decrypt(value); break;
        case 'repoOwner': config.repo.owner = value; break;
        case 'repoName': config.repo.name = value; break;
        case 'workflowFile': config.repo.workflowFile = value; break;
        case 'branch': config.repo.branch = value; break;
        case 'allowedRoles': try { config.discord.allowedRoleIds = JSON.parse(value); } catch (e) {} break;
        case 'logChannelId': config.discord.logChannelId = value; break;
        case 'requirePermissions': config.features.requirePermissions = value === 'true'; break;
        case 'enableLogging': config.features.enableLogging = value === 'true'; break;
        case 'autoRefreshStatus': config.features.autoRefreshStatus = value === 'true'; break;
        case 'refreshInterval': config.features.refreshInterval = parseInt(value) || 30000; break;
      }
    });
    
    log(`Configuration loaded for ${serverConfigs.size} servers`, 'INFO');
  } catch (error) {
    log(`Database load error: ${error.message}`, 'ERROR');
  }
};

const saveServerConfig = async (serverName, key, value) => {
  try {
    await pool.query(
      "INSERT INTO server_configs (server_name, key, value) VALUES ($1, $2, $3) ON CONFLICT (server_name, key) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP",
      [serverName, key, value]
    );
    
    // Update Memory
    if (!serverConfigs.has(serverName)) serverConfigs.set(serverName, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    const config = serverConfigs.get(serverName);
    
    switch(key) {
      case 'githubToken': config.githubToken = key === 'githubToken' ? decrypt(value) : value; break;
      case 'repoOwner': config.repo.owner = value; break;
      case 'repoName': config.repo.name = value; break;
      case 'workflowFile': config.repo.workflowFile = value; break;
      case 'branch': config.repo.branch = value; break;
      case 'allowedRoles': config.discord.allowedRoleIds = JSON.parse(value); break;
      case 'logChannelId': config.discord.logChannelId = value; break;
      case 'requirePermissions': config.features.requirePermissions = value === 'true'; break;
      case 'enableLogging': config.features.enableLogging = value === 'true'; break;
      case 'autoRefreshStatus': config.features.autoRefreshStatus = value === 'true'; break;
      case 'refreshInterval': config.features.refreshInterval = parseInt(value); break;
    }
  } catch (error) {
    log(`Save config error: ${error.message}`, 'ERROR');
    throw error;
  }
};

const testDatabaseConnection = async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    log('PostgreSQL connection successful', 'INFO');
    return true;
  } catch (error) {
    log(`Database connection failed: ${error.message}`, 'ERROR');
    return false;
  }
};

// ================================
// CONSTANTS & HELPERS
// ================================
const EMOJI = {
  platform: { all: '🌐', android: '🤖', windows: '🪟', linux: '🐧', ios: '🍎', macos: '💻' },
  status: { completed: '✅', in_progress: '🔄', queued: '⏳' },
  conclusion: { success: '✅', failure: '❌', cancelled: '🚫' }
};
const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, info: 0x5865F2, dark: 0x2C3E50 };
const cache = { branches: new Map() }; 

const formatDuration = (ms) => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const sendLog = async (serverName, msg, embed = null) => {
  const config = getServerConfig(serverName);
  if (!config.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.discord.logChannelId);
    if (channel?.isTextBased()) await channel.send(embed ? { content: msg, embeds: [embed] } : msg);
  } catch (e) { log(`Log send error: ${e.message}`, 'ERROR'); }
};

// ================================
// DASHBOARD UI & COMPONENTS
// ================================

const getConfigEmbed = (serverName) => {
  const config = getServerConfig(serverName);
  const isTokenSet = !!config.githubToken;
  const isRepoSet = !!(config.repo.owner && config.repo.name);

  return new EmbedBuilder()
    .setColor(COLORS.dark)
    .setTitle(`⚙️ Config for "${serverName}"`)
    .setDescription('Settings are tied to the **Server Name**.')
    .addFields(
      { name: '🐙 GitHub', value: `**Token:** ${isTokenSet ? '✅ Set' : '❌ No'}\n**Repo:** ${isRepoSet ? `${config.repo.owner}/${config.repo.name}` : '❌ No'}\n**File:** \`${config.repo.workflowFile || 'None'}\`\n**Branch:** \`${config.repo.branch || 'main'}\``, inline: true },
      { name: '💬 Discord', value: `**Logs:** ${config.discord.logChannelId ? `<#${config.discord.logChannelId}>` : 'None'}\n**Roles:** ${config.discord.allowedRoleIds.length} allowed`, inline: true },
      { name: '🎛️ Toggles', value: `**Perms:** ${config.features.requirePermissions ? '✅' : '❌'}\n**Logs:** ${config.features.enableLogging ? '✅' : '❌'}\n**Refresh:** ${config.features.autoRefreshStatus ? '✅' : '❌'}`, inline: false }
    )
    .setFooter({ text: 'Warning: Renaming this server will reset these settings.' });
};

const getConfigComponents = () => {
  const selectMenu = new StringSelectMenuBuilder().setCustomId('config_menu').setPlaceholder('Configure...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('GitHub').setValue('cfg_github').setEmoji('🐙'),
      new StringSelectMenuOptionBuilder().setLabel('Discord').setValue('cfg_discord').setEmoji('💬'),
      new StringSelectMenuOptionBuilder().setLabel('Toggles').setValue('cfg_features').setEmoji('🎛️')
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg_test').setLabel('Test GitHub').setStyle(ButtonStyle.Primary)
  );
  return [new ActionRowBuilder().addComponents(selectMenu), row];
};

const createButtons = (runId, url, showCancel = false) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setURL(url).setEmoji('🔗')
  );
  if (showCancel) row.addComponents(new ButtonBuilder().setCustomId(`cancel_${runId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('🚫'));
  row.addComponents(new ButtonBuilder().setCustomId(`refresh_${runId}`).setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));
  return row;
};

// ================================
// GITHUB LOGIC
// ================================

const getLatestRun = async (serverName, runId = null) => {
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!config.repo.owner || !octokit) return null;
  
  if (runId) return (await octokit.actions.getWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId })).data;
  const { data } = await octokit.actions.listWorkflowRuns({ owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: 1 });
  return data.workflow_runs[0] || null;
};

const createRunEmbed = (run) => {
  const duration = run.updated_at && run.created_at ? formatDuration(new Date(run.updated_at) - new Date(run.created_at)) : 'N/A';
  return new EmbedBuilder()
    .setColor(run.conclusion === 'success' ? COLORS.success : run.status === 'in_progress' ? COLORS.in_progress : COLORS.failure)
    .setTitle(`Build Status: ${run.status}`)
    .setURL(run.html_url)
    .setDescription(`**${run.display_title || run.name}**\nBranch: \`${run.head_branch}\`\nConclusion: ${run.conclusion || 'Running'}`)
    .addFields({ name: 'Duration', value: duration, inline: true }, { name: 'Run #', value: `${run.run_number}`, inline: true })
    .setTimestamp();
};

// ================================
// COMMAND HANDLERS
// ================================

const checkPermissions = async (interaction) => {
  const config = getServerConfig(interaction.guild.name);
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!config.features.requirePermissions) return true;
  if (config.discord.allowedRoleIds.length > 0 && interaction.member.roles.cache.some(r => config.discord.allowedRoleIds.includes(r.id))) return true;
  
  await interaction.reply({ content: '❌ Permission Denied', flags: [MessageFlags.Ephemeral] });
  return false;
};

const handleBuild = async (interaction) => {
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);

  if (!octokit || !config.repo.owner) return interaction.reply({ content: '❌ Configure the bot first via `/config`', flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply();
  const platform = interaction.options.getString('platform');
  const branch = interaction.options.getString('branch') || config.repo.branch;
  const clean = interaction.options.getBoolean('clean_build') || false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, ref: branch,
      inputs: { build_targets: platform, clean_build: clean.toString() }
    });

    await new Promise(r => setTimeout(r, 2000)); 
    const run = await getLatestRun(serverName);
    
    const embed = new EmbedBuilder().setColor(COLORS.success).setTitle('🚀 Build Triggered').setDescription(`Target: **${platform}**\nBranch: \`${branch}\``);
    const btn = run ? [createButtons(run.id, run.html_url, true)] : [];
    
    await interaction.editReply({ embeds: [embed], components: btn });
    sendLog(serverName, `🚀 Build started by ${interaction.user.tag}`);
  } catch (e) { await interaction.editReply({ content: `❌ GitHub Error: ${e.message}` }); }
};

const handleStatus = async (interaction) => {
  const serverName = interaction.guild.name;
  await interaction.deferReply();
  try {
    const run = await getLatestRun(serverName);
    if(!run) return interaction.editReply('No runs found.');
    const showCancel = run.status === 'in_progress' || run.status === 'queued';
    await interaction.editReply({ embeds: [createRunEmbed(run)], components: [createButtons(run.id, run.html_url, showCancel)] });
  } catch(e) { interaction.editReply('Error fetching status'); }
};

const handleLogs = async (interaction) => {
  const serverName = interaction.guild.name;
  await interaction.deferReply();
  const runId = interaction.options.getString('run_id');
  try {
    const run = await getLatestRun(serverName, runId);
    if(!run) return interaction.editReply('No runs found.');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`📋 Logs: Run #${run.run_number}`).setDescription(`[Click here to view logs](${run.html_url})`);
    await interaction.editReply({ embeds: [embed], components: [createButtons(run.id, run.html_url)] });
  } catch(e) { interaction.editReply('Error fetching logs'); }
};

const handleArtifacts = async (interaction) => {
  const serverName = interaction.guild.name;
  const octokit = getOctokit(serverName);
  const config = getServerConfig(serverName);
  if (!octokit) return interaction.reply({ content: '❌ Config missing', flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply();
  const runId = interaction.options.getString('run_id');
  try {
    const run = await getLatestRun(serverName, runId);
    if(!run) return interaction.editReply('No runs found.');
    const { data } = await octokit.actions.listWorkflowRunArtifacts({ owner: config.repo.owner, repo: config.repo.name, run_id: run.id });
    
    if(!data.artifacts.length) return interaction.editReply('📭 No artifacts.');
    const list = data.artifacts.map(a => `**${a.name}** (${formatBytes(a.size_in_bytes)})`).join('\n');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📦 Artifacts').setDescription(list);
    await interaction.editReply({ embeds: [embed] });
  } catch(e) { interaction.editReply('Error fetching artifacts'); }
};

const handleHistory = async (interaction) => {
  const serverName = interaction.guild.name;
  const octokit = getOctokit(serverName);
  const config = getServerConfig(serverName);
  if (!octokit) return interaction.reply({ content: '❌ Config missing', flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply();
  try {
    const { data } = await octokit.actions.listWorkflowRuns({ owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: 20 });
    const list = data.workflow_runs.slice(0, 10).map(r => `${r.conclusion==='success'?'✅':'❌'} [#${r.run_number}](${r.html_url}) - ${r.head_branch}`).join('\n');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📊 History (Last 10)').setDescription(list || 'No runs.');
    await interaction.editReply({ embeds: [embed] });
  } catch(e) { interaction.editReply('Error fetching history'); }
};

const handleCancel = async (interaction) => {
  const serverName = interaction.guild.name;
  const octokit = getOctokit(serverName);
  const config = getServerConfig(serverName);
  if (!octokit) return interaction.reply({ content: '❌ Config missing', flags: [MessageFlags.Ephemeral] });

  await interaction.deferReply();
  let runId = interaction.options.getString('run_id');
  try {
    if (!runId) {
      const run = await getLatestRun(serverName);
      if (!run || (run.status !== 'in_progress' && run.status !== 'queued')) return interaction.editReply('❌ No active run to cancel.');
      runId = run.id;
    }
    await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
    await interaction.editReply(`✅ Cancelled run #${runId}`);
  } catch(e) { interaction.editReply('Error cancelling run'); }
};

const handleCleanup = async (interaction) => {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    await interaction.editReply('✅ Commands cleared. Restart bot to re-register.');
  } catch (e) { await interaction.editReply(`Error: ${e.message}`); }
};

// ================================
// MAIN EVENT LOOP
// ================================
const commands = [
  { name: 'build', description: 'Trigger Build', options: [
      { name: 'platform', description: 'Platform', type: 3, required: true, choices: [{name:'All',value:'all'},{name:'Android',value:'android'},{name:'Windows',value:'windows'},{name:'Linux',value:'linux'},{name:'iOS',value:'ios'}] },
      { name: 'branch', description: 'Branch', type: 3, autocomplete: true },
      { name: 'clean_build', description: 'Clean?', type: 5 }
    ]},
  { name: 'config', description: 'Configure Bot (Uses Server Name)', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { name: 'workflow-status', description: 'Check Status' },
  { name: 'build-logs', description: 'View logs', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'list-artifacts', description: 'List artifacts', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'workflow-history', description: 'View history' },
  { name: 'cancel-workflow', description: 'Cancel run', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'cleanup-commands', description: 'Reset commands', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { name: 'bot-info', description: 'Bot Info' },
  { name: 'help', description: 'Help' }
];

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  log(`✅ Bot Active`, 'INFO');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return interaction.reply('❌ DM not supported');
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);

  // --- AUTOCOMPLETE ---
  if (interaction.isAutocomplete() && interaction.commandName === 'build') {
    const octokit = getOctokit(serverName);
    if (!octokit || !config.repo.owner) return interaction.respond([]);
    const now = Date.now();
    const serverCache = cache.branches.get(serverName) || { data: [], time: 0 };
    if (now - serverCache.time > 60000) { 
      try {
        const { data } = await octokit.repos.listBranches({ owner: config.repo.owner, repo: config.repo.name });
        serverCache.data = data.map(b => b.name);
        serverCache.time = now;
        cache.branches.set(serverName, serverCache);
      } catch (e) {}
    }
    const focus = interaction.options.getFocused();
    const filtered = serverCache.data.filter(b => b.startsWith(focus)).slice(0, 25);
    await interaction.respond(filtered.map(b => ({ name: b, value: b })));
    return;
  }

  // --- COMMANDS ---
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'config') return interaction.reply({ embeds: [getConfigEmbed(serverName)], components: getConfigComponents(), flags: [MessageFlags.Ephemeral] });
    if (interaction.commandName === 'cleanup-commands') return handleCleanup(interaction);
    
    // Permission Check
    if (!await checkPermissions(interaction)) return;

    const handlers = {
      'build': handleBuild,
      'workflow-status': handleStatus,
      'build-logs': handleLogs,
      'list-artifacts': handleArtifacts,
      'workflow-history': handleHistory,
      'cancel-workflow': handleCancel,
      'bot-info': (i) => i.reply({ embeds: [new EmbedBuilder().setTitle('🤖 Bot Info').setDescription('Multi-Server Edition').setColor(COLORS.info)] }),
      'help': (i) => i.reply({ content: 'Use `/config` to set up, `/build` to start.', flags: [MessageFlags.Ephemeral] })
    };

    if (handlers[interaction.commandName]) await handlers[interaction.commandName](interaction);
  }

  // --- UI HANDLERS ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'config_menu') {
    const val = interaction.values[0];
    if (val === 'cfg_github') {
      const modal = new ModalBuilder().setCustomId('modal_gh').setTitle('GitHub Settings');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tk').setLabel('Token').setStyle(1).setRequired(false).setPlaceholder('Leave empty to keep')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ow').setLabel('Owner').setValue(config.repo.owner||'').setStyle(1)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nm').setLabel('Repo Name').setValue(config.repo.name||'').setStyle(1)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wf').setLabel('Workflow File').setValue(config.repo.workflowFile||'').setStyle(1)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('br').setLabel('Branch').setValue(config.repo.branch||'main').setStyle(1))
      );
      await interaction.showModal(modal);
    } 
    else if (val === 'cfg_discord') {
      const modal = new ModalBuilder().setCustomId('modal_dc').setTitle('Discord Settings');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lg').setLabel('Log Channel ID').setValue(config.discord.logChannelId||'').setStyle(1).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rl').setLabel('Allowed Roles (IDs)').setValue(config.discord.allowedRoleIds.join(',')||'').setStyle(2).setRequired(false))
      );
      await interaction.showModal(modal);
    }
    else if (val === 'cfg_features') {
       const row = new ActionRowBuilder().addComponents(
         new ButtonBuilder().setCustomId('tg_perms').setLabel(`Perms: ${config.features.requirePermissions}`).setStyle(config.features.requirePermissions?3:4),
         new ButtonBuilder().setCustomId('tg_logs').setLabel(`Logs: ${config.features.enableLogging}`).setStyle(config.features.enableLogging?3:4),
         new ButtonBuilder().setCustomId('tg_refresh').setLabel('Back').setStyle(2)
       );
       await interaction.update({ content: 'Toggles:', components: [row], embeds: [] });
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_gh') {
      const tk = interaction.fields.getTextInputValue('tk');
      if (tk) await saveServerConfig(serverName, 'githubToken', encrypt(tk));
      await saveServerConfig(serverName, 'repoOwner', interaction.fields.getTextInputValue('ow'));
      await saveServerConfig(serverName, 'repoName', interaction.fields.getTextInputValue('nm'));
      await saveServerConfig(serverName, 'workflowFile', interaction.fields.getTextInputValue('wf'));
      await saveServerConfig(serverName, 'branch', interaction.fields.getTextInputValue('br'));
      await interaction.update({ embeds: [getConfigEmbed(serverName)], components: getConfigComponents() });
    }
    if (interaction.customId === 'modal_dc') {
      await saveServerConfig(serverName, 'logChannelId', interaction.fields.getTextInputValue('lg'));
      const roles = interaction.fields.getTextInputValue('rl').split(',').map(r=>r.trim()).filter(r=>/^\d+$/.test(r));
      await saveServerConfig(serverName, 'allowedRoles', JSON.stringify(roles));
      await interaction.update({ embeds: [getConfigEmbed(serverName)], components: getConfigComponents() });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'cfg_refresh' || interaction.customId === 'tg_refresh') await interaction.update({ content: '', embeds: [getConfigEmbed(serverName)], components: getConfigComponents() });
    if (interaction.customId === 'cfg_test') {
      const octokit = getOctokit(serverName);
      if(!octokit) return interaction.reply({ content: '❌ No token', flags: [MessageFlags.Ephemeral] });
      try {
        const { data } = await octokit.users.getAuthenticated();
        interaction.reply({ content: `✅ Connected as ${data.login}`, flags: [MessageFlags.Ephemeral] });
      } catch(e) { interaction.reply({ content: '❌ Failed', flags: [MessageFlags.Ephemeral] }); }
    }
    if (interaction.customId.startsWith('tg_')) {
      let key = '', val = false;
      if (interaction.customId === 'tg_perms') { key='requirePermissions'; val=!config.features.requirePermissions; }
      if (interaction.customId === 'tg_logs') { key='enableLogging'; val=!config.features.enableLogging; }
      if(key) {
        await saveServerConfig(serverName, key, val.toString());
        const row = new ActionRowBuilder().addComponents(
           new ButtonBuilder().setCustomId('tg_perms').setLabel(`Perms: ${config.features.requirePermissions}`).setStyle(config.features.requirePermissions?3:4),
           new ButtonBuilder().setCustomId('tg_logs').setLabel(`Logs: ${config.features.enableLogging}`).setStyle(config.features.enableLogging?3:4),
           new ButtonBuilder().setCustomId('tg_refresh').setLabel('Back').setStyle(2)
        );
        await interaction.update({ components: [row] });
      }
    }
    // Workflow Buttons
    if (interaction.customId.startsWith('refresh_')) {
      const runId = interaction.customId.split('_')[1];
      try {
        const run = await getLatestRun(serverName, runId);
        const showCancel = run.status === 'in_progress' || run.status === 'queued';
        await interaction.update({ embeds: [createRunEmbed(run)], components: [createButtons(run.id, run.html_url, showCancel)] });
      } catch(e) {}
    }
    if (interaction.customId.startsWith('cancel_')) {
       await handleCancel(interaction);
    }
  }
});

client.on('error', error => log(`Client error: ${error.message}`, 'ERROR'));
process.on('unhandledRejection', error => log(`Unhandled rejection: ${error.message}`, 'ERROR'));
process.on('SIGINT', async () => { 
  log('SIGINT - shutting down', 'INFO'); 
  await pool.end(); 
  client.destroy(); 
  process.exit(0); 
});
process.on('SIGTERM', async () => { 
  log('SIGTERM - shutting down', 'INFO'); 
  await pool.end(); 
  client.destroy(); 
  process.exit(0); 
});

// ================================
// START BOT
// ================================
const startBot = async () => {
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('❌ Failed to connect to PostgreSQL database');
    console.error('Please ensure DATABASE_URL is set correctly');
    process.exit(1);
  }
  
  await initDatabase();
  await loadConfigsFromDB();
  
  if (!process.env.DISCORD_TOKEN) { 
    console.error('❌ Discord Token not configured. Please set DISCORD_TOKEN environment variable');
    process.exit(1); 
  }
  
  client.login(process.env.DISCORD_TOKEN)
    .catch(error => { 
      log(`Login failed: ${error.message}`, 'ERROR'); 
      process.exit(1); 
    });
};

startBot();
