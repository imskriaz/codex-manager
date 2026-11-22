export const OFFICE_PROFILES = ['regular','professional','expert'] as const;
export type OfficeProfile = typeof OFFICE_PROFILES[number];
export type OfficeModelChoice = {model:string;reasoningEffort?:string;profile?:OfficeProfile};
export const officeProfileLabel = (profile:OfficeProfile) => profile.charAt(0).toUpperCase()+profile.slice(1);
export function officeProfiles(settings:{regularModel:string;professionalModel:string;expertModel:string;defaultModel:string},allowedModels:string[]=[],availableModels:string[]=[]) {
  const allowed=(model:string)=>!!model&&(!allowedModels.length||allowedModels.includes(model))&&(!availableModels.length||availableModels.includes(model));
  const profiles=OFFICE_PROFILES.map(profile=>({profile,model:settings[`${profile}Model`]})).filter(choice=>allowed(choice.model));
  if(!profiles.length){const model=[settings.defaultModel,...allowedModels,...availableModels].find(allowed);if(model)profiles.push({profile:'regular',model});}
  return profiles;
}
export const OFFICE_THINKING = ['none','minimal','low','medium','high','xhigh','max'] as const;
export function officeReasoning(value:unknown):string|undefined {
  return typeof value==='string'&&(OFFICE_THINKING as readonly string[]).includes(value)?value:undefined;
}
