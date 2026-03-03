import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.1.0.190', username='root', password='skw18@10')

cmd = """docker exec subagent-d633f700f4fc0d00 node -e "fetch('http://788be820f769:80/api/agent/memories', {headers: {Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSWQiOiJkNjMzZjcwMGY0ZmMwZDAwIiwidXNlclBob25lIjoiMTM5NDk2NzEyNTgxMzI0IiwibnVtZXJpY1VzZXJJZCI6MiwiZXhwIjoxNzcyNjQyNTAyfQ.qsDUr1vFSOwnPXIAhAq_U7pQAqEElIq0lWb9f6kZTZQ'}}).then(r => console.log(r.status, r.statusText)).catch(e => console.log('Error:', e.message))" """

stdin, stdout, stderr = client.exec_command(cmd)
print(stdout.read().decode('utf-8', errors='replace'))
print(stderr.read().decode('utf-8', errors='replace'))
client.close()
