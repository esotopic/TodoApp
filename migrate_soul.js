// Migration: Add Soul column to Todo_UserState
const sql = require('mssql');
const config = {
    server: '***REMOVED***',
    database: '1000Problems',
    user: '***REMOVED***',
    password: '***REMOVED***',
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
