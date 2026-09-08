export function compareIdentities(g: string[], d: string[], f: string[]) {
  const generated = new Set(g);
  const stored = new Set(d);
  const failed = new Set(f);
  const resolved = new Set([...stored, ...failed]);
  const missing = [...generated].filter((id) => !resolved.has(id));
  const unexpected = [...resolved].filter((id) => !generated.has(id));
  const overlap = [...stored].filter((id) => failed.has(id));
  const unique = g.length === generated.size && d.length === stored.size && f.length === failed.size;
  return {
    recorded_raw: g.length, recorded_unique: generated.size,
    db_raw: d.length, db_unique: stored.size,
    failed_raw: f.length, failed_unique: failed.size,
    missing, unexpected, overlap,
    event_ids_match: unique && missing.length === 0 && unexpected.length === 0 && overlap.length === 0,
  };
}
