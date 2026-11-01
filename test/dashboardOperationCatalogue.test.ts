import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS } from '../src/domain/dashboard/apiActions';

const source = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const types = source('src/domain/dashboard/types.ts');
const values = (name: string) => {
  const declaration = types.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === name) as ts.TypeAliasDeclaration;
  return (declaration.type as ts.UnionTypeNode).types.map(node => ((node as ts.LiteralTypeNode).literal as ts.StringLiteral).text).sort();
};
const cases = (file: string) => {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) found.add(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source(file)); return found;
};

it('routes every declared operation and exposes each exactly once in the runtime API catalogue', () => {
  const declared = values('DashboardActionName');
  expect([...DASHBOARD_API_ACTIONS].sort()).toEqual(declared);
  const handled = cases('src/presentation/dashboard/actionHandlers.ts');
  expect(declared.filter(action => !handled.has(action))).toEqual([]);
  expect([...PROJECT_API_ACTIONS].filter(action => !declared.includes(action))).toEqual([]);
});

it('handles every dashboard setting and declares configuration outside the SQLite logging controls', () => {
  const handled = cases('src/presentation/dashboard/settings.ts');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const key of values('DashboardSettingKey')) {
    expect(handled.has(key), key).toBe(true);
    if (['persistentLogLevel', 'persistentLogRetentionDays', 'persistentLoggingEnabled'].includes(key)) continue;
    expect(manifest.contributes.configuration.properties, key).toHaveProperty([`codexManager.${key}`]);
  }
});
