"""Build and run the local React/FastAPI application."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--build', action='store_true', help='Build the React UI before starting')
    parser.add_argument('--mode', choices=['guided','ollama','nebius'], default=None)
    parser.add_argument('--port', type=int, default=8000)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    os.chdir(root)
    if args.build:
        node=shutil.which('node')
        bundled=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
        if not node and bundled.is_file():node=str(bundled)
        if not node:raise SystemExit('Node.js 20+ is required to build the frontend.')
        env=os.environ.copy();env['PATH']=str(Path(node).parent)+os.pathsep+env.get('PATH','')
        subprocess.run([node,'node_modules/typescript/bin/tsc','-b'],cwd=root/'frontend',env=env,check=True)
        subprocess.run([node,'node_modules/vite/bin/vite.js','build'],cwd=root/'frontend',env=env,check=True)
    if not (root/'frontend/dist/index.html').exists():
        raise SystemExit('Frontend build missing. Run python scripts/run_app.py --build.')
    if args.mode:
        os.environ['RESPONSE_MODE']=args.mode
    elif 'RESPONSE_MODE' not in os.environ and (root/'.app/services.json').exists():
        from dotenv import dotenv_values
        if not dotenv_values(root/'.env').get('RESPONSE_MODE'):
            os.environ['RESPONSE_MODE']='ollama'
    import uvicorn
    print(f'TechAssist is available at http://127.0.0.1:{args.port}',flush=True)
    uvicorn.run('techassist_rag.web.app:create_app',factory=True,host='127.0.0.1',port=args.port,access_log=False)


if __name__=='__main__':main()
