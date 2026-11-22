export type OfficeSchedule = {
  id: string; owner: string; revision: string; title: string; prompt: string; model: string; projectPath: string;
  frequency: 'once' | 'daily' | 'weekly'; timeZone: string; time: string; weekday: number;
  enabled: boolean; nextRunAt: number; lastRunAt?: number; lastSessionId?: string; lastError?: string;
  pending?: { requestId: string; dueAt: number; manual: boolean };
};
export type UserSchedule = Omit<OfficeSchedule, 'owner' | 'pending'> & {runStatus?:'queued'|'working'|'completed'|'failed'|'needs-answer'|'cancelled'};

function fields(at: number, zone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(at);
  return ['year','month','day','hour','minute'].map(key => Number(parts.find(part => part.type === key)?.value));
}
export function scheduleClock(at: number, zone: string) {
  const [year,month,day,hour,minute]=fields(at,zone) as [number,number,number,number,number];
  return {time:`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`, weekday:new Date(Date.UTC(year,month-1,day)).getUTCDay()};
}
/** Calendar recurrence uses the saved zone. Missing DST times move forward; repeated times run once. */
export function nextScheduleRun(schedule: Pick<OfficeSchedule,'frequency'|'timeZone'|'time'|'weekday'>, after: number): number | undefined {
  if (schedule.frequency === 'once') return undefined;
  const [year,month,day]=fields(after,schedule.timeZone) as [number,number,number];
  const [hour,minute]=schedule.time.split(':').map(Number) as [number,number];
  for(let days=0;days<9;days++) {
    const date=new Date(Date.UTC(year,month-1,day+days,hour,minute));
    if(schedule.frequency==='weekly'&&date.getUTCDay()!==schedule.weekday)continue;
    const target=date.getTime(), offsets=new Set<number>();
    for(let hours=-36;hours<=36;hours+=6){
      const sample=target+hours*3600000;
      const [y,m,d,h,min]=fields(sample,schedule.timeZone) as [number,number,number,number,number];
      offsets.add(Date.UTC(y,m-1,d,h,min)-sample);
    }
    const candidates=[...offsets].map(offset=>target-offset).filter(at=>{
      const [y,m,d,h,min]=fields(at,schedule.timeZone) as [number,number,number,number,number];
      return y===date.getUTCFullYear()&&m===date.getUTCMonth()+1&&d===date.getUTCDate()&&h*60+min>=hour*60+minute;
    }).sort((a,b)=>a-b);
    // Always choose the first occurrence, including during a repeated clock hour.
    const candidate=candidates[0];
    if(candidate!==undefined&&candidate>after)return candidate;
  }
  throw new Error('The next scheduled time could not be calculated.');
}
