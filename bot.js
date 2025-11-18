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
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let octokit; // Will be initialized after config loads

// ================================
// CONFIG FILE MANAGEMENT
// ================================
const configPath = path.join(__dirname, 'config.json');

const loadConfig = () => {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error(`Config load error: ${e.message}`);
  }
  
  // Default config from env or empty
  return {
    github_token: process.env.GITHUB_TOKEN || '',
    repo_owner: process.env.REPO_OWNER || 'Shebyyy',
    repo_name: process.env.REPO_NAME || 'Dartotsu',
    workflow_file: process.env.WORKFLOW_FILE || 'dart.yml',
    branch: process.env.BRANCH || 'main',
    log_channel_id: process.env.LOG_CHANNEL_ID || '',
    allowed_role_ids: process.env.ALLOWED_ROLE_IDS?.split(',').filter(Boolean) || [],
    require_permissions: process.env.REQUIRE_PERMISSIONS === 'true',
    enable_logging: process.env.ENABLE_LOGGING === 'true',
    auto_refresh_status: process.env.AUTO_REFRESH_STATUS === 'true',
    refresh_interval: parseInt(process.env.REFRESH_INTERVAL) || 30000,
    setup_completed: !!process.env.GITHUB_TOKEN
  };
};

const saveConfig = (config) => {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    log('Config saved successfully', 'INFO');
    return true;
  } catch (e) {
    log(`Config save error: ${e.message}`, 'ERROR');
    return false;
  }
};

let CONFIG = loadConfig();

// Initialize Octokit with current config
const initOctokit = () => {
  if (CONFIG.github_token) {
    octokit = new Octokit({
      auth: CONFIG.github_token,
      request: { fetch: require('node-fetch') }
    });
  }
};

initOctokit();

// ================================
// CONSTANTS & EMOJIS
// ================================
const EMOJI = {
  platform: {
    all: '🌐',
    android: '🤖',
    windows: '🪟',
    linux: '🐧',
    ios: '🍎',
    macos: '💻'
  },
  status: {
    completed: '✅',
    in_progress: '🔄',
    queued: '⏳',
    waiting: '⏸️',
    requested: '📝',
    pending: '⏳'
  },
  conclusion: {
    success: '✅',
    failure: '❌',
    cancelled: '🚫',
    skipped: '⏭️',
    timed_out: '⏰',
    action_required: '⚠️',
    neutral: '➖'
  }
};

const COLORS = {
  success: 0x00FF00,
  failure: 0xFF0000,
  cancelled: 0xFFA500,
  in_progress: 0xFFFF00,
  queued: 0x808080,
  info: 0x5865F2
};

