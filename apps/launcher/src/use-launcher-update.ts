import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { createUpdateSchedule, startUpdateChecks } from "./update-schedule";
import { logEvent } from "./log-event";
export function useLauncherUpdate(configured: boolean, enabled = true) {
 const candidate = useRef<Update | null>(null);
 const [version,setVersion]=useState<string|null>(null);
 const [notes,setNotes]=useState<string|null>(null);
 const [phase,setPhase]=useState<"idle"|"checking"|"current"|"available"|"downloading"|"installing"|"error">("idle");
 const [progress,setProgress]=useState<number|undefined>();
 const [error,setError]=useState<string|null>(null);
 const lock=useRef(false);
 // A silent check runs on its own schedule and must not move the interface while it asks.
 async function refresh(silent=false) {
  if(!configured || !enabled || lock.current)return;
  lock.current=true;if(!silent){setError(null);setPhase("checking");}
  try {
   await candidate.current?.close();candidate.current=null;setVersion(null);setNotes(null);
   const update=await check({timeout:20000});candidate.current=update;
   setVersion(update?.version ?? null);setNotes(update?.body ?? null);setPhase(update ? "available":"current");
   logEvent(update ? `launcher update check result=available version=${update.version}` : "launcher update check result=current");
  }catch(e){logEvent(`launcher update check failed error=${String(e)}`);if(!silent){setError(String(e));setPhase("error");}}finally{lock.current=false;}
 }
 async function install() {
  if(!candidate.current || lock.current)return;
  lock.current=true;setError(null);setProgress(undefined);setPhase("downloading");
  logEvent(`launcher update installing version=${candidate.current.version}`);
  let downloaded=0,total=0;
  try {
   await candidate.current.download(event=>{
    if(event.event==="Started")total=event.data.contentLength ?? 0;
    if(event.event==="Progress")downloaded+=event.data.chunkLength;
    if(total>0)setProgress(Math.min(100,downloaded/total*100));
   });
   setPhase("installing");
   await candidate.current.install({restartAfterInstall:true});
  }catch(e){logEvent(`launcher update install failed error=${String(e)}`);setError(String(e));setPhase("error");}finally{lock.current=false;}
 }
 // The schedule lives for the whole session, so it reads the current refresh through a ref: the first
 // render happens before the configuration arrives, and a captured refresh would answer from it.
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 const schedule=useRef(createUpdateSchedule(silent=>{void refreshRef.current(silent);}));
 useEffect(()=>{ if(!configured || !enabled)return; return startUpdateChecks(schedule.current); },[configured,enabled]);
 return {version,notes,phase,progress,error,refresh:()=>refresh(),install,busy:phase==="checking"||phase==="downloading"||phase==="installing"};
}
