import { loadJson, removeJson, saveJson } from "dormouse-lib/lib/local-json-store";
import { ITEM_IDS, SECTIONS, type ItemId, type Section } from "./tut-items";

const STORAGE_KEY = "dormouse-tut-v3";
const STAR_STORAGE_KEY = "dormouse-tut-star-v1";
const FLAPPY_HIGH_SCORE_KEY = "dormouse-flappy-high-v1";
const KNOWN_IDS: ReadonlySet<ItemId> = new Set(ITEM_IDS);

export class TutorialState {
  private completed = new Set<ItemId>();
  private starPromptResolved = false;
  private flappyHighScore = 0;
  private listeners = new Set<() => void>();
  private sections: readonly Section[];

  constructor(sections: readonly Section[] = SECTIONS) {
    this.sections = sections;
    this.starPromptResolved = loadJson<unknown>(STAR_STORAGE_KEY, false) === true;
    const high = loadJson<unknown>(FLAPPY_HIGH_SCORE_KEY, 0);
    if (typeof high === "number" && Number.isFinite(high) && high >= 0) {
      this.flappyHighScore = Math.floor(high);
    }

    for (const entry of loadJson<unknown[]>(STORAGE_KEY, [], Array.isArray)) {
      if (typeof entry === "string" && KNOWN_IDS.has(entry as ItemId)) {
        this.completed.add(entry as ItemId);
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

  isStarPromptResolved(): boolean {
    return this.starPromptResolved;
  }

  resolveStarPrompt(): boolean {
    if (this.starPromptResolved) return false;
    this.starPromptResolved = true;
    this.notify();
    saveJson(STAR_STORAGE_KEY, true);
    return true;
  }

  markComplete(id: ItemId): boolean {
    if (this.completed.has(id)) return false;
    this.completed.add(id);
    this.notify();
    saveJson(STORAGE_KEY, [...this.completed]);
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
    removeJson(STORAGE_KEY);
    removeJson(STAR_STORAGE_KEY);
    removeJson(FLAPPY_HIGH_SCORE_KEY);
    this.notify();
  }

  getFlappyHighScore(): number {
    return this.flappyHighScore;
  }

  recordFlappyScore(score: number): boolean {
    if (!Number.isFinite(score) || score <= this.flappyHighScore) return false;
    this.flappyHighScore = Math.floor(score);
    saveJson(FLAPPY_HIGH_SCORE_KEY, this.flappyHighScore);
    this.notify();
    return true;
  }

  sectionProgress(sectionId: string): { done: number; total: number } {
    const section = this.sections.find((s) => s.id === sectionId);
    if (!section) return { done: 0, total: 0 };
    let done = 0;
    for (const item of section.items) {
      if (this.completed.has(item.id)) done++;
    }
    return { done, total: section.items.length };
  }

  totalProgress(): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const section of this.sections) {
      for (const item of section.items) {
        total++;
        if (this.completed.has(item.id)) done++;
      }
    }
    return { done, total };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
