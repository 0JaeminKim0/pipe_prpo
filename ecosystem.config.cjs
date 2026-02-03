module.exports = {
  apps: [
    {
      name: 'pr-po-agent',
      script: 'server.js',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
