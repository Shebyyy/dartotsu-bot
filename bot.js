// Dartotsu Discord Bot

// Polyfill ReadableStream for older Node
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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Octokit } = require('@octokit/rest');
const fetch = require('node-fetch');
const {
  Client, GatewayIntentBits, REST, Routes, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');

// --- Constants & Security ---
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';
const IV_LENGTH = 16;

const EMOJI = {
  platform: { all: '🌐', android: '🤖', windows: '🪟', linux: '🐧', ios: '🍎', macos: '💻' },
  status: { completed: '✅', in_progress: '🔄', queued: '⏳', waiting: '⏸️', requested: '📝', pending: '⏳' },
  conclusion: { success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️', timed_out: '⏰', action_required: '⚠️', neutral: '➖' }
};

const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, queued: 0x808080, info: 0x5865F2, dark: 0x2B2D31 };

// --- Postgres Pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000
});

// --- In-memory cache & configs ---
const serverConfigs = new Map(); // serverName => config
const cache = { branches: new Map() };
const configSessions = new Map(); // userId => session when editing

const DEFAULT_CONFIG = {
  githubToken: null,
  repo: { owner: null, name: null, workflowFile: null, branch: 'main' },
  discord: { allowedRoleIds: [], logChannelId: null },
  features: { requirePermissions: false, enableLogging: false, autoRefreshStatus: false, refreshInterval: 30000 }
};

// --- Encryption helpers ---
function encrypt(text) {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) {
    console.error('Encryption error', e.message);
    return null;
  }
}

function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    if (parts.length < 2) return text;
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return null;
  }
}

// --- DB Schema init & load/save ---
async function initDatabase() {
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
    console.log('✅ Database initialized');
  } catch (error) { console.error('DB init error', error.message); }
}

async function loadConfigsFromDB() {
  try {
    const { rows } = await pool.query('SELECT server_name, key, value FROM server_configs');
    rows.forEach(row => {
      const { server_name, key, value } = row;
      if (!serverConfigs.has(server_name)) serverConfigs.set(server_name, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
      const config = serverConfigs.get(server_name);
      switch (key) {
        case 'githubToken': config.githubToken = decrypt(value); break;
        case 'repoOwner': config.repo.owner = value; break;
        case 'repoName': config.repo.name = value; break;
        case 'workflowFile': config.repo.workflowFile = value; break;
        case 'branch': config.repo.branch = value; break;
        case 'allowedRoles': try { config.discord.allowedRoleIds = JSON.parse(value); } catch(e){} break;
        case 'logChannelId': config.discord.logChannelId = value; break;
        case 'requirePermissions': config.features.requirePermissions = value === 'true'; break;
        case 'enableLogging': config.features.enableLogging = value === 'true'; break;
        case 'autoRefreshStatus': config.features.autoRefreshStatus = value === 'true'; break;
        case 'refreshInterval': config.features.refreshInterval = parseInt(value) || 30000; break;
      }
    });
    console.log(`✅ Loaded configs for ${serverConfigs.size} server(s)`);
  } catch (error) { console.error('DB load error', error.message); }
}

async function saveServerConfig(serverName, key, value) {
  try {
    await pool.query(
      'INSERT INTO server_configs (server_name, key, value) VALUES ($1, $2, $3) ON CONFLICT (server_name, key) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP',
      [serverName, key, value]
    );
    if (!serverConfigs.has(serverName)) serverConfigs.set(serverName, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    const cfg = serverConfigs.get(serverName);
    switch (key) {
      case 'githubToken': cfg.githubToken = decrypt(value); break;
      case 'repoOwner': cfg.repo.owner = value; break;
      case 'repoName': cfg.repo.name = value; break;
      case 'workflowFile': cfg.repo.workflowFile = value; break;
      case 'branch': cfg.repo.branch = value; break;
      case 'allowedRoles': cfg.discord.allowedRoleIds = JSON.parse(value); break;
      case 'logChannelId': cfg.discord.logChannelId = value; break;
      case 'requirePermissions': cfg.features.requirePermissions = value === 'true'; break;
      case 'enableLogging': cfg.features.enableLogging = value === 'true'; break;
      case 'autoRefreshStatus': cfg.features.autoRefreshStatus = value === 'true'; break;
      case 'refreshInterval': cfg.features.refreshInterval = parseInt(value); break;
    }
  } catch (e) { console.error('Save config error', e.message); }
}

function getServerConfig(serverName) {
  if (!serverName) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!serverConfigs.has(serverName)) serverConfigs.set(serverName, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  return serverConfigs.get(serverName);
}

function getOctokitForServer(serverName) {
  const cfg = getServerConfig(serverName);
  const token = cfg.githubToken || process.env.GITHUB_TOKEN;
  if (!token) return null;
  return new Octokit({ auth: token, request: { fetch } });
}

// --- Utils ---
function formatDuration(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m%60}m` : m > 0 ? `${m}m ${s%60}s` : `${s}s`;
}
function formatBytes(bytes) {
  if (!bytes) return '0 Bytes';
  const k = 1024, sizes = ['Bytes','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes)/Math.log(k));
  return Math.round((bytes/Math.pow(k,i))*100)/100 + ' ' + sizes[i];
}

function log(msg, level='INFO', serverName=null) {
  const output = `[${new Date().toISOString()}] [${level}] ${serverName?`[${serverName}] `:''}${msg}`;
  console.log(output);
  if (serverName) {
    const cfg = getServerConfig(serverName);
    if (cfg.features.enableLogging) {
      try {
        const logDir = path.join(__dirname, 'logs'); if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
        fs.appendFileSync(path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`), output+'\n');
      } catch (e) { console.error('Log write error', e.message); }
    }
  }
}

