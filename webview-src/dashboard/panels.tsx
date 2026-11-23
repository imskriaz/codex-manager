export * from "./aboutModal";
export * from "./accountModals";
export * from "./cliSessionsModal";
import {deferredPanel} from './deferredPanel';
export const SettingsOverlay=deferredPanel<Parameters<typeof import('./settingsOverlay').SettingsOverlay>[0]>(()=>import('./settingsOverlay').then(module=>({default:module.SettingsOverlay})),'settings',props=>props.open);
export const ApiWorkspace=deferredPanel<Parameters<typeof import('./apiWorkspace').ApiWorkspace>[0]>(()=>import('./apiWorkspace').then(module=>({default:module.ApiWorkspace})),'API workspace',props=>props.open);
