const crypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto;
}
const { Pool } = require('pg');
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURACIÓN BASE DE DATOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware de Validación API
function validateAPI(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey === process.env.API_KEY) {
        next();
    } else {
        res.status(401).json({ error: "No autorizado. API Key inválida." });
    }
}

async function initDB() {
    if (!process.env.DATABASE_URL) {
        console.error('❌ Error: La variable DATABASE_URL no está configurada en el archivo .env');
        console.error('⚠️  Por favor, asegúrate de proporcionar una cadena de conexión válida (ej. postgres://user:pass@localhost:5432/db).');
        throw new Error("DATABASE_URL no configurada");
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT
            );

            CREATE TABLE IF NOT EXISTS ai_config (
                id SERIAL PRIMARY KEY,
                enabled BOOLEAN DEFAULT false,
                prompt TEXT DEFAULT 'Eres un asistente virtual de Luxapp. Responde de manera profesional y amable.',
                api_key TEXT DEFAULT '',
                provider TEXT DEFAULT 'openai'
            );
            /* Agregar columna provider si no existe en una db vieja */
            ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'openai';

            CREATE TABLE IF NOT EXISTS chats (
                jid TEXT PRIMARY KEY,
                name TEXT,
                last_message TEXT,
                last_timestamp INTEGER
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                msg_id TEXT UNIQUE,
                jid TEXT,
                from_me BOOLEAN,
                text TEXT,
                timestamp INTEGER
            );
        `);
        console.log('✅ Base de datos inicializada.');

        // Cargar config inicial
        const res = await pool.query('SELECT * FROM ai_config LIMIT 1');
        if (res.rows.length === 0) {
            await pool.query('INSERT INTO ai_config (enabled, provider) VALUES (false, $1)', ['openai']);
        } else {
            aiConfig = res.rows[0];
            initProviderClient(aiConfig.provider, aiConfig.api_key);
        }

    } catch (err) {
        console.error('❌ Error inicializando DB:', err.message || err);
        throw err;
    }
}

// --- CONFIGURACIÓN PRIVADA ---
let sock = null;
let qrBase64 = null;
let aiConfig = {
    enabled: false,
    prompt: "Eres un asistente virtual de Luxapp. Responde de manera profesional y amable.",
    api_key: "",
    provider: "openai"
};

let openai = null;
let anthropic = null;
let gemini = null;

function initProviderClient(provider, apiKey) {
    if (!apiKey) return;
    try {
        if (provider === 'openai') {
            openai = new OpenAI({ apiKey });
        } else if (provider === 'anthropic') {
            anthropic = new Anthropic({ apiKey });
        } else if (provider === 'gemini') {
            gemini = new GoogleGenerativeAI(apiKey);
        } else if (provider === 'openrouter') {
            openai = new OpenAI({
                baseURL: "https://openrouter.ai/api/v1",
                apiKey: apiKey,
            });
        }
    } catch (err) {
        console.error(`Error inicializando proveedor ${provider}:`, err);
    }
}

console.log('--- Configuración inicializada ---');

async function connectToWhatsApp() {
    if (sock) {
        try { sock.ws.close(); } catch (e) { }
    }

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('baileys');

    const { state, saveCreds } = await useMultiFileAuthState('auth_luxapp');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Luxapp Engine', 'MacOS', '10.15.7']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrBase64 = qr;
            io.emit('qr', qr);
        }
        if (connection === 'open') {
            qrBase64 = null;
            io.emit('status', { connected: true, user: sock.user.id.split(':')[0] });
            console.log('✅ Luxapp está conectado.');
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            io.emit('status', { connected: false });
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), statusCode === 440 ? 10000 : 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        if (jid === 'status@broadcast') return;

        const fromMe = msg.key.fromMe;
        const from = jid.split('@')[0];
        const pushName = fromMe ? (sock.user.name || 'Yo') : (msg.pushName || from);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "Multimedia/Otro";

        // Guardar en DB
        await saveMessage(jid, pushName, fromMe, text, msg.key.id, msg.messageTimestamp);

        // Notificar al Helpdesk
        io.emit('new_message', {
            jid,
            name: pushName,
            message: { text, fromMe, timestamp: msg.messageTimestamp }
        });

        // IA (Solo para mensajes entrantes y chats no grupales)
        if (aiConfig.enabled && !fromMe && !jid.includes('@g.us')) {
            await handleAIResponse(jid, text, pushName);
        }
    });
}

async function saveMessage(jid, name, fromMe, text, msgId, timestamp) {
    try {
        // Upsert chat
        await pool.query(`
            INSERT INTO chats (jid, name, last_message, last_timestamp)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (jid) DO UPDATE SET 
                name = EXCLUDED.name,
                last_message = EXCLUDED.last_message,
                last_timestamp = EXCLUDED.last_timestamp
        `, [jid, name, text, timestamp]);

        // Insert message
        await pool.query(`
            INSERT INTO messages (msg_id, jid, from_me, text, timestamp)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (msg_id) DO NOTHING
        `, [msgId, jid, fromMe, text, timestamp]);
    } catch (e) {
        console.error("Error guardando mensaje:", e.message);
    }
}

async function getProviderResponse(provider, userText, systemPrompt) {
    if ((provider === 'openai' || provider === 'openrouter') && openai) {
        const chatCompletion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userText }
            ],
            model: provider === 'openrouter' ? "google/gemini-2.5-flash" : "gpt-3.5-turbo",
        });
        return chatCompletion.choices[0].message.content;
    } else if (provider === 'anthropic' && anthropic) {
        const msg = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: "user", content: userText }],
        });
        return msg.content[0].text;
    } else if (provider === 'gemini' && gemini) {
        const model = gemini.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: systemPrompt
        });
        const result = await model.generateContent(userText);
        return result.response.text();
    }
    throw new Error('Proveedor no soportado, mal configurado o sin API Key');
}

async function handleAIResponse(jid, userText, name) {
    if (!aiConfig.api_key) return;
    if (!aiConfig.provider) aiConfig.provider = 'openai';
    initProviderClient(aiConfig.provider, aiConfig.api_key); // Ensure initialized

    try {
        const aiText = await getProviderResponse(aiConfig.provider, userText, aiConfig.prompt);
        await sock.sendMessage(jid, { text: aiText });

        const msgId = 'ai_' + Date.now();
        const ts = Math.floor(Date.now() / 1000);
        await saveMessage(jid, name, true, aiText, msgId, ts);

        io.emit('new_message', {
            jid,
            name,
            message: { text: aiText, fromMe: true, timestamp: ts }
        });

    } catch (e) {
        console.error("Error AI:", e.message);
    }
}

// --- ENDPOINTS DE AUTENTICACION ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Faltan datos" });
    const hpass = crypto.createHash('sha256').update(password).digest('hex');
    try {
        await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hpass]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: "El usuario ya existe o hubo un error" });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const hpass = crypto.createHash('sha256').update(password).digest('hex');
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, hpass]);
        if (result.rows.length > 0) {
            res.json({ token: process.env.API_KEY });
        } else {
            res.status(401).json({ error: "Credenciales inválidas" });
        }
    } catch (e) {
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// --- ENDPOINTS ---

app.get('/api/instance/status', validateAPI, (req, res) => {
    res.json({
        connected: !!sock?.user,
        number: sock?.user?.id ? sock.user.id.split(':')[0] : null,
        qrCode: qrBase64
    });
});

app.get('/api/chats', validateAPI, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM chats ORDER BY last_timestamp DESC');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Error al obtener chats" });
    }
});

app.get('/api/messages/:jid', validateAPI, async (req, res) => {
    const { jid } = req.params;
    try {
        const result = await pool.query('SELECT * FROM messages WHERE jid = $1 ORDER BY timestamp ASC LIMIT 50', [jid]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Error al obtener mensajes" });
    }
});

// Nuevo endpoint para consultar TODA la recepción de mensajes (PULL)
app.get('/api/messages/recent', validateAPI, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/creds', validateAPI, async (req, res) => {
    // También devolver la config actual de la IA para el frontend
    const aiConfigRes = await pool.query('SELECT enabled, prompt, api_key, provider FROM ai_config LIMIT 1');
    const dbConfig = aiConfigRes.rows[0] || {};

    res.json({
        apiKey: process.env.API_KEY,
        sendUrl: `${req.protocol}://${req.get('host')}/api/instance/send`,
        receiveUrl: `${req.protocol}://${req.get('host')}/api/messages/recent`,
        aiConfig: {
            enabled: dbConfig.enabled,
            prompt: dbConfig.prompt,
            apiKey: dbConfig.api_key,
            provider: dbConfig.provider || 'openai'
        }
    });
});

