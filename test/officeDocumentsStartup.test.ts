import {expect, it, vi} from 'vitest';

const loaded = vi.hoisted(() => [] as string[]);
vi.mock('exceljs', () => { loaded.push('exceljs'); return {}; });
vi.mock('docx', () => { loaded.push('docx'); return {}; });
vi.mock('pptxgenjs', () => { loaded.push('pptxgenjs'); return {}; });
vi.mock('pdf-lib', () => { loaded.push('pdf-lib'); return {}; });
vi.mock('@pdf-lib/fontkit', () => { loaded.push('fontkit'); return {}; });

it('loads dashboard document actions without initializing document runtimes', async () => {
  const documents = await import('../src/services/officeDocuments');
  expect(typeof documents.createOfficeDocument).toBe('function');
  expect(typeof documents.extractOfficeDocument).toBe('function');
  expect(loaded).toEqual([]);
});
