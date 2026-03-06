const fs = require('fs');
const path = require('path');

class JSONDatabase {
    constructor() {
        this.filePath = path.join(__dirname, 'db.json');
        if (!fs.existsSync(this.filePath)) {
            console.log('[DB] Creando archivo db.json inicial...');
            fs.writeFileSync(this.filePath, JSON.stringify({
                users: [],
                ai_config: [{ id: 1, enabled: false, prompt: 'Eres un asistente virtual de Luxapp. Responde de manera profesional y amable.', api_key: '', provider: 'openai', model: '' }],
                wh_chats: [],
                wh_messages: []
            }, null, 2));
        }
        this.data = JSON.parse(fs.readFileSync(this.filePath));
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error('[DB] Error guardando JSON:', err);
        }
    }

    async query(text, params = []) {
        const lowerText = text.toLowerCase().trim();
        console.log(`[DB] Consulta: ${lowerText.substring(0, 50)}... | Params: ${params.length}`);

        // MOCK DE QUERIES
        if (lowerText.includes('create table') || lowerText.includes('alter table')) {
            return { rows: [] };
        }

        // SELECT AI_CONFIG
        if (lowerText.includes('from ai_config')) {
            return { rows: this.data.ai_config };
        }

        // SELECT USERS
        if (lowerText.includes('from users')) {
            if (params.length >= 2) {
                const user = this.data.users.find(u => u.username === params[0] && u.password === params[1]);
                return { rows: user ? [user] : [] };
            }
            return { rows: this.data.users };
        }

        // INSERT USER
        if (lowerText.includes('insert into users')) {
            this.data.users.push({ id: this.data.users.length + 1, username: params[0], password: params[1] });
            this.save();
            return { rows: [] };
        }

        // UPDATE AI_CONFIG
        if (lowerText.includes('update ai_config')) {
            console.log(`[DB] Actualizando AI Config a provider: ${params[3]}`);
            this.data.ai_config[0] = {
                ...this.data.ai_config[0],
                enabled: params[0],
                prompt: params[1],
                api_key: params[2],
                provider: params[3],
                model: params[4]
            };
            this.save();
            return { rows: [] };
        }

        // SELECT CHATS
        if (lowerText.includes('from wh_chats')) {
            return { rows: [...this.data.wh_chats].sort((a, b) => b.last_timestamp - a.last_timestamp) };
        }

        // SELECT MESSAGES
        if (lowerText.includes('from wh_messages')) {
            if (lowerText.includes('where jid = $1')) {
                const msgs = this.data.wh_messages.filter(m => m.jid === params[0]).slice(-50);
                return { rows: msgs };
            }
            return { rows: this.data.wh_messages.slice(-50) };
        }

        // UPSERT CHAT
        if (lowerText.includes('insert into wh_chats') || lowerText.includes('on conflict (jid)')) {
            const index = this.data.wh_chats.findIndex(c => c.jid === params[0]);
            const chat = { jid: params[0], name: params[1], last_message: params[2], last_timestamp: params[3] };
            if (index > -1) this.data.wh_chats[index] = chat;
            else this.data.wh_chats.push(chat);
            this.save();
            return { rows: [] };
        }

        // INSERT MESSAGE
        if (lowerText.includes('insert into wh_messages')) {
            if (!this.data.wh_messages.find(m => m.msg_id === params[0])) {
                this.data.wh_messages.push({ msg_id: params[0], jid: params[1], from_me: params[2], text: params[3], timestamp: params[4] });
                this.save();
            }
            return { rows: [] };
        }

        return { rows: [] };
    }

    async end() {
        this.save();
    }
}

let pool;
require('dotenv').config();
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('tu_host')) {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('[DB] Conectado a Postgres remoto.');
} else {
    console.log('⚠️ [DB] Usando Base de Datos local (JSON).');
    pool = new JSONDatabase();
}

module.exports = { pool };
