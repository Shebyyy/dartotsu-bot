// Dartotsu Discord Bot - Enhanced Version
// Triggers GitHub Actions workflow for building Dartotsu
// Repository: https://github.com/Shebyyy/Dartotsu

// Polyfill ReadableStream for older Node.js versions
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

// Initialize Discord client
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ] 
});

// Initialize GitHub API client
const octokit = new Octokit({ 
  auth: process.env.GITHUB_TOKEN,
  request: { fetch: require('node-fetch') }
});

// ================================
// CONFIGURATION
// ================================
const CONFIG = {
  repo: {
    owner: 'Shebyyy',
    name: 'Dartotsu',
    workflowFile: 'dart.yml',
    branch: 'main'
  },
  discord: {
    allowedRoleIds: process.env.ALLOWED_ROLE_IDS?.split(',').filter(Boolean) || [],
    logChannelId: process.env.LOG_CHANNEL_ID || null
  },
  features: {
    requirePermissions: process.env.REQUIRE_PERMISSIONS === 'true',
    enableLogging: process.env.ENABLE_LOGGING === 'true',
    enableStatusUpdates: process.env.ENABLE_STATUS_UPDATES === 'true',
    autoRefreshStatus: process.env.AUTO_REFRESH_STATUS === 'true',
    refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 30000 // 30 seconds
  },
  cache: {
    workflowRuns: new Map(),
    lastUpdate: null
  }
};

