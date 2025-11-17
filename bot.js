// Dartotsu Discord Bot - Complete Implementation
// Triggers GitHub Actions workflow for building Dartotsu
// Repository: https://github.com/Shebyyy/Dartotsu

// Polyfill ReadableStream for older Node.js versions
if (typeof ReadableStream === 'undefined') {
  try {
    // Try to use Node.js built-in stream/web (Node.js >= 16.5.0)
    ReadableStream = require('stream/web').ReadableStream;
  } catch (e) {
    // Fallback to a minimal polyfill
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
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { Octokit } = require('@octokit/rest');

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
  request: { fetch: require('node-fetch') } // Add this line
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
    enableStatusUpdates: process.env.ENABLE_STATUS_UPDATES === 'true'
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
        type: 3, // STRING
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
        type: 5, // BOOLEAN
        required: false
      },
      {
        name: 'ping_discord',
        description: 'Ping Discord role when build completes?',
        type: 5, // BOOLEAN
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
        type: 4, // INTEGER
        required: false,
        min_value: 1,
        max_value: 10
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
        type: 3, // STRING
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
        type: 3, // STRING
        required: false
      }
    ]
  },
  {
    name: 'bot-info',
    description: 'Display bot information and statistics'
  }
];

// ================================
// UTILITY FUNCTIONS
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
  'requested': '📝'
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
  queued: 0x808080
};

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);
  
  if (CONFIG.features.enableLogging) {
    // Optional: Write to file
    const fs = require('fs');
    fs.appendFileSync('bot.log', logMessage + '\n');
  }
}

async function checkPermissions(interaction) {
  // Always allow administrators
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  // Check if permission checking is required
  if (!CONFIG.features.requirePermissions) {
    return true;
  }

  // Check allowed roles
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

// ================================
// COMMAND HANDLERS
// ================================

async function handleBuildCommand(interaction) {
  await interaction.deferReply();

  const platform = interaction.options.getString('platform');
  const cleanBuild = interaction.options.getBoolean('clean_build') ?? false;
  const pingDiscord = interaction.options.getBoolean('ping_discord') ?? false;

  try {
    // Trigger workflow dispatch
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
        text: 'Click the title to view workflow runs on GitHub',
        iconURL: interaction.user.displayAvatarURL()
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

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
        { name: '💡 Possible Causes', value: '• Invalid GitHub token\n• Workflow file not found\n• Repository permissions\n• Network issues' }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

async function handleStatusCommand(interaction) {
  await interaction.deferReply();

  const limit = interaction.options.getInteger('limit') || 5;

  try {
    // Get latest workflow runs
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
    
    // Calculate duration
    let duration = 'N/A';
    if (latestRun.updated_at && latestRun.created_at) {
      const durationMs = new Date(latestRun.updated_at) - new Date(latestRun.created_at);
      duration = formatDuration(durationMs);
    }

    const statusIcon = STATUS_EMOJI[latestRun.status] || '❓';
    const conclusionIcon = latestRun.conclusion ? (CONCLUSION_EMOJI[latestRun.conclusion] || '❓') : 'N/A';
    
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

    // Add recent runs summary
    if (runs.workflow_runs.length > 1) {
      const recentRuns = runs.workflow_runs.slice(1, limit).map((run, index) => {
        const status = run.conclusion ? (CONCLUSION_EMOJI[run.conclusion] || '❓') : (STATUS_EMOJI[run.status] || '❓');
        const time = `<t:${Math.floor(new Date(run.created_at).getTime() / 1000)}:R>`;
        return `${status} [#${run.run_number}](${run.html_url}) - ${run.head_branch} - ${time}`;
      }).join('\n');
      
      embed.addFields({ 
        name: `📋 Recent Runs (${limit - 1} more)`, 
        value: recentRuns || 'No recent runs' 
      });
    }

    await interaction.editReply({ embeds: [embed] });

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

async function handleCancelCommand(interaction) {
  await interaction.deferReply();

  let runId = interaction.options.getString('run_id');

  try {
    // If no run ID provided, get the latest running workflow
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

    // Cancel the workflow
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
    // If no run ID provided, get the latest workflow
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

    // Get workflow run details
    const { data: run } = await octokit.actions.getWorkflowRun({
      owner: CONFIG.repo.owner,
      repo: CONFIG.repo.name,
      run_id: runId
    });

    const embed = new EmbedBuilder()
      .setColor(COLOR_MAP.in_progress)
      .setTitle('📋 Workflow Logs')
      .setDescription(`Viewing logs for workflow run #${run.run_number}`)
      .addFields(
        { name: '🔗 View Full Logs', value: `[Open on GitHub](${run.html_url})`, inline: false },
        { name: '📍 Status', value: run.status, inline: true },
        { name: '🎯 Conclusion', value: run.conclusion || 'Running', inline: true },
        { name: '🌿 Branch', value: run.head_branch, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    log(`Error fetching logs: ${error.message}`, 'ERROR');
    await interaction.editReply(`❌ Failed to fetch logs: ${error.message}`);
  }
}

async function handleBotInfoCommand(interaction) {
  const uptime = process.uptime();
  const uptimeFormatted = formatDuration(uptime * 1000);
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🤖 Dartotsu Build Bot')
    .setDescription('A Discord bot for triggering and managing GitHub Actions workflows for the Dartotsu project.')
    .addFields(
      { name: '📦 Repository', value: `[${CONFIG.repo.owner}/${CONFIG.repo.name}](https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name})`, inline: true },
      { name: '🔧 Workflow', value: `\`${CONFIG.repo.workflowFile}\``, inline: true },
      { name: '⏰ Uptime', value: uptimeFormatted, inline: true },
      { name: '🌐 Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: '📊 Commands', value: `${commands.length}`, inline: true },
      { name: '🔗 Version', value: '1.0.0', inline: true },
      { name: '📚 Commands Available', value: '• `/build` - Trigger builds\n• `/workflow-status` - Check status\n• `/cancel-workflow` - Cancel runs\n• `/build-logs` - View logs\n• `/bot-info` - This info', inline: false }
    )
    .setThumbnail(client.user.displayAvatarURL())
    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ================================
// EVENT HANDLERS
// ================================

client.once('ready', async () => {
  log(`✅ Logged in as ${client.user.tag}`, 'INFO');
  
  // Set bot status
  client.user.setActivity('GitHub Actions', { type: 3 }); // Type 3 = Watching
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    log('🔄 Registering slash commands...', 'INFO');
    
    if (process.env.GUILD_ID) {
      // Guild commands (instant update, for development)
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: commands }
      );
      log(`✅ Registered ${commands.length} guild commands for quick testing!`, 'INFO');
    } else {
      // Global commands (takes up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
      log(`✅ Registered ${commands.length} global commands (may take up to 1 hour to appear)`, 'INFO');
    }
  } catch (error) {
    log(`❌ Error registering commands: ${error.message}`, 'ERROR');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Check permissions
  if (!await checkPermissions(interaction)) return;

  try {
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
      case 'bot-info':
        await handleBotInfoCommand(interaction);
        break;
      default:
        await interaction.reply({ content: '❌ Unknown command', ephemeral: true });
    }
  } catch (error) {
    log(`Error handling command ${interaction.commandName}: ${error.message}`, 'ERROR');
    
    const errorMessage = '❌ An error occurred while processing your command. Please try again later.';
    
    if (interaction.deferred) {
      await interaction.editReply(errorMessage);
    } else if (!interaction.replied) {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

// Error handling
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
