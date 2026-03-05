const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function main() {
    try {
        await pool.query('SELECT 1');
    } catch(err) {
        console.error('❌ Error inicializando DB:', err.message);
    }
}
main();
