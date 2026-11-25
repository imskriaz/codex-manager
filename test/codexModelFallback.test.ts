import {expect,it} from 'vitest';
import {codexFallbackModels, parseCodexFallbackModelIds} from '../src/domain/codexModelFallback';
it('includes current Codex models without resurrecting retired defaults',()=>{
 const models=codexFallbackModels([]);
 expect(models.map(model=>model.id)).toEqual(['gpt-6.2-sol','gpt-6.2-astra','gpt-6.1-terra','gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-6-luna']);
 expect(models.every(model=>model.description?.includes('unverified'))).toBe(true);
 expect(models.find(model=>model.id==='gpt-6-luna')?.reasoningEfforts).not.toContain('ultra');
});
it('merges editable fallbacks into a successful live list without replacing metadata', () => {
 const live = {id:'gpt-6.1-sol',label:'Live Sol',reasoningEfforts:['high']};
 const models = codexFallbackModels([live], ['hidden'], parseCodexFallbackModelIds('gpt-6.1-sol, custom-model\nhidden\ncustom-model'));
 expect(models.map(model => model.id)).toEqual(['gpt-6.1-sol','custom-model']);
 expect(models[0]).toBe(live); expect(models[1]?.description).toContain('unverified');
 expect(codexFallbackModels([live], [], [])).toEqual([live]);
 expect(() => parseCodexFallbackModelIds('bad$model')).toThrow('valid');
});
it('preserves cached metadata and explicit hidden choices',()=>{
 const saved={id:'gpt-6.2-sol',label:'Custom display',reasoningEfforts:['low'],defaultReasoningEffort:'low'};
 const models=codexFallbackModels([saved],['gpt-6.2-astra']);expect(models[0]).toBe(saved);expect(models.filter(model=>model.id===saved.id)).toHaveLength(1);expect(models.some(model=>model.id==='gpt-6.2-astra')).toBe(false);
});
