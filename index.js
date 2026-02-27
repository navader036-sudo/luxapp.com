require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const pino = require('pino');
const path = require('path');

const app = express();

// --- CONFIGURACIÓN DE EXPRESS ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Esto activa tu página web

// CONFIGURACIÓN DE TU API (Token de seguridad)
const MI_API_TOKEN = "ABC123XYZ";
let sock = null;
let qrActual = null;

// --- MOTOR DE WHATSAPP ---
async function iniciarInstancia() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('sesion_activa');

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['AdminSystem', 'Chrome', '1.0.0'],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrActual = qr;
            console.clear();
            console.log("==========================================");
            console.log("🔑 API TOKEN: " + MI_API_TOKEN);
            console.log("📢 ESCANEA EL QR EN: http://localhost:3000");
            console.log("==========================================");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            qrActual = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                console.log("⏳ Reintentando conexión...");
                setTimeout(iniciarInstancia, 5000);
            }
        } else if (connection === 'open') {
            qrActual = null;
            console.clear();
            console.log("✅ WHATSAPP CONECTADO Y API LISTA");
        }
    });

    // Guardar el socket globalmente
    app.locals.sock = sock;
}

// --- RUTAS DE LA API ---

// 1. Página Principal (Frontend)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Estado de la Instancia (Para el frontend y tu sistema)
app.get('/status', (req, res) => {
    res.json({
        instancia: sock?.user ? "CONECTADA" : "DESCONECTADA",
        qr: qrActual,
        numero: sock?.user?.id || null
    });
});

// 3. Enviar Mensaje (Ruta que llamará tu Sistema Administrativo)
// Ejemplo de uso: POST a http://localhost:3000/send
app.post('/send', (req, res) => {
    const { token, to, message } = req.body;

    // Validación de Token (Seguridad)
    if (token !== MI_API_TOKEN) {
        return res.status(401).json({ error: "Token de API inválido" });
    }

    if (!app.locals.sock?.user) {
        return res.status(503).json({ error: "WhatsApp no está vinculado actualmente" });
    }

    // Formatear el número de destino
    const jid = `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    app.locals.sock.sendMessage(jid, { text: message })
        .then(m => {
            res.json({
                status: "success",
                messageId: m.key.id,
                to: jid
            });
        })
        .catch(e => {
            res.status(500).json({ error: "Error al enviar: " + e.message });
        });
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor API corriendo en http://localhost:${PORT}`);
    iniciarInstancia();
});