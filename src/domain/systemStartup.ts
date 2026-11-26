export interface SystemStartupCheck {
  ready: boolean;
  platform: string;
  host: 'vscode' | 'node';
  checks: Array<{ label: string; status: 'passed' | 'warning' | 'blocked'; detail: string; instruction?: string }>;
}
