const express = require('express');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const sql = require('mssql');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Claude API — key from environment variable
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Database config
const dbConfig = {
    server: '***REMOVED***',
    database: '1000Problems',
    user: '***REMOVED***',
    password: '***REMOVED***',
    options: { encrypt: true, trustServerCertificate: false, connectTimeout: 30000, requestTimeout: 30000 },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
};

let pool;
async function getPool() {
    if (!pool) { pool = await sql.connect(dbConfig); }
    return pool;
}

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
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    res.redirect('/login');
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// AUTH ROUTES
// ============================================================================
app.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        const db = await getPool();
        const result = await db.request()
            .input('username', sql.NVarChar, username.trim())
            .query('SELECT Id, Username, PasswordHash, Salt FROM Users WHERE Username = @username');
        if (result.recordset.length === 0) return res.status(401).json({ error: 'Invalid username or password' });
        const user = result.recordset[0];
        const hash = hashPassword(password, user.Salt);
        if (hash !== user.PasswordHash) return res.status(401).json({ error: 'Invalid username or password' });
        req.session.user = { id: user.Id, username: user.Username };
        res.json({ success: true, username: user.Username });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/me', requireAuth, (req, res) => { res.json({ username: req.session.user.username }); });

// Protected main page
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// USER STATE (onboarding)
// ============================================================================
app.get('/api/state', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        const result = await db.request()
            .input('userId', sql.Int, req.session.user.id)
            .query('SELECT OnboardingComplete FROM Todo_UserState WHERE UserId = @userId');
        if (result.recordset.length === 0) {
            return res.json({ onboardingComplete: false });
        }
        res.json({ onboardingComplete: !!result.recordset[0].OnboardingComplete });
    } catch (err) {
        console.error('State error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================================
// CHAT / AI
// ============================================================================

// Auto-start onboarding (no user "Hi" needed)
app.post('/api/chat/start', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        const userId = req.session.user.id;

        // Check if already has chat history
        const existing = await db.request()
            .input('userId', sql.Int, userId)
            .query('SELECT COUNT(*) as cnt FROM Todo_Chat WHERE UserId = @userId');
        if (existing.recordset[0].cnt > 0) {
            return res.json({ reply: null }); // Already has history
        }

        // Get onboarding state
        const stateResult = await db.request().input('userId', sql.Int, userId)
            .query('SELECT OnboardingComplete FROM Todo_UserState WHERE UserId = @userId');
        const onboardingComplete = stateResult.recordset.length > 0 && stateResult.recordset[0].OnboardingComplete;

        const systemPrompt = buildSystemPrompt(onboardingComplete, [], req.session.user.username);

        // Send a single user message to kick off the conversation
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Start' }]
        });

        let assistantText = '';
        for (const block of response.content) {
            if (block.type === 'text') assistantText += block.text;
        }

        // Parse chips from response
        const parsed = parseChips(assistantText);

        // Save both the hidden start message and reply
        await db.request().input('userId', sql.Int, userId).input('role', sql.NVarChar, 'user').input('content', sql.NVarChar, 'Start')
            .query('INSERT INTO Todo_Chat (UserId, Role, Content) VALUES (@userId, @role, @content)');
        if (parsed.cleanText) {
            await db.request().input('userId', sql.Int, userId).input('role', sql.NVarChar, 'assistant').input('content', sql.NVarChar, parsed.cleanText)
                .query('INSERT INTO Todo_Chat (UserId, Role, Content) VALUES (@userId, @role, @content)');
        }

        res.json({ reply: parsed.cleanText, chips: parsed.chips });
    } catch (err) {
        console.error('Chat start error:', err);
        res.status(500).json({ error: 'AI error: ' + err.message });
    }
});

