import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetResumeOffersForTests,
  clearResumeOffer,
  getResumeOffer,
  getResumeOfferSnapshot,
  offerResumeCommand,
  subscribeToResumeOffers,
} from './resume-offers';

describe('resume-offers', () => {
  beforeEach(() => {
    __resetResumeOffersForTests();
  });

  it('holds an offer per session', () => {
    offerResumeCommand('pane-a', 'claude --resume abc');
    offerResumeCommand('pane-b', 'codex resume xyz');
    expect(getResumeOffer('pane-a')).toBe('claude --resume abc');
    expect(getResumeOffer('pane-b')).toBe('codex resume xyz');
    expect(getResumeOffer('pane-c')).toBeNull();
  });

  it('treats a null command as no offer', () => {
    offerResumeCommand('pane-a', null);
    expect(getResumeOffer('pane-a')).toBeNull();
    expect(getResumeOfferSnapshot().size).toBe(0);
  });

  it('clears an existing offer when re-seeded with null', () => {
    offerResumeCommand('pane-a', 'claude --resume abc');
    offerResumeCommand('pane-a', null);
    expect(getResumeOffer('pane-a')).toBeNull();
  });

  it('notifies subscribers on seed and clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToResumeOffers(listener);

    offerResumeCommand('pane-a', 'claude --resume abc');
    expect(listener).toHaveBeenCalledTimes(1);

    clearResumeOffer('pane-a');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    offerResumeCommand('pane-a', 'claude --resume abc');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify when nothing changes', () => {
    offerResumeCommand('pane-a', 'claude --resume abc');
    const listener = vi.fn();
    subscribeToResumeOffers(listener);

    offerResumeCommand('pane-a', 'claude --resume abc');
    clearResumeOffer('pane-unknown');
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands out a fresh snapshot identity only after a change', () => {
    const first = getResumeOfferSnapshot();
    expect(getResumeOfferSnapshot()).toBe(first);

    offerResumeCommand('pane-a', 'claude --resume abc');
    const second = getResumeOfferSnapshot();
    expect(second).not.toBe(first);
    expect(second.get('pane-a')).toBe('claude --resume abc');
  });
});
