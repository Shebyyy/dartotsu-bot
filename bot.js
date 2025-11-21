// Dartotsu Discord Bot - Enhanced Dashboard Edition

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
const crypto = require('crypto'); // Added for encryption

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const octokit = new Octokit({ request: { fetch: require('node-fetch') } });

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
  } catch (e) { console.error('Encryption error:', e); return text; }
};

const decrypt = (text) => {
  if (!text) return null;
  try {
    const textParts = text.split(':');
    if (textParts.length < 2) return text; // Return raw if not encrypted
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) { return null; }
};

// ================================
// POSTGRESQL DATABASE SYSTEM (RAILWAY READY)
// ================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/botdb',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let botConfig = {
  githubToken: process.env.GITHUB_TOKEN || null,
  guildId: process.env.GUILD_ID || null,
  repo: { owner: null, name: null, workflowFile: null, branch: 'main' },
  discord: {
    allowedRoleIds: [],
    logChannelId: null
  },
  features: {
    requirePermissions: false,
    enableLogging: false,
    autoRefreshStatus: false,
    refreshInterval: 30000
  }
};

// Database functions (Preserved your structure)
const initDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$       BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);
    
    await pool.query(`
      DROP TRIGGER IF EXISTS update_config_updated_at ON config
    `);
    
    await pool.query(`
      CREATE TRIGGER update_config_updated_at
        BEFORE UPDATE ON config
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);
    
    log('PostgreSQL database initialized', 'INFO');
  } catch (error) {
    log(`Database init error: ${error.message}`, 'ERROR');
  }
};

const loadConfigFromDB = async () => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM config");
    
    rows.forEach(row => {
      switch(row.key) {
        case 'githubToken': botConfig.githubToken = decrypt(row.value); break; // Decrypting
        case 'guildId': botConfig.guildId = row.value; break;
        case 'repoOwner': botConfig.repo.owner = row.value; break;
        case 'repoName': botConfig.repo.name = row.value; break;
        case 'workflowFile': botConfig.repo.workflowFile = row.value; break;
        case 'branch': botConfig.repo.branch = row.value; break;
        case 'allowedRoles': 
          try {
            botConfig.discord.allowedRoleIds = row.value ? JSON.parse(row.value) : [];
          } catch (e) {
            botConfig.discord.allowedRoleIds = [];
          }
          break;
        case 'logChannelId': botConfig.discord.logChannelId = row.value; break;
        case 'requirePermissions': botConfig.features.requirePermissions = row.value === 'true'; break;
        case 'enableLogging': botConfig.features.enableLogging = row.value === 'true'; break;
        case 'autoRefreshStatus': botConfig.features.autoRefreshStatus = row.value === 'true'; break;
        case 'refreshInterval': botConfig.features.refreshInterval = parseInt(row.value) || 30000; break;
      }
    });
    
    updateGitHubToken(); // Ensure token is applied to octokit
    log('Configuration loaded from PostgreSQL', 'INFO');
  } catch (error) {
    log(`Database load error: ${error.message}`, 'ERROR');
  }
};

const saveConfigToDB = async (key, value) => {
  try {
    await pool.query(
      "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP",
      [key, value]
    );
  } catch (error) {
    log(`Save config error for ${key}: ${error.message}`, 'ERROR');
    throw error;
  }
};

const resetConfigInDB = async () => {
  try {
    await pool.query("DELETE FROM config");
    log('PostgreSQL database cleared', 'INFO');
  } catch (error) {
    log(`Database reset error: ${error.message}`, 'ERROR');
    throw error;
  }
};

const getConfig = () => botConfig;

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

const updateGitHubToken = () => {
  if (botConfig.githubToken) {
    octokit.auth = botConfig.githubToken;
    log('GitHub token updated', 'INFO');
  } else {
    log('No GitHub token configured', 'WARN');
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

const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, queued: 0x808080, info: 0x5865F2, dark: 0x2C3E50 };

// Autocomplete Cache
const cache = { branches: [], lastFetch: 0 };

// ================================
// NEW DASHBOARD UI SYSTEM
// ================================

const getConfigEmbed = (config) => {
  const isTokenSet = !!config.githubToken;
  const isRepoSet = !!(config.repo.owner && config.repo.name);

  return new EmbedBuilder()
    .setColor(COLORS.dark)
    .setTitle('⚙️ Bot Configuration Dashboard')
    .setDescription('Select a category from the dropdown below to configure the bot.')
    .addFields(
      { 
        name: '🐙 GitHub Connection', 
        value: `**Status:** ${isTokenSet ? '✅ Token Set' : '❌ No Token'}\n**Repo:** ${isRepoSet ? `${config.repo.owner}/${config.repo.name}` : '❌ Not Set'}\n**Workflow:** \`${config.repo.workflowFile || 'None'}\`\n**Default Branch:** \`${config.repo.branch || 'None'}\``, 
        inline: true 
      },
      { 
        name: '💬 Discord Settings', 
        value: `**Guild:** ${config.guildId || 'Global'}\n**Log Channel:** ${config.discord.logChannelId ? `<#${config.discord.logChannelId}>` : 'None'}\n**Allowed Roles:** ${config.discord.allowedRoleIds.length > 0 ? `${config.discord.allowedRoleIds.length} roles` : 'Everyone'}`, 
        inline: true 
      },
      { 
        name: '🎛️ Feature Toggles', 
        value: `**Require Perms:** ${config.features.requirePermissions ? '✅ Yes' : '❌ No'}\n**File Logging:** ${config.features.enableLogging ? '✅ Yes' : '❌ No'}\n**Auto-Refresh:** ${config.features.autoRefreshStatus ? '✅ Yes' : '❌ No'}`, 
        inline: false 
      }
    )
    .setFooter({ text: '🔒 GitHub Token is encrypted in PostgreSQL' })
    .setTimestamp();
};

