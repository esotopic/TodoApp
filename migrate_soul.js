// Migration: Add Soul column to Todo_UserState
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

    // Add Soul column if not exists
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Todo_UserState') AND name = 'Soul')
        ALTER TABLE Todo_UserState ADD Soul NVARCHAR(MAX) NULL
    `);
    console.log('Soul column ready');

    await pool.close();
    console.log('Migration complete!');
})().catch(e => { console.error(e); process.exit(1); });
