import { useEffect, useLayoutEffect } from 'react';

/** `useLayoutEffect` in a browser, `useEffect` during a prerender, where a
 *  layout effect only warns. */
export const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
