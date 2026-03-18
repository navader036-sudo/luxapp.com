const crypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto;
}
const { pool } = require('./database.js');
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');



const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-api-key"]
    }
});

// Enviar estado inicial inmediato cuando un cliente se conecta
io.on('connection', (socket) => {
    console.log(`[SOCKET] Cliente conectado: ${socket.id}`);

    // Enviar estado de conexión actual
    socket.emit('status', {
        connected: !!sock?.user,
        user: sock?.user?.id ? sock.user.id.split(':')[0] : null
    });

    // Si hay un QR disponible, enviarlo de inmediato
    if (qrBase64) {
        socket.emit('qr', qrBase64);
    }
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Accept']
}));
app.use(express.json());

// Middleware de Logs para Railway (Verás esto en el Dashboard de Railway)
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Ruta raíz para verificar salud desde el navegador
app.get('/', (req, res) => {
    res.send('🚀 Luxapp Helpdesk Backend is Running! Port: ' + (process.env.PORT || 3010));
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

        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT)`);
        console.log('✅ Tabla users lista.');

        await pool.query(`CREATE TABLE IF NOT EXISTS ai_config (id SERIAL PRIMARY KEY, enabled BOOLEAN DEFAULT false, prompt TEXT DEFAULT '...', api_key TEXT DEFAULT '', provider TEXT DEFAULT 'openai')`);
        console.log('✅ Tabla ai_config lista.');

        await pool.query(`ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'openai'`);
        await pool.query(`ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS model TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS base_url TEXT DEFAULT ''`);
        console.log('✅ Columnas ai_config actualizadas.');

        await pool.query(`CREATE TABLE IF NOT EXISTS wh_chats (jid TEXT PRIMARY KEY, name TEXT, last_message TEXT, last_timestamp INTEGER)`);
        await pool.query(`ALTER TABLE wh_chats ADD COLUMN IF NOT EXISTS ai_active BOOLEAN DEFAULT true`);
        console.log('✅ Tabla wh_chats lista.');

        await pool.query(`CREATE TABLE IF NOT EXISTS wh_messages (id SERIAL PRIMARY KEY, msg_id TEXT UNIQUE, jid TEXT, from_me BOOLEAN, text TEXT, timestamp INTEGER)`);
        console.log('✅ Tabla wh_messages lista.');
        await pool.query(`CREATE TABLE IF NOT EXISTS ai_keys (provider TEXT PRIMARY KEY, api_key TEXT, base_url TEXT)`);
        console.log('✅ Tabla ai_keys lista (Bóveda de llaves).');

        console.log('✅ Base de datos inicializada completamente.');

        // Cargar config inicial
        const res = await pool.query('SELECT * FROM ai_config LIMIT 1');
        if (res.rows.length === 0) {
            await pool.query('INSERT INTO ai_config (enabled, provider) VALUES (false, $1)', ['openai']);
        } else {
            aiConfig = res.rows[0];
            initProviderClient(aiConfig.provider, aiConfig.api_key, aiConfig.base_url);
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
    provider: "openai",
    model: "",
    base_url: ""
};

let openai = null;
let anthropic = null;
let gemini = null;

function initProviderClient(provider, apiKey, baseUrl = null) {
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
                defaultHeaders: {
                    "HTTP-Referer": "https://luxapp.io",
                    "X-Title": "LuxApp",
                }
            });
        } else if (provider === 'xai') {
            openai = new OpenAI({ baseURL: "https://api.x.ai/v1", apiKey });
        } else if (provider === 'custom') {
            openai = new OpenAI({ baseURL: baseUrl || "https://api.openai.com/v1", apiKey });
        } else if (provider === 'groq') {
            openai = new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey });
        } else if (provider === 'mistral') {
            openai = new OpenAI({ baseURL: "https://api.mistral.ai/v1", apiKey });
        } else if (provider === 'deepseek') {
            openai = new OpenAI({ baseURL: "https://api.deepseek.com", apiKey });
        } else if (provider === 'perplexity') {
            openai = new OpenAI({ baseURL: "https://api.perplexity.ai", apiKey });
        } else if (provider === 'ollama') {
            openai = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
        }
    } catch (err) {
        console.error(`Error inicializando proveedor ${provider}:`, err);
    }
}

console.log('--- Configuración inicializada ---');

let store;

async function connectToWhatsApp() {
    if (sock) {
        try { sock.ws.close(); } catch (e) { }
    }

    const baileys = await import('baileys');
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

    if (!global.contacts) {
        global.contacts = {};
        try {
            if (fs.existsSync('./baileys_contacts.json')) {
                global.contacts = JSON.parse(fs.readFileSync('./baileys_contacts.json', 'utf-8'));
            }
        } catch (e) {
            console.error('Error cargando contactos:', e.message);
        }
    }

    const saveContacts = () => {
        try {
            fs.writeFileSync('./baileys_contacts.json', JSON.stringify(global.contacts, null, 2));
        } catch (e) {
            console.error('Error guardando contactos:', e.message);
        }
    };

    const { state, saveCreds } = await useMultiFileAuthState('auth_luxapp');

    let waVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
    } catch (e) {
        waVersion = [2, 3000, 1015901307];
    }

    sock = makeWASocket({
        version: waVersion,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Luxapp Engine', 'Chrome', '121.0.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    // Capturar contactos de varios eventos
    sock.ev.on('contacts.upsert', (newContacts) => {
        for (const contact of newContacts) {
            if (contact.id) {
                global.contacts[contact.id] = { ...(global.contacts[contact.id] || {}), ...contact };
            }
        }
        saveContacts();
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            if (update.id) {
                global.contacts[update.id] = { ...(global.contacts[update.id] || {}), ...update };
            }
        }
        saveContacts();
    });

    sock.ev.on('messaging-history.set', ({ contacts: newContacts }) => {
        if (newContacts) {
            for (const contact of newContacts) {
                if (contact.id) {
                    global.contacts[contact.id] = { ...(global.contacts[contact.id] || {}), ...contact };
                }
            }
            saveContacts();
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrBase64 = qr;
            io.emit('qr', qr);
        }

        if (connection === 'open') {
            qrBase64 = null;
            const userNum = sock.user.id.split(':')[0];
            io.emit('status', { connected: true, user: userNum });
            io.emit('qr', null); // Limpiar QR en el cliente
            console.log(`✅ Luxapp está conectado: ${userNum}`);
            setTimeout(() => syncContactsWithDB(), 5000);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message;
            console.log(`❌ Conexión cerrada. Código: ${statusCode} | Motivo: ${reason}`);

            // Solo borrar sesión si es un logout explícito o desautorización definitiva
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !isLoggedOut;

            io.emit('status', { connected: false });
            qrBase64 = null; // Reiniciar QR temporalmente

            if (shouldReconnect) {
                const waitTime = statusCode === 440 ? 10000 : 5000;
                console.log(`🔄 Reconectando automáticamente en ${waitTime / 1000}s...`);
                setTimeout(() => connectToWhatsApp(), waitTime);
            } else {
                console.log('🗑️ Sesión cerrada por el usuario o borrada. Regenerando QR en 3 segundos...');
                try {
                    fs.rmSync('./auth_luxapp', { recursive: true, force: true });
                } catch (err) {
                    console.error('Error al borrar auth_luxapp:', err.message);
                }
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const jid = msg.key.remoteJid;
            if (jid === 'status@broadcast' || jid.includes('@newsletter') || jid.includes('@broadcast')) return;

            const fromMe = msg.key.fromMe;
            const from = jid.split('@')[0];

            // Buscar nombre en Almacén -> Mensaje -> DB -> Número
            let pushName = fromMe ? (sock.user?.name || 'Yo') : msg.pushName;
            if (!pushName || pushName === from) {
                const contact = global.contacts[jid];
                pushName = contact?.name || contact?.verifiedName || contact?.notify || pushName || from;
            }
            // Si sigue siendo solo el número, intentar buscar en DB previa
            if (pushName === from) {
                const existingChat = await pool.query('SELECT name FROM wh_chats WHERE jid = $1', [jid]);
                if (existingChat.rows.length > 0 && existingChat.rows[0].name !== from) {
                    pushName = existingChat.rows[0].name;
                }
            }

            // Mejorar extracción de texto
            let text = "";
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
            else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;
            else if (msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption;
            else text = "Multimedia/Otro";

            const timestamp = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp !== null
                ? msg.messageTimestamp.low
                : msg.messageTimestamp;

            // Guardar en DB
            await saveMessage(jid, pushName, fromMe, text, msg.key.id, timestamp);

            // Notificar al Helpdesk
            io.emit('new_message', {
                jid,
                name: pushName,
                message: { text, fromMe, timestamp: timestamp }
            });

            // Notificar a LuxCare (Webhook)
            if (!fromMe && process.env.LUXCARE_WEBHOOK_URL) {
                try {
                    fetch(process.env.LUXCARE_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            object: 'whatsapp_business_account',
                            entry: [{
                                id: process.env.LUX_BUSINESS_ID || 'TU_BUSINESS_ID',
                                changes: [{
                                    value: {
                                        messages: [{
                                            from: from,
                                            text: { body: text }
                                        }]
                                    }
                                }]
                            }]
                        })
                    }).catch(err => console.error("Error enviando a LuxCare Webhook:", err.message));
                } catch (e) {
                    console.error("Error al intentar notificar a LuxCare:", e.message);
                }
            }

            // IA (Solo para mensajes entrantes, chats no grupales y que no sean "Chat conmigo mismo")
            if (!sock.user) return;
            const myNumber = sock.user.id.split(':')[0].split('@')[0];
            const isMe = jid.split('@')[0] === myNumber;

            console.log(`[MSG] De: ${from} | Texto: ${text} | fromMe: ${fromMe} | AI Enabled: ${aiConfig.enabled}`);

            if (aiConfig.enabled && !fromMe && !jid.includes('@g.us') && !isMe) {
                if (text && text !== "Multimedia/Otro") {
                    // Verificar si el chat tiene la IA habilitada o si un humano lo "tomó"
                    try {
                        const chatRes = await pool.query('SELECT ai_active FROM wh_chats WHERE jid = $1', [jid]);
                        let isAiActive = true;
                        if (chatRes.rows.length > 0) {
                            // Por si acaso es NULL, asume true
                            isAiActive = chatRes.rows[0].ai_active !== false;
                        }

                        if (isAiActive) {
                            console.log(`[AI] Procesando respuesta para ${jid}...`);
                            await handleAIResponse(jid, text, pushName);
                        } else {
                            console.log(`[AI] Ignorando (Humano atendiendo) para ${jid}`);
                        }
                    } catch (e) {
                        console.error("Error verificando AI state:", e.message);
                    }
                }
            }
        } catch (err) {
            console.error("Error en messages.upsert:", err.message);
        }
    });

    // Sincronización de historial
    sock.ev.on('messaging-history.set', async ({ chats, messages }) => {
        console.log(`[SYNC] Recibidos ${chats.length} chats y ${messages.length} mensajes.`);

        // Wait for DB to be completely ready
        if (!pool) return console.log('[SYNC] Pool no inicializado.');

        let validChatsSynced = 0;
        for (const chat of chats) {
            try {
                // Filtrar solo chats individuales y no el log interno de Baileys
                if (chat.id && !chat.id.includes('@g.us') && !chat.id.includes('broadcast') && !chat.id.includes('@newsletter') && !chat.id.includes('@lid')) {
                    const lastMsg = messages.filter(m => m.key.remoteJid === chat.id).sort((a, b) => {
                        let ta = typeof a.messageTimestamp === 'object' ? a.messageTimestamp.low : a.messageTimestamp;
                        let tb = typeof b.messageTimestamp === 'object' ? b.messageTimestamp.low : b.messageTimestamp;
                        return (tb || 0) - (ta || 0);
                    })[0];

                    const text = lastMsg ? (lastMsg.message?.conversation || lastMsg.message?.extendedTextMessage?.text || "Chat") : "Chat";
                    const tsRaw = lastMsg ? lastMsg.messageTimestamp : Math.floor(Date.now() / 1000);
                    let name = chat.name;
                    const contact = global.contacts[chat.id];
                    const discoveredName = contact?.name || contact?.verifiedName || contact?.notify;

                    if (discoveredName) {
                        name = discoveredName;
                    } else if (!name || name === chat.id.split('@')[0]) {
                        name = chat.id.split('@')[0];
                    }

                    await pool.query(`
                        INSERT INTO wh_chats (jid, name, last_message, last_timestamp)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (jid) DO UPDATE SET 
                            name = CASE 
                                WHEN EXCLUDED.name ~ '^[0-9]+$' AND wh_chats.name !~ '^[0-9]+$' THEN wh_chats.name
                                WHEN (wh_chats.name ~ '^[0-9]+$' OR wh_chats.name IS NULL OR wh_chats.name = '') AND EXCLUDED.name !~ '^[0-9]+$' THEN EXCLUDED.name
                                ELSE EXCLUDED.name
                            END,
                            last_message = EXCLUDED.last_message, 
                            last_timestamp = EXCLUDED.last_timestamp
                    `, [chat.id, name, text, tsRaw]);
                    validChatsSynced++;
                }
            } catch (e) {
                console.error("Error cargando chat del historial:", chat.id, e.message);
            }
        }
        console.log(`[SYNC] Guardados ${validChatsSynced} chats válidos de forma asíncrona.`);
    });

    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
            const name = contact.name || contact.verifiedName || contact.notify;
            if (name && contact.id) {
                try {
                    await pool.query(`
                        UPDATE wh_chats 
                        SET name = $1 
                        WHERE jid = $2 AND (name = split_part(jid, '@', 1) OR name IS NULL OR name = '')
                    `, [name, contact.id]);
                } catch (e) { }
            }
        }
    });

    sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
            const name = update.name || update.verifiedName;
            if (name && update.id) {
                try {
                    await pool.query('UPDATE wh_chats SET name = $1 WHERE jid = $2', [name, update.id]);
                } catch (e) { }
            }
        }
    });

    sock.ev.on('chats.upsert', async (newChats) => {
        for (const chat of newChats) {
            try {
                let name = chat.name;
                if (!name || name === chat.id.split('@')[0]) {
                    const contact = global.contacts[chat.id];
                    name = contact?.name || contact?.verifiedName || contact?.notify || name || chat.id.split('@')[0];
                }
                await pool.query(`
                    INSERT INTO wh_chats (jid, name, last_message, last_timestamp)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name WHERE wh_chats.name = wh_chats.jid OR EXCLUDED.name != wh_chats.jid
                `, [chat.id, name, "Nuevo chat", Math.floor(Date.now() / 1000)]);
            } catch (e) { }
        }
    });

    sock.ev.on('chats.update', async (updates) => {
        for (const update of updates) {
            if (update.name) {
                await pool.query('UPDATE wh_chats SET name = $1 WHERE jid = $2', [update.name, update.id]);
            }
        }
    });
}

async function saveMessage(jid, name, fromMe, text, msgId, timestamp) {
    try {
        const ts = typeof timestamp === 'object' && timestamp !== null ? timestamp.low : timestamp;

        // Upsert chat con protección contra nombres numéricos
        // Si el nuevo nombre es numérico y ya tenemos un nombre no-numérico, mantenemos el antiguo.
        // Si el nombre actual es numérico y el nuevo no lo es, actualizamos.
        await pool.query(`
            INSERT INTO wh_chats (jid, name, last_message, last_timestamp)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (jid) DO UPDATE SET 
                name = CASE 
                    WHEN EXCLUDED.name ~ '^[0-9]+$' AND wh_chats.name !~ '^[0-9]+$' THEN wh_chats.name
                    WHEN (wh_chats.name ~ '^[0-9]+$' OR wh_chats.name IS NULL OR wh_chats.name = '') AND EXCLUDED.name !~ '^[0-9]+$' THEN EXCLUDED.name
                    WHEN EXCLUDED.name !~ '^[0-9]+$' THEN EXCLUDED.name
                    ELSE wh_chats.name
                END,
                last_message = EXCLUDED.last_message,
                last_timestamp = EXCLUDED.last_timestamp
        `, [jid, name, text, ts]);

        // Insert message
        await pool.query(`
            INSERT INTO wh_messages(msg_id, jid, from_me, text, timestamp)
        VALUES($1, $2, $3, $4, $5)
            ON CONFLICT(msg_id) DO NOTHING
        `, [msgId, jid, fromMe, text, ts]);
    } catch (e) {
        console.error("Error guardando mensaje:", e.message);
    }
}

async function getProviderResponse(provider, userText, systemPrompt, history = []) {
    const selectedModel = aiConfig.model || (provider === 'openai' ? 'gpt-3.5-turbo' :
        provider === 'anthropic' ? 'claude-3-haiku-20240307' :
            provider === 'gemini' ? 'gemini-1.5-flash' :
                provider === 'openrouter' ? 'google/gemini-2.0-flash-exp:free' :
                    provider === 'custom' ? 'gpt-3.5-turbo' :
                        provider === 'groq' ? 'llama-3.1-70b-versatile' :
                            provider === 'mistral' ? 'mistral-large-latest' :
                                provider === 'deepseek' ? 'deepseek-chat' :
                                    provider === 'perplexity' ? 'llama-3.1-sonar-small-128k-online' :
                                        provider === 'ollama' ? 'llama3' : '');

    const openAiProviders = ['openai', 'openrouter', 'custom', 'groq', 'mistral', 'deepseek', 'perplexity', 'ollama', 'xai'];

    const strictRules = `\n\nREGLAS ESTRICTAS OBLIGATORIAS: \n1.Eres un asistente respondiendo por WhatsApp.Tus respuestas DEBEN ser breves, directas y concisas.\n2.NO envíes largos bloques de texto ni múltiples opciones a menos que se te pida explícitamente.\n3.NO inventes conversaciones simuladas, NO uses timestamps(ej: [11: 53 a.m.]), y NUNCA escribas respuestas en nombre del cliente.\n4.Limítate a responder exactamente a lo que se te pregunta con naturalidad.\n5.RESPONDE EXACTAMENTE EN EL MISMO IDIOMA en el que te escribe el cliente(Por defecto Español).NO mezcles ni cambies de idioma a menos que el cliente te hable en otro idioma.`;

    const finalSystemPrompt = systemPrompt + strictRules;

    const messages = [
        { role: "system", content: finalSystemPrompt },
        ...history,
        { role: "user", content: userText }
    ];

    let finalModel = selectedModel;
    // Limpieza de prefijos si no es OpenRouter
    if (provider !== 'openrouter' && finalModel.includes('/')) {
        finalModel = finalModel.split('/').pop();
    }

    if (openAiProviders.includes(provider) && openai) {
        const chatCompletion = await openai.chat.completions.create({
            messages: messages,
            model: finalModel,
            temperature: 0.5,
            max_tokens: 800, // Respuestas más cortas para evitar locuras
        });
        return chatCompletion.choices[0].message.content;
    } else if (provider === 'anthropic' && anthropic) {
        // Anthropic usa un formato diferente para el sistema
        const msg = await anthropic.messages.create({
            model: finalModel,
            max_tokens: 2048,
            system: systemPrompt,
            messages: [
                ...history,
                { role: "user", content: userText }
            ],
        });
        return msg.content[0].text;
    } else if (provider === 'gemini' && gemini) {
        try {
            // Limpiar nombre del modelo para Google (debe ser minúsculas y sin prefijos)
            let geminiModel = finalModel.toLowerCase().trim();
            if (geminiModel.includes('/')) geminiModel = geminiModel.split('/').pop();

            const model = gemini.getGenerativeModel({
                model: geminiModel,
                systemInstruction: systemPrompt,
                generationConfig: {
                    maxOutputTokens: 2048,
                    temperature: 0.7,
                }
            });
            const promptFull = history.map(m => `${m.role === 'user' ? 'Cliente' : 'Asistente'}: ${m.content} `).join('\n') + `\nCliente: ${userText} \nAsistente: `;
            const result = await model.generateContent(promptFull);
            const response = await result.response;
            return response.text();
        } catch (geminiError) {
            console.error("Error detallado de Gemini:", geminiError);
            if (geminiError.message.includes("404") || geminiError.message.includes("not found")) {
                throw new Error(`⚠️ BLOQUEO REGIONAL: El API directo de Google Gemini no está disponible en tu región(Venezuela).Por favor, usa este mismo modelo seleccionando el proveedor 'OpenRouter' para saltar el bloqueo.`);
            }
            throw geminiError;
        }
    }
    throw new Error('Proveedor no soportado, mal configurado o sin API Key');
}

async function syncContactsWithDB() {
    if (!global.contacts || !pool) return;
    try {
        const chats = await pool.query("SELECT jid, name FROM wh_chats WHERE name ~ '^[0-9]+$' OR name IS NULL OR name = ''");
        console.log(`[SYNC-NAMES] Revisando ${chats.rows.length} chats con nombres numéricos...`);
        let updated = 0;
        for (const chat of chats.rows) {
            const contact = global.contacts[chat.jid];
            const name = contact?.name || contact?.verifiedName || contact?.notify;
            if (name && name !== chat.jid.split('@')[0]) {
                await pool.query('UPDATE wh_chats SET name = $1 WHERE jid = $2', [name, chat.jid]);
                updated++;
            }
        }
        if (updated > 0) {
            console.log(`[SYNC-NAMES] Se actualizaron ${updated} nombres de contactos.`);
            io.emit('new_message', { jid: 'system', name: 'system', message: { text: 'Nombres actualizados', timestamp: Math.floor(Date.now() / 1000) } }); // Trigger refresh in frontend
        }
    } catch (e) {
        console.error("[SYNC-NAMES] Error:", e.message);
    }
}

async function handleAIResponse(jid, userText, name) {
    if (!aiConfig.api_key) {
        console.log("[AI] Error: No hay API Key configurada.");
        return;
    }
    if (!aiConfig.provider) aiConfig.provider = 'openai';
    initProviderClient(aiConfig.provider, aiConfig.api_key, aiConfig.base_url);

    try {
        // Obtener historial reciente para contexto
        const historyRes = await pool.query('SELECT from_me, text FROM wh_messages WHERE jid = $1 ORDER BY timestamp DESC LIMIT 6', [jid]);
        const history = historyRes.rows.reverse().map(m => ({
            role: m.from_me ? 'assistant' : 'user',
            content: m.text
        }));

        console.log(`[AI] Solicitando respuesta de ${aiConfig.provider} (${aiConfig.model || 'default'}) para ${jid}...`);
        const personalizedPrompt = `${aiConfig.prompt} \n\nEstás hablando con: ${name} `;
        const aiText = await getProviderResponse(aiConfig.provider, userText, personalizedPrompt, history);

        console.log(`[AI] Respuesta recibida: "${aiText.substring(0, 50)}..."`);
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
        console.error("❌ [AI] Error detallado:", e.message);
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

app.get('/health', (req, res) => {
    res.json({
        status: "up",
        whatsapp: !!sock?.user,
        database: pool ? "connected" : "error",
        timestamp: new Date().toISOString()
    });
});

app.get('/api/instance/status', validateAPI, (req, res) => {
    res.json({
        connected: !!sock?.user,
        number: sock?.user?.id ? sock.user.id.split(':')[0] : null,
        qrCode: qrBase64
    });
});

app.get('/api/chats', validateAPI, async (req, res) => {
    try {
        // Sincronización forzada desde el Almacén si está disponible (para rescatar chats que no están en DB)
        if (global.contacts) {
            const allJids = Object.keys(global.contacts);
            console.log(`[STORE - SYNC] Sincronizando ${allJids.length} contactos del almacén de memoria.`);
            for (const jid of allJids) {
                const contact = global.contacts[jid];
                const name = contact.name || contact.verifiedName || contact.notify || jid.split('@')[0];
                try {
                    await pool.query(`
                        INSERT INTO wh_chats (jid, name, last_message, last_timestamp)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name WHERE wh_chats.name ~ '^[0-9]+$' AND EXCLUDED.name !~ '^[0-9]+$'
                    `, [jid, name, "Sincronizado", Math.floor(Date.now() / 1000)]);
                } catch (e) { }
            }
        }

        const result = await pool.query('SELECT * FROM wh_chats ORDER BY last_timestamp DESC');
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error al obtener chats" });
    }
});

app.delete('/api/chats/:jid', validateAPI, async (req, res) => {
    const { jid } = req.params;
    try {
        await pool.query('DELETE FROM wh_messages WHERE jid = $1', [jid]);
        await pool.query('DELETE FROM wh_chats WHERE jid = $1', [jid]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/messages/:jid', validateAPI, async (req, res) => {
    const { jid } = req.params;
    try {
        const result = await pool.query('SELECT * FROM wh_messages WHERE jid = $1 ORDER BY timestamp ASC LIMIT 50', [jid]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Nuevo endpoint para consultar TODA la recepción de mensajes (PULL)
app.get('/api/messages/recent', validateAPI, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM wh_messages ORDER BY timestamp DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/creds', validateAPI, async (req, res) => {
    // También devolver la config actual de la IA para el frontend
    const aiConfigRes = await pool.query('SELECT enabled, prompt, api_key, provider, model FROM ai_config LIMIT 1');
    const dbConfig = aiConfigRes.rows[0] || {};

    res.json({
        apiKey: process.env.API_KEY,
        sendUrl: `${req.protocol}://${req.get('host')}/api/instance/send`,
        receiveUrl: `${req.protocol}://${req.get('host')}/api/messages/recent`,
        luxApp: {
            apiKey: process.env.API_KEY,
            sendUrl: `${req.protocol}://${req.get('host')}/api/instance/send`,
            queryUrl: `${req.protocol}://${req.get('host')}/api/messages/recent`,
            instanceId: 'default_instance' // Opcional
        },
        aiConfig: {
            enabled: dbConfig.enabled,
            prompt: dbConfig.prompt,
            apiKey: dbConfig.api_key,
            provider: dbConfig.provider || 'openai',
            model: dbConfig.model || '',
            baseUrl: dbConfig.base_url || ''
        }
    });
});

