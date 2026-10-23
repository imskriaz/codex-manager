import { expect, it } from 'vitest';
import { anchoredPopoverPosition } from '../webview-src/dashboard/anchoredPopover';
const viewport = { left: 0, top: 0, width: 800, height: 600 };
it('opens beside the clicked control and flips above without overlapping it', () => {
  expect(anchoredPopoverPosition({ top: 540, bottom: 560, left: 770, right: 790 }, { width: 264, height: 140 }, viewport)).toEqual({ left: 526, top: 394, opensAbove: true });
  expect(anchoredPopoverPosition({ top: 20, bottom: 40, left: 0, right: 20 }, { width: 264, height: 140 }, viewport)).toEqual({ left: 8, top: 46, opensAbove: false });
});
it('fits the visual viewport with an on-screen keyboard and zoom offsets', () => {
  const screen = { left: 40, top: 100, width: 320, height: 240 };
  const position = anchoredPopoverPosition({ top: 290, bottom: 314, left: 260, right: 284 }, { width: 240, height: 160 }, screen, 'start');
  expect(position).toEqual({ left: 112, top: 124, opensAbove: true });
});
it('clamps an oversized or detached anchor to the visible margin', () => {
  expect(anchoredPopoverPosition({ top: -100, bottom: -80, left: 1500, right: 1600 }, { width: 1000, height: 800 }, viewport)).toMatchObject({ left: 8, top: 8 });
});
