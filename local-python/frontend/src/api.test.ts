// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {streamReply} from './api';
afterEach(()=>vi.unstubAllGlobals());
it('parses SSE frames split across network packets',async()=>{const data=new TextEncoder().encode('event: progress\ndata: {"phase":"searching"}\n\nevent: completed\ndata: {"status":"resolved"}\n\n');const body=new ReadableStream({start(c){c.enqueue(data.slice(0,17));c.enqueue(data.slice(17,80));c.enqueue(data.slice(80));c.close();}});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body)));const callback=vi.fn();await streamReply('/conversation','csrf',{},callback);expect(callback).toHaveBeenNthCalledWith(1,'progress',{phase:'searching'});expect(callback).toHaveBeenNthCalledWith(2,'completed',{status:'resolved'});});
it('does not report a truncated stream as a completed answer',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('event: progress\ndata: {"phase":"searching"}\n\n')));await expect(streamReply('/conversation','csrf',{},vi.fn())).rejects.toThrow('connection ended');});
