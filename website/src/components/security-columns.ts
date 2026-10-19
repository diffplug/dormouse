import type { ColumnWeights } from "./MarkdownDocument";

/**
 * Relative column widths for the security pages' generated tables, keyed by
 * header text: the feature table's, and each guarantee table's with or without
 * its Feature column. Left to content, the browser gave the long code paths in
 * Pinned by the room the promise needed, and squeezed the feature table's
 * first column, which carries how you get each feature.
 */
const WEIGHTS: Record<string, number> = {
  Feature: 3,
  "What Dormouse opens on its own": 3,
  "What you trust beyond this computer": 2.5,
  Guarantee: 3,
  "Pinned by": 1.6,
};

/** Weights for a table whose every header is named above; any other sizes by content. */
export const securityColumnWeights: ColumnWeights = (header) =>
  header.every((cell) => cell in WEIGHTS) ? header.map((cell) => WEIGHTS[cell]) : undefined;