async function sendLog(serverName, msg, embed=null) {
  const cfg = getServerConfig(serverName);
  if (!cfg.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(cfg.discord.logChannelId);
    if (channel?.isTextBased()) await channel.send(embed ? { content: msg, embeds: [embed] } : msg);
  } catch (e) { log(`Log send error: ${e.message}`, 'ERROR', serverName); }
}

function createButtons(runId, url, showCancel=false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setURL(url).setEmoji('🔗')
  );
  if (showCancel) row.addComponents(new ButtonBuilder().setCustomId(`cancel_${runId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('🚫'));
  row.addComponents(new ButtonBuilder().setCustomId(`refresh_${runId}`).setLabel('Refresh').setStyle(ButtonStyle.Primary).setEmoji('🔄'));
  return row;
}

function handleGitHubError(error, interaction=null, serverName=null) {
  log(`GitHub API error: ${error.message}`, 'ERROR', serverName);
  let title = '❌ GitHub API Error';
  let desc = error.message;
  if (error.status === 401) { title = '❌ Invalid GitHub Token'; desc = 'Token invalid or expired. Update in /config'; }
  else if (error.status === 403) { title = '❌ Permission Denied'; desc = 'Missing scopes or private repo access'; }
  else if (error.status === 404) { title = '❌ Not Found'; desc = 'Repo, workflow or branch not found'; }
  const embed = new EmbedBuilder().setColor(COLORS.failure).setTitle(title).setDescription(desc).setTimestamp();
  try {
    if (!interaction) return;
    if (interaction.replied || interaction.deferred) return interaction.editReply({ embeds: [embed] });
    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  } catch (e) { /* swallow */ }
}

// --- Discord Client & Commands ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const commands = [
  { name: 'build', description: 'Trigger build', options: [
      { name: 'platform', description: 'Platform', type: 3, required: true, choices: [
        { name: 'All', value: 'all' }, { name: 'Android', value: 'android' }, { name: 'Windows', value: 'windows' },
        { name: 'Linux', value: 'linux' }, { name: 'iOS', value: 'ios' }, { name: 'macOS', value: 'macos' }
      ]},
      { name: 'branch', description: 'Branch', type: 3, autocomplete: true },
      { name: 'clean_build', description: 'Clean build?', type: 5 },
      { name: 'ping_discord', description: 'Ping on completion?', type: 5 }
    ]},
  { name: 'workflow-status', description: 'Check Status', options: [{ name: 'limit', description: 'Limit', type: 4 }, { name: 'auto_refresh', description: 'Auto Refresh', type: 5 }] },
  { name: 'build-logs', description: 'View logs', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'list-artifacts', description: 'List artifacts', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'workflow-history', description: 'View history', options: [{ name: 'days', description: 'Days', type: 4 }] },
  { name: 'cancel-workflow', description: 'Cancel run', options: [{ name: 'run_id', description: 'Run ID', type: 3 }] },
  { name: 'bot-info', description: 'Bot Info' },
  { name: 'help', description: 'Help' },
  { name: 'config', description: 'Configure Bot', default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { name: 'cleanup-commands', description: 'Reset commands', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [{ name: 'type', description: 'Type', type: 3, required: true, choices: [{ name: 'Global', value: 'global' }, { name: 'Guild', value: 'guild' }, { name: 'All', value: 'all' }] }] }
];

// --- UI: Modern Panel Dashboard (Detailed) ---
function createConfigDashboardEmbed(serverName) {
  const cfg = getServerConfig(serverName);
  return new EmbedBuilder()
    .setColor(COLORS.dark)
    .setTitle(`⚙️ Configuration — ${serverName} (Detailed)`)
    .setDescription('Use the buttons below to open detailed editors for each category. Changes are saved per server.')
    .addFields(
      { name: '🔑 GitHub Token', value: cfg.githubToken ? '✅ Set (hidden)' : '❌ Not set', inline: true },
      { name: '📦 Repository', value: cfg.repo.owner && cfg.repo.name ? `${cfg.repo.owner}/${cfg.repo.name}` : '❌ Not configured', inline: true },
      { name: '🔧 Workflow', value: cfg.repo.workflowFile || '❌ Not set', inline: true },

      { name: '\u200B', value: '\u200B', inline: false },

      { name: '📢 Log Channel', value: cfg.discord.logChannelId ? `<#${cfg.discord.logChannelId}>` : 'None', inline: true },
      { name: '👥 Allowed Roles', value: cfg.discord.allowedRoleIds.length > 0 ? cfg.discord.allowedRoleIds.map(id => `<@&${id}>`).join(', ') : 'None', inline: true },
      { name: '🔐 Guild Mode', value: 'Server-specific (Server Name)', inline: true },

      { name: '\u200B', value: '\u200B', inline: false },

      { name: '🔒 Require Permissions', value: cfg.features.requirePermissions ? '✅ Yes' : '❌ No', inline: true },
      { name: '📝 File Logging', value: cfg.features.enableLogging ? `✅ Enabled — logs/${path.basename(__dirname)}` : '❌ Disabled', inline: true },
      { name: '🔄 Auto-Refresh', value: cfg.features.autoRefreshStatus ? `✅ Enabled (${cfg.features.refreshInterval}ms)` : '❌ Disabled', inline: true }
    )
    .setFooter({ text: 'Detailed view — click a button to edit a section' })
    .setTimestamp();
}

function createConfigDashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg_open_github').setLabel('🐙 GitHub Settings').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg_open_discord').setLabel('💬 Discord Settings').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cfg_open_features').setLabel('🎛️ Feature Toggles').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg_save_preview').setLabel('💾 Save Snapshot').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cfg_reset').setLabel('🔄 Reset To Env').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cfg_close').setLabel('❌ Close').setStyle(ButtonStyle.Secondary)
    )
  ];
}

// --- Modals / Editors ---
function buildGithubModal(cfg) {
  const modal = new ModalBuilder().setCustomId('modal_cfg_github').setTitle('GitHub Settings — Edit');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tk').setLabel('Token (leave empty to keep)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ow').setLabel('Repo Owner').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.repo.owner||'')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nm').setLabel('Repo Name').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.repo.name||'')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wf').setLabel('Workflow File').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.repo.workflowFile||'')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('br').setLabel('Default Branch').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.repo.branch||'main'))
  );
  return modal;
}

function buildDiscordModal(cfg) {
  const modal = new ModalBuilder().setCustomId('modal_cfg_discord').setTitle('Discord Settings — Edit');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lg').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setRequired(false).setValue(cfg.discord.logChannelId||'')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rl').setLabel('Allowed Role IDs (comma-separated)').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue((cfg.discord.allowedRoleIds||[]).join(', ')))
  );
  return modal;
}

function buildFeaturesModal(cfg) {
  const modal = new ModalBuilder().setCustomId('modal_cfg_features').setTitle('Feature Toggles — Edit');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reqp').setLabel('Require Permissions (true/false)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.features.requirePermissions))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('logf').setLabel('Enable File Logging (true/false)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.features.enableLogging))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('autoref').setLabel('Auto Refresh (true/false)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.features.autoRefreshStatus))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('refreshInt').setLabel('Refresh Interval (ms)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.features.refreshInterval)))
  );
  return modal;
}

