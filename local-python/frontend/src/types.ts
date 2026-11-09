export type Device = {os:string;model:string;application:string;admin_access:boolean};
export type Step = {id:string;instruction:string;expected_result:string;source_ids:string[]};
export type Reply = {status:string;summary:string;category:string;mode:'guided'|'ollama'|'nebius';question?:string;choices:string[];steps:Step[];sources:{id:string;title:string;url:string;relevance:number}[];escalation?:string;progress:{attempts:number;turn:number}};
export type Message = {id:string;role:'user'|'assistant';content:string;payload:Reply;created:string};
export type Conversation = {id:string;title:string;status:string;updated:string;version:number;state:{device?:Device;attempted?:{id:string;instruction:string;outcome:string}[];pending?:Step;summary?:string};messages?:Message[]};
export type Session = {csrf_token:string;auth_mode:string;display_name:string;response_mode:string;model:string|null};