app.post('/api/ai/config', validateAPI, async (req, res) => {
    const { enabled, prompt, apiKey, provider } = req.body;
    const finalProvider = provider || 'openai';
    try {
        await pool.query(`
            UPDATE ai_config SET 
                enabled = $1, 
                prompt = $2, 
                api_key = $3,
                provider = $4
            WHERE id = (SELECT id FROM ai_config LIMIT 1)
        `, [enabled, prompt, apiKey, finalProvider]);

        aiConfig = { enabled, prompt, api_key: apiKey, provider: finalProvider };
        initProviderClient(finalProvider, apiKey);

        res.json({ status: "success", config: aiConfig });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/test', validateAPI, async (req, res) => {
    const { message } = req.body;
    if (!aiConfig.api_key) return res.status(400).json({ error: "API Key no configurada" });
    initProviderClient(aiConfig.provider, aiConfig.api_key);

    try {
        const aiText = await getProviderResponse(aiConfig.provider, message, aiConfig.prompt);
        res.json({ response: aiText });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/instance/send', validateAPI, async (req, res) => {
    const { to, message } = req.body;
    if (!sock?.user) return res.status(503).json({ error: "WhatsApp no conectado" });

    try {
        const cleanTo = to.replace(/\D/g, '');
        const jid = cleanTo.includes('@') ? cleanTo : `${cleanTo}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: message });

        const ts = Math.floor(Date.now() / 1000);
        await saveMessage(jid, cleanTo, true, message, sent.key.id, ts);

        io.emit('new_message', {
            jid,
            name: cleanTo,
            message: { text: message, fromMe: true, timestamp: ts }
        });

        res.json({ status: "sent", jid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/instance/logout', validateAPI, async (req, res) => {
    if (sock) {
        try { await sock.logout(); } catch (e) { }
    }
    try {
        fs.rmSync('auth_luxapp', { recursive: true, force: true });
    } catch (e) { }
    connectToWhatsApp();
    res.json({ status: "logged_out" });
});

server.listen(3000, async () => {
    console.log("🚀 LUXAPP HELPDESK ENGINE RUNNING ON PORT 3000");
    await initDB();
    connectToWhatsApp();
});

process.on('SIGINT', async () => {
    console.log('--- Apagando servidor Luxapp ---');
    if (sock) try { await sock.logout(); } catch (e) { }
    await pool.end();
    process.exit(0);
});