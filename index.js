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

// CONFIGURACIÓN PRIVADA
const API_TOKEN = process.env.API_TOKEN || "MI_TOKEN_SECRETO_123";
let sock = null;
let qrBase64 = null;

// MEMORIA DEL SISTEMA
let chatHistory = {}; // { jid: { name: '', messages: [] } }
let aiConfig = {
    enabled: false,
    prompt: "Eres un asistente virtual de Luxapp. Responde de manera profesional y amable.",
    apiKey: process.env.OPENAI_API_KEY || ""
};

const openai = aiConfig.apiKey ? new OpenAI({ apiKey: aiConfig.apiKey }) : null;

console.log('--- Configuración inicializada ---');

async function connectToWhatsApp() {
    if (sock) {
        try { sock.ws.close(); } catch (e) { }
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_luxapp');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`--- Iniciando motor Luxapp v${version.join('.')} ---`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
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
            console.log('✅ Luxapp está conectado y listo.');
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
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const from = jid.split('@')[0];
        const pushName = msg.pushName || from;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "Multimedia";

        // Guardar en historial
        if (!chatHistory[jid]) chatHistory[jid] = { name: pushName, messages: [] };
        const newMsg = {
            id: msg.key.id,
            fromMe: false,
            text,
            timestamp: msg.messageTimestamp
        };
        chatHistory[jid].messages.push(newMsg);

        // Notificar al Helpdesk vía Socket
        io.emit('new_message', { jid, name: pushName, message: newMsg });

        // Lógica de Asistente Virtual
        if (aiConfig.enabled && !msg.key.remoteJid.includes('@g.us')) {
            await handleAIResponse(jid, text);
        }
    });
}

async function handleAIResponse(jid, userText) {
    if (!aiConfig.apiKey) return;

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

        // Guardar respuesta de la IA
        const aiMsg = {
            id: 'ai_' + Date.now(),
            fromMe: true,
            text: aiText,
            timestamp: Math.floor(Date.now() / 1000)
        };
        chatHistory[jid].messages.push(aiMsg);
        io.emit('new_message', { jid, name: chatHistory[jid].name, message: aiMsg });

    } catch (e) {
        console.error("Error AI:", e.message);
    }
}

// --- ENDPOINTS PARA EL PANEL ---

app.get('/api/instance/status', (req, res) => {
    res.json({
        connected: !!sock?.user,
        number: sock?.user?.id ? sock.user.id.split(':')[0] : null,
        qrCode: qrBase64
    });
});

app.get('/api/chats', (req, res) => {
    res.json(chatHistory);
});

app.post('/api/ai/config', (req, res) => {
    const { enabled, prompt, apiKey } = req.body;
    if (enabled !== undefined) aiConfig.enabled = enabled;
    if (prompt) aiConfig.prompt = prompt;
    if (apiKey !== undefined) aiConfig.apiKey = apiKey;
    res.json({ status: "success", config: aiConfig });
});

app.post('/api/instance/send', async (req, res) => {
    const { to, message } = req.body;
    if (!sock?.user) return res.status(503).json({ error: "WhatsApp no conectado" });

    try {
        const jid = `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });

        // Guardar en historial
        if (!chatHistory[jid]) chatHistory[jid] = { name: to, messages: [] };
        const myMsg = { id: Date.now().toString(), fromMe: true, text: message, timestamp: Math.floor(Date.now() / 1000) };
        chatHistory[jid].messages.push(myMsg);
        io.emit('new_message', { jid, name: chatHistory[jid].name, message: myMsg });

        res.json({ status: "sent" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.listen(3000, () => {
    console.log("🚀 LUXAPP HELPDESK & ENGINE RUNNING ON PORT 3000");
    connectToWhatsApp();
});

process.on('SIGINT', async () => {
    console.log('--- Apagando servidor Luxapp ---');
    if (sock) try { await sock.logout(); } catch (e) { }
    process.exit(0);
});