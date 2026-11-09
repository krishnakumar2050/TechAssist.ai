"""Verify structured planning against the local model using synthetic evidence."""
import json
import httpx
from pathlib import Path
from techassist_rag.web.agent import OllamaPlanner
from techassist_rag.web.settings import AppSettings

settings=AppSettings.from_env()
context={'issue':'Camera works in Camera app but not Teams','device':{'os':'Windows 11','application':'Microsoft Teams'},
         'confirmed_employee_messages':['Camera hardware works in the Camera app.'], 'attempted_steps':[],
         'questions_already_asked':[], 'recent_history':[],
         'eligible_steps':[{'source_id':'camera-1','step_number':1,'instruction':'Check Windows camera access for the affected app'}],
         'evidence':[{'id':'camera-1','text':'Camera works in one app only. Check camera access for the affected application. Verify its preview works.'}]}
try:
    plan=OllamaPlanner(settings).plan(context)
except httpx.HTTPStatusError as exc:
    print(json.dumps({'status':'model_error','detail':exc.response.json().get('error','Unknown local model error')}),flush=True)
    raise SystemExit(1)
assert plan.action=='choose_step' and plan.source_id=='camera-1' and plan.step_number==1, plan
report={'status':'passed','model':settings.ollama_model,'action':plan.action,'source_id':plan.source_id,'step_number':plan.step_number,'summary':plan.summary}
Path('reports').mkdir(exist_ok=True)
Path('reports/local_model_smoke.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
