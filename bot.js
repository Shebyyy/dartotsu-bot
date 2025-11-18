// Dartotsu Discord Bot
// Repository: https://github.com/Shebyyy/Dartotsu

// Polyfill ReadableStream
if (typeof ReadableStream === 'undefined') {
  try {
    ReadableStream = require('stream/web').ReadableStream;
  } catch (e) {
    const { Readable } = require('stream');
    ReadableStream = class extends Readable {
      constructor(options = {}) {
        super(options);
        this._controller = {
          enqueue: (chunk) => this.push(chunk),
          close: () => this.push(null),
          error: (e) => this.destroy(e)
        };
      }
    };
  }
}

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const { Pool } = require('pg');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { fetch: require('node-fetch') } });

// ================================
// POSTGRESQL DATABASE SYSTEM (RAILWAY READY)
// ================================

// Railway PostgreSQL connection with fallback for local development
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/botdb',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 2000, // How long to wait when connecting a new client
});

// Configuration stored in database
let botConfig = {
  githubToken: process.env.GITHUB_TOKEN || null,
  discordToken: process.env.DISCORD_TOKEN || null,
  guildId: process.env.GUILD_ID || null,
  repo: { owner: null, name: null, workflowFile: null, branch: null },
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

// Database functions
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
    
    // Create trigger for updated_at
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
        case 'githubToken': botConfig.githubToken = row.value; break;
        case 'discordToken': botConfig.discordToken = row.value; break;
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
            log(`Error parsing allowedRoles: ${e.message}`, 'ERROR');
          }
          break;
        case 'logChannelId': botConfig.discord.logChannelId = row.value; break;
        case 'requirePermissions': botConfig.features.requirePermissions = row.value === 'true'; break;
        case 'enableLogging': botConfig.features.enableLogging = row.value === 'true'; break;
        case 'autoRefreshStatus': botConfig.features.autoRefreshStatus = row.value === 'true'; break;
        case 'refreshInterval': botConfig.features.refreshInterval = parseInt(row.value) || 30000; break;
      }
    });
    
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

const saveAllConfigToDB = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await saveConfigToDB('githubToken', botConfig.githubToken || '');
    await saveConfigToDB('discordToken', botConfig.discordToken || '');
    await saveConfigToDB('guildId', botConfig.guildId || '');
    await saveConfigToDB('repoOwner', botConfig.repo.owner || '');
    await saveConfigToDB('repoName', botConfig.repo.name || '');
    await saveConfigToDB('workflowFile', botConfig.repo.workflowFile || '');
    await saveConfigToDB('branch', botConfig.repo.branch || '');
    await saveConfigToDB('allowedRoles', JSON.stringify(botConfig.discord.allowedRoleIds));
    await saveConfigToDB('logChannelId', botConfig.discord.logChannelId || '');
    await saveConfigToDB('requirePermissions', botConfig.features.requirePermissions.toString());
    await saveConfigToDB('enableLogging', botConfig.features.enableLogging.toString());
    await saveConfigToDB('autoRefreshStatus', botConfig.features.autoRefreshStatus.toString());
    await saveConfigToDB('refreshInterval', botConfig.features.refreshInterval.toString());
    
    await client.query('COMMIT');
    log('Configuration saved to PostgreSQL', 'INFO');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    log(`Failed to save configuration: ${error.message}`, 'ERROR');
    return false;
  } finally {
    client.release();
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

// Test database connection
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

const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, queued: 0x808080, info: 0x5865F2 };

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
    description: 'Manage bot configuration',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      { name: 'action', description: 'Configuration action', type: 3, required: true, choices: [
        { name: '👁️ View Current', value: 'view' },
        { name: '⚙️ Configure', value: 'configure' },
        { name: '🔄 Reset All', value: 'reset' }
      ]}
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
  await interaction.reply({ content: '❌ No permission', ephemeral: true });
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

