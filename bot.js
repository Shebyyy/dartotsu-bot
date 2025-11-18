// Dartotsu Discord Bot - Optimized Version
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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { fetch: require('node-fetch') } });

// ================================
// CONFIG & CONSTANTS
// ================================
const CONFIG = {
  repo: { owner: 'Shebyyy', name: 'Dartotsu', workflowFile: 'dart.yml', branch: 'main' },
  discord: {
    allowedRoleIds: process.env.ALLOWED_ROLE_IDS?.split(',').filter(Boolean) || [],
    logChannelId: process.env.LOG_CHANNEL_ID || null
  },
  features: {
    requirePermissions: process.env.REQUIRE_PERMISSIONS === 'true',
    enableLogging: process.env.ENABLE_LOGGING === 'true',
    autoRefreshStatus: process.env.AUTO_REFRESH_STATUS === 'true',
    refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 30000
  }
};

const EMOJI = {
  platform: { all: '🌐', android: '🤖', windows: '🪟', linux: '🐧', ios: '🍎', macos: '💻' },
  status: { completed: '✅', in_progress: '🔄', queued: '⏳', waiting: '⏸️', requested: '📝', pending: '⏳' },
  conclusion: { success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️', timed_out: '⏰', action_required: '⚠️', neutral: '➖' }
};

const COLORS = { success: 0x00FF00, failure: 0xFF0000, cancelled: 0xFFA500, in_progress: 0xFFFF00, queued: 0x808080, info: 0x5865F2 };

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
  { name: 'help', description: 'Command help' }
];

// ================================
// UTILITY FUNCTIONS
// ================================
const log = (msg, level = 'INFO') => {
  const logMsg = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(logMsg);
  if (CONFIG.features.enableLogging) {
    try {
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
      fs.appendFileSync(path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`), logMsg + '\n');
    } catch (e) { console.error(`Log error: ${e.message}`); }
  }
};

const checkPermissions = async (interaction) => {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
      !CONFIG.features.requirePermissions || 
      CONFIG.discord.allowedRoleIds.length === 0 ||
      interaction.member.roles.cache.some(role => CONFIG.discord.allowedRoleIds.includes(role.id))) return true;
  await interaction.reply({ content: '❌ No permission', ephemeral: true });
  return false;
};

const sendLog = async (msg, embed = null) => {
  if (!CONFIG.discord.logChannelId) return;
  try {
    const channel = await client.channels.fetch(CONFIG.discord.logChannelId);
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
  if (runId) return (await octokit.actions.getWorkflowRun({ owner: CONFIG.repo.owner, repo: CONFIG.repo.name, run_id: runId })).data;
  const params = { owner: CONFIG.repo.owner, repo: CONFIG.repo.name, workflow_id: CONFIG.repo.workflowFile, per_page: 1 };
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

// ================================
// COMMAND HANDLERS
// ================================
const handleBuild = async (interaction) => {
  await interaction.deferReply();
  const platform = interaction.options.getString('platform');
  const cleanBuild = interaction.options.getBoolean('clean_build') ?? false;
  const pingDiscord = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: CONFIG.repo.owner, repo: CONFIG.repo.name, workflow_id: CONFIG.repo.workflowFile, ref: CONFIG.repo.branch,
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
        { name: '🌿 Branch', value: `\`${CONFIG.repo.branch}\``, inline: true },
        { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
      )
      .setURL(`https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/actions/workflows/${CONFIG.repo.workflowFile}`)
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
      owner: CONFIG.repo.owner, repo: CONFIG.repo.name, workflow_id: CONFIG.repo.workflowFile, per_page: limit
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
      }, CONFIG.features.refreshInterval);
    }
  } catch (error) {
    log(`Status error: ${error.message}`, 'ERROR');
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.failure).setTitle('❌ Status Error').setDescription(error.message).setTimestamp()] });
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

    await octokit.actions.cancelWorkflowRun({ owner: CONFIG.repo.owner, repo: CONFIG.repo.name, run_id: runId });
    
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
  let runId = interaction.options.getString('run_id');

  try {
    const run = runId ? await getLatestRun(runId) : await getLatestRun();
    if (!run) return interaction.editReply('❌ No workflows found');

    const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
      owner: CONFIG.repo.owner, repo: CONFIG.repo.name, run_id: run.id
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
  const days = interaction.options.getInteger('days') || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: CONFIG.repo.owner, repo: CONFIG.repo.name, workflow_id: CONFIG.repo.workflowFile,
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
  const uptime = formatDuration(process.uptime() * 1000);
  const memory = formatBytes(process.memoryUsage().heapUsed);
  
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 Dartotsu Build Bot')
    .setDescription('GitHub Actions automation for Dartotsu')
    .addFields(
      { name: '📦 Repo', value: `[${CONFIG.repo.owner}/${CONFIG.repo.name}](https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name})`, inline: true },
      { name: '🔧 Workflow', value: `\`${CONFIG.repo.workflowFile}\``, inline: true },
      { name: '⏰ Uptime', value: uptime, inline: true },
      { name: '🌐 Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: '📊 Commands', value: `${commands.length}`, inline: true },
      { name: '💾 Memory', value: memory, inline: true },
      { name: '🔗 Version', value: '2.0.0', inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
      { name: '🟢 Status', value: 'Online', inline: true },
      { name: '✨ Features', value: '• Buttons • Auto-refresh • Artifacts • Stats • Help', inline: false }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Repository').setStyle(ButtonStyle.Link).setURL(`https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}`).setEmoji('📦'),
    new ButtonBuilder().setLabel('Actions').setStyle(ButtonStyle.Link).setURL(`https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/actions`).setEmoji('⚡')
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
      await octokit.actions.cancelWorkflowRun({ owner: CONFIG.repo.owner, repo: CONFIG.repo.name, run_id: runId });
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
  log(`✅ ${client.user.tag} ready`, 'INFO');
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
process.on('SIGINT', () => { log('SIGINT - shutting down', 'INFO'); client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM - shutting down', 'INFO'); client.destroy(); process.exit(0); });

// ================================
// START BOT
// ================================
if (!process.env.DISCORD_TOKEN) { console.error('❌ DISCORD_TOKEN missing'); process.exit(1); }
if (!process.env.GITHUB_TOKEN) { console.error('❌ GITHUB_TOKEN missing'); process.exit(1); }

client.login(process.env.DISCORD_TOKEN)
  .then(() => log('🚀 Login initiated', 'INFO'))
  .catch(error => { log(`Login failed: ${error.message}`, 'ERROR'); process.exit(1); });
