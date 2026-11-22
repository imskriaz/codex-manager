export type OfficeMemoryEntry = { id: string; text: string; updatedAt: number };
export type OfficeMemory = { enabled: boolean; revision: string; entries: OfficeMemoryEntry[] };