// Create configuration modal
const createConfigModal = (currentConfig) => {
  const modal = new ModalBuilder()
    .setCustomId('configModal')
    .setTitle('🔧 Complete Bot Configuration');

  // GitHub Configuration
  const githubToken = new TextInputBuilder()
    .setCustomId('githubToken')
    .setLabel('GitHub Token (⚠️ Sensitive)')
    .setPlaceholder('ghp_xxxxxxxxxxxxxxxxxxxx')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.githubToken || '');

  const repoOwner = new TextInputBuilder()
    .setCustomId('repoOwner')
    .setLabel('GitHub Repository Owner')
    .setPlaceholder('e.g., Shebyyy')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.repo?.owner || '');

  const repoName = new TextInputBuilder()
    .setCustomId('repoName')
    .setLabel('GitHub Repository Name')
    .setPlaceholder('e.g., Dartotsu')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.repo?.name || '');

  const workflowFile = new TextInputBuilder()
    .setCustomId('workflowFile')
    .setLabel('Workflow File Name')
    .setPlaceholder('e.g., dart.yml')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.repo?.workflowFile || '');

  const branch = new TextInputBuilder()
    .setCustomId('branch')
    .setLabel('Default Branch')
    .setPlaceholder('e.g., main')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.repo?.branch || '');

  // Discord Configuration
  const discordToken = new TextInputBuilder()
    .setCustomId('discordToken')
    .setLabel('Discord Bot Token (⚠️ Sensitive)')
    .setPlaceholder('MTAxNzE5MjM4MzU2MjY3NjY4NA.G...')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.discordToken || '');

  const guildId = new TextInputBuilder()
    .setCustomId('guildId')
    .setLabel('Server ID (Optional - for guild commands)')
    .setPlaceholder('e.g., 123456789012345678')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.guildId || '');

  const allowedRoles = new TextInputBuilder()
    .setCustomId('allowedRoles')
    .setLabel('Allowed Role IDs (comma-separated)')
    .setPlaceholder('e.g., 123456789,987654321 or @Role1,@Role2')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.discord?.allowedRoleIds?.join(',') || '');

  const logChannel = new TextInputBuilder()
    .setCustomId('logChannel')
    .setLabel('Log Channel ID or #channel')
    .setPlaceholder('e.g., #bot-logs or 123456789')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.discord?.logChannelId || '');

  // Feature Toggles
  const requirePermissions = new TextInputBuilder()
    .setCustomId('requirePermissions')
    .setLabel('Require Permissions? (true/false)')
    .setPlaceholder('true or false')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.features?.requirePermissions?.toString() || 'false');

  const enableLogging = new TextInputBuilder()
    .setCustomId('enableLogging')
    .setLabel('Enable File Logging? (true/false)')
    .setPlaceholder('true or false')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.features?.enableLogging?.toString() || 'false');

  const autoRefresh = new TextInputBuilder()
    .setCustomId('autoRefresh')
    .setLabel('Auto-Refresh Status? (true/false)')
    .setPlaceholder('true or false')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.features?.autoRefreshStatus?.toString() || 'false');

  const refreshInterval = new TextInputBuilder()
    .setCustomId('refreshInterval')
    .setLabel('Refresh Interval (milliseconds)')
    .setPlaceholder('e.g., 30000 (30 seconds)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(currentConfig.features?.refreshInterval?.toString() || '30000');

  // Add all components to modal
  modal.addComponents(
    new ActionRowBuilder().addComponents(githubToken),
    new ActionRowBuilder().addComponents(discordToken),
    new ActionRowBuilder().addComponents(repoOwner),
    new ActionRowBuilder().addComponents(repoName),
    new ActionRowBuilder().addComponents(workflowFile),
    new ActionRowBuilder().addComponents(branch),
    new ActionRowBuilder().addComponents(guildId),
    new ActionRowBuilder().addComponents(allowedRoles),
    new ActionRowBuilder().addComponents(logChannel),
    new ActionRowBuilder().addComponents(requirePermissions),
    new ActionRowBuilder().addComponents(enableLogging),
    new ActionRowBuilder().addComponents(autoRefresh),
    new ActionRowBuilder().addComponents(refreshInterval)
  );

  return modal;
};

