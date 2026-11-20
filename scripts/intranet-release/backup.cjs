const { createRequire } = require("node:module");
const fs = require("node:fs");
const [home, backupDir] = process.argv.slice(2);
const root = home + "/runtime/node_modules";
const serverRequire = createRequire(root + "/@paperclipai/server/package.json");
const dbRequire = createRequire(root + "/@paperclipai/db/package.json");
serverRequire("dotenv").config({ path: home + "/server.env", quiet: true });
const config = JSON.parse(fs.readFileSync(home + "/data/instances/default/config.json", "utf8"));
const url = process.env.DATABASE_URL || config.database.connectionString ||
  "postgres://paperclip:paperclip@127.0.0.1:" + (config.database.embeddedPostgresPort ?? 54329) + "/paperclip";
(async () => {
  const sql = dbRequire("postgres")(url, { max: 1 });
  try {
    const [{ active }] = await sql`select count(*)::int as active from heartbeat_runs where status in ('queued','running','scheduled_retry')`;
    if (active) {
      console.error(`等待 ${active} 个 heartbeat 运行结束后再发布。`);
      process.exitCode = 10;
      return;
    }
    const { runDatabaseBackup } = await import(root + "/@paperclipai/db/dist/index.js");
    const backup = await runDatabaseBackup({
      connectionString: url, backupDir, filenamePrefix: "pre-deployment",
      retention: { dailyDays: 30, weeklyWeeks: 4, monthlyMonths: 1 },
    });
    console.log(JSON.stringify({ activeRuns: active, ...backup }));
  } finally {
    await sql.end();
  }
})().catch(() => {
  console.error("数据库预检或备份失败。");
  process.exitCode = 1;
});
