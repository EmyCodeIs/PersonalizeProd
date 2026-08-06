'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const common = {
  cwd: __dirname,
  interpreter: '/bin/bash',
  autorestart: true,
  restart_delay: 0,
  min_uptime: '60s',
  kill_timeout: 15000,
  time: true,
  env: {
    NODE_ENV: 'production',
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'personalize-session-access',
      script: 'scripts/watch-session-access.sh',
      max_restarts: 20,
      max_memory_restart: '200M',
    },
    {
      ...common,
      name: 'personalize-wppconnect',
      script: 'scripts/start-vps-whatsapp.sh',
      max_restarts: 30,
      exp_backoff_restart_delay: 5000,
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '1200M',
    },
    {
      ...common,
      name: 'personalize-backup',
      script: 'scripts/backup-vps-state.sh',
      autorestart: false,
      cron_restart: '15 3 * * *',
      max_restarts: 0,
      max_memory_restart: '150M',
    },
  ],
};