// ================================
// SLASH COMMANDS DEFINITION
// ================================
const commands = [
  {
    name: 'build',
    description: 'Trigger Dartotsu build workflow on GitHub Actions',
    options: [
      {
        name: 'platform',
        description: 'Select platform(s) to build',
        type: 3,
        required: true,
        choices: [
          { name: '🌐 All Platforms', value: 'all' },
          { name: '🤖 Android', value: 'android' },
          { name: '🪟 Windows', value: 'windows' },
          { name: '🐧 Linux', value: 'linux' },
          { name: '🍎 iOS', value: 'ios' },
          { name: '💻 macOS', value: 'macos' }
        ]
      },
      {
        name: 'clean_build',
        description: 'Perform a clean build? (removes cached files)',
        type: 5,
        required: false
      },
      {
        name: 'ping_discord',
        description: 'Ping Discord role when build completes?',
        type: 5,
        required: false
      }
    ]
  },
  {
    name: 'workflow-status',
    description: 'Check the status of recent workflow runs',
    options: [
      {
        name: 'limit',
        description: 'Number of recent runs to show (1-10)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 10
      },
      {
        name: 'auto_refresh',
        description: 'Auto-refresh status every 30 seconds?',
        type: 5,
        required: false
      }
    ]
  },
  {
    name: 'cancel-workflow',
    description: 'Cancel a running workflow',
    options: [
      {
        name: 'run_id',
        description: 'Workflow run ID (leave empty to cancel latest)',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'build-logs',
    description: 'Get logs from a workflow run',
    options: [
      {
        name: 'run_id',
        description: 'Workflow run ID (leave empty for latest)',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'list-artifacts',
    description: 'List build artifacts from a workflow run',
    options: [
      {
        name: 'run_id',
        description: 'Workflow run ID (leave empty for latest)',
        type: 3,
        required: false
      }
    ]
  },
  {
    name: 'workflow-history',
    description: 'View workflow run history with statistics',
    options: [
      {
        name: 'days',
        description: 'Number of days to look back (1-30)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 30
      }
    ]
  },
  {
    name: 'bot-info',
    description: 'Display bot information and statistics'
  },
  {
    name: 'help',
    description: 'Show all available commands with examples'
  }
];

// ================================
// UTILITY CONSTANTS
// ================================
const PLATFORM_EMOJI = {
  'all': '🌐',
  'android': '🤖',
  'windows': '🪟',
  'linux': '🐧',
  'ios': '🍎',
  'macos': '💻'
};

const STATUS_EMOJI = {
  'completed': '✅',
  'in_progress': '🔄',
  'queued': '⏳',
  'waiting': '⏸️',
  'requested': '📝',
  'pending': '⏳'
};

const CONCLUSION_EMOJI = {
  'success': '✅',
  'failure': '❌',
  'cancelled': '🚫',
  'skipped': '⏭️',
  'timed_out': '⏰',
  'action_required': '⚠️',
  'neutral': '➖'
};

const COLOR_MAP = {
  success: 0x00FF00,
  failure: 0xFF0000,
  cancelled: 0xFFA500,
  in_progress: 0xFFFF00,
  queued: 0x808080,
  info: 0x5865F2
};

// ================================
// UTILITY FUNCTIONS
// ================================

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);
  
  if (CONFIG.features.enableLogging) {
    try {
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir);
      }
      const logFile = path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`);
      fs.appendFileSync(logFile, logMessage + '\n');
    } catch (error) {
      console.error(`Failed to write to log file: ${error.message}`);
    }
  }
}

async function checkPermissions(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  if (!CONFIG.features.requirePermissions) {
    return true;
  }

  if (CONFIG.discord.allowedRoleIds.length === 0) {
    return true;
  }

  const hasRole = interaction.member.roles.cache.some(role => 
    CONFIG.discord.allowedRoleIds.includes(role.id)
  );

  if (!hasRole) {
    await interaction.reply({
      content: '❌ You do not have permission to use this command. Required role missing.',
      ephemeral: true
    });
    return false;
  }

  return true;
}

async function sendLogMessage(message, embed = null) {
  if (!CONFIG.discord.logChannelId) return;
  
  try {
    const channel = await client.channels.fetch(CONFIG.discord.logChannelId);
    if (channel && channel.isTextBased()) {
      if (embed) {
        await channel.send({ content: message, embeds: [embed] });
      } else {
        await channel.send(message);
      }
    }
  } catch (error) {
    log(`Failed to send log message: ${error.message}`, 'ERROR');
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function createActionButtons(runId, runUrl, includeCancel = false) {
  const row = new ActionRowBuilder();
  
  row.addComponents(
    new ButtonBuilder()
      .setLabel('View on GitHub')
      .setStyle(ButtonStyle.Link)
      .setURL(runUrl)
      .setEmoji('🔗')
  );

  if (includeCancel) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`cancel_${runId}`)
        .setLabel('Cancel Build')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🚫')
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`refresh_${runId}`)
      .setLabel('Refresh Status')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄')
  );

  return row;
}

// ================================
// COMMAND HANDLERS
// ================================

async function handleBuildCommand(interaction) {
  await interaction.deferReply();

  const platform = interaction.options.getString('platform');
  const cleanBuild = interaction.options.getBoolean('clean_build') ?? false;
  const pingDiscord = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      workflow_id: CONFIG.repo.workflowFile,
      ref: CONFIG.repo.branch,
      inputs: {
        build_targets: platform,
        clean_build: cleanBuild.toString(),
        ping_discord: pingDiscord.toString()
      }
    });

    // Wait a moment for the workflow to appear
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try to get the latest run
    let latestRun = null;
    try {
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        owner: CONFIG.repo.owner,
        repo: CONFIG.repo.name,
        workflow_id: CONFIG.repo.workflowFile,
        per_page: 1
      });
      if (runs.workflow_runs.length > 0) {
        latestRun = runs.workflow_runs[0];
      }
    } catch (error) {
      log(`Could not fetch latest run: ${error.message}`, 'WARN');
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_MAP.success)
      .setTitle('✅ Build Workflow Triggered')
      .setDescription('The Dartotsu build workflow has been successfully triggered!')
      .addFields(
        { 
          name: '🎯 Platform', 
          value: `${PLATFORM_EMOJI[platform] || '📦'} **${platform.toUpperCase()}**`, 
          inline: true 
        },
        { 
          name: '🧹 Clean Build', 
          value: cleanBuild ? '✅ Yes' : '❌ No', 
          inline: true 
        },
        { 
          name: '🔔 Discord Ping', 
          value: pingDiscord ? '✅ Enabled' : '❌ Disabled', 
          inline: true 
        },
        { 
          name: '👤 Triggered By', 
          value: `${interaction.user.tag}`, 
          inline: true 
        },
        { 
          name: '🌿 Branch', 
          value: `\`${CONFIG.repo.branch}\``, 
          inline: true 
        },
        { 
          name: '⏰ Time', 
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`, 
          inline: true 
        }
      )
      .setURL(`https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/actions/workflows/${CONFIG.repo.workflowFile}`)
      .setFooter({ 
        text: 'Build started! Use /workflow-status to track progress',
        iconURL: interaction.user.displayAvatarURL()
      })
      .setTimestamp();

    const components = [];
    if (latestRun) {
      components.push(createActionButtons(latestRun.id, latestRun.html_url, true));
    }

    await interaction.editReply({ 
      embeds: [embed],
      components: components
    });

    log(`Build triggered by ${interaction.user.tag} - Platform: ${platform}, Clean: ${cleanBuild}, Ping: ${pingDiscord}`, 'INFO');
    
    await sendLogMessage(
      `🚀 New build triggered by ${interaction.user.tag}`,
      embed
    );

  } catch (error) {
    log(`Error triggering workflow: ${error.message}`, 'ERROR');

    const errorEmbed = new EmbedBuilder()
      .setColor(COLOR_MAP.failure)
      .setTitle('❌ Build Trigger Failed')
      .setDescription('Failed to trigger the build workflow. Please check the error below.')
      .addFields(
        { name: '🐛 Error', value: `\`\`\`${error.message}\`\`\`` },
        { name: '💡 Possible Causes', value: '• Invalid GitHub token\n• Workflow file not found\n• Repository permissions\n• Network issues\n• API rate limit' }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

async function handleStatusCommand(interaction) {
  await interaction.deferReply();

  const limit = interaction.options.getInteger('limit') || 5;
  const autoRefresh = interaction.options.getBoolean('auto_refresh') ?? false;

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      workflow_id: CONFIG.repo.workflowFile,
      per_page: limit
    });

    if (runs.workflow_runs.length === 0) {
      return interaction.editReply('📭 No workflow runs found for this workflow.');
    }

    const latestRun = runs.workflow_runs[0];
    
    let duration = 'N/A';
    if (latestRun.updated_at && latestRun.created_at) {
      const durationMs = new Date(latestRun.updated_at) - new Date(latestRun.created_at);
      duration = formatDuration(durationMs);
    }

    const statusIcon = STATUS_EMOJI[latestRun.status] || '❓';
    const conclusionIcon = latestRun.conclusion ? (CONCLUSION_EMOJI[latestRun.conclusion] || '❓') : '⏳';
    
    const color = latestRun.conclusion === 'success' ? COLOR_MAP.success :
                  latestRun.conclusion === 'failure' ? COLOR_MAP.failure :
                  latestRun.status === 'in_progress' ? COLOR_MAP.in_progress :
                  COLOR_MAP.queued;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('📊 Latest Workflow Status')
      .setURL(latestRun.html_url)
      .setDescription(`**${latestRun.display_title || latestRun.name}**`)
      .addFields(
        { 
          name: '📍 Status', 
          value: `${statusIcon} ${latestRun.status.replace('_', ' ').toUpperCase()}`, 
          inline: true 
        },
        { 
          name: '🎯 Conclusion', 
          value: latestRun.conclusion ? `${conclusionIcon} ${latestRun.conclusion.toUpperCase()}` : '⏳ Running', 
          inline: true 
        },
        { 
          name: '⏱️ Duration', 
          value: duration, 
          inline: true 
        },
        { 
          name: '🌿 Branch', 
          value: `\`${latestRun.head_branch}\``, 
          inline: true 
        },
        { 
          name: '🔢 Run #', 
          value: `${latestRun.run_number}`, 
          inline: true 
        },
        { 
          name: '🆔 Run ID', 
          value: `\`${latestRun.id}\``, 
          inline: true 
        },
        { 
          name: '💬 Commit', 
          value: `\`\`\`${latestRun.head_commit?.message.split('\n')[0].substring(0, 80) || 'N/A'}\`\`\``, 
          inline: false 
        },
        { 
          name: '👤 Author', 
          value: latestRun.head_commit?.author?.name || latestRun.triggering_actor?.login || 'Unknown', 
          inline: true 
        },
        { 
          name: '📅 Started', 
          value: `<t:${Math.floor(new Date(latestRun.created_at).getTime() / 1000)}:R>`, 
          inline: true 
        }
      )
      .setTimestamp();

    if (autoRefresh) {
      embed.setFooter({ text: '🔄 Auto-refresh enabled (30s)' });
    }

    if (runs.workflow_runs.length > 1) {
      const recentRuns = runs.workflow_runs.slice(1, limit).map((run) => {
        const status = run.conclusion ? (CONCLUSION_EMOJI[run.conclusion] || '❓') : (STATUS_EMOJI[run.status] || '❓');
        const time = `<t:${Math.floor(new Date(run.created_at).getTime() / 1000)}:R>`;
        return `${status} [#${run.run_number}](${run.html_url}) - ${run.head_branch} - ${time}`;
      }).join('\n');
      
      embed.addFields({ 
        name: `📋 Recent Runs (${limit - 1} more)`, 
        value: recentRuns || 'No recent runs' 
      });
    }

    const includeCancel = latestRun.status === 'in_progress' || latestRun.status === 'queued';
    const components = [createActionButtons(latestRun.id, latestRun.html_url, includeCancel)];

    await interaction.editReply({ embeds: [embed], components: components });

    if (autoRefresh && (latestRun.status === 'in_progress' || latestRun.status === 'queued')) {
      setTimeout(() => autoRefreshStatus(interaction, latestRun.id), CONFIG.features.refreshInterval);
    }

  } catch (error) {
    log(`Error fetching workflow status: ${error.message}`, 'ERROR');
    
    const errorEmbed = new EmbedBuilder()
      .setColor(COLOR_MAP.failure)
      .setTitle('❌ Failed to Fetch Status')
      .setDescription(`Error: ${error.message}`)
      .setTimestamp();
    
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

async function autoRefreshStatus(interaction, runId) {
  try {
    const { data: run } = await octokit.actions.getWorkflowRun({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      run_id: runId
    });

    if (run.status === 'completed') {
      const embed = new EmbedBuilder()
        .setColor(run.conclusion === 'success' ? COLOR_MAP.success : COLOR_MAP.failure)
        .setTitle(`${CONCLUSION_EMOJI[run.conclusion] || '✅'} Build ${run.conclusion === 'success' ? 'Completed Successfully' : 'Failed'}`)
        .setDescription(`Workflow run #${run.run_number} has ${run.conclusion}`)
        .addFields(
          { name: '⏱️ Duration', value: formatDuration(new Date(run.updated_at) - new Date(run.created_at)), inline: true },
          { name: '🔗 View Details', value: `[Open on GitHub](${run.html_url})`, inline: true }
        )
        .setTimestamp();

      await interaction.followUp({ embeds: [embed] });
    }
  } catch (error) {
    log(`Auto-refresh error: ${error.message}`, 'ERROR');
  }
}

async function handleCancelCommand(interaction) {
  await interaction.deferReply();

  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        owner: CONFIG.repo.owner,
        repo: CONFIG.repo.name,
        workflow_id: CONFIG.repo.workflowFile,
        status: 'in_progress',
        per_page: 1
      });

      if (runs.workflow_runs.length === 0) {
        return interaction.editReply('❌ No running workflows found to cancel.');
      }

      runId = runs.workflow_runs[0].id;
    }

    await octokit.actions.cancelWorkflowRun({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      run_id: runId
    });

    const embed = new EmbedBuilder()
      .setColor(COLOR_MAP.cancelled)
      .setTitle('🚫 Workflow Cancelled')
      .setDescription(`Workflow run #${runId} has been cancelled.`)
      .addFields(
        { name: '👤 Cancelled By', value: interaction.user.tag, inline: true },
        { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    
    log(`Workflow ${runId} cancelled by ${interaction.user.tag}`, 'INFO');

  } catch (error) {
    log(`Error cancelling workflow: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Failed to cancel workflow: ${error.message}`);
  }
}

