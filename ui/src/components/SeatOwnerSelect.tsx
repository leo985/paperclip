import { useQuery } from "@tanstack/react-query";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { SearchableSelect } from "@/components/SearchableSelect";
export function SeatOwnerSelect({companyId,value,onChange,disabled=false}:{companyId:string;value:string;onChange:(value:string)=>void;disabled?:boolean}) {
 const people=useQuery({queryKey:["dsp7-seat-owner-candidates",companyId],queryFn:()=>dsp7SeatsApi.ownerCandidates(companyId)});
 return <div className="space-y-2"><SearchableSelect value={value} onValueChange={id=>onChange(id)} disabled={disabled||Boolean(people.error)} loading={people.isLoading} placeholder="选择席位负责人" searchPlaceholder="搜索姓名或邮箱" emptyMessage="没有可选人员，请先在组织成员中激活研发成员。" groups={[{id:"owners",options:(people.data??[]).map(p=>({key:p.id,value:p.id,label:p.name+" · "+p.email,searchText:p.name+" "+p.email}))}]}/>{people.error&&<p role="alert" className="text-sm text-destructive">人员加载失败：{people.error.message}</p>}</div>;
}