const getConfigComponents = (config) => {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('config_menu')
    .setPlaceholder('Select a category to configure...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('GitHub Settings').setValue('cfg_github').setEmoji('🐙').setDescription('Token, Repo, Workflow, Branch'),
      new StringSelectMenuOptionBuilder().setLabel('Discord Settings').setValue('cfg_discord').setEmoji('💬').setDescription('Channels, Roles, Guild ID'),
      new StringSelectMenuOptionBuilder().setLabel('Feature Toggles').setValue('cfg_features').setEmoji('🎛️').setDescription('Permissions, Refresh rates')
    );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
    new ButtonBuilder().setCustomId('cfg_test').setLabel('Test Connection').setStyle(ButtonStyle.Primary).setEmoji('📡'),
    new ButtonBuilder().setCustomId('cfg_reset').setLabel('Reset Config').setStyle(ButtonStyle.Danger)
  );

  return [new ActionRowBuilder().addComponents(selectMenu), actionRow];
};

// ================================
// COMMANDS
// ================================
const commands = [
  {
    name: 'build',
    description: 'Trigger Dartotsu build workflow',
    options: [
      { name: 'platform', description: 'Platform to build', type: 3, required: true, choices: [
        { name: '🌐 All', value: 'all' }, { name: '🤖 Android', value: 'android' }, 
        { name: '🪟 Windows', value: 'windows' }, { name: '🐧 Linux', value: 'linux' }, 
        { name: '🍎 iOS', value: 'ios' }, { name: '💻 macOS', value: 'macos' }
      ]},
      { name: 'branch', description: 'Branch to build from (Auto-complete)', type: 3, required: false, autocomplete: true },
      { name: 'clean_build', description: 'Clean build?', type: 5, required: false },
      { name: 'ping_discord', description: 'Ping on completion?', type: 5, required: false }
    ]
  },
  {
    name: 'workflow-status',
    description: 'Check workflow status',
    options: [
      { name: 'limit', description: 'Recent runs (1-10)', type: 4, required: false, min_value: 1, max_value: 10 },
      { name: 'auto_refresh', description: 'Auto-refresh?', type: 5, required: false }
    ]
  },
  { name: 'cancel-workflow', description: 'Cancel workflow', options: [{ name: 'run_id', description: 'Run ID', type: 3, required: false }] },
  { name: 'build-logs', description: 'View logs', options: [{ name: 'run_id', description: 'Run ID', type: 3, required: false }] },
  { name: 'list-artifacts', description: 'List artifacts', options: [{ name: 'run_id', description: 'Run ID', type: 3, required: false }] },
  { name: 'workflow-history', description: 'View statistics', options: [{ name: 'days', description: 'Days (1-30)', type: 4, required: false, min_value: 1, max_value: 30 }] },
  { name: 'bot-info', description: 'Bot information' },
  { name: 'help', description: 'Command help' },
  {
    name: 'config',
    description: 'Open Bot Configuration Dashboard',
    default_member_permissions: PermissionFlagsBits.Administrator.toString()
  },
  {
    name: 'cleanup-commands',
    description: 'Clean up duplicate bot commands (Admin only)',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      {
        name: 'type',
        description: 'Type of commands to clean',
        type: 3,
        required: true,
        choices: [
          { name: '🌐 Global Commands', value: 'global' },
          { name: '🏠 Guild Commands', value: 'guild' },
          { name: '🧹 All Commands', value: 'all' }
        ]
      }
    ]
  }
];