// ================================
// COMMANDS
// ================================
const commands = [
  {
    name: 'setup-config',
    description: '⚙️ Initial bot configuration (Admin only)',
    default_member_permissions: '0',
    options: [
      {
        name: 'github_token',
        description: 'GitHub Personal Access Token',
        type: 3,
        required: true
      },
      {
        name: 'repo_owner',
        description: 'Repository owner (default: Shebyyy)',
        type: 3,
        required: false
      },
      {
        name: 'repo_name',
        description: 'Repository name (default: Dartotsu)',
        type: 3,
        required: false
      },
      {
        name: 'log_channel',
        description: 'Log channel',
        type: 7,
        required: false
      },
      {
        name: 'allowed_roles',
        description: 'Comma-separated role IDs',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'update-config',
    description: '🔧 Update bot configuration',
    options: [
      {
        name: 'setting',
        description: 'Setting to update',
        type: 3,
        required: true,
        choices: [
          { name: '🔑 GitHub Token', value: 'github_token' },
          { name: '📦 Repository Owner', value: 'repo_owner' },
          { name: '📦 Repository Name', value: 'repo_name' },
          { name: '📄 Workflow File', value: 'workflow_file' },
          { name: '🌿 Branch', value: 'branch' },
          { name: '📢 Log Channel', value: 'log_channel' },
          { name: '👥 Allowed Roles', value: 'allowed_roles' },
          { name: '🔐 Require Permissions', value: 'require_permissions' },
          { name: '📝 Enable Logging', value: 'enable_logging' },
          { name: '🔄 Auto Refresh', value: 'auto_refresh' }
        ]
      },
      {
        name: 'value',
        description: 'New value',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: 'view-config',
    description: '👀 View current configuration'
  },
  {
    name: 'reset-config',
    description: '🔄 Reset configuration to defaults (Admin only)',
    default_member_permissions: '0'
  },
  {
    name: 'build',
    description: '🚀 Trigger Dartotsu build workflow',
    options: [
      {
        name: 'platform',
        description: 'Platform to build',
        type: 3,
        required: true,
        choices: [
          { name: '🌐 All', value: 'all' },
          { name: '🤖 Android', value: 'android' },
          { name: '🪟 Windows', value: 'windows' },
          { name: '🐧 Linux', value: 'linux' },
          { name: '🍎 iOS', value: 'ios' },
          { name: '💻 macOS', value: 'macos' }
        ]
      },
      {
        name: 'clean_build',
        description: 'Clean build?',
        type: 5,
        required: false
      },
      {
        name: 'ping_discord',
        description: 'Ping on completion?',
        type: 5,
        required: false
      }
    ]
  },
  {
    name: 'workflow-status',
    description: '📊 Check workflow status',
    options: [
      {
        name: 'limit',
        description: 'Recent runs (1-10)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 10
      },
      {
        name: 'auto_refresh',
        description: 'Auto-refresh?',
        type: 5,
        required: false
      }
    ]
  },
  {
    name: 'cancel-workflow',
    description: '🚫 Cancel workflow',
    options: [
      {
        name: 'run_id',
        description: 'Run ID',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'build-logs',
    description: '📋 View logs',
    options: [
      {
        name: 'run_id',
        description: 'Run ID',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'list-artifacts',
    description: '📦 List artifacts',
    options: [
      {
        name: 'run_id',
        description: 'Run ID',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'workflow-history',
    description: '📈 View statistics',
    options: [
      {
        name: 'days',
        description: 'Days (1-30)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 30
      }
    ]
  },
  {
    name: 'bot-info',
    description: '🤖 Bot information'
  },
  {
    name: 'help',
    description: '❓ Command help'
  }
];

// ================================
// UTILITY FUNCTIONS
// ================================
const log = (msg, level = 'INFO') => {
  const logMsg = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(logMsg);
  
  if (CONFIG.enable_logging) {
    try {
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
      fs.appendFileSync(
        path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`),
        logMsg + '\n'
      );
    } catch (e) {
      console.error(`Log error: ${e.message}`);
    }
  }
};

const checkPermissions = async (interaction) => {
  // Check if setup is completed
  if (!CONFIG.setup_completed && interaction.commandName !== 'setup-config') {
    await interaction.reply({
      content: '⚠️ Bot not configured! Run `/setup-config` first.',
      ephemeral: true
    });
    return false;
  }

  // Administrator always has access
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  // Check if permissions are required
  if (!CONFIG.require_permissions || CONFIG.allowed_role_ids.length === 0) {
    return true;
  }

  // Check if user has allowed role
  if (interaction.member.roles.cache.some(role => CONFIG.allowed_role_ids.includes(role.id))) {
    return true;
  }

  await interaction.reply({
    content: '❌ No permission',
    ephemeral: true
  });
  return false;
};

const sendLog = async (msg, embed = null) => {
  if (!CONFIG.log_channel_id) return;
  try {
    const channel = await client.channels.fetch(CONFIG.log_channel_id);
    if (channel?.isTextBased()) {
      await channel.send(embed ? { content: msg, embeds: [embed] } : msg);
    }
  } catch (e) {
    log(`Log send error: ${e.message}`, 'ERROR');
  }
};

const formatDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const createButtons = (runId, url, showCancel = false) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('GitHub')
      .setStyle(ButtonStyle.Link)
      .setURL(url)
      .setEmoji('🔗')
  );
  
  if (showCancel) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`cancel_${runId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🚫')
    );
  }
  
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`refresh_${runId}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄')
  );
  
  return row;
};

const getLatestRun = async (runId = null, status = null) => {
  if (!octokit) throw new Error('Bot not configured');
  
  if (runId) {
    return (await octokit.actions.getWorkflowRun({
      owner: CONFIG.repo_owner,
      repo: CONFIG.repo_name,
      run_id: runId
    })).data;
  }
  
  const params = {
    owner: CONFIG.repo_owner,
    repo: CONFIG.repo_name,
    workflow_id: CONFIG.workflow_file,
    per_page: 1
  };
  
  if (status) params.status = status;
  
  const { data: runs } = await octokit.actions.listWorkflowRuns(params);
  return runs.workflow_runs[0] || null;
};

const createRunEmbed = (run, title = '📊 Workflow Status') => {
  const duration = run.updated_at && run.created_at
    ? formatDuration(new Date(run.updated_at) - new Date(run.created_at))
    : 'N/A';
  
  const statusIcon = EMOJI.status[run.status] || '❓';
  const conclusionIcon = run.conclusion ? (EMOJI.conclusion[run.conclusion] || '❓') : '⏳';
  
  const color = run.conclusion === 'success' ? COLORS.success
    : run.conclusion === 'failure' ? COLORS.failure
    : run.status === 'in_progress' ? COLORS.in_progress
    : COLORS.queued;
  
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

// ================================
// CONFIG COMMAND HANDLERS
// ================================
const handleSetupConfig = async (interaction) => {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '❌ Only administrators can run initial setup',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const githubToken = interaction.options.getString('github_token');
  const repoOwner = interaction.options.getString('repo_owner') || CONFIG.repo_owner;
  const repoName = interaction.options.getString('repo_name') || CONFIG.repo_name;
  const logChannel = interaction.options.getChannel('log_channel');
  const allowedRoles = interaction.options.getString('allowed_roles');

  // Validate GitHub token
  try {
    const testOctokit = new Octokit({
      auth: githubToken,
      request: { fetch: require('node-fetch') }
    });

    await testOctokit.repos.get({
      owner: repoOwner,
      repo: repoName
    });
  } catch (error) {
    return interaction.editReply({
      content: `❌ Invalid GitHub token or repository: ${error.message}`
    });
  }

  // Update config
  CONFIG.github_token = githubToken;
  CONFIG.repo_owner = repoOwner;
  CONFIG.repo_name = repoName;
  CONFIG.log_channel_id = logChannel?.id || CONFIG.log_channel_id;
  CONFIG.allowed_role_ids = allowedRoles
    ? allowedRoles.split(',').map(id => id.trim()).filter(Boolean)
    : CONFIG.allowed_role_ids;
  CONFIG.setup_completed = true;

  if (saveConfig(CONFIG)) {
    initOctokit();

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('✅ Bot Configured Successfully')
      .setDescription('Initial setup complete!')
      .addFields(
        { name: '🔑 GitHub Token', value: '✅ Set and validated', inline: true },
        { name: '📦 Repository', value: `${repoOwner}/${repoName}`, inline: true },
        { name: '📢 Log Channel', value: logChannel ? `<#${logChannel.id}>` : '❌ Not set', inline: true },
        { name: '👥 Allowed Roles', value: CONFIG.allowed_role_ids.length ? `${CONFIG.allowed_role_ids.length} role(s)` : '❌ Not set', inline: true },
        { name: '💡 Next Steps', value: 'Use `/update-config` to modify settings\nUse `/build` to start building!', inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    log(`Setup completed by ${interaction.user.tag}`, 'INFO');
  } else {
    await interaction.editReply({ content: '❌ Failed to save configuration' });
  }
};

const handleUpdateConfig = async (interaction) => {
  if (!await checkPermissions(interaction)) return;

  await interaction.deferReply({ ephemeral: true });

  const setting = interaction.options.getString('setting');
  const value = interaction.options.getString('value');

  let displayValue = value;

  switch (setting) {
    case 'github_token':
      try {
        const testOctokit = new Octokit({
          auth: value,
          request: { fetch: require('node-fetch') }
        });
        await testOctokit.repos.get({
          owner: CONFIG.repo_owner,
          repo: CONFIG.repo_name
        });
        CONFIG.github_token = value;
        initOctokit();
        displayValue = '✅ Token validated';
      } catch (error) {
        return interaction.editReply({ content: `❌ Invalid token: ${error.message}` });
      }
      break;

    case 'repo_owner':
      CONFIG.repo_owner = value;
      break;

    case 'repo_name':
      CONFIG.repo_name = value;
      break;

    case 'workflow_file':
      CONFIG.workflow_file = value;
      break;

    case 'branch':
      CONFIG.branch = value;
      break;

    case 'log_channel':
      CONFIG.log_channel_id = value;
      displayValue = `<#${value}>`;
      break;

    case 'allowed_roles':
      CONFIG.allowed_role_ids = value.split(',').map(id => id.trim()).filter(Boolean);
      displayValue = `${CONFIG.allowed_role_ids.length} role(s)`;
      break;

    case 'require_permissions':
      CONFIG.require_permissions = value.toLowerCase() === 'true';
      displayValue = CONFIG.require_permissions ? '✅ Enabled' : '❌ Disabled';
      break;

    case 'enable_logging':
      CONFIG.enable_logging = value.toLowerCase() === 'true';
      displayValue = CONFIG.enable_logging ? '✅ Enabled' : '❌ Disabled';
      break;

    case 'auto_refresh':
      CONFIG.auto_refresh_status = value.toLowerCase() === 'true';
      displayValue = CONFIG.auto_refresh_status ? '✅ Enabled' : '❌ Disabled';
      break;

    default:
      return interaction.editReply({ content: '❌ Unknown setting' });
  }

  if (saveConfig(CONFIG)) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('✅ Configuration Updated')
      .addFields(
        { name: '⚙️ Setting', value: setting.replace(/_/g, ' ').toUpperCase(), inline: true },
        { name: '📝 New Value', value: displayValue, inline: true },
        { name: '👤 Updated By', value: interaction.user.tag, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    log(`Config updated: ${setting} by ${interaction.user.tag}`, 'INFO');
  } else {
    await interaction.editReply({ content: '❌ Failed to save configuration' });
  }
};

const handleViewConfig = async (interaction) => {
  if (!await checkPermissions(interaction)) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Bot Configuration')
    .addFields(
      { name: '🔑 GitHub Token', value: CONFIG.github_token ? '✅ Set' : '❌ Not set', inline: true },
      { name: '📦 Repository', value: `${CONFIG.repo_owner}/${CONFIG.repo_name}`, inline: true },
      { name: '📄 Workflow', value: CONFIG.workflow_file, inline: true },
      { name: '🌿 Branch', value: CONFIG.branch, inline: true },
      { name: '📢 Log Channel', value: CONFIG.log_channel_id ? `<#${CONFIG.log_channel_id}>` : '❌ Not set', inline: true },
      { name: '👥 Allowed Roles', value: CONFIG.allowed_role_ids.length ? `${CONFIG.allowed_role_ids.length} role(s)` : '❌ None', inline: true },
      { name: '🔐 Require Permissions', value: CONFIG.require_permissions ? '✅ Yes' : '❌ No', inline: true },
      { name: '📝 Logging', value: CONFIG.enable_logging ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: '🔄 Auto Refresh', value: CONFIG.auto_refresh_status ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: '⏱️ Refresh Interval', value: `${CONFIG.refresh_interval / 1000}s`, inline: true },
      { name: '✅ Setup', value: CONFIG.setup_completed ? '✅ Complete' : '⚠️ Incomplete', inline: true }
    )
    .setFooter({ text: 'Use /update-config to modify settings' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
};

const handleResetConfig = async (interaction) => {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '❌ Only administrators can reset configuration',
      ephemeral: true
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('confirm_reset')
      .setLabel('Confirm Reset')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⚠️'),
    new ButtonBuilder()
      .setCustomId('cancel_reset')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: '⚠️ **WARNING**: This will reset ALL configuration to defaults!\nAre you sure?',
    components: [row],
    ephemeral: true
  });

  const collector = interaction.channel.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time: 30000,
    max: 1
  });

  collector.on('collect', async i => {
    if (i.customId === 'confirm_reset') {
      CONFIG = {
        github_token: '',
        repo_owner: 'Shebyyy',
        repo_name: 'Dartotsu',
        workflow_file: 'dart.yml',
        branch: 'main',
        log_channel_id: '',
        allowed_role_ids: [],
        require_permissions: false,
        enable_logging: true,
        auto_refresh_status: false,
        refresh_interval: 30000,
        setup_completed: false
      };

      if (saveConfig(CONFIG)) {
        await i.update({
          content: '✅ Configuration reset successfully',
          components: []
        });
        log(`Config reset by ${interaction.user.tag}`, 'WARN');
      } else {
        await i.update({
          content: '❌ Failed to reset configuration',
          components: []
        });
      }
    } else {
      await i.update({
        content: '✅ Reset cancelled',
        components: []
      });
    }
  });
};

// ================================
// BUILD COMMAND HANDLERS
// ================================
const handleBuild = async (interaction) => {
  await interaction.deferReply();

  const platform = interaction.options.getString('platform');
  const cleanBuild = interaction.options.getBoolean('clean_build') ?? false;
  const pingDiscord = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: CONFIG.repo_owner,
      repo: CONFIG.repo_name,
      workflow_id: CONFIG.workflow_file,
      ref: CONFIG.branch,
      inputs: {
        build_targets: platform,
        clean_build: cleanBuild.toString(),
        ping_discord: pingDiscord.toString()
      }
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
        { name: '🌿 Branch', value: `\`${CONFIG.branch}\``, inline: true },
        { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
      )
      .setURL(`https://github.com/${CONFIG.repo_owner}/${CONFIG.repo_name}/actions/workflows/${CONFIG.workflow_file}`)
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

  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? false;

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: CONFIG.repo_owner,
      repo: CONFIG.repo_name,
      workflow_id: CONFIG.workflow_file,
      per_page: limit
    });

    if (!runs.workflow_runs.length) {
      return interaction.editReply('📭 No workflows found');
    }

    const latestRun = runs.workflow_runs[0];
    const embed = createRunEmbed(latestRun, '📊 Latest Workflow Status');

    if (autoRefresh) {
      embed.setFooter({ text: '🔄 Auto-refresh (30s)' });
    }

    if (runs.workflow_runs.length > 1) {
      const recent = runs.workflow_runs.slice(1, limit).map(r => {
        const icon = r.conclusion ? (EMOJI.conclusion[r.conclusion] || '❓') : (EMOJI.status[r.status] || '❓');
        return `${icon} [#${r.run_number}](${r.html_url}) - ${r.head_branch} - <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`;
      }).join('\n');
      embed.addFields({ name: `📋 Recent (${limit - 1})`, value: recent });
    }

    const showCancel = latestRun.status === 'in_progress' || latestRun.status === 'queued';
    await interaction.editReply({
      embeds: [embed],
      components: [createButtons(latestRun.id, latestRun.html_url, showCancel)]
    });

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
        } catch (e) {
          log(`Auto-refresh error: ${e.message}`, 'ERROR');
        }
      }, CONFIG.refresh_interval);
    }
  } catch (error) {
    log(`Status error: ${error.message}`, 'ERROR');
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.failure)
        .setTitle('❌ Status Error')
        .setDescription(error.message)
        .setTimestamp()]
    });
  }
};

