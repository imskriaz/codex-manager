/** Keep only a possible stop prefix between deltas; never emit the stop itself. */
export class StopSequenceMatcher {
  private pending = '';
  private readonly patterns: Array<{ text: string; prefixes: Uint32Array; offset: number }>;
  matched?: string;

  constructor(sequences: readonly string[]) {
    this.patterns = sequences.map(text => {
      const prefixes = new Uint32Array(text.length);
      for (let index = 1, offset = 0; index < text.length; index++) {
        while (offset && text[index] !== text[offset]) offset = prefixes[offset - 1]!;
        if (text[index] === text[offset]) offset++;
        prefixes[index] = offset;
      }
      return { text, prefixes, offset: 0 };
    });
  }

  write(text: string): string {
    if (this.matched !== undefined) return '';
    if (!this.patterns.length) return text;
    const value = this.pending + text;
    for (let index = 0; index < text.length; index++) {
      for (const pattern of this.patterns) {
        while (pattern.offset && text[index] !== pattern.text[pattern.offset]) pattern.offset = pattern.prefixes[pattern.offset - 1]!;
        if (text[index] === pattern.text[pattern.offset]) pattern.offset++;
        if (pattern.offset === pattern.text.length) {
          const result = value.slice(0, this.pending.length + index + 1 - pattern.text.length);
          this.matched = pattern.text;
          this.pending = '';
          return result;
        }
      }
    }
    const held = this.patterns.reduce((length, pattern) => Math.max(length, pattern.offset), 0);
    this.pending = held ? value.slice(-held) : '';
    return held ? value.slice(0, -held) : value;
  }

  flush(): string {
    const text = this.pending;
    this.pending = '';
    for (const pattern of this.patterns) pattern.offset = 0;
    return text;
  }
}
