import json
from fastapi.testclient import TestClient
from techassist_rag.web.app import create_app
from techassist_rag.web.database import Database
from techassist_rag.web.settings import AppSettings
from techassist_rag.web.agent import Agent, Plan

HIT = {'id':'camera-1', 'document_id':'camera', 'title':'Camera permissions', 'platform':'Windows 11',
       'rerank_score':.9, 'source_urls':['https://support.microsoft.com/camera'],
       'text':'Camera permissions\nResolution:\n1. Check the privacy shutter\n2. Select the camera in the app\nVerify: Preview works\nEscalate: Contact IT'}


class Retriever:
    def __init__(self, hits=None):
        self.hits = hits if hits is not None else [HIT]
        self.calls = []
    def retrieve(self, query):
        self.calls.append(query)
        return self.hits


def setup(tmp_path, retriever=None, planner=None):
    settings = AppSettings(database_url='sqlite:///'+str(tmp_path/'app.db'))
    r = retriever or Retriever()
    app = create_app(settings, agent=Agent(settings, r, planner))
    client = TestClient(app)
    session = client.get('/api/session').json()
    headers = {'X-CSRF-Token':session['csrf_token']}
    conversation = client.post('/api/conversations', headers=headers).json()
    return client, headers, conversation['id'], r


def turn(client, headers, cid, text, **kwargs):
    count = len(client.get('/api/conversations/'+cid).json()['messages'])
    body = {'request_id':f'request-{count:04d}', 'message':text, **kwargs}
    response = client.post('/api/conversations/'+cid+'/messages', headers=headers, json=body)
    assert response.status_code == 200, response.text
    frames = [f for f in response.text.split('\n\n') if 'event: completed' in f]
    assert frames, response.text
    return json.loads(frames[-1].split('data: ',1)[1])


def test_clarify_retrieve_followup_and_resolve_are_persistent(tmp_path):
    c,h,cid,r = setup(tmp_path)
    reply = turn(c,h,cid,'My camera is not working.')
    assert reply['status']=='collecting_context' and 'operating system' in reply['question']
    assert not r.calls
    reply = turn(c,h,cid,'Windows 11')
    assert reply['steps'][0]['instruction']=='Check the privacy shutter'
    first = reply['steps'][0]['id']
    reply = turn(c,h,cid,'Still failing',action='failed',step_id=first)
    assert reply['steps'][0]['instruction']=='Select the camera in the app'
    assert reply['steps'][0]['id'] != first
    reply = turn(c,h,cid,'It works now',action='worked',step_id=reply['steps'][0]['id'])
    assert reply['status']=='resolved'
    loaded = c.get('/api/conversations/'+cid).json()
    assert len(loaded['messages'])==8
    assert len(loaded['state']['attempted'])==2
    assert loaded['state']['device']['os']=='Windows 11'
    assert 'My camera' in r.calls[-1]


def test_two_browser_sessions_cannot_read_or_write_each_others_history(tmp_path):
    c,h,cid,r = setup(tmp_path)
    other = TestClient(c.app)
    csrf = other.get('/api/session').json()['csrf_token']
    assert other.get('/api/conversations').json()==[]
    assert other.get('/api/conversations/'+cid).status_code==404
    assert other.post('/api/conversations/'+cid+'/messages',headers={'X-CSRF-Token':csrf},json={'request_id':'request-other','message':'Read history'}).status_code==404


def test_csrf_and_cross_origin_write_are_rejected(tmp_path):
    c,h,cid,r = setup(tmp_path)
    assert c.post('/api/conversations').status_code==403
    assert c.post('/api/conversations',headers={**h,'Origin':'https://attacker.example'}).status_code==403


def test_duplicate_turn_is_replayed_without_second_retrieval(tmp_path):
    c,h,cid,r = setup(tmp_path)
    body={'request_id':'same-request-id','message':'Windows 11 camera is not working'}
    url='/api/conversations/'+cid+'/messages'
    assert c.post(url,headers=h,json=body).status_code==200
    assert c.post(url,headers=h,json=body).status_code==200
    assert len(r.calls)==1
    assert len(c.get('/api/conversations/'+cid).json()['messages'])==2


def test_stale_step_is_rejected(tmp_path):
    c,h,cid,r = setup(tmp_path)
    turn(c,h,cid,'Windows 11 camera failure')
    response=c.post('/api/conversations/'+cid+'/messages',headers=h,json={'request_id':'stale-request','message':'Worked','action':'worked','step_id':'old-step'})
    assert response.status_code==409


def test_low_evidence_clarifies_once_then_escalates(tmp_path):
    c,h,cid,r = setup(tmp_path,Retriever([]))
    reply=turn(c,h,cid,'How do I fix my printer?',device={'os':'Windows 11'})
    assert reply['status']=='collecting_context'
    reply=turn(c,h,cid,'The print queue is stuck.')
    assert reply['status']=='escalated'
    assert reply['escalation']


def test_battery_safety_bypasses_normal_step_loop(tmp_path):
    c,h,cid,r=setup(tmp_path)
    reply=turn(c,h,cid,'My laptop battery is swollen and the trackpad is lifting.')
    assert reply['status']=='escalated'
    assert 'Stop using' in reply['summary']
    assert reply['steps']==[]


def test_model_cannot_choose_invented_instructions_and_loop_is_bounded(tmp_path):
    class BadPlanner:
        calls=0
        def plan(self, context):
            self.calls+=1
            return Plan(action='choose_step',source_id='invented',step_number=1)
    planner=BadPlanner()
    c,h,cid,r=setup(tmp_path,planner=planner)
    reply=turn(c,h,cid,'Windows 11 camera failure')
    assert reply['status']=='escalated'
    assert planner.calls==3


