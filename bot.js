// Dartotsu Discord Bot

// --- 1. Polyfills & Imports ---
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

// --- 2. Security & Constants ---
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; 
const IV_LENGTH = 16;

const EMOJI = {
  platform: { all: '🌐', android: '🤖', windows: '🪟', linux: '🐧', ios: '🍎', macos: '💻' },
  status: { completed: '✅', in_progress: '🔄', queued: '⏳', waiting: '⏸️', requested: '📝', pending: '⏳' },
  conclusion: { success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️', timed_out: '⏰', action_required: '⚠️', neutral: '➖' }
};

const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, queued: 0x808080, info: 0x5865F2, dark: 0x2B2D31 };

// --- 3. Database & Config System ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
});

// Cache
const serverConfigs = new Map();
const cache = { branches: new Map() };

const DEFAULT_CONFIG = {
  githubToken: null,
  repo: { owner: null, name: null, workflowFile: null, branch: 'main' },
  discord: { allowedRoleIds: [], logChannelId: null },
  features: { requirePermissions: false, enableLogging: false, autoRefreshStatus: false, refreshInterval: 30000 }
};

// Encryption Helpers
const encrypt = (text) => {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) { console.error('Encryption Error:', e.message); return text; }
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

// Config Helpers
const getServerConfig = (serverName) => {
  if (!serverConfigs.has(serverName)) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return serverConfigs.get(serverName);
};

const getOctokit = (serverName) => {
  const config = getServerConfig(serverName);
  if (!config.githubToken) return null;
  return new Octokit({ auth: config.githubToken, request: { fetch: require('node-fetch') } });
};

// --- 4. Database Functions ---
const initDatabase = async () => {
  try {
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
    console.log('✅ Database initialized (Server Name Mode)');
  } catch (error) { console.error(`Database Init Error: ${error.message}`); }
};

