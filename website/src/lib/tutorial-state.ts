import { ALL_ITEM_IDS, ITEM_IDS, SECTIONS, type ItemId } from "./tut-items";

const STORAGE_KEY = "dormouse-tut-v3";
const STAR_STORAGE_KEY = "dormouse-tut-star-v1";
const KNOWN_IDS: ReadonlySet<ItemId> = new Set(ITEM_IDS);

export class TutorialState {
  private completed = new Set<ItemId>();
  private starPromptResolved = false;
  private listeners = new Set<() => void>();
  private storage = typeof localStorage !== "undefined" ? localStorage : null;

  constructor() {
    this.starPromptResolved = this.storage?.getItem(STAR_STORAGE_KEY) === "true";

    const raw = this.storage?.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (typeof entry === "string" && KNOWN_IDS.has(entry as ItemId)) {
          this.completed.add(entry as ItemId);
        }
      }
    } catch {
      // Corrupt payload — start fresh.
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isComplete(id: ItemId): boolean {
    return this.completed.has(id);
  }

  isStarPromptResolved(): boolean {
    return this.starPromptResolved;
  }

  resolveStarPrompt(): boolean {
    if (this.starPromptResolved) return false;
    this.starPromptResolved = true;
    this.notify();
    this.persistStarPrompt();
    return true;
  }

  markComplete(id: ItemId): boolean {
    if (this.completed.has(id)) return false;
    this.completed.add(id);
    this.notify();
    this.persist();
    return true;
  }

  reset(): void {
    const changed = this.completed.size > 0 || this.starPromptResolved;
    if (!changed) return;
    this.completed.clear();
    this.starPromptResolved = false;
    this.storage?.removeItem(STORAGE_KEY);
    this.storage?.removeItem(STAR_STORAGE_KEY);
    this.notify();
  }

  sectionProgress(sectionId: string): { done: number; total: number } {
    const section = SECTIONS.find((s) => s.id === sectionId);
    if (!section) return { done: 0, total: 0 };
    let done = 0;
    for (const item of section.items) {
      if (this.completed.has(item.id)) done++;
    }
    return { done, total: section.items.length };
  }

  totalProgress(): { done: number; total: number } {
    return {
      done: this.completed.size + (this.starPromptResolved ? 1 : 0),
      total: ALL_ITEM_IDS.length + 1,
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.completed]));
    } catch {
      // Quota or access errors shouldn't break in-memory progress —
      // listeners already fired against the new state.
    }
  }

  private persistStarPrompt(): void {
    try {
      this.storage?.setItem(STAR_STORAGE_KEY, "true");
    } catch {
      // Quota or access errors shouldn't break in-memory progress.
    }
  }
}
