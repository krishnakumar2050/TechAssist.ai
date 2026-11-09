// @vitest-environment jsdom
import React from 'react';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,waitFor,cleanup,fireEvent} from '@testing-library/react';
import App from './App';
import {api,streamReply} from './api';
vi.mock('./api',()=>({api:vi.fn(),streamReply:vi.fn()}));
const session={csrf_token:'test-csrf',auth_mode:'local',display_name:'Your workspace',response_mode:'guided',model:null};
const conversation={id:'conversation-1',title:'Camera problem',status:'collecting_context',updated:'',version:0,state:{},messages:[]};
beforeEach(()=>{vi.resetAllMocks();window.history.replaceState(null,'','/');vi.mocked(api).mockImplementation(async(path)=>{if(path==='/session')return session as any;if(path==='/conversations')return [] as any;return conversation as any;});});
afterEach(cleanup);
describe('Employee support UI',()=>{
 it('shows issue categories, device context and an accessible composer',async()=>{render(<App/>);await waitFor(()=>expect(screen.getByRole('button',{name:'Send message'}).hasAttribute('disabled')).toBe(true));expect(screen.getByText('A little help.')).toBeTruthy();expect(screen.getByText('Camera & meetings')).toBeTruthy();expect(screen.getByLabelText('Operating system')).toBeTruthy();expect(screen.getByLabelText('Describe your technical issue')).toBeTruthy();});
 it('sends an employee query through the streaming endpoint and loads persisted history',async()=>{vi.mocked(api).mockImplementation(async(path,options)=>{if(path==='/session')return session as any;if(path==='/conversations'&&options?.method==='POST')return conversation as any;if(path==='/conversations')return [] as any;return {...conversation,messages:[{id:'a',role:'assistant',content:'Which OS?',payload:{status:'collecting_context',summary:'Let’s find the right instructions.',category:'Camera',mode:'guided',question:'Which operating system?',choices:['Windows 11'],steps:[],sources:[],progress:{}}}]} as any;});vi.mocked(streamReply).mockResolvedValue(undefined);render(<App/>);await waitFor(()=>expect(screen.getByLabelText('Describe your technical issue').hasAttribute('disabled')).toBe(false));fireEvent.change(screen.getByLabelText('Describe your technical issue'),{target:{value:'My camera does not work'}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));await waitFor(()=>expect(streamReply).toHaveBeenCalledOnce());expect(vi.mocked(streamReply).mock.calls[0][2]).toMatchObject({message:'My camera does not work',action:'message'});await screen.findByText('Which operating system?');expect(screen.getByRole('button',{name:/Windows 11/})).toBeTruthy();});
 it('offers employee sign-in when the backend requires authentication',async()=>{vi.mocked(api).mockRejectedValue(new Error('Sign in to continue.'));render(<App/>);expect(await screen.findByText('Sign in with your employee account')).toBeTruthy();});
});