app.get('/api/chat', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        const result = await db.request()
            .input('userId', sql.Int, req.session.user.id)
            .query('SELECT Role, Content FROM Todo_Chat WHERE UserId = @userId ORDER BY CreatedDate ASC');
        res.json({ messages: result.recordset.map(r => ({ role: r.Role, content: r.Content })) });
    } catch (err) {
        console.error('Chat fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/chat', requireAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });

        const db = await getPool();
        const userId = req.session.user.id;

        // Save user message
        await db.request()
            .input('userId', sql.Int, userId)
            .input('role', sql.NVarChar, 'user')
            .input('content', sql.NVarChar, message)
            .query('INSERT INTO Todo_Chat (UserId, Role, Content) VALUES (@userId, @role, @content)');

        // Get chat history
        const historyResult = await db.request()
            .input('userId', sql.Int, userId)
            .query('SELECT Role, Content FROM Todo_Chat WHERE UserId = @userId ORDER BY CreatedDate ASC');

        const chatHistory = historyResult.recordset.map(r => ({ role: r.Role, content: r.Content }));

        // Get onboarding state
        const stateResult = await db.request()
            .input('userId', sql.Int, userId)
            .query('SELECT OnboardingComplete FROM Todo_UserState WHERE UserId = @userId');
        const onboardingComplete = stateResult.recordset.length > 0 && stateResult.recordset[0].OnboardingComplete;

        // Get existing tasks for context
        const tasksResult = await db.request()
            .input('userId', sql.Int, userId)
            .query('SELECT Id, Title, Category, Location, IsComplete FROM Todo_Tasks WHERE UserId = @userId ORDER BY SortOrder ASC');
        const existingTasks = tasksResult.recordset;

        // Build system prompt
        const systemPrompt = buildSystemPrompt(onboardingComplete, existingTasks, req.session.user.username);

        // Call Claude with tool use
        const tools = [
            {
                name: 'save_tasks',
                description: 'Save a list of todo tasks for the user. Use this when the user has confirmed their task list or when generating tasks from the onboarding conversation. Each task has a title and optional category.',
                input_schema: {
                    type: 'object',
                    properties: {
                        tasks: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string', description: 'The task title' },
                                    category: { type: 'string', description: 'One of: Home, Work, Health, Learning' },
                                    location: { type: 'string', description: 'Where this task happens — e.g. Costco, Supermarket, Gym, Office, Home, Library, Pharmacy, Online. Be specific and consistent.' }
                                },
                                required: ['title']
                            }
                        },
                        complete_onboarding: {
                            type: 'boolean',
                            description: 'Set to true when the onboarding conversation is complete and tasks have been generated'
                        }
                    },
                    required: ['tasks']
                }
            }
        ];

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: systemPrompt,
            tools: tools,
            messages: chatHistory
        });

        // Process response - handle tool use
        let assistantText = '';
        let toolUsed = false;

        for (const block of response.content) {
            if (block.type === 'text') {
                assistantText += block.text;
            } else if (block.type === 'tool_use' && block.name === 'save_tasks') {
                toolUsed = true;
                const { tasks, complete_onboarding } = block.input;

                // Clear existing tasks and save new ones
                await db.request().input('userId', sql.Int, userId)
                    .query('DELETE FROM Todo_Tasks WHERE UserId = @userId');

                for (let i = 0; i < tasks.length; i++) {
                    await db.request()
                        .input('userId', sql.Int, userId)
                        .input('title', sql.NVarChar, tasks[i].title)
                        .input('category', sql.NVarChar, tasks[i].category || null)
                        .input('location', sql.NVarChar, tasks[i].location || null)
                        .input('sortOrder', sql.Int, i)
                        .query('INSERT INTO Todo_Tasks (UserId, Title, Category, Location, SortOrder) VALUES (@userId, @title, @category, @location, @sortOrder)');
                }

                // Mark onboarding complete if indicated
                if (complete_onboarding) {
                    const existingState = await db.request().input('userId', sql.Int, userId)
                        .query('SELECT Id FROM Todo_UserState WHERE UserId = @userId');
                    if (existingState.recordset.length === 0) {
                        await db.request().input('userId', sql.Int, userId)
                            .query('INSERT INTO Todo_UserState (UserId, OnboardingComplete) VALUES (@userId, 1)');
                    } else {
                        await db.request().input('userId', sql.Int, userId)
                            .query('UPDATE Todo_UserState SET OnboardingComplete = 1, UpdatedDate = GETUTCDATE() WHERE UserId = @userId');
                    }
                }

                // Now send tool result back to get final text
                const followUp = await anthropic.messages.create({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 1024,
                    system: systemPrompt,
                    tools: tools,
                    messages: [
                        ...chatHistory,
                        { role: 'assistant', content: response.content },
                        { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: `Saved ${tasks.length} tasks successfully.` }] }
                    ]
                });

                for (const b of followUp.content) {
                    if (b.type === 'text') assistantText += b.text;
                }
            }
        }

        // Parse chips from response
        const parsed = parseChips(assistantText);

        // Save assistant response (clean text without chip markup)
        if (parsed.cleanText) {
            await db.request()
                .input('userId', sql.Int, userId)
                .input('role', sql.NVarChar, 'assistant')
                .input('content', sql.NVarChar, parsed.cleanText)
                .query('INSERT INTO Todo_Chat (UserId, Role, Content) VALUES (@userId, @role, @content)');
        }

        res.json({
            reply: parsed.cleanText,
            chips: parsed.chips,
            toolUsed: toolUsed
        });
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: 'AI error: ' + err.message });
    }
});