// ================================
// UTILITY FUNCTIONS
// ================================
const log = (msg, level = 'INFO') => {
  const logMsg = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(logMsg);
  const config = getConfig();
  if (config.features.enableLogging) {
    try {
      const fs = require('fs');
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
      fs.appendFileSync(path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`), logMsg + '\n');
    } catch (e) { console.error(`Log error: ${e.message}`); }
  }
};

const checkPermissions = async (interaction) => {
  const config = getConfig();
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
      !config.features.requirePermissions || 
      config.discord.allowedRoleIds.length === 0 ||
      interaction.member.roles.cache.some(role => config.discord.allowedRoleIds.includes(role.id))) return true;
  await interaction.reply({ content: '❌ No permission', flags: [MessageFlags.Ephemeral] });
  return false;
};

const sendLog = async (msg, embed = null) => {
  const config = getConfig();
  if (!config.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.discord.logChannelId);
    if (channel?.isTextBased()) await channel.send(embed ? { content: msg, embeds: [embed] } : msg);
  } catch (e) { log(`Log send error: ${e.message}`, 'ERROR'); }
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

const getLatestRun = async (runId = null, status = null) => {
  const config = getConfig();
  if (!config.repo.owner || !config.repo.name || !config.repo.workflowFile) return null;
  
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

const cleanupCommands = async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const config = getConfig();
  try {
    log('🧹 Cleaning up existing commands...', 'INFO');
    if (config.guildId) {
      await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    } else {
      const guilds = client.guilds.cache;
      for (const [guildId] of guilds) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] });
      }
    }
  } catch (error) { log(`Cleanup error: ${error.message}`, 'ERROR'); }
};

const handleGitHubError = (error, interaction) => {
  log(`GitHub API error: ${error.message}`, 'ERROR');
  const errorEmbed = new EmbedBuilder()
    .setColor(COLORS.failure)
    .setTitle('❌ GitHub API Error')
    .setDescription(error.message)
    .setFooter({ text: 'Check your /config settings' });
  
  if (interaction.replied || interaction.deferred) return interaction.editReply({ embeds: [errorEmbed] });
  return interaction.reply({ embeds: [errorEmbed], flags: [MessageFlags.Ephemeral] });
};

// ================================
// COMMAND HANDLERS
// ================================
const handleBuild = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  if (!config.githubToken || !config.repo.owner) {
    return await interaction.editReply({ 
      content: '❌ Bot not configured. Use `/config` to set it up', 
      flags: [MessageFlags.Ephemeral] 
    });
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
    const latestRun = await getLatestRun().catch(() => null);

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('✅ Build Triggered')
      .setDescription('Dartotsu build workflow started!')
      .addFields(
        { name: '🎯 Platform', value: `${EMOJI.platform[platform] || '📦'} **${platform.toUpperCase()}**`, inline: true },
        { name: '🧹 Clean', value: cleanBuild ? '✅' : '❌', inline: true },
        { name: '🔔 Ping', value: pingDiscord ? '✅' : '❌', inline: true },
        { name: '👤 By', value: interaction.user.tag, inline: true },
        { name: '🌿 Branch', value: `\`${branch}\``, inline: true },
        { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
      )
      .setURL(`https://github.com/${config.repo.owner}/${config.repo.name}/actions/workflows/${config.repo.workflowFile}`)
      .setFooter({ text: 'Use /workflow-status to track', iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    const components = latestRun ? [createButtons(latestRun.id, latestRun.html_url, true)] : [];
    await interaction.editReply({ embeds: [embed], components });
    log(`Build: ${platform} by ${interaction.user.tag}`, 'INFO');
    await sendLog(`🚀 Build by ${interaction.user.tag}`, embed);
  } catch (error) {
    return handleGitHubError(error, interaction);
  }
};

const handleStatus = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  if (!config.githubToken) return interaction.editReply('❌ GitHub Token not configured.');

  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? config.features.autoRefreshStatus;

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: limit
    });
    
    if (!runs.workflow_runs.length) return interaction.editReply('📭 No workflows found');

    const latestRun = runs.workflow_runs[0];
    const embed = createRunEmbed(latestRun, '📊 Latest Workflow Status');
    
    if (autoRefresh) embed.setFooter({ text: '🔄 Auto-refresh active' });
    
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
          const run = await getLatestRun(latestRun.id);
          if (run.status === 'completed') {
            await interaction.followUp({ content: `✅ Run #${run.run_number} finished: **${run.conclusion}**`, flags: [MessageFlags.Ephemeral] });
          }
        } catch (e) { log(`Auto-refresh error: ${e.message}`, 'ERROR'); }
      }, config.features.refreshInterval);
    }
  } catch (error) { return handleGitHubError(error, interaction); }
};