// --- Handlers: Build, Status, Logs, Artifacts, Cancel, History, BotInfo, Help ---
async function handleBuild(interaction) {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const octokit = getOctokitForServer(serverName);
  if (!octokit || !cfg.repo.owner || !cfg.repo.name || !cfg.repo.workflowFile) return interaction.editReply('❌ Bot not configured. Use `/config`.');

  const platform = interaction.options.getString('platform');
  const branch = interaction.options.getString('branch') || cfg.repo.branch;
  const clean = interaction.options.getBoolean('clean_build') ?? false;
  const ping = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, ref: branch, inputs: { build_targets: platform, clean_build: clean.toString(), ping_discord: ping.toString() } });
    // give GitHub a moment
    await new Promise(r=>setTimeout(r,1500));
    const { data } = await octokit.actions.listWorkflowRuns({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, per_page: 1 });
    const run = data.workflow_runs[0];

    const embed = new EmbedBuilder().setColor(COLORS.success).setTitle('🚀 Build Triggered').setDescription('Dartotsu build workflow started!')
      .addFields(
        { name: 'Target', value: `${EMOJI.platform[platform]||'📦'} ${platform.toUpperCase()}`, inline:true },
        { name: 'Branch', value: `\`${branch}\``, inline:true },
        { name: 'Clean', value: clean? '✅':'❌', inline:true },
        { name: 'Initiator', value: interaction.user.tag, inline:true }
      ).setTimestamp();

    const components = run ? [createButtons(run.id, run.html_url, true)] : [];
    await interaction.editReply({ embeds: [embed], components });
    sendLog(serverName, `🚀 Build ${platform} started by ${interaction.user.tag}`, embed);
  } catch (e) { handleGitHubError(e, interaction, serverName); }
}