function buildSystemPrompt(onboardingComplete, existingTasks, username) {
    const categoryNote = `

IMPORTANT: The app has exactly 4 task categories: Home, Work, Health, Learning.
Every task you create MUST have one of these 4 categories. No other categories allowed.

LOCATIONS — CRITICAL:
Every task MUST have a location field. The location is WHERE the task happens physically.
Examples: "Costco", "Supermarket", "Gym", "Office", "Home", "Library", "Pharmacy", "Online", "Park", "Doctor", "Bank", "School".
Be specific and consistent — use "Costco" not "costco" or "At Costco". Use singular proper nouns.
The app shows location buttons at the bottom — when a user taps one, it means "I'm at this place right now, what should I do?"

"I'M AT [LOCATION]" MESSAGES:
If the user's message starts with [Location: X], they are telling you they are physically AT that location RIGHT NOW.
Your job: Find ALL incomplete tasks at that location and give them a focused, actionable briefing:
1. List every task for that location
2. Suggest an efficient order to tackle them
3. Add any helpful tips (e.g. "grab a cart first", "check your list")
4. Be energetic and motivating — they're there and ready to go!
Do NOT use the save_tasks tool for location messages — just advise them.`;

    const chipsInstruction = `

SUGGESTION CHIPS — CRITICAL:
After EVERY response, you MUST include clickable suggestion chips so the user can tap to respond quickly.
Format: Put chips at the very end of your message using this exact format:
<<CHIPS>>
row: Option A | Option B | Option C
row: Option D | Option E
<<END>>

Rules for chips:
- ALWAYS include chips — never skip them
- Each "row:" is a group of related options displayed on one line
- Keep chip labels SHORT (1-4 words max)
- Make chips contextually smart — anticipate what the user might want next
- Include a MIX of specifics and general options
- For tasks: include WHERE options (stores, locations), WHEN options (today, this week, this month), and related items
- Example: user says "groceries" in Home category → offer store chips AND timing chips AND related task chips
- For onboarding: offer the 4 category areas as chips
- After saving tasks: offer "Add more" | "Show my tasks" | category-specific options`;

    if (!onboardingComplete) {
        return `You are a friendly, focused AI task coach inside a Todo app called "1000 Problems Todo". The user's name is ${username}.

This is an ONBOARDING conversation. Your goal is to learn about the user's priorities and generate a personalized task list across 4 life areas: Home, Work, Health, and Learning.

If the user's first message is "Start", begin the onboarding directly — welcome them warmly and ask what they'd like to get organized first.

Steps:
1. FIRST MESSAGE: Welcome them by name and ask what area they'd like to tackle first — Home, Work, Health, or Learning?
2. Ask 2-3 short follow-up questions (one at a time!) to understand their specific goals and priorities.
3. After enough context (3-4 exchanges), use the save_tasks tool to generate 8-15 actionable tasks spread across the 4 categories. Set complete_onboarding to true.
4. After saving, give a brief encouraging summary.

Rules:
- Keep responses SHORT (2-3 sentences max)
- Be warm but efficient
- Ask ONE question at a time
- Generate practical, specific tasks (not vague ones)
- Include a mix of quick wins and bigger goals${categoryNote}${chipsInstruction}`;
    }

    const taskSummary = existingTasks.length > 0
        ? `\nCurrent tasks:\n${existingTasks.map(t => `- [${t.IsComplete ? 'x' : ' '}] ${t.Title} (${t.Category || 'Home'})${t.Location ? ' @ ' + t.Location : ''}`).join('\n')}`
        : '\nNo tasks yet.';

    return `You are a helpful AI task coach inside "1000 Problems Todo". The user's name is ${username}. Onboarding is complete.${taskSummary}

You can help the user:
- Add new tasks (use save_tasks tool — include ALL existing tasks plus new ones)
- Reorganize or reprioritize tasks
- Break down big tasks into smaller steps
- Provide motivation and accountability

If the user's message starts with [Category: X], they selected that category button and want to add tasks specifically to that section.

When modifying tasks, always use the save_tasks tool with the COMPLETE updated list (existing + changes). Keep responses brief and actionable.${categoryNote}${chipsInstruction}`;
}

