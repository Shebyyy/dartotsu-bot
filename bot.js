// Dartotsu Discord Bot - Multi-Server Edition (Server Name Based)

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
const fs = require('fs');
const crypto = require('crypto');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ================================
// SECURITY (ENCRYPTION)
// ================================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; // Must be 32 chars
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
const branchCache = new Map(); // Cache for autocomplete

const DEFAULT_CONFIG = {
  githubToken: null,
  guildId: null, // Kept for legacy/global command support if needed
  repo: { owner: null, name: null, workflowFile: null, branch: 'main' },
  discord: { allowedRoleIds: [], logChannelId: null },
  features: { requirePermissions: false, enableLogging: false, autoRefreshStatus: false, refreshInterval: 30000 }
};

// Helper to get config for a specific server name
const getServerConfig = (serverName) => {
  if (!serverConfigs.has(serverName)) {
    // Return deep copy of default
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  return serverConfigs.get(serverName);
};

// Helper to get Octokit for a specific server
const getOctokit = (serverName) => {
  const config = getServerConfig(serverName);
  if (!config.githubToken) return null;
  return new Octokit({ 
    auth: config.githubToken,
    request: { fetch: require('node-fetch') }
  });
};

// Database functions
const initDatabase = async () => {
  try {
    // CHANGED: Table now supports server_name as part of Primary Key
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
    
    // Keeping your Trigger logic
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
    
    log('PostgreSQL database initialized (Multi-Server)', 'INFO');
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
        case 'guildId': config.guildId = value; break;
        case 'allowedRoles': 
          try { config.discord.allowedRoleIds = value ? JSON.parse(value) : []; } catch (e) { config.discord.allowedRoleIds = []; }
          break;
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
    
    // Update memory immediately
    if (!serverConfigs.has(serverName)) serverConfigs.set(serverName, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    const config = serverConfigs.get(serverName);
    
    // Update specific key in memory
    if (key === 'githubToken') config.githubToken = decrypt(value); // Value passed here should be encrypted string, decrypt for memory
    else if (key === 'repoOwner') config.repo.owner = value;
    else if (key === 'repoName') config.repo.name = value;
    else if (key === 'workflowFile') config.repo.workflowFile = value;
    else if (key === 'branch') config.repo.branch = value;
    else if (key === 'guildId') config.guildId = value;
    else if (key === 'allowedRoles') config.discord.allowedRoleIds = JSON.parse(value);
    else if (key === 'logChannelId') config.discord.logChannelId = value;
    else if (key === 'requirePermissions') config.features.requirePermissions = value === 'true';
    else if (key === 'enableLogging') config.features.enableLogging = value === 'true';
    else if (key === 'autoRefreshStatus') config.features.autoRefreshStatus = value === 'true';
    else if (key === 'refreshInterval') config.features.refreshInterval = parseInt(value);

  } catch (error) {
    log(`Save config error for ${key}: ${error.message}`, 'ERROR');
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
// CONSTANTS
// ================================
const EMOJI = {
  platform: { all: '🌐', android: '🤖', windows: '🪟', linux: '🐧', ios: '🍎', macos: '💻' },
  status: { completed: '✅', in_progress: '🔄', queued: '⏳', waiting: '⏸️', requested: '📝', pending: '⏳' },
  conclusion: { success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️', timed_out: '⏰', action_required: '⚠️', neutral: '➖' }
};

const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, queued: 0x808080, info: 0x5865F2, dark: 0x2B2D31 };

// ================================
// UTILITY FUNCTIONS
// ================================
const log = (msg, level = 'INFO', serverName = null) => {
  const logMsg = `[${new Date().toISOString()}] [${level}] ${serverName ? `[${serverName}] ` : ''}${msg}`;
  console.log(logMsg);
  
  // Check if we should log to file based on server config
  let shouldLog = false;
  if (serverName) {
    const config = getServerConfig(serverName);
    if (config.features.enableLogging) shouldLog = true;
  } else {
    shouldLog = true; // Always log system events to console, potentially file if needed
  }

  if (shouldLog) {
    try {
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
      fs.appendFileSync(path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`), logMsg + '\n');
    } catch (e) { console.error(`Log error: ${e.message}`); }
  }
};

const checkPermissions = async (interaction) => {
  const config = getServerConfig(interaction.guild.name);
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
      !config.features.requirePermissions || 
      config.discord.allowedRoleIds.length === 0 ||
      interaction.member.roles.cache.some(role => config.discord.allowedRoleIds.includes(role.id))) return true;
  await interaction.reply({ content: '❌ No permission', flags: [MessageFlags.Ephemeral] });
  return false;
};

const sendLog = async (serverName, msg, embed = null) => {
  const config = getServerConfig(serverName);
  if (!config.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.discord.logChannelId);
    if (channel?.isTextBased()) await channel.send(embed ? { content: msg, embeds: [embed] } : msg);
  } catch (e) { log(`Log send error: ${e.message}`, 'ERROR', serverName); }
};

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

const createButtons = (runId, url, showCancel = false) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setURL(url).setEmoji('🔗')
  );
  if (showCancel) row.addComponents(new ButtonBuilder().setCustomId(`cancel_${runId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('🚫'));
  row.addComponents(new ButtonBuilder().setCustomId(`refresh_${runId}`).setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));
  return row;
};

const getLatestRun = async (serverName, runId = null, status = null) => {
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!config.repo.owner || !config.repo.name || !config.repo.workflowFile || !octokit) return null;
  
  if (runId) return (await octokit.actions.getWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId })).data;
  const params = { owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: 1 };
  if (status) params.status = status;
  const { data: runs } = await octokit.actions.listWorkflowRuns(params);
  return runs.workflow_runs[0] || null;
};

const createRunEmbed = (run, title = '📊 Workflow Status') => {
  const duration = run.updated_at && run.created_at ? formatDuration(new Date(run.updated_at) - new Date(run.created_at)) : 'N/A';
  const statusIcon = EMOJI.status[run.status] || '❓';
  const conclusionIcon = run.conclusion ? (EMOJI.conclusion[run.conclusion] || '❓') : '⏳';
  const color = run.conclusion === 'success' ? COLORS.success : run.conclusion === 'failure' ? COLORS.failure : 
                run.status === 'in_progress' ? COLORS.in_progress : COLORS.queued;
  
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setURL(run.html_url)
    .setDescription(`**${run.display_title || run.name}**`)
    .addFields(
      { name: '📍 Status', value: `${statusIcon} ${run.status.replace('_', ' ').toUpperCase()}`, inline: true },
      { name: '🎯 Conclusion', value: run.conclusion ? `${conclusionIcon} ${run.conclusion.toUpperCase()}` : '⏳ Running', inline: true },
      { name: '⏱️ Duration', value: duration, inline: true },
      { name: '🌿 Branch', value: `\`${run.head_branch}\``, inline: true },
      { name: '🔢 Run', value: `#${run.run_number}`, inline: true },
      { name: '🆔 ID', value: `\`${run.id}\``, inline: true }
    )
    .setTimestamp();
};

const handleGitHubError = (error, interaction) => {
  log(`GitHub API error: ${error.message}`, 'ERROR', interaction.guild?.name);
  
  let errorMessage = '❌ GitHub API Error';
  let errorDetails = error.message;
  
  if (error.status === 401) { errorMessage = '❌ Invalid GitHub Token'; errorDetails = 'Token is invalid or expired.'; }
  else if (error.status === 403) { errorMessage = '❌ Permission Denied'; errorDetails = 'Token missing scopes or private repo.'; }
  else if (error.status === 404) { errorMessage = '❌ Not Found'; errorDetails = 'Repo or workflow not found.'; }
  
  const errorEmbed = new EmbedBuilder().setColor(COLORS.failure).setTitle(errorMessage).setDescription(errorDetails).setTimestamp();
  if (interaction.replied || interaction.deferred) return interaction.editReply({ embeds: [errorEmbed] });
  return interaction.reply({ embeds: [errorEmbed], flags: [MessageFlags.Ephemeral] });
};

// ================================
// NEW UI: DASHBOARD (REPLACES PAGE 1/2/3)
// ================================

const getConfigEmbed = (serverName) => {
  const config = getServerConfig(serverName);
  const isTokenSet = !!config.githubToken;
  const isRepoSet = !!(config.repo.owner && config.repo.name);

  return new EmbedBuilder()
    .setColor(COLORS.dark)
    .setTitle(`⚙️ Config for "${serverName}"`)
    .setDescription('Settings are tied to this **Server Name**.')
    .addFields(
      { name: '🐙 GitHub', value: `**Token:** ${isTokenSet ? '✅ Set' : '❌ No'}\n**Repo:** ${isRepoSet ? `${config.repo.owner}/${config.repo.name}` : '❌ No'}\n**Workflow:** \`${config.repo.workflowFile || 'None'}\`\n**Branch:** \`${config.repo.branch || 'main'}\``, inline: true },
      { name: '💬 Discord', value: `**Logs:** ${config.discord.logChannelId ? `<#${config.discord.logChannelId}>` : 'None'}\n**Roles:** ${config.discord.allowedRoleIds.length} allowed`, inline: true },
      { name: '🎛️ Features', value: `**Perms:** ${config.features.requirePermissions ? '✅' : '❌'}\n**Logs:** ${config.features.enableLogging ? '✅' : '❌'}\n**Auto-Refresh:** ${config.features.autoRefreshStatus ? '✅' : '❌'}`, inline: false }
    )
    .setFooter({ text: 'Use the menu below to edit.' });
};

const getConfigComponents = () => {
  const selectMenu = new StringSelectMenuBuilder().setCustomId('config_menu').setPlaceholder('Select category to configure...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('GitHub Settings').setValue('cfg_github').setEmoji('🐙'),
      new StringSelectMenuOptionBuilder().setLabel('Discord Settings').setValue('cfg_discord').setEmoji('💬'),
      new StringSelectMenuOptionBuilder().setLabel('Feature Toggles').setValue('cfg_features').setEmoji('🎛️')
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh Dashboard').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg_test').setLabel('Test GitHub Connection').setStyle(ButtonStyle.Primary)
  );
  return [new ActionRowBuilder().addComponents(selectMenu), row];
};

// ================================
// COMMAND HANDLERS
// ================================

const handleBuild = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  
  if (!config.githubToken || !config.repo.owner) {
    return await interaction.editReply({ content: '❌ Bot not configured. Use `/config`.' });
  }
  
  const platform = interaction.options.getString('platform');
  const branch = interaction.options.getString('branch') || config.repo.branch;
  const cleanBuild = interaction.options.getBoolean('clean_build') ?? false;
  const pingDiscord = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, ref: branch,
      inputs: { build_targets: platform, clean_build: cleanBuild.toString(), ping_discord: pingDiscord.toString() }
    });

    await new Promise(r => setTimeout(r, 2000));
    const latestRun = await getLatestRun(serverName).catch(() => null);

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('✅ Build Triggered')
      .setDescription('Dartotsu build workflow started!')
      .addFields(
        { name: '🎯 Platform', value: `${EMOJI.platform[platform] || '📦'} **${platform.toUpperCase()}**`, inline: true },
        { name: '🧹 Clean', value: cleanBuild ? '✅' : '❌', inline: true },
        { name: '👤 By', value: interaction.user.tag, inline: true },
        { name: '🌿 Branch', value: `\`${branch}\``, inline: true }
      )
      .setTimestamp();

    if (latestRun) embed.setURL(latestRun.html_url);
    const components = latestRun ? [createButtons(latestRun.id, latestRun.html_url, true)] : [];
    
    await interaction.editReply({ embeds: [embed], components });
    sendLog(serverName, `🚀 Build ${platform} by ${interaction.user.tag}`, embed);
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleStatus = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  
  if (!config.githubToken) return await interaction.editReply({ content: '❌ Bot not configured.' });
  
  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? config.features.autoRefreshStatus;

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: limit
    });
    
    if (!runs.workflow_runs.length) return interaction.editReply('📭 No workflows found');

    const latestRun = runs.workflow_runs[0];
    const embed = createRunEmbed(latestRun, '📊 Latest Workflow Status');
    if (autoRefresh) embed.setFooter({ text: '🔄 Auto-refresh enabled' });
    
    if (runs.workflow_runs.length > 1) {
      const recent = runs.workflow_runs.slice(1, limit).map(r => {
        const icon = r.conclusion ? (EMOJI.conclusion[r.conclusion] || '❓') : (EMOJI.status[r.status] || '❓');
        return `${icon} [#${r.run_number}](${r.html_url}) - ${r.head_branch} - <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`;
      }).join('\n');
      embed.addFields({ name: `📋 Recent (${limit - 1})`, value: recent });
    }

    const showCancel = latestRun.status === 'in_progress' || latestRun.status === 'queued';
    await interaction.editReply({ embeds: [embed], components: [createButtons(latestRun.id, latestRun.html_url, showCancel)] });

    if (autoRefresh && showCancel) {
      setTimeout(async () => {
        try {
          const run = await getLatestRun(serverName, latestRun.id);
          if (run.status === 'completed') {
            await interaction.followUp({ content: `✅ Run #${run.run_number} finished!`, flags: [MessageFlags.Ephemeral] });
          }
        } catch (e) { }
      }, config.features.refreshInterval);
    }
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleCancel = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  
  if (!config.githubToken) return await interaction.editReply({ content: '❌ Bot not configured.' });
  
  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const run = await getLatestRun(serverName, null, 'in_progress');
      if (!run) return interaction.editReply('❌ No running workflows');
      runId = run.id;
    }

    await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
    
    const embed = new EmbedBuilder().setColor(COLORS.cancelled).setTitle('🚫 Workflow Cancelled').setDescription(`Run #${runId} cancelled`).addFields({ name: 'By', value: interaction.user.tag });
    await interaction.editReply({ embeds: [embed] });
    sendLog(serverName, `Cancelled ${runId} by ${interaction.user.tag}`);
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleLogs = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  if (!config.githubToken) return await interaction.editReply({ content: '❌ Bot not configured.' });
  
  let runId = interaction.options.getString('run_id');

  try {
    const run = runId ? await getLatestRun(serverName, runId) : await getLatestRun(serverName);
    if (!run) return interaction.editReply('❌ No workflows found');

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📋 Workflow Logs')
      .setDescription(`Logs for run #${run.run_number}\n[Click to View](${run.html_url})`)
      .addFields(
        { name: 'Status', value: run.status, inline: true },
        { name: 'Conclusion', value: run.conclusion || 'Running', inline: true }
      );

    await interaction.editReply({ embeds: [embed], components: [createButtons(run.id, run.html_url, false)] });
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleArtifacts = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!config.githubToken) return await interaction.editReply({ content: '❌ Bot not configured.' });
  
  let runId = interaction.options.getString('run_id');

  try {
    const run = runId ? await getLatestRun(serverName, runId) : await getLatestRun(serverName);
    if (!run) return interaction.editReply('❌ No workflows found');

    const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
      owner: config.repo.owner, repo: config.repo.name, run_id: run.id
    });

    if (!artifacts.artifacts.length) return interaction.editReply('📭 No artifacts found');

    const list = artifacts.artifacts.map(a => `**${a.name}** (${formatBytes(a.size_in_bytes)}) - ${a.expired ? 'Expired' : 'Available'}`).join('\n');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📦 Build Artifacts').setDescription(list).setFooter({ text: 'Download from GitHub Actions' });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleHistory = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!config.githubToken) return await interaction.editReply({ content: '❌ Bot not configured.' });
  
  const days = interaction.options.getInteger('days') || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile,
      per_page: 100, created: `>=${since.toISOString()}`
    });

    if (!runs.workflow_runs.length) return interaction.editReply(`📭 No runs in ${days} day(s)`);

    const stats = runs.workflow_runs.reduce((acc, r) => {
      acc.total++;
      if (r.conclusion === 'success') acc.success++;
      else if (r.conclusion === 'failure') acc.failure++;
      else if (r.conclusion === 'cancelled') acc.cancelled++;
      else if (r.status === 'in_progress') acc.inProgress++;
      if (r.updated_at && r.created_at) acc.totalDuration += new Date(r.updated_at) - new Date(r.created_at);
      return acc;
    }, { total: 0, success: 0, failure: 0, cancelled: 0, inProgress: 0, totalDuration: 0 });

    const successRate = ((stats.success / stats.total) * 100).toFixed(1);
    const avgDuration = formatDuration(stats.totalDuration / stats.total);

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📊 Workflow Statistics')
      .setDescription(`Last ${days} day(s)`)
      .addFields(
        { name: 'Total', value: `${stats.total}`, inline: true },
        { name: 'Success', value: `${stats.success} (${successRate}%)`, inline: true },
        { name: 'Failed', value: `${stats.failure}`, inline: true },
        { name: 'Duration (Avg)', value: avgDuration, inline: true }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleBotInfo = async (interaction) => {
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const uptime = formatDuration(process.uptime() * 1000);
  const memory = formatBytes(process.memoryUsage().heapUsed);
  
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 Dartotsu Build Bot')
    .setDescription('Multi-Server Edition')
    .addFields(
      { name: '📦 Repo', value: config.repo.owner ? `${config.repo.owner}/${config.repo.name}` : 'Not configured', inline: true },
      { name: '⏰ Uptime', value: uptime, inline: true },
      { name: '🌐 Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: '💾 Memory', value: memory, inline: true },
      { name: '🔗 Version', value: '3.0.0', inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: interaction.user.tag });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Repo').setStyle(ButtonStyle.Link).setURL('https://github.com/Shebyyy/Dartotsu').setEmoji('📦')
  );

  await interaction.reply({ embeds: [embed], components: [row] });
};

const handleHelp = async (interaction) => {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Command Help')
    .addFields(
      { name: '/build', value: 'Trigger builds. Supports auto-complete for branches.' },
      { name: '/workflow-status', value: 'Check current status (auto-refreshes).' },
      { name: '/config', value: 'Open the Dashboard to configure the bot.' },
      { name: '/build-logs', value: 'View logs of recent builds.' },
      { name: '/list-artifacts', value: 'Download build artifacts.' },
      { name: '/workflow-history', value: 'View success/fail stats.' }
    );
  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
};

const handleCleanup = async (interaction) => {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    // Reregister
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    await interaction.editReply('✅ Commands cleaned up & re-registered.');
  } catch (error) { await interaction.editReply(`Error: ${error.message}`); }
};