async function handleStatus(interaction) {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const octokit = getOctokitForServer(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? cfg.features.autoRefreshStatus;

  try {
    const { data } = await octokit.actions.listWorkflowRuns({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, per_page: limit });
    if (!data.workflow_runs.length) return interaction.editReply('📭 No runs found');
    const latest = data.workflow_runs[0];
    const duration = latest.updated_at && latest.created_at ? formatDuration(new Date(latest.updated_at) - new Date(latest.created_at)) : 'N/A';
    const icon = latest.conclusion ? (EMOJI.conclusion[latest.conclusion]||'') : (EMOJI.status[latest.status]||'');
    const embed = new EmbedBuilder().setColor(latest.conclusion === 'success'?COLORS.success:(latest.conclusion==='failure'?COLORS.failure:COLORS.in_progress)).setTitle('📊 Workflow Status').setDescription(`**${latest.display_title||latest.name}**`)
      .addFields(
        { name: 'Status', value: `${icon} ${latest.status.toUpperCase()}`, inline:true },
        { name: 'Conclusion', value: latest.conclusion || 'Running', inline:true },
        { name: 'Duration', value: duration, inline:true },
        { name: 'Branch', value: `\`${latest.head_branch}\``, inline:true },
        { name: 'Run #', value: `${latest.run_number}`, inline:true }
      ).setURL(latest.html_url).setTimestamp();

    if (data.workflow_runs.length>1) {
      const recent = data.workflow_runs.slice(1).map(r => {
        const i = r.conclusion ? (EMOJI.conclusion[r.conclusion]||'') : (EMOJI.status[r.status]||'');
        return `${i} [#${r.run_number}](${r.html_url}) - ${r.head_branch}`;
      }).join('\n');
      embed.addFields({ name: '📋 Recent', value: recent });
    }

    const showCancel = latest.status === 'in_progress' || latest.status === 'queued';
    await interaction.editReply({ embeds: [embed], components: [createButtons(latest.id, latest.html_url, showCancel)] });

    if (autoRefresh && showCancel) {
      setTimeout(async () => {
        try {
          const { data: ref } = await octokit.actions.getWorkflowRun({ owner: cfg.repo.owner, repo: cfg.repo.name, run_id: latest.id });
          if (ref.status === 'completed') {
            const doneEmbed = new EmbedBuilder().setColor(ref.conclusion === 'success'?COLORS.success:COLORS.failure).setTitle(`✅ Build ${ref.conclusion}`).setDescription(`Run #${ref.run_number} finished.`);
            await interaction.followUp({ embeds: [doneEmbed] });
            sendLog(serverName, `✅ Build #${ref.run_number} finished`, doneEmbed);
          }
        } catch (e) { log(`Auto-refresh error: ${e.message}`, 'ERROR', serverName); }
      }, cfg.features.refreshInterval);
    }
  } catch (e) { handleGitHubError(e, interaction, serverName); }
}

async function handleLogs(interaction) {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const octokit = getOctokitForServer(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  let runId = interaction.options.getString('run_id');
  try {
    let run;
    if (runId) run = (await octokit.actions.getWorkflowRun({ owner: cfg.repo.owner, repo: cfg.repo.name, run_id: runId })).data;
    else {
      const { data } = await octokit.actions.listWorkflowRuns({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, per_page: 1 });
      run = data.workflow_runs[0];
    }
    if (!run) return interaction.editReply('❌ No runs found');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`📋 Logs: Run #${run.run_number}`).setDescription(`[Click here to view full logs on GitHub](${run.html_url})`).addFields({ name: 'Status', value: run.status, inline:true }, { name: 'Conclusion', value: run.conclusion || 'Running', inline:true }).setTimestamp();
    await interaction.editReply({ embeds: [embed], components: [createButtons(run.id, run.html_url, false)] });
  } catch (e) { handleGitHubError(e, interaction, serverName); }
}

async function handleArtifacts(interaction) {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const octokit = getOctokitForServer(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  let runId = interaction.options.getString('run_id');
  try {
    let run;
    if (runId) run = (await octokit.actions.getWorkflowRun({ owner: cfg.repo.owner, repo: cfg.repo.name, run_id: runId })).data;
    else {
      const { data } = await octokit.actions.listWorkflowRuns({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, per_page: 1 });
      run = data.workflow_runs[0];
    }
    if (!run) return interaction.editReply('❌ No runs found');
    const { data } = await octokit.actions.listWorkflowRunArtifacts({ owner: cfg.repo.owner, repo: cfg.repo.name, run_id: run.id });
    if (!data.artifacts.length) return interaction.editReply('📭 No artifacts found for this run.');
    const list = data.artifacts.map(a=>`**${a.name}**\n📦 ${formatBytes(a.size_in_bytes)} • ${a.expired ? 'Expired' : 'Available'}`).join('\n\n');
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`📦 Artifacts (Run #${run.run_number})`).setDescription(list).setFooter({ text: 'Download via GitHub Actions' });
    await interaction.editReply({ embeds: [embed] });
  } catch (e) { handleGitHubError(e, interaction, serverName); }
}

async function handleCancel(interaction) {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const octokit = getOctokitForServer(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  let runId = interaction.options.getString('run_id');
  try {
    if (!runId) {
      const { data } = await octokit.actions.listWorkflowRuns({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, status: 'in_progress' });
      if (data.workflow_runs[0]) runId = data.workflow_runs[0].id;
    }
    if (!runId) return interaction.editReply('❌ No active runs to cancel');
    await octokit.actions.cancelWorkflowRun({ owner: cfg.repo.owner, repo: cfg.repo.name, run_id: runId });
    const embed = new EmbedBuilder().setColor(COLORS.cancelled).setTitle('🚫 Workflow Cancelled').setDescription(`Run #${runId} has been cancelled.`).addFields({ name: 'By', value: interaction.user.tag });
    await interaction.editReply({ embeds: [embed] });
    sendLog(serverName, `🚫 Run #${runId} cancelled by ${interaction.user.tag}`);
  } catch (e) { handleGitHubError(e, interaction, serverName); }
}

async function handleHistory(interaction) {
  await interaction.deferReply();
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const octokit = getOctokitForServer(serverName);
  if (!octokit) return interaction.editReply('❌ Not Configured');

  const days = interaction.options.getInteger('days') || 7;
  const since = new Date(Date.now() - days*24*60*60*1000);

  try {
    const { data } = await octokit.actions.listWorkflowRuns({ owner: cfg.repo.owner, repo: cfg.repo.name, workflow_id: cfg.repo.workflowFile, per_page: 100, created: `>=${since.toISOString()}` });
    const stats = data.workflow_runs.reduce((acc, r) => { acc.total++; if(r.conclusion==='success') acc.success++; else if(r.conclusion==='failure') acc.failure++; else if(r.conclusion==='cancelled') acc.cancelled++; else if(r.status==='in_progress') acc.inProgress++; if(r.updated_at && r.created_at) acc.totalDuration += new Date(r.updated_at) - new Date(r.created_at); return acc; }, { total:0, success:0, failure:0, cancelled:0, inProgress:0, totalDuration:0 });
    const avgDuration = stats.total ? formatDuration(stats.totalDuration / stats.total) : '0s';
    const successRate = stats.total ? ((stats.success / stats.total)*100).toFixed(1) : 0;
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📊 Workflow Statistics').setDescription(`Last ${days} days`).addFields({ name: 'Total', value: `${stats.total}`, inline:true },{ name:'Success', value:`${stats.success} (${successRate}%)`, inline:true },{ name:'Failed', value:`${stats.failure}`, inline:true },{ name:'Avg Duration', value: avgDuration, inline:true }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (e) { handleGitHubError(e, interaction, serverName); }
}

async function handleBotInfo(interaction) {
  const serverName = interaction.guild.name;
  const cfg = getServerConfig(serverName);
  const uptime = formatDuration(process.uptime() * 1000);
  const memory = formatBytes(process.memoryUsage().heapUsed);
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('🤖 Dartotsu Build Bot').setDescription('Multi-Server Edition')
    .addFields(
      { name: '📦 Repo', value: cfg.repo.owner ? `${cfg.repo.owner}/${cfg.repo.name}` : 'Not Set', inline:true },
      { name: '🔧 Workflow', value: cfg.repo.workflowFile || 'Not Set', inline:true },
      { name: '⏰ Uptime', value: uptime, inline:true },
      { name: '💾 Memory', value: memory, inline:true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline:true },
      { name: '🟢 Status', value: 'Online', inline:true }
    ).setThumbnail(client.user.displayAvatarURL()).setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Repository').setStyle(ButtonStyle.Link).setURL(cfg.repo.owner ? `https://github.com/${cfg.repo.owner}/${cfg.repo.name}` : 'https://github.com').setEmoji('📦'));
  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleHelp(interaction) {
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📚 Command Help').addFields(
    { name: '/build', value: 'Trigger a new build. Supports autocomplete for branches.', inline:false },
    { name: '/workflow-status', value: 'View latest build status with live refresh.', inline:false },
    { name: '/config', value: 'Open the Dashboard to configure the bot.', inline:false }
  ).setFooter({ text: 'Dartotsu Bot' });
  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

// --- Permission check ---
async function checkPermissions(interaction) {
  const cfg = getServerConfig(interaction.guild.name);
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (!cfg.features.requirePermissions) return true;
  if (cfg.discord.allowedRoleIds.length > 0 && interaction.member.roles.cache.some(r => cfg.discord.allowedRoleIds.includes(r.id))) return true;
  await interaction.reply({ content: '❌ Permission Denied', flags: [MessageFlags.Ephemeral] });
  return false;
}

// --- Interaction handling ---
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.guild) return interaction.reply({ content: '❌ DM not supported', flags: [MessageFlags.Ephemeral] });

    // Autocomplete for branch
    if (interaction.isAutocomplete() && interaction.commandName === 'build') {
      const serverName = interaction.guild.name; const cfg = getServerConfig(serverName);
      const octokit = getOctokitForServer(serverName);
      if (!octokit || !cfg.repo.owner) return interaction.respond([]);
      const now = Date.now();
      const serverCache = cache.branches.get(serverName) || { data: [], time: 0 };
      if (now - serverCache.time > 60000) {
        try { const { data } = await octokit.repos.listBranches({ owner: cfg.repo.owner, repo: cfg.repo.name, per_page: 50 }); serverCache.data = data.map(b=>b.name); serverCache.time = now; cache.branches.set(serverName, serverCache); } catch(e){}
      }
      const focus = interaction.options.getFocused();
      const filtered = serverCache.data.filter(b => b.startsWith(focus)).slice(0,25);
      await interaction.respond(filtered.map(b=>({ name: b, value: b })));
      return;
    }

    // Chat commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'config') return interaction.reply({ embeds: [createConfigDashboardEmbed(interaction.guild.name)], components: createConfigDashboardComponents(), flags: [MessageFlags.Ephemeral] });
      if (interaction.commandName === 'cleanup-commands') return handleCleanupCommands(interaction);

      if (!await checkPermissions(interaction)) return;
      const handlers = {
        'build': handleBuild, 'workflow-status': handleStatus, 'build-logs': handleLogs, 'list-artifacts': handleArtifacts,
        'workflow-history': handleHistory, 'cancel-workflow': handleCancel, 'bot-info': handleBotInfo, 'help': handleHelp
      };
      if (handlers[interaction.commandName]) await handlers[interaction.commandName](interaction);
    }

    // String select menu for config (legacy support)
    if (interaction.isStringSelectMenu() && interaction.customId === 'config_menu') {
      const val = interaction.values[0];
      const serverName = interaction.guild.name;
      const cfg = getServerConfig(serverName);
      if (val === 'cfg_github') {
        const modal = buildGithubModal(cfg);
        await interaction.showModal(modal);
      } else if (val === 'cfg_discord') {
        const modal = buildDiscordModal(cfg);
        await interaction.showModal(modal);
      } else if (val === 'cfg_features') {
        const modal = buildFeaturesModal(cfg);
        await interaction.showModal(modal);
      }
    }

    // Modal submits
    if (interaction.isModalSubmit()) {
      const serverName = interaction.guild.name;
      if (interaction.customId === 'modal_cfg_github') {
        const tk = interaction.fields.getTextInputValue('tk');
        if (tk) await saveServerConfig(serverName, 'githubToken', encrypt(tk));
        await saveServerConfig(serverName, 'repoOwner', interaction.fields.getTextInputValue('ow'));
        await saveServerConfig(serverName, 'repoName', interaction.fields.getTextInputValue('nm'));
        await saveServerConfig(serverName, 'workflowFile', interaction.fields.getTextInputValue('wf'));
        await saveServerConfig(serverName, 'branch', interaction.fields.getTextInputValue('br'));
        await interaction.update({ embeds: [createConfigDashboardEmbed(serverName)], components: createConfigDashboardComponents() });
      } else if (interaction.customId === 'modal_cfg_discord') {
        await saveServerConfig(serverName, 'logChannelId', interaction.fields.getTextInputValue('lg'));
        const roles = interaction.fields.getTextInputValue('rl').split(',').map(r=>r.trim()).filter(r=>/^\d+$/.test(r));
        await saveServerConfig(serverName, 'allowedRoles', JSON.stringify(roles));
        await interaction.update({ embeds: [createConfigDashboardEmbed(serverName)], components: createConfigDashboardComponents() });
      } else if (interaction.customId === 'modal_cfg_features') {
        const reqp = interaction.fields.getTextInputValue('reqp').trim().toLowerCase();
        const logf = interaction.fields.getTextInputValue('logf').trim().toLowerCase();
        const autoref = interaction.fields.getTextInputValue('autoref').trim().toLowerCase();
        const refreshInt = interaction.fields.getTextInputValue('refreshInt').trim();
        await saveServerConfig(serverName, 'requirePermissions', (reqp === 'true').toString());
        await saveServerConfig(serverName, 'enableLogging', (logf === 'true').toString());
        await saveServerConfig(serverName, 'autoRefreshStatus', (autoref === 'true').toString());
        if (!isNaN(parseInt(refreshInt))) await saveServerConfig(serverName, 'refreshInterval', String(Math.max(5000, parseInt(refreshInt))));
        await interaction.update({ embeds: [createConfigDashboardEmbed(serverName)], components: createConfigDashboardComponents() });
      }
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const id = interaction.customId;
      const serverName = interaction.guild.name;
      const cfg = getServerConfig(serverName);

      // Dashboard buttons
      if (id === 'cfg_open_github') {
        const modal = buildGithubModal(cfg);
        return interaction.showModal(modal);
      }

      if (id === 'cfg_open_discord') {
        const modal = buildDiscordModal(cfg);
        return interaction.showModal(modal);
      }

      if (id === 'cfg_open_features') {
        const modal = buildFeaturesModal(cfg);
        return interaction.showModal(modal);
      }

      if (id === 'cfg_save_preview') {
        // snapshot: save current config values to DB (they should already be saved) and show confirmation
        await interaction.deferUpdate();
        const embed = new EmbedBuilder().setColor(COLORS.success).setTitle('💾 Configuration Snapshot Saved').setDescription('Current settings have been recorded.').setTimestamp();
        await interaction.editReply({ embeds: [embed], components: [] });
        await sendLog(serverName, `💾 Configuration snapshot saved by ${interaction.user.tag}`, embed);
        return;
      }

      if (id === 'cfg_reset') {
        // Reset server config to defaults / env
        await interaction.deferUpdate();
        try {
          const keys = ['githubToken','repoOwner','repoName','workflowFile','branch','allowedRoles','logChannelId','requirePermissions','enableLogging','autoRefreshStatus','refreshInterval'];
          for (const k of keys) await pool.query('DELETE FROM server_configs WHERE server_name=$1 AND key=$2', [serverName, k]);
          serverConfigs.set(serverName, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
          const embed = new EmbedBuilder().setColor(COLORS.cancelled).setTitle('🔄 Configuration Reset').setDescription('Server configuration reset to defaults/env.').setTimestamp();
          await interaction.editReply({ embeds: [embed], components: [] });
          await sendLog(serverName, `🔄 Configuration reset by ${interaction.user.tag}`, embed);
        } catch (e) {
          log(`Reset error: ${e.message}`,'ERROR', serverName);
          await interaction.editReply({ content: `❌ Error: ${e.message}` });
        }
        return;
      }

      if (id === 'cfg_close') {
        await interaction.deferUpdate();
        await interaction.editReply({ content: 'Closed configuration panel.', embeds: [], components: [] });
        return;
      }

      // Existing toggle buttons (legacy)
      if (id === 'cfg_test') {
        const oct = getOctokitForServer(serverName);
        if (!oct) return interaction.reply({ content: '❌ No token', flags: [MessageFlags.Ephemeral] });
        try { const { data } = await oct.users.getAuthenticated(); interaction.reply({ content: `✅ Connected as ${data.login}`, flags: [MessageFlags.Ephemeral] }); } catch(e) { interaction.reply({ content: '❌ Failed', flags: [MessageFlags.Ephemeral] }); }
      }

      // Workflow Buttons: refresh_x / cancel_x
      if (id.startsWith('refresh_') || id.startsWith('cancel_')) {
        const parts = id.split('_'); const action = parts[0]; const runId = parts[1];
        const oct = getOctokitForServer(serverName);
        if (!oct) return interaction.reply({ content: '❌ Not configured', flags: [MessageFlags.Ephemeral] });
        if (action === 'refresh') {
          await interaction.deferUpdate();
          try {
            const { data } = await oct.actions.getWorkflowRun({ owner: cfg.repo.owner, repo: cfg.repo.name, run_id: runId });
            const showCancel = data.status === 'in_progress' || data.status === 'queued';
            const icon = data.conclusion ? (EMOJI.conclusion[data.conclusion]||'') : (EMOJI.status[data.status]||'');
            const embed = new EmbedBuilder().setColor(data.conclusion==='success'?COLORS.success:(data.conclusion==='failure'?COLORS.failure:COLORS.in_progress)).setTitle('📊 Workflow Status').setDescription(`**${data.display_title||data.name}**`).addFields({ name:'Status', value:`${icon} ${data.status.toUpperCase()}`, inline:true },{ name:'Conclusion', value: data.conclusion || 'Running', inline:true }).setURL(data.html_url).setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [createButtons(data.id, data.html_url, showCancel)] });
          } catch (e) { /* swallow */ }
        }
        if (action === 'cancel') { await handleCancel(interaction); }
      }
    }
  } catch (error) {
    log(`Interaction error: ${error.message}`, 'ERROR', interaction.guild?.name);
    try { if (interaction.deferred) await interaction.editReply('❌ Error occurred. Try again later.'); else if (!interaction.replied) await interaction.reply({ content: '❌ Error occurred. Try again later.', flags: [MessageFlags.Ephemeral] }); } catch(e){}
  }
});