// Parse suggestion chips from AI response
function parseChips(text) {
    const chipRegex = /<<CHIPS>>([\s\S]*?)<<END>>/;
    const match = text.match(chipRegex);
    if (!match) return { cleanText: text.trim(), chips: [] };

    const cleanText = text.replace(chipRegex, '').trim();
    const chipBlock = match[1].trim();
    const chips = [];

    chipBlock.split('\n').forEach(line => {
        line = line.trim();
        if (line.startsWith('row:')) {
            const options = line.substring(4).split('|').map(o => o.trim()).filter(o => o);
            if (options.length > 0) chips.push(options);
        }
    });

    return { cleanText, chips };
}

// ============================================================================
// TASKS API
// ============================================================================
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        const result = await db.request()
            .input('userId', sql.Int, req.session.user.id)
            .query('SELECT Id, Title, Category, Location, IsComplete, SortOrder FROM Todo_Tasks WHERE UserId = @userId ORDER BY SortOrder ASC');
        res.json({ tasks: result.recordset });
    } catch (err) {
        console.error('Tasks error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get unique locations from user's incomplete tasks
app.get('/api/locations', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        const result = await db.request()
            .input('userId', sql.Int, req.session.user.id)
            .query('SELECT DISTINCT Location FROM Todo_Tasks WHERE UserId = @userId AND Location IS NOT NULL AND IsComplete = 0 ORDER BY Location');
        res.json({ locations: result.recordset.map(r => r.Location) });
    } catch (err) {
        console.error('Locations error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        await db.request()
            .input('id', sql.Int, req.params.id)
            .input('userId', sql.Int, req.session.user.id)
            .query('DELETE FROM Todo_Tasks WHERE Id = @id AND UserId = @userId');
        res.json({ success: true });
    } catch (err) {
        console.error('Delete task error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/tasks/:id/toggle', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        await db.request()
            .input('id', sql.Int, req.params.id)
            .input('userId', sql.Int, req.session.user.id)
            .query('UPDATE Todo_Tasks SET IsComplete = CASE WHEN IsComplete = 1 THEN 0 ELSE 1 END, UpdatedDate = GETUTCDATE() WHERE Id = @id AND UserId = @userId');
        res.json({ success: true });
    } catch (err) {
        console.error('Toggle error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================================
// RESET APP
// ============================================================================
app.post('/api/reset', requireAuth, async (req, res) => {
    try {
        const db = await getPool();
        const userId = req.session.user.id;
        await db.request().input('userId', sql.Int, userId).query('DELETE FROM Todo_Tasks WHERE UserId = @userId');
        await db.request().input('userId', sql.Int, userId).query('DELETE FROM Todo_Chat WHERE UserId = @userId');
        await db.request().input('userId', sql.Int, userId).query('DELETE FROM Todo_UserState WHERE UserId = @userId');
        res.json({ success: true });
    } catch (err) {
        console.error('Reset error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, '0.0.0.0', () => { console.log(`TodoApp running at http://localhost:${PORT}`); });