const handleCancel = async (interaction) => {
  await interaction.deferReply();

  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const run = await getLatestRun(null, 'in_progress');
      if (!run) return interaction.editReply('❌ No running workflows');
      runId = run.id;
    }

    await octokit.actions.cancelWorkflowRun({
      owner: CONFIG.repo_owner,
      repo: CONFIG.repo_name,
      run_id: runId
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS.cancelled)
      .setTitle('🚫 Workflow Cancelled')
      .setDescription(`Run #${runId} cancelled`)
      .addFields(
        { name: '👤 By', value: interaction.user.tag, inline: true },
        { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
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

    await interaction.editReply({
      embeds: [embed],
      components: [createButtons(run.id, run.html_url, false)]
    });
  } catch (error) {
    log(`Logs error: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Logs failed: ${error.message}`);
  }
};

const handleArtifacts = async (interaction) => {
  await interaction.deferReply();

  let runId = interaction.options.getString('run_id');

  try {
    const run = runId ? await getLatestRun(runId) : await getLatestRun();
    if (!run) return interaction.editReply('❌ No workflows found');

    const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
      owner: CONFIG.repo_owner,
      repo: CONFIG.repo_name,
      run_id: run.id
    });

    if (!artifacts.artifacts.length) {
      return interaction.editReply('📭 No artifacts found');
    }

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

  const days = interaction.options.getInteger('days') || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: CONFIG.repo_owner,
      repo: CONFIG.repo_name,
      workflow_id: CONFIG.workflow_file,
      per_page: 100,
      created: `>=${since.toISOString()}`
    });

    if (!runs.workflow_runs.length) {
      return interaction.editReply(`📭 No runs in ${days} day(s)`);
    }

    const stats = runs.workflow_runs.reduce((acc, r) => {
      acc.total++;
      if (r.conclusion === 'success') acc.success++;
      else if (r.conclusion === 'failure') acc.failure++;
      else if (r.conclusion === 'cancelled') acc.cancelled++;
      else if (r.status === 'in_progress') acc.inProgress++;
      if (r.updated_at && r.created_at) {
        acc.totalDuration += new Date(r.updated_at) - new Date(r.created_at);
      }
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
  const uptime = formatDuration(process.uptime() * 1000);
  const memory = formatBytes(process.memoryUsage().heapUsed);

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 Dartotsu Build Bot')
    .setDescription('GitHub Actions automation for Dartotsu')
    .addFields(
      { name: '📦 Repo', value: `[${CONFIG.repo_owner}/${CONFIG.repo_name}](https://github.com/${CONFIG.repo_owner}/${CONFIG.repo_name})`, inline: true },
      { name: '🔧 Workflow', value: `\`${CONFIG.workflow_file}\``, inline: true },
      { name: '⏰ Uptime', value: uptime, inline: true },
      { name: '🌐 Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: '📊 Commands', value: `${commands.length}`, inline: true },
      { name: '💾 Memory', value: memory, inline: true },
      { name: '🔗 Version', value: '2.1.0', inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
      { name: '🟢 Status', value: CONFIG.setup_completed ? 'Configured' : '⚠️ Setup Required', inline: true },
      { name: '✨ Features', value: '• Dynamic Config • Buttons • Auto-refresh • Artifacts • Stats', inline: false }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Repository')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://github.com/${CONFIG.repo_owner}/${CONFIG.repo_name}`)
      .setEmoji('📦'),
    new ButtonBuilder()
      .setLabel('Actions')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://github.com/${CONFIG.repo_owner}/${CONFIG.repo_name}/actions`)
      .setEmoji('⚡')
  );

  await interaction.reply({ embeds: [embed], components: [row] });
};

const handleHelp = async (interaction) => {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📚 Command Help')
    .setDescription('Available commands with examples')
    .addFields(
      { name: '⚙️ /setup-config', value: '`/setup-config github_token:ghp_xxx...`\nInitial bot setup (Admin only)', inline: false },
      { name: '🔧 /update-config', value: '`/update-config setting:log_channel value:123456`\nUpdate settings', inline: false },
      { name: '👀 /view-config', value: 'View current configuration', inline: false },
      { name: '🔄 /reset-config', value: 'Reset all settings (Admin only)', inline: false },
      { name: '🚀 /build', value: '`/build platform:android clean_build:true`\nTrigger builds', inline: false },
      { name: '📊 /workflow-status', value: '`/workflow-status limit:10 auto_refresh:true`\nCheck status', inline: false },
      { name: '🚫 /cancel-workflow', value: '`/cancel-workflow run_id:12345`\nCancel runs', inline: false },
      { name: '📋 /build-logs', value: '`/build-logs run_id:12345`\nView logs', inline: false },
      { name: '📦 /list-artifacts', value: '`/list-artifacts`\nList build files', inline: false },
      { name: '📈 /workflow-history', value: '`/workflow-history days:30`\nView stats', inline: false },
      { name: '🤖 /bot-info', value: 'Bot information', inline: false }
    )
    .setFooter({ text: 'Most params are optional!' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
};

// ================================
// BUTTON HANDLER
// ================================
const handleButton = async (interaction) => {
  const [action, runId] = interaction.customId.split('_');

  if (action === 'cancel') {
    await interaction.deferUpdate();
    try {
      await octokit.actions.cancelWorkflowRun({
        owner: CONFIG.repo_owner,
        repo: CONFIG.repo_name,
        run_id: runId
      });

      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(COLORS.cancelled)
        .setFooter({ text: `Cancelled by ${interaction.user.tag}` });

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
      const duration = run.updated_at && run.created_at
        ? formatDuration(new Date(run.updated_at) - new Date(run.created_at))
        : 'N/A';

      const statusIcon = EMOJI.status[run.status] || '❓';
      const conclusionIcon = run.conclusion ? (EMOJI.conclusion[run.conclusion] || '❓') : '⏳';

      const color = run.conclusion === 'success' ? COLORS.success
        : run.conclusion === 'failure' ? COLORS.failure
        : run.status === 'in_progress' ? COLORS.in_progress
        : COLORS.queued;

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
        await interaction.followUp({
          content: `${EMOJI.conclusion[run.conclusion] || '✅'} Build ${run.conclusion}!`,
          ephemeral: true
        });
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
  log(`✅ ${client.user.tag} ready`, 'INFO');

  if (!CONFIG.setup_completed) {
    log('⚠️ Bot not configured - run /setup-config', 'WARN');
  } else {
    log('✅ Configuration loaded', 'INFO');
  }

  client.user.setActivity('GitHub Actions 🚀', { type: 3 });

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    log('🔄 Registering commands...', 'INFO');
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
      : Routes.applicationCommands(client.user.id);

    await rest.put(route, { body: commands });
    log(`✅ Registered ${commands.length} ${process.env.GUILD_ID ? 'guild' : 'global'} commands`, 'INFO');
    log(`🤖 Serving ${client.guilds.cache.size} server(s)`, 'INFO');
  } catch (error) {
    log(`❌ Command registration error: ${error.message}`, 'ERROR');
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!await checkPermissions(interaction)) return;

      const handlers = {
        'setup-config': handleSetupConfig,
        'update-config': handleUpdateConfig,
        'view-config': handleViewConfig,
        'reset-config': handleResetConfig,
        'build': handleBuild,
        'workflow-status': handleStatus,
        'cancel-workflow': handleCancel,
        'build-logs': handleLogs,
        'list-artifacts': handleArtifacts,
        'workflow-history': handleHistory,
        'bot-info': handleBotInfo,
        'help': handleHelp
      };

      const handler = handlers[interaction.commandName];
      if (handler) {
        await handler(interaction);
      } else {
        await interaction.reply({ content: '❌ Unknown command', ephemeral: true });
      }
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (error) {
    log(`Interaction error: ${error.message}`, 'ERROR');
    const msg = '❌ Error occurred. Try again later.';
    try {
      if (interaction.deferred) {
        await interaction.editReply(msg);
      } else if (!interaction.replied) {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch (e) {
      log(`Error reply failed: ${e.message}`, 'ERROR');
    }
  }
});

client.on('error', error => log(`Client error: ${error.message}`, 'ERROR'));

process.on('unhandledRejection', error => log(`Unhandled rejection: ${error.message}`, 'ERROR'));

process.on('SIGINT', () => {
  log('SIGINT - shutting down', 'INFO');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SIGTERM - shutting down', 'INFO');
  client.destroy();
  process.exit(0);
});

// ================================
// START BOT
// ================================
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN missing in .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN)
  .then(() => log('🚀 Login initiated', 'INFO'))
  .catch(error => {
    log(`Login failed: ${error.message}`, 'ERROR');
    process.exit(1);
  });
