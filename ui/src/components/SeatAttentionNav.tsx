import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { SidebarNavItem } from "./SidebarNavItem";
export function SeatAttentionNav(){
 const {selectedCompanyId}=useCompany();
 const seats=useQuery({queryKey:["dsp7-registered-seats",selectedCompanyId],queryFn:()=>dsp7SeatsApi.list(selectedCompanyId!),enabled:Boolean(selectedCompanyId),refetchInterval:10000,retry:false});
 const alerts=(seats.data??[]).flatMap(s=>s.presence?.alerts??[]);
 useEffect(()=>{
  if(typeof Notification==='undefined'||Notification.permission!=='granted')return;
  for(const a of alerts){const key='seat-alert:'+selectedCompanyId+':'+a.id+':'+a.level;try{if(sessionStorage.getItem(key))continue;sessionStorage.setItem(key,'1');new Notification(a.level==='urgent'?'智研协同平台：阻塞超时升级':'智研协同平台：等待人工处理',{body:a.message,tag:key});}catch{/* Inline alerts and Mac reminders remain available. */}}
 },[selectedCompanyId,JSON.stringify(alerts.map(a=>[a.id,a.level]))]);
 return <SidebarNavItem to="/seats" label="席位管理" icon={Network} badge={alerts.length||undefined} badgeTone={alerts.some(a=>a.level==='urgent')?'danger':'warning'} badgeLabel="项待处理"/>;
}
