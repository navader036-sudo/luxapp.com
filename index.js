require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs'); // Añadido para gestionar archivos de sesión

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_TOKEN = "ABC123XYZ";
let sock = null;
let qrCode = null;

async function startWA() {
    console.log("🔄 Iniciando motor de WhatsApp...");
    const { version } = await fetchLatestBaileysVersion();

    // Usamos 'sesion_activa' como carpeta de archivos
    const { state, saveCreds } = await useMultiFileAuthState('sesion_activa');

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['AdminSystem', 'Safari', '15.0'], // Identidad estable
        printQRInTerminal: false,
    });

    // Guardar credenciales al actualizarse
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;
            console.clear();
            console.log("📢 NUEVO QR GENERADO - ESCANEA EN EL PANEL WEB");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            qrCode = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Conexión cerrada. Código: ${code}`);

            // Si no fue un cierre de sesión manual, reconectar
            if (code !== DisconnectReason.loggedOut) {
                console.log("⏳ Reintentando conexión en 5 segundos...");
                setTimeout(startWA, 5000);
            }
        } else if (connection === 'open') {
            qrCode = null;
            console.log("✅ WHATSAPP CONECTADO Y API LISTA");
        }
    });

    // Hacer el socket accesible globalmente
    app.locals.sock = sock;
}

// --- ENDPOINTS DE ADMINISTRACIÓN ---

// 1. Estado de la Instancia
app.get('/status', (req, res) => {
    const s = app.locals.sock;
    res.json({
        instancia: s?.user ? "CONECTADA" : "DESCONECTADA",
        numero: s?.user?.id ? s.user.id.split(':')[0] : null,
        qr: qrCode
    });
});

// 2. Cerrar Sesión y Cambiar Número (Logout)
app.get('/logout', async (req, res) => {
    try {
        const s = app.locals.sock;
        if (s) {
            await s.logout(); // Desconecta de WhatsApp
            s.end(); // Cierra el socket
        }

        // Borrar carpeta de sesión para permitir nuevo QR
        const sessionPath = path.join(__dirname, 'sesion_activa');
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log("🗑️ Sesión eliminada físicamente.");
        }

        res.json({ status: "success", message: "Sesión cerrada. El servidor se reiniciará." });

        // Reiniciar el proceso para limpiar memoria y generar nuevo QR
        setTimeout(() => { process.exit(0); }, 1500);

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Enviar Mensaje vía API
app.post('/send', (req, res) => {
    const { token, to, message } = req.body;
    const s = app.locals.sock;

    if (token !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    if (!s?.user) return res.status(503).json({ error: "WA Not Connected" });

    // Limpiar el número y formatear JID
    const cleanNumber = to.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    s.sendMessage(jid, { text: message })
        .then(m => res.json({ status: "success", messageId: m.key.id }))
        .catch(e => res.status(500).json({ error: e.message }));
});

// --- INICIO DEL SERVIDOR ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🌐 API Dashboard en http://localhost:${PORT}`);
    startWA();
});