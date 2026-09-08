import { compareIdentities } from './integration/identity';

describe('independent event identity accounting', () => {
  it('accepts exactly disjoint DB and durable failures', () => {
    expect(compareIdentities(['a', 'b'], ['a'], ['b']).event_ids_match).toBe(true);
  });
  it('does not let equal counts conceal missing and unexpected IDs', () => {
    expect(compareIdentities(['a'], ['b'], [])).toMatchObject({ missing: ['a'], unexpected: ['b'], event_ids_match: false });
  });
  it('rejects DB/failure overlap', () => {
    expect(compareIdentities(['a'], ['a'], ['a'])).toMatchObject({ overlap: ['a'], event_ids_match: false });
  });
  it.each([
    [['a', 'a'], ['a'], []],
    [['a'], ['a', 'a'], []],
    [['a'], [], ['a', 'a']],
  ])('raw duplicate rows cannot be hidden by Set', (g, d, f) => {
    expect(compareIdentities(g, d, f).event_ids_match).toBe(false);
  });
});