// ================================
// COMMAND HANDLERS
// ================================
const handleBuild = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  // Check if repository is configured
  if (!config.repo.owner || !config.repo.name || !config.repo.workflowFile || !config.repo.branch) {
    return await interaction.editReply({ 
      content: '❌ Repository not configured. Use `/config action:configure` to set it up', 
      ephemeral: true 
    });
  }
  
  const platform = interaction.options.getString('platform');
  const cleanBuild = interaction.options.getBoolean('clean_build') ?? false;
  const pingDiscord = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, ref: config.repo.branch,
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
        { name: '🌿 Branch', value: `\`${config.repo.branch}\``, inline: true },
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
    log(`Build error: ${error.message}`, 'ERROR');
    const errorEmbed = new EmbedBuilder()
      .setColor(COLORS.failure)
      .setTitle('❌ Build Failed')
      .setDescription('Failed to trigger workflow')
      .addFields(
        { name: '🐛 Error', value: `\`\`\`${error.message}\`\`\`` },
        { name: '💡 Causes', value: '• Invalid token\n• Workflow not found\n• Permissions\n• Rate limit' }
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [errorEmbed] });
  }
};

const handleStatus = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  // Check if repository is configured
  if (!config.repo.owner || !config.repo.name || !config.repo.workflowFile) {
    return await interaction.editReply({ 
      content: '❌ Repository not configured. Use `/config action:configure` to set it up', 
      ephemeral: true 
    });
  }
  
  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? false;

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: config.repo.owner, repo: config.repo.name, workflow_id: config.repo.workflowFile, per_page: limit
    });
    
    if (!runs.workflow_runs.length) return interaction.editReply('📭 No workflows found');

    const latestRun = runs.workflow_runs[0];
    const embed = createRunEmbed(latestRun, '📊 Latest Workflow Status');
    
    if (autoRefresh) embed.setFooter({ text: '🔄 Auto-refresh (30s)' });
    
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
            const completeEmbed = new EmbedBuilder()
              .setColor(run.conclusion === 'success' ? COLORS.success : COLORS.failure)
              .setTitle(`${EMOJI.conclusion[run.conclusion] || '✅'} Build ${run.conclusion === 'success' ? 'Success' : 'Failed'}`)
              .setDescription(`Run #${run.run_number} ${run.conclusion}`)
              .addFields(
                { name: '⏱️ Duration', value: formatDuration(new Date(run.updated_at) - new Date(run.created_at)), inline: true },
                { name: '🔗 View', value: `[GitHub](${run.html_url})`, inline: true }
              )
              .setTimestamp();
            await interaction.followUp({ embeds: [completeEmbed] });
          }
        } catch (e) { log(`Auto-refresh error: ${e.message}`, 'ERROR'); }
      }, config.features.refreshInterval);
    }
  } catch (error) {
    log(`Status error: ${error.message}`, 'ERROR');
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.failure).setTitle('❌ Status Error').setDescription(error.message).setTimestamp()] });
  }
};

const handleCancel = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  // Check if repository is configured
  if (!config.repo.owner || !config.repo.name) {
    return await interaction.editReply({ 
      content: '❌ Repository not configured. Use `/config action:configure` to set it up', 
      ephemeral: true 
    });
  }
  
  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const run = await getLatestRun(null, 'in_progress');
      if (!run) return interaction.editReply('❌ No running workflows');
      runId = run.id;
    }

    await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
    
    const embed = new EmbedBuilder()
      .setColor(COLORS.cancelled)
      .setTitle('🚫 Workflow Cancelled')
      .setDescription(`Run #${runId} cancelled`)
      .addFields(
        { name: '👤 By', value: interaction.user.tag, inline: true },
        { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
      )
      .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
    log(`Cancelled ${runId} by ${interaction.user.tag}`, 'INFO');
  } catch (error) {
    log(`Cancel error: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Cancel failed: ${error.message}`);
  }
};

const handleLogs = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  // Check if repository is configured
  if (!config.repo.owner || !config.repo.name) {
    return await interaction.editReply({ 
      content: '❌ Repository not configured. Use `/config action:configure` to set it up', 
      ephemeral: true 
    });
  }
  
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
  } catch (error) {
    log(`Logs error: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Logs failed: ${error.message}`);
  }
};

