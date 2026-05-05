import { ALL_ITEM_IDS, SECTIONS, type ItemId } from "./tut-items";

const STORAGE_PREFIX = "mouseterm-tut-v2-";

export class TutorialState {
  private completed = new Set<ItemId>();
  private listeners = new Set<() => void>();

  constructor() {
    if (typeof localStorage === "undefined") return;
    for (const id of ALL_ITEM_IDS) {
      if (localStorage.getItem(STORAGE_PREFIX + id) === "1") {
        this.completed.add(id);
      }
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

  markComplete(id: ItemId): boolean {
    if (this.completed.has(id)) return false;
    this.completed.add(id);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_PREFIX + id, "1");
    }
    this.notify();
    return true;
  }

  reset(): void {
    if (this.completed.size === 0) return;
    if (typeof localStorage !== "undefined") {
      for (const id of this.completed) {
        localStorage.removeItem(STORAGE_PREFIX + id);
      }
    }
    this.completed.clear();
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
    return { done: this.completed.size, total: ALL_ITEM_IDS.length };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