const loadConfigsFromDB = async () => {
  try {
    const { rows } = await pool.query("SELECT server_name, key, value FROM server_configs");
    rows.forEach(row => {
      const { server_name, key, value } = row;
      if (!serverConfigs.has(server_name)) serverConfigs.set(server_name, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
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
    console.log(`✅ Loaded configurations for ${serverConfigs.size} servers`);
  } catch (error) { console.error(`DB Load Error: ${error.message}`); }
};

const saveServerConfig = async (serverName, key, value) => {
  try {
    await pool.query(
      "INSERT INTO server_configs (server_name, key, value) VALUES ($1, $2, $3) ON CONFLICT (server_name, key) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP",
      [serverName, key, value]
    );
    if (!serverConfigs.has(serverName)) serverConfigs.set(serverName, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    const config = serverConfigs.get(serverName);
    
    // Update memory
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
  } catch (error) { console.error(`Save Config Error: ${error.message}`); }
};

// --- 5. Utility & Formatting ---
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

const log = (msg, level = 'INFO', serverName = null) => {
  const logMsg = `[${new Date().toISOString()}] [${level}] ${serverName ? `[${serverName}] ` : ''}${msg}`;
  console.log(logMsg);
  
  // Detailed File Logging
  if (serverName) {
    const config = getServerConfig(serverName);
    if (config && config.features.enableLogging) {
      try {
        const logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
        fs.appendFileSync(path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`), logMsg + '\n');
      } catch (e) { console.error(`Log Write Error: ${e.message}`); }
    }
  }
};

const sendLog = async (serverName, msg, embed = null) => {
  const config = getServerConfig(serverName);
  if (!config.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.discord.logChannelId);
    if (channel?.isTextBased()) await channel.send(embed ? { content: msg, embeds: [embed] } : msg);
  } catch (e) { log(`Log send error: ${e.message}`, 'ERROR', serverName); }
};

const createButtons = (runId, url, showCancel = false) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setURL(url).setEmoji('🔗')
  );
  if (showCancel) row.addComponents(new ButtonBuilder().setCustomId(`cancel_${runId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('🚫'));
  row.addComponents(new ButtonBuilder().setCustomId(`refresh_${runId}`).setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));
  return row;
};

const handleGitHubError = (error, interaction) => {
  log(`GitHub API error: ${error.message}`, 'ERROR', interaction.guild?.name);
  let errorMessage = '❌ GitHub API Error';
  let errorDetails = error.message;
  
  if (error.status === 401) { errorMessage = '❌ Invalid GitHub Token'; errorDetails = 'Token invalid or expired. Update in /config'; }
  else if (error.status === 403) { errorMessage = '❌ Permission Denied'; errorDetails = 'Missing scopes or private repo access'; }
  else if (error.status === 404) { errorMessage = '❌ Not Found'; errorDetails = 'Repo, workflow, or branch not found'; }
  
  const embed = new EmbedBuilder().setColor(COLORS.failure).setTitle(errorMessage).setDescription(errorDetails).setTimestamp();
  if (interaction.replied || interaction.deferred) return interaction.editReply({ embeds: [embed] });
  return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
};

// --- 6. UI Components (Dashboard) ---
const getConfigEmbed = (serverName) => {
  const config = getServerConfig(serverName);
  return new EmbedBuilder()
    .setColor(COLORS.dark)
    .setTitle(`⚙️ Configuration: ${serverName}`)
    .setDescription('Select a category below to configure the bot for this server.')
    .addFields(
      { name: '🐙 GitHub', value: `**Token:** ${config.githubToken ? '✅ Set' : '❌ No'}\n**Repo:** ${config.repo.owner}/${config.repo.name || '?'}\n**Workflow:** \`${config.repo.workflowFile || '?'}\`\n**Branch:** \`${config.repo.branch || '?'}\``, inline: true },
      { name: '💬 Discord', value: `**Log Channel:** ${config.discord.logChannelId ? `<#${config.discord.logChannelId}>` : 'None'}\n**Roles:** ${config.discord.allowedRoleIds.length > 0 ? `${config.discord.allowedRoleIds.length} roles` : 'All'}`, inline: true },
      { name: '🎛️ Features', value: `**Perms:** ${config.features.requirePermissions ? '✅' : '❌'}\n**Logs:** ${config.features.enableLogging ? '✅' : '❌'}\n**Auto-Refresh:** ${config.features.autoRefreshStatus ? '✅' : '❌'}`, inline: false }
    )
    .setFooter({ text: 'Settings are tied to the Server Name' });
};

const getConfigComponents = () => {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('config_menu').setPlaceholder('Select category...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('GitHub Settings').setValue('cfg_github').setEmoji('🐙'),
          new StringSelectMenuOptionBuilder().setLabel('Discord Settings').setValue('cfg_discord').setEmoji('💬'),
          new StringSelectMenuOptionBuilder().setLabel('Feature Toggles').setValue('cfg_features').setEmoji('🎛️')
        )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg_test').setLabel('Test Token').setStyle(ButtonStyle.Primary)
    )
  ];
};

// --- 7. Command Handlers ---

const handleBuild = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);

  if (!octokit || !config.repo.owner) return interaction.editReply({ content: '❌ Bot not configured. Use `/config`.' });

  const platform = interaction.options.getString('platform');
  const branch = interaction.options.getString('branch') || config.repo.branch;
  const clean = interaction.options.getBoolean('clean_build') ?? false;
  const ping = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, ref: branch,
      inputs: { build_targets: platform, clean_build: clean.toString(), ping_discord: ping.toString() }
    });

    await new Promise(r => setTimeout(r, 2000));
    
    // Fetch latest run
    const { data } = await octokit.actions.listWorkflowRuns({ owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: 1 });
    const run = data.workflow_runs[0];

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🚀 Build Triggered')
      .setDescription('Dartotsu build workflow started!')
      .addFields(
        { name: 'Target', value: `${EMOJI.platform[platform] || '📦'} ${platform.toUpperCase()}`, inline: true },
        { name: 'Branch', value: `\`${branch}\``, inline: true },
        { name: 'Clean', value: clean ? '✅' : '❌', inline: true },
        { name: 'Initiator', value: interaction.user.tag, inline: true }
      )
      .setTimestamp();
      
    if (run) embed.setURL(run.html_url);

    await interaction.editReply({ embeds: [embed], components: run ? [createButtons(run.id, run.html_url, true)] : [] });
    sendLog(serverName, `🚀 Build ${platform} started by ${interaction.user.tag}`, embed);
  } catch (e) { handleGitHubError(e, interaction); }
};

const handleStatus = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  
  if (!octokit) return interaction.editReply('❌ Not Configured');

  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? config.features.autoRefreshStatus;

  try {
    const { data } = await octokit.actions.listWorkflowRuns({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: limit
    });

    if (!data.workflow_runs.length) return interaction.editReply('📭 No runs found');

    const latest = data.workflow_runs[0];
    const duration = latest.updated_at && latest.created_at ? formatDuration(new Date(latest.updated_at) - new Date(latest.created_at)) : 'N/A';
    const icon = latest.conclusion ? EMOJI.conclusion[latest.conclusion] : EMOJI.status[latest.status];
    
    const embed = new EmbedBuilder()
      .setColor(latest.conclusion === 'success' ? COLORS.success : latest.conclusion === 'failure' ? COLORS.failure : COLORS.in_progress)
      .setTitle('📊 Workflow Status')
      .setDescription(`**${latest.display_title}**`)
      .addFields(
        { name: 'Status', value: `${icon} ${latest.status.toUpperCase()}`, inline: true },
        { name: 'Conclusion', value: latest.conclusion || 'Running', inline: true },
        { name: 'Duration', value: duration, inline: true },
        { name: 'Branch', value: `\`${latest.head_branch}\``, inline: true },
        { name: 'Run #', value: `${latest.run_number}`, inline: true }
      )
      .setURL(latest.html_url)
      .setTimestamp();

    if (data.workflow_runs.length > 1) {
      const recent = data.workflow_runs.slice(1).map(r => {
        const i = r.conclusion ? EMOJI.conclusion[r.conclusion] : EMOJI.status[r.status];
        return `${i} [#${r.run_number}](${r.html_url}) - ${r.head_branch}`;
      }).join('\n');
      embed.addFields({ name: '📋 Recent', value: recent });
    }

    const showCancel = latest.status === 'in_progress' || latest.status === 'queued';
    await interaction.editReply({ embeds: [embed], components: [createButtons(latest.id, latest.html_url, showCancel)] });

    if (autoRefresh && showCancel) {
      setTimeout(async () => {
        try {
          const { data: refData } = await octokit.actions.getWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: latest.id });
          if (refData.status === 'completed') {
            const doneEmbed = new EmbedBuilder().setColor(COLORS.success).setTitle(`✅ Build ${refData.conclusion}`).setDescription(`Run #${refData.run_number} finished.`);
            await interaction.followUp({ embeds: [doneEmbed] });
            sendLog(serverName, `✅ Build #${refData.run_number} finished`, doneEmbed);
          }
        } catch(e) {}
      }, config.features.refreshInterval);
    }
  } catch (e) { handleGitHubError(e, interaction); }
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
      { name: '📦 Repo', value: config.repo.owner ? `${config.repo.owner}/${config.repo.name}` : 'Not Set', inline: true },
      { name: '🔧 Workflow', value: config.repo.workflowFile || 'Not Set', inline: true },
      { name: '⏰ Uptime', value: uptime, inline: true },
      { name: '💾 Memory', value: memory, inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
      { name: '🟢 Status', value: 'Online', inline: true }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Repository').setStyle(ButtonStyle.Link).setURL(config.repo.owner ? `https://github.com/${config.repo.owner}/${config.repo.name}` : 'https://github.com').setEmoji('📦'),
    new ButtonBuilder().setLabel('Actions').setStyle(ButtonStyle.Link).setURL(config.repo.owner ? `https://github.com/${config.repo.owner}/${config.repo.name}/actions` : 'https://github.com').setEmoji('⚡')
  );

  await interaction.reply({ embeds: [embed], components: [row] });
};