app.get('/api/ai/keys', validateAPI, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ai_keys');
        const keys = {};
        result.rows.forEach(r => {
            keys[r.provider] = { apiKey: r.api_key, baseUrl: r.base_url };
        });
        res.json(keys);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/config', validateAPI, async (req, res) => {
    const { enabled, prompt, apiKey, provider, model, baseUrl } = req.body;
    const finalProvider = provider || 'openai';
    const finalModel = model || '';
    const finalBaseUrl = baseUrl || '';
    try {
        // Actualizar configuración activa
        await pool.query(`
            UPDATE ai_config SET 
                enabled = $1, 
                prompt = $2, 
                api_key = $3,
                provider = $4,
                model = $5,
                base_url = $6
            WHERE id = (SELECT id FROM ai_config LIMIT 1)
        `, [enabled, prompt, apiKey, finalProvider, finalModel, finalBaseUrl]);

        // Guardar en la bóveda para este proveedor
        if (apiKey) {
            await pool.query(`
                INSERT INTO ai_keys (provider, api_key, base_url)
                VALUES ($1, $2, $3)
                ON CONFLICT (provider) DO UPDATE SET api_key = EXCLUDED.api_key, base_url = EXCLUDED.base_url
            `, [finalProvider, apiKey, finalBaseUrl]);
        }

        aiConfig = { enabled, prompt, api_key: apiKey, provider: finalProvider, model: finalModel, base_url: finalBaseUrl };
        initProviderClient(finalProvider, apiKey, finalBaseUrl);

        res.json({ status: "success", config: aiConfig });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/test', validateAPI, async (req, res) => {
    const { message } = req.body;
    if (!aiConfig.api_key) return res.status(400).json({ error: "API Key no configurada" });
    initProviderClient(aiConfig.provider, aiConfig.api_key, aiConfig.base_url);

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
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: message });

        const ts = Math.floor(Date.now() / 1000);
        const cleanTo = jid.split('@')[0];
        await saveMessage(jid, cleanTo, true, message, sent.key.id, ts);

        // Si un humano responde, pausar la IA automáticamente
        await pool.query('UPDATE wh_chats SET ai_active = false WHERE jid = $1', [jid]);

        io.emit('new_message', {
            jid,
            name: cleanTo,
            message: { text: message, fromMe: true, timestamp: ts },
            ai_paused: true // para la UI
        });

        res.json({ status: "sent", jid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint para alternar la IA manualmente
app.post('/api/chats/:jid/toggle-ai', validateAPI, async (req, res) => {
    try {
        const { active } = req.body;
        await pool.query('UPDATE wh_chats SET ai_active = $1 WHERE jid = $2', [active, req.params.jid]);
        res.json({ success: true, ai_active: active });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- LUXCARE INTEGRATION ENDPOINT ---
app.post('/api/lux/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { to, message, external_id } = req.body;

    // 1. Validar que la llave sea la correcta
    const secretKey = process.env.LUXCARE_API_KEY || 'lux_secret_123';
    if (apiKey !== secretKey) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    if (!sock?.user) return res.status(503).json({ error: "WhatsApp no conectado" });

    try {
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: message });

        const ts = Math.floor(Date.now() / 1000);
        const cleanTo = jid.split('@')[0];

        // Guardar mensaje en DB
        await saveMessage(jid, cleanTo, true, message, sent.key.id, ts);

        // Si LuxCare envía un mensaje, pausar la IA para ese chat
        await pool.query('UPDATE wh_chats SET ai_active = false WHERE jid = $1', [jid]);

        io.emit('new_message', {
            jid,
            name: cleanTo,
            message: { text: message, fromMe: true, timestamp: ts },
            ai_paused: true
        });

        // Responder con el formato que espera LuxCare
        res.status(200).json({
            status: 'sent',
            id_interno: external_id || sent.key.id
        });
    } catch (e) {
        console.error("Error en envio LuxCare:", e.message);
        res.status(500).json({ error: 'Error al enviar' });
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

const PORT = process.env.PORT || 3010;
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 LUXAPP HELPDESK ENGINE RUNNING ON PORT ${PORT}`);
    try {
        await initDB();
        connectToWhatsApp();
    } catch (e) {
        console.error("❌ Falla crítica en el inicio:", e.message);
    }
});

// Manejo global de errores para evitar que un error de red tumbe el servidor
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', async () => {
    console.log('--- Apagando servidor Luxapp ---');
    if (sock) try { await sock.logout(); } catch (e) { }
    await pool.end();
    process.exit(0);
});