const { app } = require('./app');
const { env } = require('./config/env');
const { prisma } = require('./config/prisma');

async function startServer() {
  await prisma.$connect();
  const server = app.listen(env.PORT, () => {
    console.log(`Daymark API listening on http://localhost:${env.PORT}`);
  });

  let isShuttingDown = false;
  async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} received; closing server.`);
    server.close(async (error) => {
      if (error) console.error(error);
      await prisma.$disconnect();
      process.exit(error ? 1 : 0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(async (error) => {
  console.error('Could not start the API server.', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