// ================================
// EVENT HANDLERS
// ================================
const commands = [
  { name: 'build', description: 'Trigger build', options: [
      { name: 'platform', description: 'Platform', type: 3, required: true, choices: [{ name: 'All', value: 'all' }, { name: 'Android', value: 'android' }, { name: 'Windows', value: 'windows' }, { name: 'Linux', value: 'linux' }, { name: 'iOS', value: 'ios' }, { name: 'macOS', value: 'macos' }] },
      { name: 'branch', description: 'Branch', type: 3, autocomplete: true },
      { name: 'clean_build', description: 'Clean build?', type: 5 },
      { name: 'ping_discord', description: 'Ping?', type: 5 }
    ]
  },
  { name: 'workflow-status', description: 'Check status', options: [{ name: 'limit', description: 'Limit', type: 4 }, { name: 'auto_refresh', description: 'Auto refresh?', type: 5 }] },
  { name: 'cancel-workflow', description: 'Cancel run', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'build-logs', description: 'View logs', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'list-artifacts', description: 'List artifacts', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'workflow-history', description: 'View history', options: [{ name: 'days', description: 'Days', type: 4 }] },
  { name: 'bot-info', description: 'Bot info' },
  { name: 'help', description: 'Help' },
  { name: 'config', description: 'Configure Bot', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { name: 'cleanup-commands', description: 'Cleanup', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [{name:'type',description:'Type',type:3,required:true,choices:[{name:'Global',value:'global'},{name:'Guild',value:'guild'},{name:'All',value:'all'}]}] }
];

client.once('ready', async () => {
  const dbConnected = await testDatabaseConnection();
  if (dbConnected) {
    await initDatabase();
    await loadConfigsFromDB();
  }
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  log(`✅ Bot Active as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return interaction.reply({ content: '❌ DM not supported', flags: [MessageFlags.Ephemeral] });
  
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);

  try {
    // 1. Autocomplete
    if (interaction.isAutocomplete() && interaction.commandName === 'build') {
      const octokit = getOctokit(serverName);
      if (!octokit || !config.repo.owner) return interaction.respond([]);
      
      const now = Date.now();
      const serverCache = branchCache.get(serverName) || { data: [], time: 0 };
      
      if (now - serverCache.time > 60000) { // 1 min cache
        try {
          const { data } = await octokit.repos.listBranches({ owner: config.repo.owner, repo: config.repo.name, per_page: 30 });
          serverCache.data = data.map(b => b.name);
          serverCache.time = now;
          branchCache.set(serverName, serverCache);
        } catch (e) {}
      }
      
      const focusedValue = interaction.options.getFocused();
      const filtered = serverCache.data.filter(choice => choice.startsWith(focusedValue)).slice(0, 25);
      await interaction.respond(filtered.map(choice => ({ name: choice, value: choice })));
      return;
    }

    // 2. Chat Commands
    if (interaction.isChatInputCommand()) {
      // Permissions check for non-config commands
      if (interaction.commandName !== 'config' && interaction.commandName !== 'cleanup-commands' && !await checkPermissions(interaction)) return;

      const handlers = {
        'build': handleBuild,
        'workflow-status': handleStatus,
        'cancel-workflow': handleCancel,
        'build-logs': handleLogs,
        'list-artifacts': handleArtifacts,
        'workflow-history': handleHistory,
        'bot-info': handleBotInfo,
        'help': handleHelp,
        'cleanup-commands': handleCleanup,
        'config': async (i) => i.reply({ embeds: [getConfigEmbed(serverName)], components: getConfigComponents(), flags: [MessageFlags.Ephemeral] })
      };

      const handler = handlers[interaction.commandName];
      if (handler) await handler(interaction);
    }

    // 3. Dashboard Select Menu
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
      } else if (val === 'cfg_discord') {
        const modal = new ModalBuilder().setCustomId('modal_dc').setTitle('Discord Settings');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lg').setLabel('Log Channel ID').setValue(config.discord.logChannelId||'').setStyle(1).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rl').setLabel('Allowed Roles (IDs)').setValue(config.discord.allowedRoleIds.join(',')||'').setStyle(2).setRequired(false))
        );
        await interaction.showModal(modal);
      } else if (val === 'cfg_features') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tg_perms').setLabel(`Perms: ${config.features.requirePermissions}`).setStyle(config.features.requirePermissions?3:4),
          new ButtonBuilder().setCustomId('tg_logs').setLabel(`Logs: ${config.features.enableLogging}`).setStyle(config.features.enableLogging?3:4),
          new ButtonBuilder().setCustomId('tg_refresh').setLabel('Back').setStyle(2)
        );
        await interaction.update({ content: 'Feature Toggles:', components: [row], embeds: [] });
      }
    }

    // 4. Dashboard Modals
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

    // 5. Buttons
    if (interaction.isButton()) {
      const id = interaction.customId;
      
      if (id === 'cfg_refresh' || id === 'tg_refresh') {
        await interaction.update({ content: '', embeds: [getConfigEmbed(serverName)], components: getConfigComponents() });
      }
      else if (id === 'cfg_test') {
        const octokit = getOctokit(serverName);
        if(!octokit) return interaction.reply({ content: '❌ No token', flags: [MessageFlags.Ephemeral] });
        try {
          const { data } = await octokit.users.getAuthenticated();
          interaction.reply({ content: `✅ Connected as ${data.login}`, flags: [MessageFlags.Ephemeral] });
        } catch(e) { interaction.reply({ content: '❌ Connection Failed', flags: [MessageFlags.Ephemeral] }); }
      }
      else if (id.startsWith('tg_')) {
        let key = '', val = false;
        if (id === 'tg_perms') { key='requirePermissions'; val=!config.features.requirePermissions; }
        if (id === 'tg_logs') { key='enableLogging'; val=!config.features.enableLogging; }
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
      else if (id.startsWith('refresh_')) {
        const runId = id.split('_')[1];
        try {
          const run = await getLatestRun(serverName, runId);
          const showCancel = run.status === 'in_progress' || run.status === 'queued';
          await interaction.update({ embeds: [createRunEmbed(run)], components: [createButtons(run.id, run.html_url, showCancel)] });
        } catch(e) {}
      }
      else if (id.startsWith('cancel_')) {
        // Manually call handleCancel logic here or extract it
        await interaction.deferUpdate();
        const runId = id.split('_')[1];
        const octokit = getOctokit(serverName);
        try {
          await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
          await interaction.followUp({ content: '✅ Cancelled', flags: [MessageFlags.Ephemeral] });
        } catch(e) { await interaction.followUp({ content: '❌ Failed', flags: [MessageFlags.Ephemeral] }); }
      }
    }

  } catch (error) {
    log(`Interaction Error: ${error.message}`, 'ERROR');
    // Do not reply here to avoid "Already Replied" errors, just log
  }
});

// --- 9. Startup ---
const startBot = async () => {
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('❌ Failed to connect to PostgreSQL database');
    process.exit(1);
  }
  
  await initDatabase();
  await loadConfigsFromDB();
  
  if (!process.env.DISCORD_TOKEN) { 
    console.error('❌ Discord Token not configured.');
    process.exit(1); 
  }
  
  client.login(process.env.DISCORD_TOKEN).catch(error => { 
    log(`Login failed: ${error.message}`, 'ERROR'); 
    process.exit(1); 
  });
};

startBot();