// --- Cleanup commands helper ---
async function handleCleanupCommands(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const type = interaction.options.getString('type');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    let removed = 0;
    if (type === 'global' || type === 'all') {
      const existing = await rest.get(Routes.applicationCommands(client.user.id));
      if (existing.length > 0) { await rest.put(Routes.applicationCommands(client.user.id), { body: [] }); removed += existing.length; }
    }
    if (type === 'guild' || type === 'all') {
      const guilds = client.guilds.cache;
      for (const [guildId] of guilds) {
        const existing = await rest.get(Routes.applicationGuildCommands(client.user.id, guildId));
        if (existing.length > 0) { await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] }); removed += existing.length; }
      }
    }
    const embed = new EmbedBuilder().setColor(COLORS.success).setTitle('🧹 Commands Cleaned Up').setDescription(`Successfully removed ${removed} command(s)`).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (e) { log(`Cleanup error: ${e.message}`, 'ERROR'); await interaction.editReply({ content: `❌ Error: ${e.message}` }); }
}

// --- Ready & Register commands ---
client.once('ready', async () => {
  await initDatabase();
  await loadConfigsFromDB();
  log(`✅ ${client.user.tag} ready`, 'INFO');

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    // register global commands by default
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    log(`✅ Registered ${commands.length} commands`,'INFO');
  } catch (e) { log(`Command register error: ${e.message}`, 'ERROR'); }
});