const handleCancel = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  if (!config.githubToken) return interaction.editReply('❌ GitHub Token not configured.');
  
  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const run = await getLatestRun(null, 'in_progress');
      if (!run) return interaction.editReply('❌ No running workflows');
      runId = run.id;
    }

    await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
    await interaction.editReply({ content: `✅ Cancel signal sent to run #${runId}` });
    log(`Cancelled ${runId} by ${interaction.user.tag}`, 'INFO');
  } catch (error) { return handleGitHubError(error, interaction); }
};

const handleLogs = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  if (!config.githubToken) return interaction.editReply('❌ GitHub Token not configured.');
  
  let runId = interaction.options.getString('run_id');

  try {
    const run = runId ? await getLatestRun(runId) : await getLatestRun();
    if (!run) return interaction.editReply('❌ No workflows found');

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📋 Workflow Logs')
      .setDescription(`Logs for run #${run.run_number}`)
      .addFields(
        { name: '🔗 Full Logs', value: `[GitHub](${run.html_url})`, inline: false },
        { name: '📍 Status', value: run.status, inline: true },
        { name: '🎯 Conclusion', value: run.conclusion || 'Running', inline: true },
        { name: '🌿 Branch', value: run.head_branch, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [createButtons(run.id, run.html_url, false)] });
  } catch (error) { return handleGitHubError(error, interaction); }
};

const handleArtifacts = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  if (!config.githubToken) return interaction.editReply('❌ GitHub Token not configured.');
  
  let runId = interaction.options.getString('run_id');

  try {
    const run = runId ? await getLatestRun(runId) : await getLatestRun();
    if (!run) return interaction.editReply('❌ No workflows found');

    const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
      owner: config.repo.owner, repo: config.repo.name, run_id: run.id
    });

    if (!artifacts.artifacts.length) return interaction.editReply('📭 No artifacts found');

    const list = artifacts.artifacts.map(a => 
      `**${a.name}**\n├ Size: ${formatBytes(a.size_in_bytes)}\n├ ${a.expired ? '❌ Expired' : '✅ Available'}\n└ <t:${Math.floor(new Date(a.created_at).getTime() / 1000)}:R>`
    ).join('\n\n');

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📦 Build Artifacts')
      .setDescription(`${artifacts.artifacts.length} artifact(s) for run #${run.id}`)
      .addFields({ name: 'Artifacts', value: list })
      .setFooter({ text: 'Download from GitHub Actions' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) { return handleGitHubError(error, interaction); }
};

