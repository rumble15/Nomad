import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: () => ({
      get: () => undefined,
    }),
  },
}));
vi.mock('../../../src/services/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
}));

import { parseGeminiReservationImportResponse } from '../../../src/services/reservationPdfImportService';

describe('parseGeminiReservationImportResponse', () => {
  it('parses JSON wrapped in markdown code fences', () => {
    const raw = `\`\`\`json
{
  "reservations": [
    {
      "title": "LH123 Frankfurt to Rome",
      "type": "flight",
      "status": "confirmed",
      "reservation_time": "2026-08-03T09:30",
      "location": "FRA",
      "confirmation_number": "ABC123"
    }
  ]
}
\`\`\``;
    const parsed = parseGeminiReservationImportResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toContain('LH123');
    expect(parsed[0].type).toBe('flight');
    expect(parsed[0].status).toBe('confirmed');
  });

  it('drops entries without title and normalizes unknown types', () => {
    const parsed = parseGeminiReservationImportResponse(JSON.stringify({
      reservations: [
        { type: 'spaceship' },
        { title: 'Dinner Booking', type: 'spaceship' },
      ],
    }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Dinner Booking');
    expect(parsed[0].type).toBe('other');
  });
});