client.on('error', e => log(`Client Error: ${e.message}`, 'ERROR'));
process.on('unhandledRejection', e => log(`Unhandled rejection: ${e.message}`, 'ERROR'));

// --- Startup System (NEW CLEAN) ---
async function startBot() {
  log('🔄 Starting Dartotsu Bot…', 'INFO');

  // 1. Check required environment variables
  if (!process.env.DISCORD_TOKEN) {
    log('❌ DISCORD_TOKEN is missing in environment variables', 'ERROR');
    process.exit(1);
  }

  // 2. Test PostgreSQL connection BEFORE starting bot
  try {
    const conn = await pool.connect();
    conn.release();
    log('🟢 PostgreSQL connected successfully', 'INFO');
  } catch (err) {
    log(`❌ PostgreSQL connection failed: ${err.message}`, 'ERROR');
    process.exit(1);
  }

  // 3. Initialize DB schema + load configs
  await initDatabase();
  await loadConfigsFromDB();

  // 4. Login the bot
  try {
    await client.login(process.env.DISCORD_TOKEN);
    log('🚀 Discord bot logged in successfully', 'INFO');
  } catch (err) {
    log(`❌ Discord login failed: ${err.message}`, 'ERROR');
    process.exit(1);
  }
}

// --- Run Bot ---
startBot();
