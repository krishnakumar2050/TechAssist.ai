import {useEffect,useRef,useState} from 'react';
import {ArrowUp,ArrowUpRight,Plus,MessageSquare,PanelLeftClose,PanelLeftOpen,Monitor,Wifi,Camera,Headphones,ChevronRight,ChevronDown,Check,CheckCircle2,ShieldCheck,BookOpen,Copy,LifeBuoy,Sparkles,LoaderCircle,AlertTriangle,X,Command,RotateCcw} from 'lucide-react';
import {api,streamReply} from './api';
import type {Conversation,Device,Message,Reply,Session} from './types';

const emptyDevice:Device={os:'',model:'',application:'',admin_access:false};
const topics=[{name:'Connectivity',icon:Wifi,prompt:'My Windows 11 laptop connects to Wi-Fi, but websites will not load.',hint:'Wi-Fi, Bluetooth & networks',color:'blue'},
{name:'Camera & meetings',icon:Camera,prompt:'My Windows 11 camera works in the Camera app but not in a video meeting.',hint:'Get back in the conversation',color:'peach'},
{name:'Audio & sound',icon:Headphones,prompt:'My wireless headphones connect to Windows 11, but I cannot hear any sound.',hint:'Speakers, microphones & more',color:'purple'},
{name:'Laptop & power',icon:Monitor,prompt:'My laptop gets very hot during work and shuts down by itself.',hint:'Battery, charging & performance',color:'green'}];
const phases:Record<string,string>={understanding:'Understanding your issue',planning:'Reviewing your conversation',searching:'Finding relevant guidance',reranking_complete:'Checking the best matches',preparing_response:'Preparing your next step'};
const statusNames:Record<string,string>={collecting_context:'Getting context',awaiting_step_result:'In progress',resolved:'Resolved',escalated:'Ready for IT'};
function safeUrl(url:string){return /^https:\/\//i.test(url)?url:undefined;}

export default function App(){
 const[session,setSession]=useState<Session|null>(null),[history,setHistory]=useState<Conversation[]>([]),[active,setActive]=useState<Conversation|null>(null),[messages,setMessages]=useState<Message[]>([]);
 const[device,setDevice]=useState<Device>(emptyDevice),[input,setInput]=useState(''),[busy,setBusy]=useState(false),[phase,setPhase]=useState(''),[error,setError]=useState(''),[login,setLogin]=useState(false),[ready,setReady]=useState(false),[sidebar,setSidebar]=useState(false),[contextOpen,setContextOpen]=useState(false);
 const[retry,setRetry]=useState<{cid:string;body:any}|null>(null);const end=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{let live=true;(async()=>{try{const s=await api<Session>('/session');if(!live)return;setSession(s);const list=await api<Conversation[]>('/conversations');if(!live)return;setHistory(list);const cid=new URLSearchParams(location.search).get('chat');if(cid){const c=await api<Conversation>('/conversations/'+encodeURIComponent(cid));if(!live)return;setActive(c);setMessages(c.messages||[]);setDevice({...emptyDevice,...c.state.device});}}catch(e){if(live){setError((e as Error).message);if((e as Error).message.includes('Sign in'))setLogin(true);}}finally{if(live)setReady(true);}})();return()=>{live=false;};},[]);
 useEffect(()=>{const shortcut=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(!busy)newChat();}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[busy]);
 useEffect(()=>{end.current?.scrollIntoView?.({behavior:'smooth'});},[messages,phase]);
 async function refresh(cid:string){const[c,list]=await Promise.all([api<Conversation>('/conversations/'+cid),api<Conversation[]>('/conversations')]);setActive(c);setMessages(c.messages||[]);setHistory(list);setDevice({...emptyDevice,...c.state.device});}
 async function select(cid:string){if(busy)return;setError('');try{await refresh(cid);historyUrl(cid);setSidebar(false);setRetry(null);}catch(e){setError((e as Error).message);}}
 function historyUrl(cid?:string){window.history.replaceState(null,'',cid?'/?chat='+cid:'/');}
 function newChat(){if(busy)return;setActive(null);setMessages([]);setInput('');setDevice(emptyDevice);setError('');setRetry(null);historyUrl();setSidebar(false);textarea.current?.focus();}
 async function send(text=input,action='message',stepId?:string,override?:Device){
  if(!session||busy||!text.trim())return;setError('');setBusy(true);setInput('');setPhase('understanding');let cid=active?.id;
  try{if(!cid){const c=await api<Conversation>('/conversations',{method:'POST',headers:{'X-CSRF-Token':session.csrf_token}});cid=c.id;setActive(c);historyUrl(cid);}
   const body={request_id:crypto.randomUUID(),message:text,action,step_id:stepId||null,device:override||device};setRetry({cid,body});
   setMessages(m=>[...m,{id:body.request_id,role:'user',content:text,payload:{} as Reply,created:new Date().toISOString()}]);
   await doStream(cid,body);setRetry(null);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);setPhase('');}
 }
 async function doStream(cid:string,body:any){await streamReply('/conversations/'+cid+'/messages',session!.csrf_token,body,(event,data)=>{if(event==='progress')setPhase(data.phase);});await refresh(cid);}
 async function retryTurn(){if(!retry||busy)return;setBusy(true);setError('');try{await doStream(retry.cid,retry.body);setRetry(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);setPhase('');}}
 function choice(text:string){let next=device;if(['Windows 11','macOS','Ubuntu'].includes(text)){next={...device,os:text};setDevice(next);}void send(text,'message',undefined,next);}
 const lastReply=[...messages].reverse().find(m=>m.role==='assistant')?.payload;
 const closed=active?.status==='resolved'||active?.status==='escalated';
 const attempts=active?.state.attempted||[];
 return <div className="app-shell">
  {sidebar&&<button className="scrim" aria-label="Close navigation" onClick={()=>setSidebar(false)}/>}
  <aside className={'sidebar '+(sidebar?'is-open':'')}>
   <a className="brand" href="/" onClick={e=>{e.preventDefault();newChat();}}><span className="brand-symbol"><Command size={21}/></span>techassist<span className="brand-dot">.</span></a>
   <div className="workspace-label"><span className="tiny-dot"/>EMPLOYEE WORKSPACE</div>
   <button className="new-chat" onClick={newChat} disabled={busy}><Plus size={17}/>New conversation<span>⌘ K</span></button>
   <div className="nav-section-label">YOUR SPACE</div>
   <button className={'nav-item '+(!active?'selected':'')} onClick={newChat} disabled={busy}><Sparkles size={17}/>Support assistant<ChevronRight size={14}/></button>
   <div className="history-head"><span>RECENT CONVERSATIONS</span><MessageSquare size={13}/></div>
   <nav className="history-list" aria-label="Conversation history">{history.length===0?<p className="empty-history">Your conversations will appear here.</p>:history.map(c=><button key={c.id} className={'history-item '+(active?.id===c.id?'active':'')} disabled={busy} onClick={()=>select(c.id)}><MessageSquare size={15}/><span>{c.title}</span>{c.status==='resolved'&&<Check size={13}/>}</button>)}</nav>
   <div className="sidebar-bottom"><div className="help-note"><ShieldCheck size={19}/><div><strong>A little guidance goes a long way.</strong><p>Clear steps. Trusted sources.<br/>Support at your pace.</p></div></div><div className="profile"><div className="avatar">Y</div><div><strong>Your workspace</strong><span>{session?.auth_mode==='oidc'?'Employee account':'Local session'}</span></div><button className="icon-button" aria-label="Close sidebar" onClick={()=>setSidebar(false)}><PanelLeftClose size={17}/></button></div></div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={()=>setSidebar(true)}><PanelLeftOpen size={20}/></button><span>Workspace</span><ChevronRight size={13}/><strong>Support assistant</strong></div><div className="topbar-right"><span className="availability"><i/>Here to help</span><button className="context-toggle" onClick={()=>setContextOpen(!contextOpen)} aria-label="Toggle device context"><Monitor size={17}/><span>My device</span></button></div></header>
   <main className={'main-area '+(active?'chat-layout':'welcome-layout')}>
    <section className="conversation-area">
     {!active&&<div className="welcome">
       <div className="eyebrow"><span className="sparkle-box"><Sparkles size={16}/></span>YOUR WORKDAY, UNINTERRUPTED</div>
       <h1>A little help.<br/><span>A smoother workday.</span></h1>
       <p className="welcome-description">Tech trouble shouldn’t slow you down. Tell me what’s happening,<br className="desktop-br"/> and we’ll work through it together, one step at a time.</p>
       <div className="start-label">WHAT CAN WE HELP YOU WITH?</div>
       <div className="topic-grid">{topics.map(t=><button className="topic-card" key={t.name} disabled={busy||!session} onClick={()=>send(t.prompt)}><span className={'topic-icon '+t.color}><t.icon size={21}/></span><div><strong>{t.name}</strong><span>{t.hint}</span></div><ArrowUpRight size={17}/></button>)}</div>
       <div className="welcome-note"><BookOpen size={15}/><span>Grounded in our technical knowledge. Tailored to your issue.</span></div>
     </div>}
     {active&&<><div className="conversation-heading"><div><span className="eyebrow small">LET’S WORK THROUGH IT</span><h2>{active.title==='New conversation'?'Your support conversation':active.title}</h2></div><span className={'status-badge '+active.status}>{statusNames[active.status]||'In progress'}</span></div><div className="message-list" aria-live="polite">{messages.map((m,i)=><div className={'message '+m.role} key={m.id}>{m.role==='user'?<><span className="user-message">{m.content}</span><div className="message-avatar">Y</div></>:<><div className="assistant-avatar"><Command size={17}/></div><div className="assistant-content"><div className="assistant-label">TechAssist <span>{m.payload.mode==='nebius'?'NEBIUS AI':m.payload.mode==='ollama'?'LOCAL AI':'GUIDED SUPPORT'}</span></div><AssistantAnswer
  reply={m.payload}
  fallback={m.content}
  interactive={i===messages.length-1&&!closed}
  busy={busy}
  onChoice={choice}
  onOutcome={(text,action,id)=>void send(text,action,id)}
/></div></>}</div>)}{busy&&<div className="progress-message" role="status"><div className="assistant-avatar"><Command size={17}/></div><LoaderCircle size={15} className="spin"/><span>{phases[phase]||'Working on your next step'}<span className="loading-dots">…</span></span></div>}<div ref={end}/></div></>}
     <div className={'composer-area '+(!active?'initial-composer':'')}>
      {error&&<div className="error-notice" role="alert"><AlertTriangle size={16}/><span>{error}</span>{retry&&<button onClick={retryTurn} disabled={busy}><RotateCcw size={14}/>Retry</button>}<button aria-label="Dismiss error" onClick={()=>setError('')}><X size={15}/></button></div>}
      {login?<a className="login-button" href="/api/auth/login">Sign in with your employee account<ArrowUpRight size={17}/></a>:closed?<div className="closed-composer"><span>{active?.status==='resolved'?'This conversation is resolved.':'Your handoff summary is ready.'}</span><button onClick={newChat}>Start a new conversation<Plus size={15}/></button></div>:<form className="composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea ref={textarea} aria-label="Describe your technical issue" placeholder={active?'Tell me what happened, or ask a follow-up…':'Describe your issue. For example, “My laptop won’t connect to Wi-Fi”…'} value={input} maxLength={4000} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}} rows={2} disabled={busy||!ready||!session}/><div className="composer-toolbar"><span><ShieldCheck size={14}/>{session?.response_mode==='nebius'?'Nebius AI · source-backed guidance':session?.response_mode==='ollama'?'Local AI · source-backed guidance':'Guided support · source-backed steps'}</span><button className="send-button" aria-label="Send message" disabled={!input.trim()||busy||!session}>{busy?<LoaderCircle size={18} className="spin"/>:<ArrowUp size={20}/>}</button></div></form>}
      <p className="composer-footer">TechAssist can make mistakes. Check the sources and contact IT when you’re unsure.</p>
     </div>
    </section>
    <aside className={'context-panel '+(contextOpen?'context-open':'')}><button className="icon-button context-close" aria-label="Close device context" onClick={()=>setContextOpen(false)}><X size={18}/></button><div className="context-heading"><span className="context-glyph"><Monitor size={19}/></span><div><strong>A little context helps.</strong><p>Get guidance that fits your setup.</p></div></div><div className="device-form"><label>Operating system<select value={device.os} disabled={busy||closed} onChange={e=>setDevice({...device,os:e.target.value})}><option value="">Select your OS</option><option>Windows 11</option><option>Windows 10</option><option>macOS</option><option>Ubuntu</option></select></label><label>Laptop model <span>optional</span><input value={device.model} placeholder="e.g. Dell Latitude 5440" maxLength={120} disabled={busy||closed} onChange={e=>setDevice({...device,model:e.target.value})}/></label><label>Affected application <span>optional</span><input value={device.application} placeholder="e.g. Microsoft Teams" maxLength={120} disabled={busy||closed} onChange={e=>setDevice({...device,application:e.target.value})}/></label><label className="admin-checkbox"><input type="checkbox" checked={device.admin_access} disabled={busy||closed} onChange={e=>setDevice({...device,admin_access:e.target.checked})}/>I have administrator access</label><p className="field-hint">Included with your next message.</p></div>{active&&<div className="workflow"><div className="context-section-label">YOUR PROGRESS</div><div className="workflow-item"><span className="workflow-dot checked"><Check size={11}/></span><div><strong>Understand the issue</strong><p>{lastReply?.category||'Gathering context'}</p></div></div><div className="workflow-item"><span className={'workflow-dot '+(attempts.length?'checked':'current')}>{attempts.length?<Check size={11}/>:<span/>}</span><div><strong>Work through the checks</strong><p>{attempts.length?`${attempts.length} check${attempts.length===1?'':'s'} recorded`:'One clear step at a time'}</p></div></div><div className="workflow-item"><span className={'workflow-dot '+(active.status==='resolved'?'checked':'')}>{active.status==='resolved'&&<Check size={11}/>}</span><div><strong>Confirm the outcome</strong><p>{active.status==='resolved'?'Issue resolved':'Let us know what changes'}</p></div></div>{attempts.length>0&&<details className="attempts"><summary>Previous checks<ChevronDown size={13}/></summary>{attempts.map((a,i)=><div key={a.id}><span>{i+1}</span><p>{a.instruction}<small>{a.outcome==='failed'?'Issue continued':a.outcome==='cannot'?'Could not perform':'Resolved'}</small></p></div>)}</details>}</div>}<div className="support-card"><LifeBuoy size={22}/><h3>Sometimes you need<br/>a human touch.</h3><p>If we can’t resolve it here, take your troubleshooting history to IT.</p><button disabled={!active||busy||closed} onClick={()=>send('Please prepare a handoff summary for IT.','escalate')}>Prepare an IT handoff<ArrowUpRight size={15}/></button></div><div className="privacy-note"><ShieldCheck size={14}/><span>Never share passwords or recovery keys in chat.</span></div></aside>
   </main>
  </div>
 </div>
}
function AssistantAnswer({reply,fallback,interactive,busy,onChoice,onOutcome}:{
  reply:Reply;
  fallback:string;
  interactive:boolean;
  busy:boolean;
  onChoice:(choice:string)=>void;
  onOutcome:(message:string,action:'worked'|'failed'|'cannot',stepId:string)=>void;
}){
  const summary=reply.summary||fallback;
  return <>
    {!reply.steps?.length&&summary&&<p>{summary}</p>}
    {reply.question&&<div className="clarification">
      <strong>{reply.question}</strong>
      {interactive&&!!reply.choices?.length&&<div className="choice-row">
        {reply.choices.map(choice=><button key={choice} disabled={busy} onClick={()=>onChoice(choice)}>
          {choice}<ChevronRight size={13}/>
        </button>)}
      </div>}
    </div>}
    {reply.steps?.map((step,index)=><div className="step-card" key={step.id}>
      <div className="step-title">
        <span className="step-number">{(reply.progress?.attempts||0)+index+1}</span>
        <span>{interactive?'NEXT STEP':'TROUBLESHOOTING STEP'}</span>
      </div>
      <h3>{step.instruction}</h3>
      {index===0&&summary&&summary.trim()!==step.instruction.trim()&&
        <p className="step-context">{summary}</p>}
      {step.expected_result&&<div className="expected">
        <CheckCircle2 size={15}/><span><strong>How to check it worked</strong>{step.expected_result}</span>
      </div>}
      <StepSources sources={(reply.sources||[]).filter(source=>step.source_ids?.includes(source.id))}/>
      {interactive&&<div className="outcome-buttons">
        <button className="solved" disabled={busy} onClick={()=>onOutcome('That solved the problem.','worked',step.id)}><Check size={15}/>That solved it</button>
        <button disabled={busy} onClick={()=>onOutcome('I tried this, but the issue is still happening.','failed',step.id)}>Still not working</button>
        <button className="text-button" disabled={busy} onClick={()=>onOutcome('I cannot perform this step.','cannot',step.id)}>I can’t do this</button>
      </div>}
    </div>)}
    {reply.escalation&&<Handoff text={reply.escalation}/>}
    {!reply.steps?.length&&<StepSources sources={reply.sources||[]}/>}
  </>;
}

function StepSources({sources}:{sources:Reply['sources']}){
  if(!sources.length)return null;
  return <ul className="step-sources" aria-label="Supporting articles">
    {sources.map(source=>{
      const url=safeUrl(source.url);
      return <li key={source.id}>
        <BookOpen size={14} aria-hidden="true"/>
        {url?<a href={url} target="_blank" rel="noopener noreferrer">{source.title}<ArrowUpRight size={13} aria-hidden="true"/></a>:<span>{source.title}</span>}
      </li>;
    })}
  </ul>;
}
function Handoff({text}:{text:string}){const[copied,setCopied]=useState(false);return <div className="handoff"><div><LifeBuoy size={17}/><strong>Your IT handoff</strong><button onClick={()=>{navigator.clipboard.writeText(text).then(()=>setCopied(true)).catch(()=>setCopied(false));}}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?'Copied':'Copy'}</button></div><pre>{text}</pre><p>Share this with your IT team through your usual support channel.</p></div>}
