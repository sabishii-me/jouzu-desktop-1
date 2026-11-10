import {test,expect,type Page} from '@playwright/test';
import { UI_BASE } from './host-control';

// Drives the real onboarding surface through a stateful configuration backend.
async function openSetup(page:Page, initial:{profile?:string|null;modelReady?:boolean;recent?:{id:string;path:string;environment:{kind:string}}[]}={}) {
 await page.addInitScript(state=>{
  localStorage.setItem('jouzu.ui.language','en');
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const callbacks:Record<string,unknown>={};
  const s={profile:state.profile ?? null,modelReady:state.modelReady ?? false,signedIn:state.modelReady ?? false,recent:state.recent ?? []};
  let cancelPending:(()=>void)|null=null;
  const snapshot=()=>({schemaVersion:1,modelReady:s.modelReady,profile:s.profile,account:{signedIn:s.signedIn},credentials:[],customProviders:[],providers:[{id:'openai',name:'OpenAI'},{id:'openai-codex',name:'Codex',oauth:true,oauthName:'OpenAI (ChatGPT Plus/Pro)',apiKey:false}],models:[]});
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:(callback:unknown)=>{const id=String(Math.random());callbacks[id]=callback;return id;},
   unregisterCallback:()=>{},
   invoke:async (command:string,args:any)=>{
    if(command==='plugin:event|listen'){if(args.event==='control-device')(window as any).__deviceHandler=args.handler;return 1;}
    if(command==='launcher_state')return {ready:true,bash:true,platform:'windows',recent:s.recent};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='environment_read')return [];
    if(command==='cancel_control'){cancelPending?.();return 1;}
    if(command==='control_request'){
     const action=args?.request?.action;
     if(action==='profile')s.profile=String(args.request.profile);
     if(action==='shisa-logout'){s.signedIn=false;s.modelReady=false;}
     if(action==='custom-provider')s.modelReady=true;
     if(action==='shisa-login'){
      s.signedIn=true;
      // The device panel stays until sign-in settles, mirroring the blocking backend call.
      (callbacks[(window as any).__deviceHandler] as any)?.({event:'control-device',id:1,payload:{url:'https://platform.shisa.ai/connect',code:'DEMO-1234'}});
      return new Promise((resolve,reject)=>{cancelPending=()=>{cancelPending=null;reject(new Error('cancelled'));};setTimeout(()=>{cancelPending=null;resolve(snapshot());},8000);});
     }
     if(action==='provider-oauth'){
      (callbacks[(window as any).__deviceHandler] as any)?.({event:'control-device',id:1,payload:{provider:'openai-codex',url:'https://auth.openai.com/codex/device',code:'DEMO-CODE'}});
      return new Promise((resolve,reject)=>{cancelPending=()=>{cancelPending=null;reject(new Error('cancelled'));};setTimeout(()=>{cancelPending=null;resolve(snapshot());},8000);});
     }
     return snapshot();
    }
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 },initial);
 await page.goto(UI_BASE);
}

// Drives the first status read so the window is caught in its start-up state, before any page exists.
async function openStartup(page:Page, status:'hang'|'fail') {
 await page.addInitScript(mode=>{
  localStorage.setItem('jouzu.ui.language','en');
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1, unregisterCallback:()=>{},
   invoke:async (command:string)=>{
    if(command==='launcher_state')return {ready:true,bash:true,recent:[],platform:'windows'};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='control_request')return mode==='hang' ? new Promise(()=>{}) : Promise.reject(new Error('Cannot start configuration service'));
    if(command==='environment_read')return [];
    if(command==='diagnostics')return {schemaVersion:1,crashes:[],records:[]};
    if(command.includes('version'))return '0.3.8';
    return 1;
   }
  };
 },status);
 await page.goto(UI_BASE);
}
test('a missing model opens the connect-a-model page, without a language step', async ({page}) => {
 await openSetup(page,{modelReady:false});
 await expect(page.getByRole('heading',{name:'Connect a model'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Sign in to Shisa.AI',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'English',exact:true})).toHaveCount(0);
});

test('Shisa.AI authorization keeps its actions together and cancels cleanly', async ({page}) => {
 await openSetup(page,{modelReady:false});
 await page.getByRole('button',{name:'Sign in to Shisa.AI',exact:true}).click();
 const open=page.getByRole('button',{name:'Open in browser',exact:true});
 const cancel=page.getByRole('button',{name:'Cancel',exact:true});
 await expect(open).toBeVisible();
 const a=await open.boundingBox(), b=await cancel.boundingBox();
 expect(a?.y).toBe(b?.y);
 expect(b!.x+b!.width).toBeLessThan(a!.x);
 await cancel.click();
 await expect(open).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Sign in to Shisa.AI',exact:true})).toBeVisible();
});

test('Codex OAuth is an Add Provider entry and cancels cleanly', async ({page}) => {
 await openSetup(page,{modelReady:false});
 await page.getByRole('combobox',{name:'Service',exact:true}).click();
 await page.getByRole('option',{name:'Codex',exact:true}).click();
 await expect(page.getByText('OpenAI (ChatGPT Plus/Pro)',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();
 await expect(page.getByLabel('Sign-in URL',{exact:true})).toHaveValue('https://auth.openai.com/codex/device');
 await expect(page.getByLabel('Device code',{exact:true})).toHaveValue('DEMO-CODE');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign in with ChatGPT',exact:true})).toBeVisible();
});

test('a configured model opens the workspace', async ({page}) => {
 await openSetup(page,{modelReady:true,recent:[{id:'w1',path:'C:/Projects/Jouzu',environment:{kind:'windows'}}]});
 await expect(page.getByRole('button',{name:'New session',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Connect a model'})).toHaveCount(0);
});



