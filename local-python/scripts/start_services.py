"""Provision project-owned Docker PostgreSQL/Ollama services with encrypted DB credentials."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import httpx
from techassist_rag.secrets import load_secret, store_secret

suffix = hashlib.sha256(str(Path.cwd()).encode()).hexdigest()[:8]
owner = str(Path.cwd())

def docker(args, **kwargs):
    return subprocess.run(['docker', *args], check=True, **kwargs)


def service(name, image, extra, env=None):
    exists = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
    if exists.returncode == 0:
        info = json.loads(exists.stdout)[0]
        if info['Config'].get('Labels', {}).get('com.techassist.workspace') != owner:
            raise RuntimeError('Container name is already in use by a different workspace.')
        docker(['start', name], stdout=subprocess.DEVNULL)
    else:
        docker(['run', '-d', '--name', name, '--label', 'com.techassist.workspace='+owner, '--restart', 'unless-stopped', *extra, image], env=env, stdout=subprocess.DEVNULL)


def main():
    directory = Path('.secrets')
    password = load_secret(directory, 'database')
    if not password:
        password = secrets.token_urlsafe(32)
        store_secret(directory, 'database', password)
    env = os.environ.copy()
    env['POSTGRES_PASSWORD'] = password
    pg = 'techassist-postgres-' + suffix
    ollama = 'techassist-ollama-' + suffix
    print('Preparing PostgreSQL container…', flush=True)
    service(pg, 'postgres:16-alpine', ['-p', '127.0.0.1:54329:5432', '-v', 'techassist-postgres-'+suffix+':/var/lib/postgresql/data', '-e', 'POSTGRES_USER=techassist', '-e', 'POSTGRES_DB=techassist', '-e', 'POSTGRES_PASSWORD'], env)
    for _ in range(60):
        ready = subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'techassist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('PostgreSQL did not become ready.')
    Path('.app').mkdir(exist_ok=True)
    if not Path('.app/services.json').exists():
        Path('.app/services.json').write_text(json.dumps({'postgres': pg, 'ollama': ollama}))
    print('PostgreSQL ready. Database credential is encrypted in the project.', flush=True)
    print('Preparing Ollama container…', flush=True)
    version=subprocess.run(['docker','version','--format','{{.Server.Version}}'],capture_output=True,text=True,check=True).stdout.strip()
    memory=int(subprocess.run(['docker','info','--format','{{.MemTotal}}'],capture_output=True,text=True,check=True).stdout.strip())
    model='qwen2.5:1.5b' if memory < 4_000_000_000 else 'qwen2.5:3b'
    image='ollama/ollama:latest'
    if version.startswith('20.10.') and int(version.split('.')[2].split('-')[0]) < 10:
        image='techassist-ollama-cpu:'+suffix
        print('Building current Ollama CPU runtime for Docker 20…',flush=True)
        docker(['build','-f','docker/ollama-cpu.Dockerfile','-t',image,'docker'])
        image_id=subprocess.run(['docker','image','inspect','--format','{{.Id}}',image],capture_output=True,text=True,check=True).stdout.strip().split(':')[-1][:8]
        ollama += '-cpu-'+image_id
    previous=json.loads(Path('.app/services.json').read_text()).get('ollama')
    if previous and previous!=ollama:
        old=subprocess.run(['docker','inspect',previous],capture_output=True,text=True)
        if old.returncode==0 and json.loads(old.stdout)[0]['Config'].get('Labels',{}).get('com.techassist.workspace')==owner:
            docker(['stop',previous],stdout=subprocess.DEVNULL)
    service(ollama, image, ['-p','127.0.0.1:11434:11434','-v','techassist-ollama-'+suffix+':/root/.ollama'])
    for _ in range(60):
        ready=subprocess.run(['docker','exec',ollama,'ollama','list'],capture_output=True)
        if ready.returncode==0:break
        time.sleep(1)
    else:raise RuntimeError('Ollama did not become ready; inspect its container logs.')
    Path('.app/services.json').write_text(json.dumps({'postgres':pg,'ollama':ollama,'model':model}))
    print('Downloading '+model+' for local generation…',flush=True)
    last_percent=-1
    with httpx.stream('POST','http://127.0.0.1:11434/api/pull',json={'model':model,'stream':True},timeout=180) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if not line:continue
            item=json.loads(line)
            if item.get('error'):raise RuntimeError('Local model download failed.')
            if item.get('total'):
                percent=int(item.get('completed',0)*100/item['total'])//10*10
                if percent!=last_percent:
                    print(f'Model download: {percent}%',flush=True);last_percent=percent
            elif item.get('status')=='success':print('Model downloaded.',flush=True)
    print('Services ready. Set RESPONSE_MODE=ollama to use the local planning model.', flush=True)


if __name__ == '__main__':
    main()
