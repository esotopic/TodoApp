const express = require('express');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const sql = require('mssql');

const app = express();
const PORT = process.env.PORT || 3000;

// Database config — shared 1000Problems database
const dbConfig = {
    server: '***REMOVED***',
    database: '1000Problems',
    user: '***REMOVED***',
    password: '***REMOVED***',
    options: {
        encrypt: true,
        trustServerCertificate: false,
        connectTimeout: 30000,
        requestTimeout: 30000
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
};

let pool;
async function getPool() {
    if (!pool) {
        pool = await sql.connect(dbConfig);
    }
    return pool;
}

// PBKDF2 hash matching the .NET implementation
function hashPassword(password, saltBase64) {
    const saltBuffer = Buffer.from(saltBase64, 'base64');
    const hash = crypto.pbkdf2Sync(password, saltBuffer, 100000, 32, 'sha256');
    return hash.toString('base64');
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: '***REMOVED***',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    res.redirect('/login');
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Login page
app.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login API
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const db = await getPool();
        const result = await db.request()
            .input('username', sql.NVarChar, username.trim())
            .query('SELECT Id, Username, PasswordHash, Salt, CreatedDate FROM Users WHERE Username = @username');

        if (result.recordset.length === 0) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const user = result.recordset[0];
        const hash = hashPassword(password, user.Salt);

        if (hash !== user.PasswordHash) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        req.session.user = { id: user.Id, username: user.Username };
        res.json({ success: true, username: user.Username });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// API: get current user
app.get('/api/me', requireAuth, (req, res) => {
    res.json({ username: req.session.user.username });
});

// Protected main page
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`TodoApp running at http://localhost:${PORT}`);
});
