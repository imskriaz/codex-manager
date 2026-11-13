export function getAccountShortcut(event: KeyboardEvent, pathname: string): "search" | "refresh" | "add" | "view" | undefined {
  if (pathname !== "/" || event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"], [role="combobox"], [role="searchbox"], [role="dialog"], [role="menu"], [inert]')) return;
  switch (event.key.toLowerCase()) {
    case "/": return "search";
    case "r": return "refresh";
    case "a": return "add";
    case "v": return "view";
    default: return;
  }
}
