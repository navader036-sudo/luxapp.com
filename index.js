const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json()); // Para que la API entienda JSON

let sock; // Variable global para mantener la conexión

async function conectarAWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ['Mi API Express', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const debeReconectar = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (debeReconectar) conectarAWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ API de WhatsApp lista y conectada');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- RUTA DE LA API PARA ENVIAR MENSAJES ---
app.post('/enviar', async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ error: 'Falta el número o el mensaje' });
    }

    try {
        // Formatear el número (debe terminar en @s.whatsapp.net)
        // Ejemplo: "5215512345678@s.whatsapp.net"
        const idDestino = `${numero}@s.whatsapp.net`;

        await sock.sendMessage(idDestino, { text: mensaje });

        res.status(200).json({ status: 'Enviado correctamente', a: numero });
    } catch (err) {
        res.status(500).json({ error: 'Error al enviar el mensaje', detalle: err.message });
    }
});

// Iniciar servidor Express
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor API corriendo en http://localhost:${PORT}`);
    conectarAWhatsApp();
});