const handleArtifacts = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  // Check if repository is configured
  if (!config.repo.owner || !config.repo.name) {
    return await interaction.editReply({ 
      content: '❌ Repository not configured. Use `/config action:configure` to set it up', 
      ephemeral: true 
    });
  }
  
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
  } catch (error) {
    log(`Artifacts error: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Artifacts failed: ${error.message}`);
  }
};

const handleHistory = async (interaction) => {
  await interaction.deferReply();
  const config = getConfig();
  
  // Check if repository is configured
  if (!config.repo.owner || !config.repo.name || !config.repo.workflowFile) {
    return await interaction.editReply({ 
      content: '❌ Repository not configured. Use `/config action:configure` to set it up', 
      ephemeral: true 
    });
  }
  
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
        { name: '📈 Total', value: `${stats.total}`, inline: true },
        { name: '✅ Success', value: `${stats.success} (${successRate}%)`, inline: true },
        { name: '❌ Failed', value: `${stats.failure}`, inline: true },
        { name: '🚫 Cancelled', value: `${stats.cancelled}`, inline: true },
        { name: '🔄 Running', value: `${stats.inProgress}`, inline: true },
        { name: '⏱️ Avg', value: avgDuration, inline: true }
      )
      .setFooter({ text: `${runs.workflow_runs.length} runs` })
      .setTimestamp();

    const recent = runs.workflow_runs.slice(0, 10).map(r => {
      const icon = r.conclusion ? (EMOJI.conclusion[r.conclusion] || '❓') : (EMOJI.status[r.status] || '❓');
      return `${icon} [#${r.run_number}](${r.html_url}) - <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`;
    }).join('\n');
    embed.addFields({ name: '📋 Recent', value: recent });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`History error: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ History failed: ${error.message}`);
  }
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
      { name: '🔗 Version', value: '2.0.0', inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
      { name: '🟢 Status', value: 'Online', inline: true },
      { name: '🗄️ Database', value: 'PostgreSQL', inline: true },
      { name: '✨ Features', value: '• Buttons • Auto-refresh • Artifacts • Stats • Config', inline: false }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Repository').setStyle(ButtonStyle.Link).setURL(
      config.repo.owner && config.repo.name ? 
      `https://github.com/${config.repo.owner}/${config.repo.name}` : 
      'https://github.com/Shebyyy/Dartotsu'
    ).setEmoji('📦'),
    new ButtonBuilder().setLabel('Actions').setStyle(ButtonStyle.Link).setURL(
      config.repo.owner && config.repo.name ? 
      `https://github.com/${config.repo.owner}/${config.repo.name}/actions` : 
      'https://github.com/Shebyyy/Dartotsu/actions'
    ).setEmoji('⚡')
  );

  await interaction.reply({ embeds: [embed], components: [row] });
};