const handleHistory = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  const days = interaction.options.getInteger('days') || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { data } = await octokit.actions.listWorkflowRuns({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile,
      per_page: 100, created: `>=${since.toISOString()}`
    });

    const stats = data.workflow_runs.reduce((acc, r) => {
      acc.total++;
      if (r.conclusion === 'success') acc.success++;
      else if (r.conclusion === 'failure') acc.failure++;
      else if (r.conclusion === 'cancelled') acc.cancelled++;
      else if (r.status === 'in_progress') acc.inProgress++;
      if (r.updated_at && r.created_at) acc.totalDuration += new Date(r.updated_at) - new Date(r.created_at);
      return acc;
    }, { total: 0, success: 0, failure: 0, cancelled: 0, inProgress: 0, totalDuration: 0 });

    const avgDuration = stats.total ? formatDuration(stats.totalDuration / stats.total) : '0s';
    const successRate = stats.total ? ((stats.success / stats.total) * 100).toFixed(1) : 0;

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📊 Workflow Statistics')
      .setDescription(`Last ${days} days`)
      .addFields(
        { name: 'Total', value: `${stats.total}`, inline: true },
        { name: 'Success', value: `${stats.success} (${successRate}%)`, inline: true },
        { name: 'Failed', value: `${stats.failure}`, inline: true },
        { name: 'Avg Duration', value: avgDuration, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (e) { handleGitHubError(e, interaction); }
};

const handleArtifacts = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  const runId = interaction.options.getString('run_id');
  try {
    let targetRunId = runId;
    if (!targetRunId) {
      const { data } = await octokit.actions.listWorkflowRuns({ owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: 1 });
      if (data.workflow_runs[0]) targetRunId = data.workflow_runs[0].id;
    }
    if (!targetRunId) return interaction.editReply('❌ No runs found');

    const { data } = await octokit.actions.listWorkflowRunArtifacts({ owner: config.repo.owner, repo: config.repo.name, run_id: targetRunId });
    
    if (!data.artifacts.length) return interaction.editReply('📭 No artifacts found for this run.');

    const list = data.artifacts.map(a => `**${a.name}**\n📦 ${formatBytes(a.size_in_bytes)} • ${a.expired ? 'Expired' : 'Available'}`).join('\n\n');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`📦 Artifacts (Run #${targetRunId})`).setDescription(list).setFooter({ text: 'Download via GitHub Actions' });
    
    await interaction.editReply({ embeds: [embed] });
  } catch (e) { handleGitHubError(e, interaction); }
};

