require('dotenv').config();
// Migration: Add CompletedDate column to Todo_Tasks
const sql = require('mssql');
const config = {
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: { encrypt: true, trustServerCertificate: false, connectTimeout: 30000, requestTimeout: 30000 }
};

(async () => {
    const pool = await sql.connect(config);

    // Add CompletedDate column if not exists
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Todo_Tasks') AND name = 'CompletedDate')
        ALTER TABLE Todo_Tasks ADD CompletedDate DATETIME2 NULL
    `);
    console.log('CompletedDate column ready');

    // Backfill: set CompletedDate for already-completed tasks to their UpdatedDate
    await pool.request().query(`
        UPDATE Todo_Tasks SET CompletedDate = UpdatedDate
        WHERE IsComplete = 1 AND CompletedDate IS NULL
    `);
    console.log('Backfilled CompletedDate for existing completed tasks');

    await pool.close();
    console.log('Migration complete!');
})().catch(e => { console.error(e); process.exit(1); });
