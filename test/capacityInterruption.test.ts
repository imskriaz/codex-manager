import { expect, it } from 'vitest';
import { isCodexCapacityInterruption } from '../src/domain/codexSessionState';

it.each(['Selected model is at capacity. Please try a different model.', 'The model is currently at capacity. Please try again later.', 'Server is at capacity', 'Provider is at capacity', 'serverOverloaded', 'server_is_overloaded', 'model_overloaded', 'model_at_capacity'])(
  'recognizes explicit capacity rejection: %s', message => expect(isCodexCapacityInterruption(message)).toBe(true)
);

it.each(['Connection closed', 'Disk is at capacity', 'You have hit your usage limit', 'Authentication failed'])(
  'does not classify unrelated failures as model capacity: %s', message => expect(isCodexCapacityInterruption(message)).toBe(false)
);