const handleLogs = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  const runId = interaction.options.getString('run_id');
  try {
    let run;
    if (runId) {
      const { data } = await octokit.actions.getWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
      run = data;
    } else {
      const { data } = await octokit.actions.listWorkflowRuns({ owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: 1 });
      run = data.workflow_runs[0];
    }

    if (!run) return interaction.editReply('❌ No runs found');

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(`📋 Logs: Run #${run.run_number}`)
      .setDescription(`[Click here to view full logs on GitHub](${run.html_url})`)
      .addFields(
        { name: 'Status', value: run.status, inline: true },
        { name: 'Conclusion', value: run.conclusion || 'Running', inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [createButtons(run.id, run.html_url, false)] });
  } catch (e) { handleGitHubError(e, interaction); }
};

const handleCancel = async (interaction) => {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);
  const octokit = getOctokit(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  let runId = interaction.options.getString('run_id');
  try {
    if (!runId) {
      const { data } = await octokit.actions.listWorkflowRuns({ owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, status: 'in_progress' });
      if (data.workflow_runs[0]) runId = data.workflow_runs[0].id;
    }
    
    if (!runId) return interaction.editReply('❌ No active runs to cancel');

    await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
    
    const embed = new EmbedBuilder().setColor(COLORS.cancelled).setTitle('🚫 Workflow Cancelled').setDescription(`Run #${runId} has been cancelled.`).addFields({ name: 'By', value: interaction.user.tag });
    await interaction.editReply({ embeds: [embed] });
    sendLog(serverName, `🚫 Run #${runId} cancelled by ${interaction.user.tag}`);
  } catch (e) { handleGitHubError(e, interaction); }
};

const handleCleanup = async (interaction) => {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const type = interaction.options.getString('type');
    if (type === 'global' || type === 'all') await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    if (type === 'guild' || type === 'all') await rest.put(Routes.applicationGuildCommands(client.user.id, interaction.guildId), { body: [] });
    
    await interaction.editReply('✅ Commands cleaned up. Restart bot to apply changes.');
  } catch (e) { await interaction.editReply(`Error: ${e.message}`); }
};

const handleHelp = async (interaction) => {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Command Help')
    .addFields(
      { name: '/build', value: 'Trigger a new build. Supports auto-complete for branches.' },
      { name: '/workflow-status', value: 'View latest build status with live refresh.' },
      { name: '/config', value: 'Open the Dashboard to configure the bot.' },
      { name: '/build-logs', value: 'Get direct link to build logs.' },
      { name: '/list-artifacts', value: 'List downloadable files (APK, etc).' },
      { name: '/workflow-history', value: 'View success/failure rates.' },
      { name: '/cancel-workflow', value: 'Stop a running build.' }
    )
    .setFooter({ text: 'Dartotsu Bot' });
  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
};

const checkPermissions = async (interaction) => {
  const config = getServerConfig(interaction.guild.name);
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!config.features.requirePermissions) return true;
  if (config.discord.allowedRoleIds.length > 0 && interaction.member.roles.cache.some(r => config.discord.allowedRoleIds.includes(r.id))) return true;
  await interaction.reply({ content: '❌ Permission Denied', flags: [MessageFlags.Ephemeral] });
  return false;
};