def test_model_selects_only_verified_source_step(tmp_path):
    class Planner:
        def plan(self, context):
            assert context['eligible_steps']
            return Plan(action='choose_step',source_id='camera-1',step_number=2,summary='Let’s check the application settings.')
    c,h,cid,r=setup(tmp_path,planner=Planner())
    reply=turn(c,h,cid,'Windows 11 camera issue')
    assert reply['steps'][0]['instruction']=='Select the camera in the app'
    assert reply['steps'][0]['source_ids']==['camera-1']


def test_failed_provider_does_not_erase_history_or_leave_lease(tmp_path):
    class FailingRetriever:
        def retrieve(self, query):
            raise RuntimeError('private provider payload must not leak')
    c,h,cid,r=setup(tmp_path,FailingRetriever())
    response=c.post('/api/conversations/'+cid+'/messages',headers=h,json={'request_id':'failed-request','message':'Windows 11 camera failure'})
    assert 'event: error' in response.text
    assert 'private provider' not in response.text
    assert c.get('/api/conversations/'+cid).json()['messages']==[]
    c.app.state.agent.retriever=Retriever()
    assert turn(c,h,cid,'Windows 11 camera failure')['steps']


def test_memory_survives_database_reopen(tmp_path):
    c,h,cid,r=setup(tmp_path)
    turn(c,h,cid,'Windows 11 camera failure')
    token=c.cookies.get('techassist_session')
    reopened=Database('sqlite:///'+str(tmp_path/'app.db'))
    owner=reopened.identity(token)['owner']
    assert reopened.get(owner,cid)['state']['pending']['instruction']=='Check the privacy shutter'
    reopened.engine.dispose()


def test_concurrent_claims_are_serialized(tmp_path):
    db=Database('sqlite:///'+str(tmp_path/'lock.db'))
    row=db.create('owner')
    lease=db.claim('owner',row['id'])
    import pytest
    from techassist_rag.web.database import Conflict
    with pytest.raises(Conflict):db.claim('owner',row['id'])
    db.release(row['id'],lease)
    assert db.claim('owner',row['id'])


def test_freeform_already_checked_advances_without_repeating_step(tmp_path):
    c,h,cid,r=setup(tmp_path)
    first=turn(c,h,cid,'Windows 11 camera failure')
    second=turn(c,h,cid,'The privacy shutter is already on.')
    assert second['steps'][0]['id'] != first['steps'][0]['id']
    saved=c.get('/api/conversations/'+cid).json()
    assert len(saved['state']['attempted'])==1


def test_agent_can_refine_retrieval_once_then_choose_a_supported_step(tmp_path):
    class Planner:
        calls=0
        def plan(self, context):
            self.calls+=1
            if self.calls==1:
                return Plan(action='retrieve',query='Windows camera application permissions')
            return Plan(action='choose_step',source_id='camera-1',step_number=2,summary='Check the app selection next.')
    planner=Planner()
    c,h,cid,r=setup(tmp_path,planner=planner)
    answer=turn(c,h,cid,'Windows 11 camera failure')
    assert answer['steps'][0]['instruction']=='Select the camera in the app'
    assert len(r.calls)==2 and planner.calls==2


def test_agent_work_runs_off_the_api_event_loop(tmp_path):
    import threading
    c,h,cid,r=setup(tmp_path)
    seen={}
    original=c.app.state.agent.turn
    def record(*args,**kwargs):
        seen['worker']=threading.get_ident()
        return original(*args,**kwargs)
    c.app.state.agent.turn=record
    async def loop_identity():
        return {'thread':threading.get_ident()}
    c.app.add_api_route('/_test_loop_thread',loop_identity)
    with c:
        loop_thread=c.get('/_test_loop_thread').json()['thread']
        turn(c,h,cid,'Windows 11 camera failure')
        assert seen['worker']!=loop_thread


def test_new_safety_signal_overrides_apparent_resolution(tmp_path):
    c,h,cid,r=setup(tmp_path)
    turn(c,h,cid,'Windows 11 camera failure')
    reply=turn(c,h,cid,'That solved it, but now there is a burning smell.')
    assert reply['status']=='escalated' and 'Stop using' in reply['summary']


def test_nebius_planner_sends_structured_plan_and_preserves_source_step(tmp_path, monkeypatch):
    import httpx
    from techassist_rag.web.agent import NebiusPlanner
    from techassist_rag.web.schemas import TurnRequest

    monkeypatch.setenv('NEBIUS_API_KEY', 'test-key')
    def complete(client, url, *, headers, json):
        assert url == 'https://api.tokenfactory.nebius.com/v1/chat/completions'
        assert headers['Authorization'] == 'Bearer test-key'
        assert json['model'] == 'openai/gpt-oss-20b'
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'choices': [{'message': {'content': '{"action":"choose_step","source_id":"camera-1","step_number":2,"summary":"The camera works in other apps."}'}}]
        })

    monkeypatch.setattr(httpx.Client, 'post', complete)
    settings = AppSettings(response_mode='nebius')
    state, answer = Agent(settings, Retriever(), NebiusPlanner(settings)).turn(
        {'state': {}}, TurnRequest(
            request_id='nebius-test', message='Windows 11 camera issue'))
    assert answer['mode'] == 'nebius'
    assert answer['steps'][0]['instruction'] == 'Select the camera in the app'