async function handleLogsCommand(interaction) {
  await interaction.deferReply();

  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        owner: CONFIG.repo.owner,
        repo: CONFIG.repo.name,
        workflow_id: CONFIG.repo.workflowFile,
        per_page: 1
      });

      if (runs.workflow_runs.length === 0) {
        return interaction.editReply('❌ No workflow runs found.');
      }

      runId = runs.workflow_runs[0].id;
    }

    const { data: run } = await octokit.actions.getWorkflowRun({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      run_id: runId
    });

    const embed = new EmbedBuilder()
      .setColor(COLOR_MAP.info)
      .setTitle('📋 Workflow Logs')
      .setDescription(`Viewing logs for workflow run #${run.run_number}`)
      .addFields(
        { name: '🔗 View Full Logs', value: `[Open on GitHub](${run.html_url})`, inline: false },
        { name: '📍 Status', value: run.status, inline: true },
        { name: '🎯 Conclusion', value: run.conclusion || 'Running', inline: true },
        { name: '🌿 Branch', value: run.head_branch, inline: true }
      )
      .setTimestamp();

    const components = [createActionButtons(run.id, run.html_url, false)];

    await interaction.editReply({ embeds: [embed], components: components });

  } catch (error) {
    log(`Error fetching logs: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Failed to fetch logs: ${error.message}`);
  }
}