// --- 8. Event Loop & Interactions ---
const commands = [
  { name: 'build', description: 'Trigger build', options: [
      { name: 'platform', description: 'Platform', type: 3, required: true, choices: [{name:'All',value:'all'},{name:'Android',value:'android'},{name:'Windows',value:'windows'},{name:'Linux',value:'linux'},{name:'iOS',value:'ios'},{name:'macOS',value:'macos'}] },
      { name: 'branch', description: 'Branch', type: 3, autocomplete: true },
      { name: 'clean_build', description: 'Clean build?', type: 5 },
      { name: 'ping_discord', description: 'Ping?', type: 5 }
    ]},
  { name: 'config', description: 'Configure Bot', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { name: 'workflow-status', description: 'Check Status', options: [{ name: 'limit', description: 'Limit', type: 4 }, { name: 'auto_refresh', description: 'Auto Refresh', type: 5 }] },
  { name: 'build-logs', description: 'View logs', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'list-artifacts', description: 'List artifacts', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'workflow-history', description: 'View history', options: [{ name: 'days', description: 'Days', type: 4 }] },
  { name: 'cancel-workflow', description: 'Cancel run', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'cleanup-commands', description: 'Reset commands', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [{name: 'type', description: 'Type', type: 3, required: true, choices: [{name:'Global',value:'global'},{name:'Guild',value:'guild'},{name:'All',value:'all'}]}] },
  { name: 'bot-info', description: 'Bot Info' },
  { name: 'help', description: 'Help' }
];

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log(`✅ Bot Active as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return interaction.reply('❌ DM not supported');
  const serverName = interaction.guild.name;
  const config = getServerConfig(serverName);

  // Autocomplete
  if (interaction.isAutocomplete() && interaction.commandName === 'build') {
    const octokit = getOctokit(serverName);
    if (!octokit || !config.repo.owner) return interaction.respond([]);
    const now = Date.now();
    const serverCache = cache.branches.get(serverName) || { data: [], time: 0 };
    if (now - serverCache.time > 60000) { 
      try {
        const { data } = await octokit.repos.listBranches({ owner: config.repo.owner, repo: config.repo.name, per_page: 30 });
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

  // Commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'config') return interaction.reply({ embeds: [getConfigEmbed(serverName)], components: getConfigComponents(), flags: [MessageFlags.Ephemeral] });
    if (interaction.commandName === 'cleanup-commands') return handleCleanup(interaction);
    
    if (!await checkPermissions(interaction)) return;

    const handlers = {
      'build': handleBuild,
      'workflow-status': handleStatus,
      'build-logs': handleLogs,
      'list-artifacts': handleArtifacts,
      'workflow-history': handleHistory,
      'cancel-workflow': handleCancel,
      'bot-info': handleBotInfo,
      'help': handleHelp
    };

    if (handlers[interaction.commandName]) await handlers[interaction.commandName](interaction);
  }

  // UI Handlers
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
        const { data } = await octokit.actions.getWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
        const showCancel = data.status === 'in_progress' || data.status === 'queued';
        // Re-create the specific embed from handleStatus
        const icon = data.conclusion ? EMOJI.conclusion[data.conclusion] : EMOJI.status[data.status];
        const embed = new EmbedBuilder()
          .setColor(data.conclusion === 'success' ? COLORS.success : data.conclusion === 'failure' ? COLORS.failure : COLORS.in_progress)
          .setTitle('📊 Workflow Status')
          .setDescription(`**${data.display_title}**`)
          .addFields(
            { name: 'Status', value: `${icon} ${data.status.toUpperCase()}`, inline: true },
            { name: 'Conclusion', value: data.conclusion || 'Running', inline: true }
          )
          .setURL(data.html_url)
          .setTimestamp();
        await interaction.update({ embeds: [embed], components: [createButtons(data.id, data.html_url, showCancel)] });
      } catch(e) {}
    }
    if (interaction.customId.startsWith('cancel_')) {
       await handleCancel(interaction);
    }
  }
});

client.on('error', error => console.error(`Client Error: ${error.message}`));
process.on('unhandledRejection', error => console.error(`Unhandled Rejection: ${error.message}`));

// --- 9. Startup ---
const startBot = async () => {
  const dbConnected = await pool.connect().catch(() => null);
  if (!dbConnected) {
    console.error('❌ Failed to connect to PostgreSQL database');
    process.exit(1);
  }
  dbConnected.release();
  
  await initDatabase();
  await loadConfigsFromDB();
  
  if (!process.env.DISCORD_TOKEN) { console.error('❌ Discord Token missing'); process.exit(1); }
  
  client.login(process.env.DISCORD_TOKEN).catch(error => { 
    console.error(`Login failed: ${error.message}`); 
    process.exit(1); 
  });
};

startBot();
