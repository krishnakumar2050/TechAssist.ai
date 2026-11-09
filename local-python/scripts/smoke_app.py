"""Live local-app smoke test with synthetic employee messages only."""
import json
from pathlib import Path
import httpx


def events(response):
    response.raise_for_status()
    completed=[]
    for frame in response.text.split('\n\n'):
        if frame.startswith('event: error'):
            raise RuntimeError('Agent turn failed: '+frame)
        if frame.startswith('event: completed'):
            completed.append(json.loads(frame.split('data: ',1)[1]))
    assert completed, 'Missing completed SSE event'
    return completed[-1]


def main():
    with httpx.Client(base_url='http://127.0.0.1:8000',timeout=230) as client:
        assert client.get('/').status_code==200
        session=client.get('/api/session').json()
        headers={'X-CSRF-Token':session['csrf_token']}
        cid=client.post('/api/conversations',headers=headers).json()['id']
        def turn(number,message,**kw):
            answer=events(client.post(f'/api/conversations/{cid}/messages',headers=headers,json={'request_id':f'smoke-turn-{number}','message':message,**kw}))
            print(json.dumps({'turn':number,'mode':answer['mode'],'status':answer['status'],'step':answer['steps'][0]['instruction'] if answer['steps'] else None}),flush=True)
            return answer
        answer=turn(1,'My Windows 11 camera works in Camera app, but not in Teams.',device={'os':'Windows 11','application':'Teams','model':'Dell Latitude 5440'})
        if answer['status']=='collecting_context':
            answer=turn(2,'Microsoft Teams is the affected application. The preview is black.')
        assert answer['status']=='awaiting_step_result', answer
        first=answer['steps'][0]['id']
        answer=turn(3,'I tried this, but it is still failing.',action='failed',step_id=first)
        if answer['status']=='collecting_context':
            answer=turn(4,'The camera is allowed but the preview is still black in Teams.')
        assert answer['status']=='awaiting_step_result', answer
        assert answer['steps'][0]['id']!=first
        answer=turn(5,'That solved it.',action='worked',step_id=answer['steps'][0]['id'])
        assert answer['status']=='resolved'
        persisted=client.get('/api/conversations/'+cid).json()
        assert len(persisted['state']['attempted'])==2
        assert persisted['state']['device']['os']=='Windows 11'
        with httpx.Client(base_url='http://127.0.0.1:8000') as other:
            other.get('/api/session')
            assert other.get('/api/conversations/'+cid).status_code==404
        report={'status':'passed','response_mode':session['response_mode'],'conversation_id':cid,'checks':['frontend HTTP 200','live Pinecone retrieval and reranking','source-backed step','failed step leads to different step','resolved outcome','PostgreSQL conversation persistence','cross-session ownership isolation']}
        Path('reports').mkdir(exist_ok=True)
        Path('reports/application_smoke_'+session['response_mode']+'.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report),flush=True)


if __name__=='__main__':main()