const handleHelp = async (interaction) => {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Command Help')
    .setDescription('Available commands with examples')
    .addFields(
      { name: '🚀 /build', value: '`/build platform:android clean_build:true`\nTrigger builds', inline: false },
      { name: '📊 /workflow-status', value: '`/workflow-status limit:10 auto_refresh:true`\nCheck status', inline: false },
      { name: '🚫 /cancel-workflow', value: '`/cancel-workflow run_id:12345`\nCancel runs', inline: false },
      { name: '📋 /build-logs', value: '`/build-logs run_id:12345`\nView logs', inline: false },
      { name: '📦 /list-artifacts', value: '`/list-artifacts`\nList build files', inline: false },
      { name: '📈 /workflow-history', value: '`/workflow-history days:30`\nView stats', inline: false },
      { name: '🤖 /bot-info', value: 'Bot information', inline: false },
      { name: '⚙️ /config', value: '`/config action:configure`\nManage bot settings (Admin only)', inline: false }
    )
    .setFooter({ text: 'Most params are optional!' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
};

const handleConfig = async (interaction) => {
  const action = interaction.options.getString('action');
  
  if (action === 'view') {
    await interaction.deferReply({ ephemeral: true });
    const config = getConfig();
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('⚙️ Bot Configuration (PostgreSQL Storage)')
      .addFields(
        { name: '📦 Repository', value: config.repo.owner && config.repo.name ? 
          `${config.repo.owner}/${config.repo.name}` : 'Not configured', inline: true },
        { name: '🔧 Workflow', value: config.repo.workflowFile || 'Not configured', inline: true },
        { name: '🌿 Branch', value: config.repo.branch || 'Not configured', inline: true },
        { name: '🔐 Require Permissions', value: config.features.requirePermissions ? '✅' : '❌', inline: true },
        { name: '📝 Enable Logging', value: config.features.enableLogging ? '✅' : '❌', inline: true },
        { name: '🔄 Auto Refresh', value: config.features.autoRefreshStatus ? '✅' : '❌', inline: true },
        { name: '⏱️ Refresh Interval', value: `${config.features.refreshInterval}ms`, inline: true },
        { name: '📢 Log Channel', value: config.discord.logChannelId ? `<#${config.discord.logChannelId}>` : 'None', inline: true },
        { name: '👥 Allowed Roles', value: config.discord.allowedRoleIds.length > 0 ? 
          config.discord.allowedRoleIds.map(id => `<@&${id}>`).join(', ') : 'None', inline: true },
        { name: '🔑 Tokens', value: config.githubToken && config.discordToken ? '✅ Set' : '❌ Missing', inline: true },
        { name: '🌐 Guild ID', value: config.guildId || 'Global commands', inline: true }
      )
      .setFooter({ text: '🗄️ Stored in PostgreSQL - persists until reset' })
      .setTimestamp();
    
    return await interaction.editReply({ embeds: [embed], ephemeral: true });
  } 
  else if (action === 'configure') {
    const modal = createConfigModal(getConfig());
    await interaction.showModal(modal);
  }
  else if (action === 'reset') {
    await interaction.deferReply({ ephemeral: true });
    
    // Reset database and memory
    await resetConfigInDB();
    
    botConfig = {
      githubToken: process.env.GITHUB_TOKEN || null,
      discordToken: process.env.DISCORD_TOKEN || null,
      guildId: process.env.GUILD_ID || null,
      repo: { owner: null, name: null, workflowFile: null, branch: null },
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
    
    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🔄 Configuration Reset')
      .setDescription('Configuration has been reset to environment variables')
      .setFooter({ text: 'PostgreSQL database cleared - all settings removed' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [embed], ephemeral: true });
    await sendLog(`🔄 Configuration reset by ${interaction.user.tag}`, embed);
  }
};

// ================================
// BUTTON HANDLER
// ================================
const handleButton = async (interaction) => {
  const [action, runId] = interaction.customId.split('_');
  const config = getConfig();
  
  if (action === 'cancel') {
    await interaction.deferUpdate();
    try {
      await octokit.actions.cancelWorkflowRun({ owner: config.repo.owner, repo: config.repo.name, run_id: runId });
      const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(COLORS.cancelled).setFooter({ text: `Cancelled by ${interaction.user.tag}` });
      await interaction.editReply({ embeds: [embed], components: [] });
      await interaction.followUp({ content: '✅ Cancelled!', ephemeral: true });
      log(`Button cancel ${runId} by ${interaction.user.tag}`, 'INFO');
    } catch (error) {
      log(`Button cancel error: ${error.message}`, 'ERROR');
      await interaction.followUp({ content: `❌ Failed: ${error.message}`, ephemeral: true });
    }
  } else if (action === 'refresh') {
    await interaction.deferUpdate();
    try {
      const run = await getLatestRun(runId);
      const duration = run.updated_at && run.created_at ? formatDuration(new Date(run.updated_at) - new Date(run.created_at)) : 'N/A';
      const statusIcon = EMOJI.status[run.status] || '❓';
      const conclusionIcon = run.conclusion ? (EMOJI.conclusion[run.conclusion] || '❓') : '⏳';
      const color = run.conclusion === 'success' ? COLORS.success : run.conclusion === 'failure' ? COLORS.failure : 
                    run.status === 'in_progress' ? COLORS.in_progress : COLORS.queued;

      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(color)
        .setFields(
          { name: '📍 Status', value: `${statusIcon} ${run.status.replace('_', ' ').toUpperCase()}`, inline: true },
          { name: '🎯 Conclusion', value: run.conclusion ? `${conclusionIcon} ${run.conclusion.toUpperCase()}` : '⏳ Running', inline: true },
          { name: '⏱️ Duration', value: duration, inline: true }
        )
        .setFooter({ text: `Updated ${new Date().toLocaleTimeString()} by ${interaction.user.tag}` })
        .setTimestamp();

      const showCancel = run.status === 'in_progress' || run.status === 'queued';
      const components = run.status === 'completed' ? [] : [createButtons(run.id, run.html_url, showCancel)];
      await interaction.editReply({ embeds: [embed], components });
      
      if (run.status === 'completed') {
        await interaction.followUp({ content: `${EMOJI.conclusion[run.conclusion] || '✅'} Build ${run.conclusion}!`, ephemeral: true });
      }
    } catch (error) {
      log(`Button refresh error: ${error.message}`, 'ERROR');
      await interaction.followUp({ content: `❌ Failed: ${error.message}`, ephemeral: true });
    }
  }
};

// ================================
// EVENT HANDLERS
// ================================
client.once('ready', async () => {
  // Test database connection first
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    log('❌ Failed to connect to database', 'ERROR');
    return;
  }
  
  // Initialize and load database
  await initDatabase();
  await loadConfigFromDB();
  
  log(`✅ ${client.user.tag} ready`, 'INFO');
  client.user.setActivity('GitHub Actions 🚀', { type: 3 });
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    log('🔄 Registering commands...', 'INFO');
    const config = getConfig();
    const route = config.guildId 
      ? Routes.applicationGuildCommands(client.user.id, config.guildId)
      : Routes.applicationCommands(client.user.id);
    
    await rest.put(route, { body: commands });
    log(`✅ Registered ${commands.length} ${config.guildId ? 'guild' : 'global'} commands`, 'INFO');
    log(`🤖 Serving ${client.guilds.cache.size} server(s)`, 'INFO');
  } catch (error) {
    log(`❌ Command registration error: ${error.message}`, 'ERROR');
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'configModal') {
        await interaction.deferReply({ ephemeral: true });
        
        // Get all modal values
        const githubToken = interaction.fields.getTextInputValue('githubToken').trim();
        const discordToken = interaction.fields.getTextInputValue('discordToken').trim();
        const guildId = interaction.fields.getTextInputValue('guildId').trim();
        const repoOwner = interaction.fields.getTextInputValue('repoOwner').trim();
        const repoName = interaction.fields.getTextInputValue('repoName').trim();
        const workflowFile = interaction.fields.getTextInputValue('workflowFile').trim();
        const branch = interaction.fields.getTextInputValue('branch').trim();
        const allowedRoles = interaction.fields.getTextInputValue('allowedRoles').trim();
        const logChannel = interaction.fields.getTextInputValue('logChannel').trim();
        const requirePermissions = interaction.fields.getTextInputValue('requirePermissions').trim().toLowerCase();
        const enableLogging = interaction.fields.getTextInputValue('enableLogging').trim().toLowerCase();
        const autoRefresh = interaction.fields.getTextInputValue('autoRefresh').trim().toLowerCase();
        const refreshInterval = interaction.fields.getTextInputValue('refreshInterval').trim();
        
        // Update configuration
        if (githubToken) botConfig.githubToken = githubToken;
        if (discordToken) botConfig.discordToken = discordToken;
        if (guildId) botConfig.guildId = guildId;
        if (repoOwner) botConfig.repo.owner = repoOwner;
        if (repoName) botConfig.repo.name = repoName;
        if (workflowFile) botConfig.repo.workflowFile = workflowFile;
        if (branch) botConfig.repo.branch = branch;
        
        if (allowedRoles) {
          botConfig.discord.allowedRoleIds = allowedRoles.split(',')
            .map(id => id.trim().replace(/[<@&>]/g, ''))
            .filter(id => id);
        }
        
        if (logChannel) {
          botConfig.discord.logChannelId = logChannel.replace(/[<#>]/g, '');
        }
        
        if (requirePermissions === 'true' || requirePermissions === 'false') {
          botConfig.features.requirePermissions = requirePermissions === 'true';
        }
        
        if (enableLogging === 'true' || enableLogging === 'false') {
          botConfig.features.enableLogging = enableLogging === 'true';
        }
        
        if (autoRefresh === 'true' || autoRefresh === 'false') {
          botConfig.features.autoRefreshStatus = autoRefresh === 'true';
        }
        
        if (refreshInterval) {
          const interval = parseInt(refreshInterval);
          if (!isNaN(interval) && interval >= 5000) {
            botConfig.features.refreshInterval = interval;
          }
        }
        
        // Save to database
        if (await saveAllConfigToDB()) {
          const embed = new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('✅ Configuration Updated')
            .setDescription('Your configuration has been saved to PostgreSQL!')
            .addFields(
              { name: '📦 Repository', value: botConfig.repo.owner && botConfig.repo.name ? 
                `${botConfig.repo.owner}/${botConfig.repo.name}` : 'Not set', inline: true },
              { name: '🔧 Workflow', value: botConfig.repo.workflowFile || 'Not set', inline: true },
              { name: '🌿 Branch', value: botConfig.repo.branch || 'Not set', inline: true },
              { name: '🔑 Tokens', value: (botConfig.githubToken && botConfig.discordToken) ? '✅ Set' : '❌ Missing', inline: true }
            )
            .setFooter({ text: '🗄️ Stored securely in PostgreSQL database' })
            .setTimestamp();
          
          await interaction.editReply({ embeds: [embed], ephemeral: true });
          await sendLog(`⚙️ Configuration updated by ${interaction.user.tag}`, embed);
        } else {
          await interaction.editReply({ content: '❌ Failed to save configuration', ephemeral: true });
        }
      }
    }
    else if (interaction.isChatInputCommand()) {
      // Skip permission check for config command (Discord handles it)
      if (interaction.commandName !== 'config' && !await checkPermissions(interaction)) return;

      const handlers = {
        'build': handleBuild,
        'workflow-status': handleStatus,
        'cancel-workflow': handleCancel,
        'build-logs': handleLogs,
        'list-artifacts': handleArtifacts,
        'workflow-history': handleHistory,
        'bot-info': handleBotInfo,
        'help': handleHelp,
        'config': handleConfig
      };

      const handler = handlers[interaction.commandName];
      if (handler) await handler(interaction);
      else await interaction.reply({ content: '❌ Unknown command', ephemeral: true });
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (error) {
    log(`Interaction error: ${error.message}`, 'ERROR');
    const msg = '❌ Error occurred. Try again later.';
    try {
      if (interaction.deferred) await interaction.editReply(msg);
      else if (!interaction.replied) await interaction.reply({ content: msg, ephemeral: true });
    } catch (e) { log(`Error reply failed: ${e.message}`, 'ERROR'); }
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
  // Test database connection first
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('❌ Failed to connect to PostgreSQL database');
    console.error('Please ensure DATABASE_URL is set correctly');
    process.exit(1);
  }
  
  // Initialize and load database
  await initDatabase();
  await loadConfigFromDB();
  const config = getConfig();
  
  // Use config tokens or environment variables
  const discordToken = config.discordToken || process.env.DISCORD_TOKEN;
  const githubToken = config.githubToken || process.env.GITHUB_TOKEN;
  
  if (!discordToken) { 
    console.error('❌ Discord Token not configured. Use /config action:configure to set it'); 
    process.exit(1); 
  }
  if (!githubToken) { 
    console.error('❌ GitHub Token not configured. Use /config action:configure to set it'); 
    process.exit(1); 
  }
  
  // Update Octokit with token
  octokit.auth = githubToken;
  
  client.login(discordToken)
    .then(() => log('🚀 Login initiated', 'INFO'))
    .catch(error => { log(`Login failed: ${error.message}`, 'ERROR'); process.exit(1); });
};

startBot();
