module.exports = {
  apps: [{
    name: 'ondc-connector',
    script: 'server.js',
    node_args: '-r dotenv/config',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production', PORT: 4000 },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true
  }]
}
