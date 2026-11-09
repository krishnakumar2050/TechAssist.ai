import json,re,subprocess
from pathlib import Path
info=json.loads(Path('.app/services.json').read_text())
name=info['ollama']
logs=subprocess.run(['docker','logs',name],capture_output=True,text=True)
lines=(logs.stdout+'\n'+logs.stderr).splitlines()
messages=list(dict.fromkeys(line for line in lines if re.search(r'pthread|failed|fatal|error|SIGABRT|Operation not permitted',line,re.I)))
print('\n'.join(messages[:12]))
state=subprocess.run(['docker','inspect','--format','{{json .State}}',name],capture_output=True,text=True)
s=json.loads(state.stdout)
print(json.dumps({k:s.get(k) for k in ('Status','ExitCode','Error','OOMKilled')}))
mem=subprocess.run(['docker','info','--format','{{.MemTotal}}'],capture_output=True,text=True)
print('Docker memory bytes:',mem.stdout.strip())
