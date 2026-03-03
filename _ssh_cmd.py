import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.1.0.190', username='root', password='skw18@10')

cmd = """docker exec rick-ai-agent-1 node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/rick.db');
const users = db.prepare('SELECT id, role, display_name FROM users').all();
console.log('Users:', JSON.stringify(users, null, 2));
const identities = db.prepare('SELECT user_id, connector, external_id FROM user_identities').all();
console.log('Identities:', JSON.stringify(identities, null, 2));
" """

stdin, stdout, stderr = client.exec_command(cmd)
print(stdout.read().decode('utf-8', errors='replace'))
print(stderr.read().decode('utf-8', errors='replace'))
client.close()