const handleHistory = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  if (!config.githubToken) return interaction.editReply('❌ GitHub Token not configured.');
  
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

    const successRate = stats.total ? ((stats.success / stats.total) * 100).toFixed(1) : 0;
    const avgDuration = stats.total ? formatDuration(stats.totalDuration / stats.total) : '0s';

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📊 Workflow Statistics')
      .setDescription(`Last ${days} day(s)`)
      .addFields(
        { name: '📈 Total', value: `${stats.total}`, inline: true },
        { name: '✅ Success', value: `${stats.success} (${successRate}%)`, inline: true },
        { name: '❌ Failed', value: `${stats.failure}`, inline: true },
        { name: '🚫 Cancelled', value: `${stats.cancelled}`, inline: true },
        { name: '🔄 Running', value: `${stats.inProgress}`, inline: true },
        { name: '⏱️ Avg', value: avgDuration, inline: true }
      )
      .setFooter({ text: `${runs.workflow_runs.length} runs` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) { return handleGitHubError(error, interaction); }
};

const handleBotInfo = async (interaction) => {
  const config = getConfig();
  const uptime = formatDuration(process.uptime() * 1000);
  const memory = formatBytes(process.memoryUsage().heapUsed);
  
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 Dartotsu Build Bot')
    .setDescription('GitHub Actions automation for Dartotsu')
    .addFields(
      { name: '📦 Repo', value: config.repo.owner && config.repo.name ? 
        `[${config.repo.owner}/${config.repo.name}](https://github.com/${config.repo.owner}/${config.repo.name})` : 'Not configured', inline: true },
      { name: '🔧 Workflow', value: config.repo.workflowFile || 'Not configured', inline: true },
      { name: '⏰ Uptime', value: uptime, inline: true },
      { name: '🌐 Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: '📊 Commands', value: `${commands.length}`, inline: true },
      { name: '💾 Memory', value: memory, inline: true },
      { name: '🔗 Version', value: '2.0.0 (Enhanced)', inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
};

const handleHelp = async (interaction) => {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Command Help')
    .setDescription('Available commands with examples')
    .addFields(
      { name: '🚀 /build', value: '`/build platform:android clean_build:true`\nTrigger builds', inline: false },
      { name: '📊 /workflow-status', value: '`/workflow-status limit:10`\nCheck status', inline: false },
      { name: '⚙️ /config', value: 'Open the configuration dashboard', inline: false }
    )
    .setFooter({ text: 'Most params are optional!' });

  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
};

const handleCleanup = async (interaction) => {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  await cleanupCommands();
  const embed = new EmbedBuilder().setColor(COLORS.success).setTitle('🧹 Commands Cleaned Up').setDescription('Commands have been reset. Restart bot to apply.');
  await interaction.editReply({ embeds: [embed] });
};

// ================================
// EVENT HANDLERS
// ================================
client.once('ready', async () => {
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    log('❌ Failed to connect to database', 'ERROR');
    return;
  }
  
  await initDatabase();
  await loadConfigFromDB();
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    // Clean up first
    await cleanupCommands();
    
    log('🔄 Registering commands...', 'INFO');
    const config = getConfig();
    const route = config.guildId 
      ? Routes.applicationGuildCommands(client.user.id, config.guildId)
      : Routes.applicationCommands(client.user.id);
    
    await rest.put(route, { body: commands });
    log(`✅ Registered ${commands.length} commands`, 'INFO');
    log(`🤖 Serving ${client.guilds.cache.size} server(s)`, 'INFO');
  } catch (error) {
    log(`❌ Command registration error: ${error.message}`, 'ERROR');
  }
});

client.on('interactionCreate', async (interaction) => {
  const config = getConfig();

  try {
    // --- AUTOCOMPLETE ---
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'build') {
        const focusedValue = interaction.options.getFocused();
        if (!config.githubToken || !config.repo.owner) return interaction.respond([]);

        if (Date.now() - cache.lastFetch > 60000) {
          try {
            const { data } = await octokit.repos.listBranches({ 
              owner: config.repo.owner, repo: config.repo.name, per_page: 30 
            });
            cache.branches = data.map(b => b.name);
            cache.lastFetch = Date.now();
          } catch (e) { /* ignore errors */ }
        }

        const filtered = cache.branches.filter(choice => choice.startsWith(focusedValue)).slice(0, 25);
        await interaction.respond(filtered.map(choice => ({ name: choice, value: choice })));
      }
      return;
    }

    // --- COMMANDS ---
    if (interaction.isChatInputCommand()) {
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
        'config': async (i) => i.reply({ embeds: [getConfigEmbed(config)], components: getConfigComponents(config), flags: [MessageFlags.Ephemeral] })
      };

      if (handlers[interaction.commandName]) await handlers[interaction.commandName](interaction);
      else await interaction.reply({ content: '❌ Unknown command', flags: [MessageFlags.Ephemeral] });
    } 
    
    // --- DASHBOARD: SELECT MENU ---
    else if (interaction.isStringSelectMenu() && interaction.customId === 'config_menu') {
      const selection = interaction.values[0];
      
      if (selection === 'cfg_github') {
        const modal = new ModalBuilder().setCustomId('modal_github').setTitle('GitHub Settings');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_token').setLabel('Access Token').setStyle(TextInputStyle.Short).setPlaceholder('Leave empty to keep current').setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_owner').setLabel('Repo Owner').setValue(config.repo.owner || '').setStyle(TextInputStyle.Short)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_name').setLabel('Repo Name').setValue(config.repo.name || '').setStyle(TextInputStyle.Short)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_workflow').setLabel('Workflow File').setValue(config.repo.workflowFile || '').setStyle(TextInputStyle.Short)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_branch').setLabel('Default Branch').setValue(config.repo.branch || 'main').setStyle(TextInputStyle.Short))
        );
        await interaction.showModal(modal);
      } 
      else if (selection === 'cfg_discord') {
        const modal = new ModalBuilder().setCustomId('modal_discord').setTitle('Discord Settings');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_guild').setLabel('Guild ID').setValue(config.guildId || '').setStyle(TextInputStyle.Short).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_log').setLabel('Log Channel ID').setValue(config.discord.logChannelId || '').setStyle(TextInputStyle.Short).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_roles').setLabel('Allowed Role IDs (comma separated)').setValue(config.discord.allowedRoleIds.join(', ')).setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
      }
      else if (selection === 'cfg_features') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tog_perms').setLabel(`Require Perms: ${config.features.requirePermissions}`).setStyle(config.features.requirePermissions ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('tog_logs').setLabel(`File Logging: ${config.features.enableLogging}`).setStyle(config.features.enableLogging ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('tog_auto').setLabel(`Auto Refresh: ${config.features.autoRefreshStatus}`).setStyle(config.features.autoRefreshStatus ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh UI').setStyle(ButtonStyle.Secondary)
        );
        await interaction.update({ content: '**Feature Toggles:** Click buttons to switch.', embeds: [], components: [row] });
      }
    }

    // --- DASHBOARD: MODALS ---
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_github') {
        const token = interaction.fields.getTextInputValue('inp_token');
        const owner = interaction.fields.getTextInputValue('inp_owner');
        const name = interaction.fields.getTextInputValue('inp_name');
        const workflow = interaction.fields.getTextInputValue('inp_workflow');
        const branch = interaction.fields.getTextInputValue('inp_branch');

        if (token) {
          botConfig.githubToken = token;
          await saveConfigToDB('githubToken', encrypt(token));
          updateGitHubToken();
        }
        botConfig.repo.owner = owner; await saveConfigToDB('repoOwner', owner);
        botConfig.repo.name = name; await saveConfigToDB('repoName', name);
        botConfig.repo.workflowFile = workflow; await saveConfigToDB('workflowFile', workflow);
        botConfig.repo.branch = branch; await saveConfigToDB('branch', branch);

        await interaction.update({ embeds: [getConfigEmbed(botConfig)], components: getConfigComponents(botConfig) });
        await sendLog(`⚙️ GitHub settings updated by ${interaction.user.tag}`);
      }
      else if (interaction.customId === 'modal_discord') {
        const guild = interaction.fields.getTextInputValue('inp_guild');
        const logId = interaction.fields.getTextInputValue('inp_log');
        const roles = interaction.fields.getTextInputValue('inp_roles');

        botConfig.guildId = guild; await saveConfigToDB('guildId', guild);
        botConfig.discord.logChannelId = logId; await saveConfigToDB('logChannelId', logId);
        
        const roleArr = roles.split(',').map(r => r.trim()).filter(r => /^\d+$/.test(r));
        botConfig.discord.allowedRoleIds = roleArr;
        await saveConfigToDB('allowedRoles', JSON.stringify(roleArr));

        await interaction.update({ embeds: [getConfigEmbed(botConfig)], components: getConfigComponents(botConfig) });
        await sendLog(`⚙️ Discord settings updated by ${interaction.user.tag}`);
      }
    }

    // --- BUTTONS ---
    else if (interaction.isButton()) {
      const id = interaction.customId;
      
      // Config Buttons
      if (id === 'cfg_refresh') {
        await interaction.update({ content: '', embeds: [getConfigEmbed(botConfig)], components: getConfigComponents(botConfig) });
      }
      else if (id === 'cfg_reset') {
        await resetConfigInDB();
        await interaction.reply({ content: '⚠️ Config reset to defaults.', flags: [MessageFlags.Ephemeral] });
      }
      else if (id === 'cfg_test') {
        await interaction.deferUpdate();
        try {
          const { data } = await octokit.users.getAuthenticated();
          await interaction.followUp({ content: `✅ **Success!** Connected as \`${data.login}\``, flags: [MessageFlags.Ephemeral] });
        } catch (e) {
          await interaction.followUp({ content: `❌ **Failed:** ${e.message}`, flags: [MessageFlags.Ephemeral] });
        }
      }
      // Feature Toggles
      else if (id.startsWith('tog_')) {
        if (id === 'tog_perms') {
          botConfig.features.requirePermissions = !botConfig.features.requirePermissions;
          await saveConfigToDB('requirePermissions', botConfig.features.requirePermissions.toString());
        } else if (id === 'tog_logs') {
          botConfig.features.enableLogging = !botConfig.features.enableLogging;
          await saveConfigToDB('enableLogging', botConfig.features.enableLogging.toString());
        } else if (id === 'tog_auto') {
          botConfig.features.autoRefreshStatus = !botConfig.features.autoRefreshStatus;
          await saveConfigToDB('autoRefreshStatus', botConfig.features.autoRefreshStatus.toString());
        }
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tog_perms').setLabel(`Require Perms: ${botConfig.features.requirePermissions}`).setStyle(botConfig.features.requirePermissions ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('tog_logs').setLabel(`File Logging: ${botConfig.features.enableLogging}`).setStyle(botConfig.features.enableLogging ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('tog_auto').setLabel(`Auto Refresh: ${botConfig.features.autoRefreshStatus}`).setStyle(botConfig.features.autoRefreshStatus ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('cfg_refresh').setLabel('Refresh UI').setStyle(ButtonStyle.Secondary)
        );
        await interaction.update({ components: [row] });
      }
      // Workflow Buttons (Refresh/Cancel)
      else if (id.startsWith('cancel_') || id.startsWith('refresh_')) {
        await handleButton(interaction); // Reuse your existing button handler
      }
    }

  } catch (error) {
    log(`Interaction error: ${error.message}`, 'ERROR');
    try {
      if (interaction.deferred) await interaction.editReply('❌ Error occurred.');
      else if (!interaction.replied) await interaction.reply({ content: '❌ Error occurred.', flags: [MessageFlags.Ephemeral] });
    } catch (e) {}
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

const startBot = async () => {
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('❌ Failed to connect to PostgreSQL database');
    process.exit(1);
  }
  await initDatabase();
  await loadConfigFromDB();
  updateGitHubToken();
  if (!process.env.DISCORD_TOKEN) { 
    console.error('❌ Discord Token not configured.');
    process.exit(1); 
  }
  client.login(process.env.DISCORD_TOKEN);
};

startBot();