async function handleArtifactsCommand(interaction) {
  await interaction.deferReply();

  let runId = interaction.options.getString('run_id');

  try {
    if (!runId) {
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        owner: CONFIG.repo.owner,
        repo: CONFIG.repo.name,
        workflow_id: CONFIG.repo.workflowFile,
        per_page: 1
      });

      if (runs.workflow_runs.length === 0) {
        return interaction.editReply('❌ No workflow runs found.');
      }

      runId = runs.workflow_runs[0].id;
    }

    const { data: artifacts } = await octokit.actions.listWorkflowRunArtifacts({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      run_id: runId
    });

    if (artifacts.artifacts.length === 0) {
      return interaction.editReply('📭 No artifacts found for this workflow run.');
    }

    const artifactList = artifacts.artifacts.map(artifact => {
      const size = formatBytes(artifact.size_in_bytes);
      const expired = artifact.expired ? '❌ Expired' : '✅ Available';
      return `**${artifact.name}**\n├ Size: ${size}\n├ Status: ${expired}\n└ Created: <t:${Math.floor(new Date(artifact.created_at).getTime() / 1000)}:R>`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setColor(COLOR_MAP.info)
      .setTitle('📦 Build Artifacts')
      .setDescription(`Found ${artifacts.artifacts.length} artifact(s) for run #${runId}`)
      .addFields({ name: 'Artifacts', value: artifactList })
      .setFooter({ text: 'Download artifacts from GitHub Actions page' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    log(`Error fetching artifacts: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Failed to fetch artifacts: ${error.message}`);
  }
}

async function handleHistoryCommand(interaction) {
  await interaction.deferReply();

  const days = interaction.options.getInteger('days') || 7;
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      workflow_id: CONFIG.repo.workflowFile,
      per_page: 100,
      created: `>=${sinceDate.toISOString()}`
    });

    if (runs.workflow_runs.length === 0) {
      return interaction.editReply(`📭 No workflow runs found in the last ${days} day(s).`);
    }

    const stats = {
      total: runs.workflow_runs.length,
      success: 0,
      failure: 0,
      cancelled: 0,
      inProgress: 0,
      totalDuration: 0
    };

    runs.workflow_runs.forEach(run => {
      if (run.conclusion === 'success') stats.success++;
      else if (run.conclusion === 'failure') stats.failure++;
      else if (run.conclusion === 'cancelled') stats.cancelled++;
      else if (run.status === 'in_progress') stats.inProgress++;

      if (run.updated_at && run.created_at) {
        stats.totalDuration += new Date(run.updated_at) - new Date(run.created_at);
      }
    });

    const successRate = ((stats.success / stats.total) * 100).toFixed(1);
    const avgDuration = formatDuration(stats.totalDuration / stats.total);

    const embed = new EmbedBuilder()
      .setColor(COLOR_MAP.info)
      .setTitle('📊 Workflow History & Statistics')
      .setDescription(`Analysis of the last ${days} day(s)`)
      .addFields(
        { name: '📈 Total Runs', value: `${stats.total}`, inline: true },
        { name: '✅ Success', value: `${stats.success} (${successRate}%)`, inline: true },
        { name: '❌ Failed', value: `${stats.failure}`, inline: true },
        { name: '🚫 Cancelled', value: `${stats.cancelled}`, inline: true },
        { name: '🔄 In Progress', value: `${stats.inProgress}`, inline: true },
        { name: '⏱️ Avg Duration', value: avgDuration, inline: true }
      )
      .setFooter({ text: `Data from ${runs.workflow_runs.length} workflow runs` })
      .setTimestamp();

    const recentRuns = runs.workflow_runs.slice(0, 10).map((run) => {
      const status = run.conclusion ? (CONCLUSION_EMOJI[run.conclusion] || '❓') : (STATUS_EMOJI[run.status] || '❓');
      const time = `<t:${Math.floor(new Date(run.created_at).getTime() / 1000)}:R>`;
      return `${status} [#${run.run_number}](${run.html_url}) - ${time}`;
    }).join('\n');

    embed.addFields({ name: '📋 Recent Runs', value: recentRuns });

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    log(`Error fetching history: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Failed to fetch history: ${error.message}`);
  }
}

