import { ALL_ITEM_IDS, ITEM_IDS, SECTIONS, type ItemId } from "./tut-items";

const STORAGE_KEY = "dormouse-tut-v3";
const STAR_STORAGE_KEY = "dormouse-tut-star-v1";
const FLAPPY_HIGH_SCORE_KEY = "dormouse-flappy-high-v1";
const KNOWN_IDS: ReadonlySet<ItemId> = new Set(ITEM_IDS);

export class TutorialState {
  private completed = new Set<ItemId>();
  private starPromptResolved = false;
  private flappyHighScore = 0;
  private listeners = new Set<() => void>();
  private storage = typeof localStorage !== "undefined" ? localStorage : null;

  constructor() {
    this.starPromptResolved = this.storage?.getItem(STAR_STORAGE_KEY) === "true";

    const high = this.storage?.getItem(FLAPPY_HIGH_SCORE_KEY);
    if (high) {
      const parsed = Number.parseInt(high, 10);
      if (Number.isFinite(parsed) && parsed >= 0) this.flappyHighScore = parsed;
    }

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
    const changed =
      this.completed.size > 0 ||
      this.starPromptResolved ||
      this.flappyHighScore > 0;
    if (!changed) return;
    this.completed.clear();
    this.starPromptResolved = false;
    this.flappyHighScore = 0;
    this.storage?.removeItem(STORAGE_KEY);
    this.storage?.removeItem(STAR_STORAGE_KEY);
    this.storage?.removeItem(FLAPPY_HIGH_SCORE_KEY);
    this.notify();
  }

  getFlappyHighScore(): number {
    return this.flappyHighScore;
  }

  recordFlappyScore(score: number): boolean {
    if (!Number.isFinite(score) || score <= this.flappyHighScore) return false;
    this.flappyHighScore = Math.floor(score);
    this.persistFlappyHighScore();
    this.notify();
    return true;
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

  private persistFlappyHighScore(): void {
    try {
      this.storage?.setItem(FLAPPY_HIGH_SCORE_KEY, String(this.flappyHighScore));
    } catch {
      // Quota or access errors shouldn't break in-memory progress.
    }
  }
}
