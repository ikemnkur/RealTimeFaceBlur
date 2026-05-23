require('dotenv').config();
const knex = require('knex')({
    client: 'mysql2',
    connection: {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 3306,
        user:     process.env.DB_USER     || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME     || 'faceblurr',
    },
    pool: {
        min: 0,
        max: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    },
});

module.exports = knex;
