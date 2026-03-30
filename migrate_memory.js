require('dotenv').config();
// Migration: Add Todo_DeletedTasks table and Source column to Todo_Tasks
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

    // Create Todo_DeletedTasks if not exists
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Todo_DeletedTasks')
        CREATE TABLE Todo_DeletedTasks (
            Id INT IDENTITY(1,1) PRIMARY KEY,
            UserId INT NOT NULL FOREIGN KEY REFERENCES Users(Id),
            Title NVARCHAR(500) NOT NULL,
            Location NVARCHAR(100) NULL,
            DeletedDate DATETIME2 DEFAULT GETUTCDATE()
        )
    `);
    console.log('Todo_DeletedTasks table ready');

    // Add Source column if not exists
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Todo_Tasks') AND name = 'Source')
        ALTER TABLE Todo_Tasks ADD Source NVARCHAR(20) NULL DEFAULT 'ai'
    `);
    console.log('Source column ready');

    await pool.close();
    console.log('Migration complete!');
})().catch(e => { console.error(e); process.exit(1); });
