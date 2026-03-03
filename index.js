const { Pool } = require('pg');
require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const { OpenAI } = require('openai');

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
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_config (
                id SERIAL PRIMARY KEY,
                enabled BOOLEAN DEFAULT false,
                prompt TEXT DEFAULT 'Eres un asistente virtual de Luxapp. Responde de manera profesional y amable.',
                api_key TEXT DEFAULT ''
            );
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
            await pool.query('INSERT INTO ai_config (enabled) VALUES (false)');
        } else {
            aiConfig = res.rows[0];
            if (aiConfig.api_key) {
                openai = new OpenAI({ apiKey: aiConfig.api_key });
            }
        }
    } catch (err) {
        console.error('❌ Error inicializando DB:', err.message);
    }
}

// --- CONFIGURACIÓN PRIVADA ---
let sock = null;
let qrBase64 = null;
let aiConfig = {
    enabled: false,
    prompt: "Eres un asistente virtual de Luxapp. Responde de manera profesional y amable.",
    api_key: ""
};

let openai = null;

console.log('--- Configuración inicializada ---');

async function connectToWhatsApp() {
    if (sock) {
        try { sock.ws.close(); } catch (e) { }
    }

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

async function handleAIResponse(jid, userText, name) {
    if (!aiConfig.api_key) return;
    if (!openai) openai = new OpenAI({ apiKey: aiConfig.api_key });

    try {
        const chatCompletion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: aiConfig.prompt },
                { role: "user", content: userText }
            ],
            model: "gpt-3.5-turbo",
        });

        const aiText = chatCompletion.choices[0].message.content;
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

app.get('/api/creds', validateAPI, (req, res) => {
    res.json({
        apiKey: process.env.API_KEY,
        sendUrl: `${req.protocol}://${req.get('host')}/api/instance/send`,
        receiveUrl: `${req.protocol}://${req.get('host')}/api/messages/recent`
    });
});

app.post('/api/ai/config', validateAPI, async (req, res) => {
    const { enabled, prompt, apiKey } = req.body;
    try {
        await pool.query(`
            UPDATE ai_config SET 
                enabled = $1, 
                prompt = $2, 
                api_key = $3
            WHERE id = (SELECT id FROM ai_config LIMIT 1)
        `, [enabled, prompt, apiKey]);

        aiConfig = { enabled, prompt, api_key: apiKey };
        if (apiKey) openai = new OpenAI({ apiKey });

        res.json({ status: "success", config: aiConfig });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/test', validateAPI, async (req, res) => {
    const { message } = req.body;
    if (!aiConfig.api_key) return res.status(400).json({ error: "API Key no configurada" });
    if (!openai) openai = new OpenAI({ apiKey: aiConfig.api_key });

    try {
        const chatCompletion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: aiConfig.prompt },
                { role: "user", content: message }
            ],
            model: "gpt-3.5-turbo",
        });

        res.json({ response: chatCompletion.choices[0].message.content });
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