async function handleBotInfoCommand(interaction) {
  const uptime = process.uptime();
  const uptimeFormatted = formatDuration(uptime * 1000);
  const memoryUsage = process.memoryUsage();
  const memoryFormatted = formatBytes(memoryUsage.heapUsed);
  
  const embed = new EmbedBuilder()
    .setColor(COLOR_MAP.info)
    .setTitle('🤖 Dartotsu Build Bot')
    .setDescription('A Discord bot for triggering and managing GitHub Actions workflows for the Dartotsu project.')
    .addFields(
      { name: '📦 Repository', value: `[${CONFIG.repo.owner}/${CONFIG.repo.name}](https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name})`, inline: true },
      { name: '🔧 Workflow', value: `\`${CONFIG.repo.workflowFile}\``, inline: true },
      { name: '⏰ Uptime', value: uptimeFormatted, inline: true },
      { name: '🌐 Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: '📊 Commands', value: `${commands.length}`, inline: true },
      { name: '💾 Memory', value: memoryFormatted, inline: true },
      { name: '🔗 Version', value: '2.0.0 Enhanced', inline: true },
      { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
      { name: '🟢 Status', value: 'Online', inline: true },
      { name: '✨ New Features', value: '• Interactive buttons\n• Auto-refresh status\n• Artifact listing\n• Workflow history\n• Better error handling\n• Improved UI/UX', inline: false },
      { name: '📚 Commands Available', value: '• `/build` - Trigger builds\n• `/workflow-status` - Check status\n• `/cancel-workflow` - Cancel runs\n• `/build-logs` - View logs\n• `/list-artifacts` - View artifacts\n• `/workflow-history` - Statistics\n• `/bot-info` - This info\n• `/help` - Command help', inline: false }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setLabel('GitHub Repository')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}`)
        .setEmoji('📦'),
      new ButtonBuilder()
        .setLabel('Actions')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/actions`)
        .setEmoji('⚡')
    );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleHelpCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_MAP.info)
    .setTitle('📚 Command Help & Examples')
    .setDescription('Here are all available commands with usage examples:')
    .addFields(
      {
        name: '🚀 /build',
        value: '**Trigger a build workflow**\n' +
               '• `/build platform:android` - Build for Android\n' +
               '• `/build platform:all clean_build:true` - Clean build all platforms\n' +
               '• `/build platform:windows ping_discord:true` - Build Windows with notification',
        inline: false
      },
      {
        name: '📊 /workflow-status',
        value: '**Check workflow status**\n' +
               '• `/workflow-status` - View latest workflow\n' +
               '• `/workflow-status limit:10` - Show 10 recent runs\n' +
               '• `/workflow-status auto_refresh:true` - Auto-refresh running builds',
        inline: false
      },
      {
        name: '🚫 /cancel-workflow',
        value: '**Cancel a running workflow**\n' +
               '• `/cancel-workflow` - Cancel latest running workflow\n' +
               '• `/cancel-workflow run_id:12345` - Cancel specific run',
        inline: false
      },
      {
        name: '📋 /build-logs',
        value: '**View workflow logs**\n' +
               '• `/build-logs` - View logs for latest run\n' +
               '• `/build-logs run_id:12345` - View logs for specific run',
        inline: false
      },
      {
        name: '📦 /list-artifacts',
        value: '**List build artifacts**\n' +
               '• `/list-artifacts` - List artifacts from latest build\n' +
               '• `/list-artifacts run_id:12345` - List artifacts from specific run',
        inline: false
      },
      {
        name: '📈 /workflow-history',
        value: '**View workflow statistics**\n' +
               '• `/workflow-history` - Last 7 days statistics\n' +
               '• `/workflow-history days:30` - Last 30 days statistics',
        inline: false
      },
      {
        name: '🤖 /bot-info',
        value: '**Display bot information**\n' +
               '• `/bot-info` - Show bot stats and version',
        inline: false
      }
    )
    .setFooter({ text: 'Tip: Most commands work with just the command name - optional parameters provide more control!' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ================================
// BUTTON INTERACTION HANDLER
// ================================

async function handleButtonInteraction(interaction) {
  const [action, runId] = interaction.customId.split('_');

  if (action === 'cancel') {
    await interaction.deferUpdate();
    
    try {
      await octokit.actions.cancelWorkflowRun({
        owner: CONFIG.repo.owner,
        repo: CONFIG.repo.name,
        run_id: runId
      });

      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(COLOR_MAP.cancelled)
        .setFooter({ text: `Cancelled by ${interaction.user.tag}` });

      await interaction.editReply({ embeds: [embed], components: [] });
      await interaction.followUp({ 
        content: `✅ Workflow run cancelled successfully!`, 
        ephemeral: true 
      });

      log(`Workflow ${runId} cancelled via button by ${interaction.user.tag}`, 'INFO');

    } catch (error) {
      log(`Error cancelling workflow via button: ${error.message}`, 'ERROR');
      await interaction.followUp({ 
        content: `❌ Failed to cancel workflow: ${error.message}`, 
        ephemeral: true 
      });
    }
  } 
  else if (action === 'refresh') {
    await interaction.deferUpdate();

    try {
      const { data: run } = await octokit.actions.getWorkflowRun({
        owner: CONFIG.repo.owner,
        repo: CONFIG.repo.name,
        run_id: runId
      });

      let duration = 'N/A';
      if (run.updated_at && run.created_at) {
        const durationMs = new Date(run.updated_at) - new Date(run.created_at);
        duration = formatDuration(durationMs);
      }

      const statusIcon = STATUS_EMOJI[run.status] || '❓';
      const conclusionIcon = run.conclusion ? (CONCLUSION_EMOJI[run.conclusion] || '❓') : '⏳';
      
      const color = run.conclusion === 'success' ? COLOR_MAP.success :
                    run.conclusion === 'failure' ? COLOR_MAP.failure :
                    run.status === 'in_progress' ? COLOR_MAP.in_progress :
                    COLOR_MAP.queued;

      const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(color)
        .setFields(
          { 
            name: '📍 Status', 
            value: `${statusIcon} ${run.status.replace('_', ' ').toUpperCase()}`, 
            inline: true 
          },
          { 
            name: '🎯 Conclusion', 
            value: run.conclusion ? `${conclusionIcon} ${run.conclusion.toUpperCase()}` : '⏳ Running', 
            inline: true 
          },
          { 
            name: '⏱️ Duration', 
            value: duration, 
            inline: true 
          }
        )
        .setFooter({ text: `Last updated: ${new Date().toLocaleTimeString()} by ${interaction.user.tag}` })
        .setTimestamp();

      const includeCancel = run.status === 'in_progress' || run.status === 'queued';
      const components = run.status === 'completed' ? [] : [createActionButtons(run.id, run.html_url, includeCancel)];

      await interaction.editReply({ embeds: [embed], components: components });

      if (run.status === 'completed') {
        await interaction.followUp({ 
          content: `${CONCLUSION_EMOJI[run.conclusion] || '✅'} Build ${run.conclusion}!`, 
          ephemeral: true 
        });
      }

    } catch (error) {
      log(`Error refreshing status: ${error.message}`, 'ERROR');
      await interaction.followUp({ 
        content: `❌ Failed to refresh status: ${error.message}`, 
        ephemeral: true 
      });
    }
  }
}

// ================================
// EVENT HANDLERS
// ================================

client.once('ready', async () => {
  log(`✅ Logged in as ${client.user.tag}`, 'INFO');
  
  client.user.setActivity('GitHub Actions 🚀', { type: 3 });
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    log('🔄 Registering slash commands...', 'INFO');
    
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: commands }
      );
      log(`✅ Registered ${commands.length} guild commands for quick testing!`, 'INFO');
    } else {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
      log(`✅ Registered ${commands.length} global commands (may take up to 1 hour to appear)`, 'INFO');
    }

    log(`🤖 Bot is ready! Serving ${client.guilds.cache.size} server(s)`, 'INFO');
    
  } catch (error) {
    log(`❌ Error registering commands: ${error.message}`, 'ERROR');
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!await checkPermissions(interaction)) return;

      switch (interaction.commandName) {
        case 'build':
          await handleBuildCommand(interaction);
          break;
        case 'workflow-status':
          await handleStatusCommand(interaction);
          break;
        case 'cancel-workflow':
          await handleCancelCommand(interaction);
          break;
        case 'build-logs':
          await handleLogsCommand(interaction);
          break;
        case 'list-artifacts':
          await handleArtifactsCommand(interaction);
          break;
        case 'workflow-history':
          await handleHistoryCommand(interaction);
          break;
        case 'bot-info':
          await handleBotInfoCommand(interaction);
          break;
        case 'help':
          await handleHelpCommand(interaction);
          break;
        default:
          await interaction.reply({ content: '❌ Unknown command', ephemeral: true });
      }
    } 
    else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  } catch (error) {
    log(`Error handling interaction: ${error.message}`, 'ERROR');
    
    const errorMessage = '❌ An error occurred while processing your request. Please try again later.';
    
    try {
      if (interaction.deferred) {
        await interaction.editReply(errorMessage);
      } else if (!interaction.replied) {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (followupError) {
      log(`Error sending error message: ${followupError.message}`, 'ERROR');
    }
  }
});

client.on('error', error => {
  log(`Discord client error: ${error.message}`, 'ERROR');
});

process.on('unhandledRejection', error => {
  log(`Unhandled promise rejection: ${error.message}`, 'ERROR');
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully...', 'INFO');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully...', 'INFO');
  client.destroy();
  process.exit(0);
});

// ================================
// START BOT
// ================================

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN is not set in environment variables!');
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  console.error('❌ ERROR: GITHUB_TOKEN is not set in environment variables!');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN)
  .then(() => log('🚀 Bot login initiated...', 'INFO'))
  .catch(error => {
    log(`Failed to login: ${error.message}`, 'ERROR');
    process.exit(1);
  });
