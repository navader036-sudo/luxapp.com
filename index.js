require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Servir archivos estáticos

// CONFIGURACIÓN PRIVADA
const API_TOKEN = "MI_TOKEN_SECRETO_123";
let sock = null;
let qrBase64 = null;
let receivedMessages = [];
// Lista de números permitidos (whitelist)
const allowedNumbers = [];

console.log('--- Configuración inicializada ---');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_luxapp');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`--- Usando v${version.join('.')} (Latest: ${isLatest}) ---`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrBase64 = qr;
            console.log('⚡ Nuevo código QR generado. Escanéalo en el panel web.');
        }

        if (connection === 'open') {
            qrBase64 = null;
            console.log('✅ Luxapp está conectado y listo.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexión cerrada. Reintentando:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        }
    });

    sock.ev.on('messages.upsert', m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Guardamos el mensaje en el buffer para que tu sistema administrativo lo recoja
        receivedMessages.push({
            id: msg.key.id,
            from: msg.key.remoteJid.split('@')[0],
            pushName: msg.pushName,
            text: msg.message.conversation || msg.message.extendedTextMessage?.text || "Multimedia",
            timestamp: msg.messageTimestamp
        });
    });
}

// --- ENDPOINTS PARA TU SISTEMA ADMINISTRATIVO ---

// 1. Consultar estado y obtener QR
app.get('/api/instance/status', (req, res) => {
    const token = req.headers['authorization'];
    if (token !== API_TOKEN) return res.status(401).json({ error: "No autorizado" });

    res.json({
        connected: sock?.user ? true : false,
        number: sock?.user?.id ? sock.user.id.split(':')[0] : null,
        qrCode: qrBase64, // Tu sistema puede usar este string para mostrar el QR
        info: "Si connected es false y qrCode tiene valor, muestra el QR en tu sistema."
    });
});

// 2. Enviar Mensaje (Tu sistema administrativo llama aquí)
app.post('/api/instance/send', async (req, res) => {
    const token = req.headers['authorization'];
    const { to, message } = req.body;

    if (token !== API_TOKEN) return res.status(401).json({ error: "No autorizado" });
    if (!sock?.user) return res.status(503).json({ error: "WhatsApp no conectado" });

    // Verificar envío masivo
    if (Array.isArray(to)) {
        return res.status(400).json({ error: "Envio masivo no permitido", warning: "No se permite envío de mensajes a múltiples números simultáneamente" });
    }

    // Verificar número en whitelist (opcional)
    if (allowedNumbers.length && !allowedNumbers.includes(to)) {
        return res.status(403).json({ error: "Número no autorizado", warning: "El número no está en la lista de números permitidos" });
    }

    try {
        const jid = `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ status: "sent", to: to, warning: "Recuerda que no se pueden enviar mensajes masivos" });

        // 3b. Responder a un mensaje recibido (reply)
        app.post('/api/instance/reply', async (req, res) => {
            const token = req.headers['authorization'];
            const { to, message, replyTo } = req.body;

            if (token !== API_TOKEN) return res.status(401).json({ error: "No autorizado" });
            if (!sock?.user) return res.status(503).json({ error: "WhatsApp no conectado" });

            // Validar envío masivo (solo un número)
            if (Array.isArray(to)) {
                return res.status(400).json({ error: "Envio masivo no permitido", warning: "No se permite envío de mensajes a múltiples números simultáneamente" });
            }

            // Validar whitelist
            if (allowedNumbers.length && !allowedNumbers.includes(to)) {
                return res.status(403).json({ error: "Número no autorizado", warning: "El número no está en la lista de números permitidos" });
            }

            if (!replyTo) return res.status(400).json({ error: "replyTo (id del mensaje) es requerido" });

            try {
                const jid = `${to}@s.whatsapp.net`;
                await sock.sendMessage(jid, { text: message, quoted: { key: { id: replyTo, remoteJid: jid } } });
                res.json({ status: "sent", to, replyTo, warning: "Recuerda que no se pueden enviar mensajes masivos" });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Consultar mensajes recibidos (Pulling)
app.get('/api/instance/messages', (req, res) => {
    const token = req.headers['authorization'];
    if (token !== API_TOKEN) return res.status(401).json({ error: "No autorizado" });

    const messagesToDeliver = [...receivedMessages];
    receivedMessages = [];
    res.json({ count: messagesToDeliver.length, messages: messagesToDeliver });
});

// 4. Añadir número a la lista de permitidos
app.post('/api/instance/add-number', (req, res) => {
    const token = req.headers['authorization'];
    const { number } = req.body;
    if (token !== API_TOKEN) return res.status(401).json({ error: "No autorizado" });
    if (!number) return res.status(400).json({ error: "Número requerido" });
    if (!allowedNumbers.includes(number)) {
        allowedNumbers.push(number);
    }
    res.json({ status: "added", number, allowedNumbers });
});

// 4. Cerrar sesión completamente
app.post('/api/instance/logout', async (req, res) => {
    const token = req.headers['authorization'];
    if (token !== API_TOKEN) return res.status(401).json({ error: "No autorizado" });

    if (sock) await sock.logout();
    if (fs.existsSync('auth_luxapp')) fs.rmSync('auth_luxapp', { recursive: true, force: true });
    res.json({ status: "logged_out" });
    setTimeout(() => process.exit(0), 1000);
});

app.listen(3000, () => {
    console.log("🚀 LUXAPP ENGINE RUNNING ON PORT 3000");
    connectToWhatsApp();
});