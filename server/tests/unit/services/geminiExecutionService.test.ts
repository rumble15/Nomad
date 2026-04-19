import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/database', () => ({
  db: {
    transaction: () => (cb: () => void) => cb(),
    prepare: () => ({ run: () => {} }),
  },
}));

import {
  normalizeGeminiExecutionMode,
  normalizeGeminiActionStatus,
  classifyGeminiRisk,
} from '../../../src/services/geminiExecutionService';

describe('geminiExecutionService', () => {
  it('normalizes execution mode safely', () => {
    expect(normalizeGeminiExecutionMode('review')).toBe('review');
    expect(normalizeGeminiExecutionMode(' FORCE ')).toBe('force');
    expect(normalizeGeminiExecutionMode('unknown')).toBe('auto');
    expect(normalizeGeminiExecutionMode(null)).toBe('auto');
  });

  it('normalizes action status safely', () => {
    expect(normalizeGeminiActionStatus('ok')).toBe('ok');
    expect(normalizeGeminiActionStatus('skipped')).toBe('skipped');
    expect(normalizeGeminiActionStatus('error')).toBe('error');
    expect(normalizeGeminiActionStatus('failed')).toBe('error');
    expect(normalizeGeminiActionStatus(undefined)).toBe('error');
  });

  it('classifies action risk deterministically', () => {
    expect(classifyGeminiRisk([])).toBe('low');

    expect(classifyGeminiRisk([
      { type: 'create_todo', name: 'A' },
    ])).toBe('medium');

    expect(classifyGeminiRisk([
      { type: 'create_place', query: 'Rome center' },
    ])).toBe('high');

    expect(classifyGeminiRisk([
      { type: 'search_trip', query: 'museum' },
      { type: 'maps_search', query: 'museum rome' },
      { type: 'web_search', query: 'opening hours' },
    ])).toBe('medium');
  });
});
