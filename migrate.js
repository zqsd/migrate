#!/usr/bin/env node

const fs = require('fs');
const db = require('./db');
const path = require('path');
const glob = require('glob-promise');
const moment = require('moment');

async function tableExists(client, name) {
    const tables = await client.query('SHOW TABLES;');
    for(let row of tables.rows) {
        if(row.Table === name)
            return true;
    }
    return false;
}

async function getMigrationFiles() {
    return (await glob('./migrations/*.js')).sort(function(a,b){
        return a.localeCompare(b);
    }).map((filename) => {
        return path.basename(filename, '.js');
    });
}

async function getCurrentMigration() {
    const [result] = (await client.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows;
    if(result)
        return result.name;
    return null;
}

async function up(client) {
    const migrationFiles = await getMigrationFiles();
    const currentMigration = await getCurrentMigration();
    let migrationName;
    if(!currentMigration) {
        migrationName = migrationFiles[0];
    }
    else {
        for(let i = 0; i < migrationFiles.length - 1; i++) {
            if(migrationFiles[i] === currentMigration) {
                migrationName = migrationFiles[i + 1];
                break;
            }
        }
    }

    if(migrationName) {
        console.log('inserting migration ' + migrationName);

        const migration = require('./migrations/' + migrationName + '.js');
        try {
            await migration.up(client);
            await client.query('INSERT INTO migrations (name) VALUES ($1)', [migrationName]);
        }
        catch(e) {
            await migration.down(client);
            console.error(e);
            throw e;
        }
    }
}

async function down() {
    const migrationFiles = await getMigrationFiles();
    const migrationName = await getCurrentMigration();
    if(migrationName) {
        console.log('removing migration ' + migrationName);

        const migration = require('./migrations/' + migrationName + '.js');
        try {
            await migration.down(client);
            await client.query('DELETE FROM migrations WHERE name = $1', [migrationName]);
        }
        catch(e) {
            await migration.up(client);
            console.error(e);
            throw e;
        }
    }
}

async function status() {
    let migrations = {};

    for(let m of await glob('./migrations/*.js')) {
        const name = path.basename(m, '.js');
        migrations[name] = {
            name: name,
            file: true,
            db: false,
        };
    }

    for(let m of (await client.query('SELECT * FROM migrations')).rows) {
        const name = m.name;
        if(!migrations[name]) {
            migrations[name] = {
                name: name,
                file: false,
                db: true,
            };
        }
        else {
            migrations[name].db = true;
        }
    }

    Object.values(migrations).sort(function(a, b) {
        return a.name.localeCompare(b.name);
    }).forEach((migration) => {
        console.log(` [${migration.db ? '*' : ' '}] ${migration.name}`);
    });
}

function create() {
    const filename = moment().format('YYYYMMDDHHmmss') + '.js';
    fs.writeFileSync(path.join('migrations', filename), `exports.up = async (client) => {
    await client.query(\`CREATE TABLE users(
        "id" UUID PRIMARY KEY NOT NULL,
        "name" STRING NOT NULL,
        UNIQUE INDEX name_idx(name ASC)
    );\`);
};

exports.down = async (client) => {
    await client.query('DROP TABLE IF EXISTS users CASCADE;');
};`);
    console.log(`created migrations/${filename}`);
}

(async () => {
    client = await db.pool.connect();
    try {
        if(!await tableExists(client, 'migrations')) {
            const r = await client.query(`CREATE TABLE migrations (
                "id" UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
                "name" TEXT NOT NULL UNIQUE
            );`);
            console.log('migrations table initialized');
        }

        if(process.argv.length === 2) {
            await status();
        }
        else {
            if(process.argv[2] === 'status') {
                await status(client);
            }
            else if(process.argv[2] === 'new' || process.argv[2] === 'create') {
                create();
            }
            else if(process.argv[2] === 'up') {
                await up(client);
                await status(client);
            }
            else if(process.argv[2] === 'down') {
                await down(client);
                await status(client);
            }
            else {
                console.error('unknown command');
                process.exit(1);
            }
        }

        process.exit(0);
    }
    catch(e) {
        throw e;
    }
    finally {
        client.release();
    }
})().catch(e => {
    console.log(e.stack);
    process.exit(1);
});

