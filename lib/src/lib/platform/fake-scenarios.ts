import { PROMPT } from '../ansi';
import type { FakeScenario } from './fake-adapter';

/** Simple shell prompt — waits 500ms then shows prompt. Stays alive for interaction. */
export const SCENARIO_SHELL_PROMPT: FakeScenario = {
  name: 'shell-prompt',
  chunks: [{ delay: 500, data: PROMPT }],
  endsWithPrompt: true,
};

